import crypto from 'crypto'
import { AUTO_TEAM_STATUSES, listAutoTeamAccounts } from './auto-team-db.js'
import { getAutoTeamSettings } from './auto-team-config.js'

const DEFAULT_TIMEOUT_MS = 15000
const MANAGED_FILES_PATH = '/v0/management/auth-files'
const DOWNLOAD_FILE_PATH = '/v0/management/auth-files/download'

const normalizeOptionalString = (value) => {
  if (value == null) return ''
  return String(value).trim()
}

const normalizeEmail = (value) => normalizeOptionalString(value).toLowerCase()

const normalizeBaseUrl = (value) => normalizeOptionalString(value).replace(/\/+$/, '')

const normalizePlanType = (value) => {
  const normalized = normalizeOptionalString(value).toLowerCase().replace(/\s+/g, '-')
  return normalized || 'unknown'
}

const formatUtcIso = (date) => {
  const resolved = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(resolved.getTime())) {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return resolved.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const parseDateCandidate = (value) => {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value > 1e12 ? value : value * 1000
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const numeric = Number.parseInt(text, 10)
    if (Number.isFinite(numeric)) {
      return parseDateCandidate(numeric)
    }
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

const resolveResponseDetail = (response) => {
  const data = response?.data
  if (typeof data === 'string' && data.trim()) return data.trim()
  if (data && typeof data === 'object') {
    const detail = data.detail
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    if (detail && typeof detail === 'object' && typeof detail.message === 'string' && detail.message.trim()) {
      return detail.message.trim()
    }
    if (typeof data.error === 'string' && data.error.trim()) return data.error.trim()
    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim()
  }
  const text = normalizeOptionalString(response?.text)
  return text ? text.slice(0, 200) : ''
}

const buildCpaRequestError = (action, response) => {
  const detail = resolveResponseDetail(response)
  return new Error(`${action}（${response.url}）：HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
}

const requestCpa = async (settings, path, { method = 'GET', params = null, body = undefined, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const baseUrl = normalizeBaseUrl(settings?.baseUrl)
  const url = new URL(path, `${baseUrl}/`)
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${settings.key}`,
        ...headers,
      },
      body,
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return {
      url: url.toString(),
      ok: response.ok,
      status: response.status,
      text,
      data,
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`CPA 请求超时（${url.toString()}）`)
    }
    throw new Error(`CPA 请求失败（${url.toString()}）：${error?.message || String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

const resolveCpaSettings = async (options = {}) => {
  const source = options.settings || await getAutoTeamSettings({ includeSecrets: true })
  if (source && typeof source === 'object' && !source.cpa && ('baseUrl' in source || 'key' in source || 'enabled' in source)) {
    return {
      enabled: Boolean(source.enabled),
      baseUrl: normalizeBaseUrl(source.baseUrl),
      key: normalizeOptionalString(source.key),
      syncOnChange: Boolean(source.syncOnChange ?? true),
    }
  }
  return {
    enabled: Boolean(source?.cpa?.enabled),
    baseUrl: normalizeBaseUrl(source?.cpa?.baseUrl),
    key: normalizeOptionalString(source?.cpa?.key),
    syncOnChange: Boolean(source?.cpa?.syncOnChange ?? true),
  }
}

const ensureCpaConfigured = (settings) => {
  if (!settings?.baseUrl) {
    throw new Error('未配置 CPA Base URL')
  }
  if (!settings?.key) {
    throw new Error('未配置 CPA 管理密钥')
  }
  return settings
}

const parseCpaFileEmailFromName = (name) => {
  const normalizedName = normalizeOptionalString(name)
  if (!normalizedName.startsWith('codex-') || normalizedName.startsWith('codex-main-') || !normalizedName.endsWith('.json')) {
    return ''
  }
  const stem = normalizedName.slice(6, -5)
  const segments = stem.split('-')
  if (segments.length < 3) return ''
  return normalizeEmail(segments.slice(0, -2).join('-'))
}

const normalizeCpaFile = (file = {}) => ({
  name: normalizeOptionalString(file.name),
  email: normalizeEmail(file.email || parseCpaFileEmailFromName(file.name)),
  size: file.size == null ? null : Number(file.size),
  createdAt: normalizeOptionalString(file.created_at || file.createdAt) || null,
  updatedAt: normalizeOptionalString(file.updated_at || file.updatedAt) || null,
  raw: file,
})

const extractAuthSource = (account = {}) => {
  const authJson = account.authJson && typeof account.authJson === 'object' ? account.authJson : {}
  return {
    email: normalizeEmail(authJson.email || authJson.email_address || account.email),
    planType: normalizePlanType(authJson.planType || authJson.plan_type || account.planType),
    accessToken: normalizeOptionalString(authJson.accessToken || authJson.access_token || account.accessToken),
    refreshToken: normalizeOptionalString(authJson.refreshToken || authJson.refresh_token || account.refreshToken),
    idToken: normalizeOptionalString(authJson.idToken || authJson.id_token || account.idToken),
    accountId: normalizeOptionalString(authJson.accountId || authJson.account_id || account.chatgptAccountId),
    expiresIn: Number(authJson.expiresIn || authJson.expires_in || 0),
    refreshedAt: authJson.refreshedAt || authJson.refreshed_at || authJson.lastRefresh || authJson.last_refresh || account.updatedAt || account.createdAt,
    expiredAt: authJson.expiredAt || authJson.expired_at || authJson.expiresAt || authJson.expires_at || authJson.expired,
  }
}

const resolveLastRefreshDate = (authSource) => {
  return parseDateCandidate(authSource.refreshedAt) || new Date()
}

const resolveExpiredDate = (authSource, lastRefreshDate) => {
  const explicit = parseDateCandidate(authSource.expiredAt)
  if (explicit) return explicit
  if (Number.isFinite(authSource.expiresIn) && authSource.expiresIn > 0) {
    return new Date(lastRefreshDate.getTime() + authSource.expiresIn * 1000)
  }
  return new Date(lastRefreshDate.getTime() + 3600 * 1000)
}

const buildManagedAuthName = ({ email, planType, accountId }) => {
  const normalizedEmail = normalizeEmail(email)
  const normalizedPlanType = normalizePlanType(planType)
  const hashSource = normalizeOptionalString(accountId) || normalizedEmail || 'unknown'
  const hashId = crypto.createHash('md5').update(hashSource).digest('hex').slice(0, 8)
  return `codex-${normalizedEmail}-${normalizedPlanType}-${hashId}.json`
}

const buildAutoTeamCpaAuthDescriptor = (account) => {
  const authSource = extractAuthSource(account)
  if (!authSource.email) {
    throw new Error('缺少邮箱，无法构造 CPA 认证文件')
  }
  if (!authSource.accessToken) {
    throw new Error('缺少 access token，无法同步到 CPA')
  }

  const lastRefreshDate = resolveLastRefreshDate(authSource)
  const expiredDate = resolveExpiredDate(authSource, lastRefreshDate)
  const name = buildManagedAuthName(authSource)
  const content = JSON.stringify({
    type: 'codex',
    id_token: authSource.idToken,
    access_token: authSource.accessToken,
    refresh_token: authSource.refreshToken,
    account_id: authSource.accountId,
    email: authSource.email,
    expired: formatUtcIso(expiredDate),
    last_refresh: formatUtcIso(lastRefreshDate),
  }, null, 2)

  return {
    name,
    email: authSource.email,
    accountId: authSource.accountId,
    planType: authSource.planType,
    content,
  }
}

const uploadAuthDescriptorToCpa = async (settings, descriptor) => {
  const form = new FormData()
  form.append('file', new Blob([descriptor.content], { type: 'application/json' }), descriptor.name)
  const response = await requestCpa(settings, MANAGED_FILES_PATH, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) {
    throw buildCpaRequestError('上传 CPA 认证文件失败', response)
  }
  return response
}

const deleteAuthFileFromCpa = async (settings, name) => {
  const response = await requestCpa(settings, MANAGED_FILES_PATH, {
    method: 'DELETE',
    params: { name },
  })
  if (!response.ok) {
    throw buildCpaRequestError('删除 CPA 认证文件失败', response)
  }
  return response
}

export async function listAutoTeamCpaFiles(options = {}) {
  const settings = ensureCpaConfigured(await resolveCpaSettings(options))
  const response = await requestCpa(settings, MANAGED_FILES_PATH)
  if (!response.ok) {
    throw buildCpaRequestError('获取 CPA 文件列表失败', response)
  }
  const files = Array.isArray(response.data)
    ? response.data.map(normalizeCpaFile)
    : Array.isArray(response.data?.files)
      ? response.data.files.map(normalizeCpaFile)
      : []

  return {
    files,
    total: files.length,
  }
}

export async function testAutoTeamCpaConnection(options = {}) {
  const result = await listAutoTeamCpaFiles(options)
  return {
    ok: true,
    total: result.total,
    files: result.files,
  }
}

export async function syncAutoTeamAccountsToCpa(options = {}) {
  const settings = ensureCpaConfigured(await resolveCpaSettings(options))
  const accounts = Array.isArray(options.accounts) ? options.accounts : await listAutoTeamAccounts()
  const managedEmails = new Set([
    ...accounts.map(account => normalizeEmail(account.email)),
    ...(Array.isArray(options.extraManagedEmails) ? options.extraManagedEmails.map(normalizeEmail) : []),
  ].filter(Boolean))

  const activeDescriptors = new Map()
  const skipped = []

  for (const account of accounts) {
    if (account.status !== AUTO_TEAM_STATUSES.ACTIVE) continue
    try {
      const descriptor = buildAutoTeamCpaAuthDescriptor(account)
      activeDescriptors.set(descriptor.name, descriptor)
    } catch (error) {
      skipped.push({
        email: normalizeEmail(account.email),
        reason: error?.message || String(error),
      })
    }
  }

  const { files: cpaFiles } = await listAutoTeamCpaFiles({ settings })
  const uploadedFiles = []
  const deletedFiles = []
  const failures = []

  for (const descriptor of activeDescriptors.values()) {
    try {
      await uploadAuthDescriptorToCpa(settings, descriptor)
      uploadedFiles.push(descriptor.name)
    } catch (error) {
      failures.push({
        name: descriptor.name,
        email: descriptor.email,
        error: error?.message || String(error),
      })
    }
  }

  for (const item of cpaFiles) {
    if (!item.name) continue
    if (item.name.startsWith('codex-main-')) continue
    const fileEmail = normalizeEmail(item.email || parseCpaFileEmailFromName(item.name))
    if (!fileEmail || !managedEmails.has(fileEmail)) continue
    if (activeDescriptors.has(item.name)) continue
    try {
      await deleteAuthFileFromCpa(settings, item.name)
      deletedFiles.push(item.name)
    } catch (error) {
      failures.push({
        name: item.name,
        email: fileEmail,
        error: error?.message || String(error),
      })
    }
  }

  return {
    activeCount: activeDescriptors.size,
    managedCount: managedEmails.size,
    cpaCount: cpaFiles.length,
    uploaded: uploadedFiles.length,
    deleted: deletedFiles.length,
    skipped,
    failures,
    uploadedFiles,
    deletedFiles,
  }
}

export async function syncAutoTeamCpaIfConfigured(options = {}) {
  const settings = await resolveCpaSettings(options)
  if (!settings.enabled) {
    return { skipped: true, reason: 'disabled' }
  }
  if (!settings.syncOnChange && !options.force) {
    return { skipped: true, reason: 'sync_on_change_disabled' }
  }
  if (!settings.baseUrl || !settings.key) {
    return { skipped: true, reason: 'unconfigured' }
  }

  try {
    return {
      skipped: false,
      ...(await syncAutoTeamAccountsToCpa({ ...options, settings })),
    }
  } catch (error) {
    if (options.throwOnFailure) throw error
    console.error('[AutoTeamCPA] sync failed:', {
      reason: options.reason || '',
      error: error?.message || String(error),
    })
    return {
      skipped: false,
      error: error?.message || String(error),
    }
  }
}

export async function downloadAutoTeamCpaFile(name, options = {}) {
  const settings = ensureCpaConfigured(await resolveCpaSettings(options))
  const response = await requestCpa(settings, DOWNLOAD_FILE_PATH, {
    params: { name },
  })
  if (!response.ok) {
    throw buildCpaRequestError('下载 CPA 认证文件失败', response)
  }
  return {
    name: normalizeOptionalString(name),
    content: response.text,
  }
}
