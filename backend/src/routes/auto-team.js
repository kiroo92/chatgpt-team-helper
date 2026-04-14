import express from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { AutoTeamCloudMailClient } from '../services/auto-team-cloudmail.js'
import { listAutoTeamCpaFiles, syncAutoTeamAccountsToCpa, testAutoTeamCpaConnection } from '../services/auto-team-cpa.js'
import { AUTO_TEAM_STATUSES } from '../services/auto-team-db.js'
import { getAutoTeamManagerCandidates, getAutoTeamSettings, updateAutoTeamSettings } from '../services/auto-team-config.js'
import { resolveAutoTeamBrowserExecutablePath, resolveAutoTeamBrowserRuntime } from '../services/auto-team-browser.js'
import {
  AUTO_TEAM_REDIRECT_HOST,
  AUTO_TEAM_REDIRECT_PORT,
  AUTO_TEAM_REDIRECT_URI,
  cancelManualOAuthSession,
  createManualOAuthSession,
  finalizeManualOAuthSession,
  getManualOAuthSessionStatus,
  startAutoTeamOAuthCallbackServer,
  submitManualOAuthCallback,
} from '../services/auto-team-oauth.js'
import {
  checkAutoTeamAccounts,
  createNewAutoTeamAccount,
  deleteAutoTeamAccountRecord,
  getAutoTeamAccountsList,
  getAutoTeamManagerAccount,
  getAutoTeamSummary,
  importManualAutoTeamAccount,
  rotateAutoTeamAccounts,
  setAutoTeamAccountStatus,
} from '../services/auto-team-manager.js'

const router = express.Router()

const ALLOWED_STATUSES = new Set(Object.values(AUTO_TEAM_STATUSES))

const toInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const sanitizeAutoTeamAccount = (account) => {
  if (!account) return null
  return {
    id: Number(account.id || 0),
    email: String(account.email || ''),
    status: String(account.status || ''),
    planType: account.planType ? String(account.planType) : null,
    chatgptAccountId: account.chatgptAccountId ? String(account.chatgptAccountId) : null,
    cloudmailAccountId: account.cloudmailAccountId ? String(account.cloudmailAccountId) : null,
    quotaPrimaryPct: account.quotaPrimaryPct == null ? null : Number(account.quotaPrimaryPct),
    quotaPrimaryResetsAt: account.quotaPrimaryResetsAt == null ? null : Number(account.quotaPrimaryResetsAt),
    quotaWeeklyPct: account.quotaWeeklyPct == null ? null : Number(account.quotaWeeklyPct),
    quotaWeeklyResetsAt: account.quotaWeeklyResetsAt == null ? null : Number(account.quotaWeeklyResetsAt),
    quotaExhaustedAt: account.quotaExhaustedAt == null ? null : Number(account.quotaExhaustedAt),
    lastActiveAt: account.lastActiveAt == null ? null : Number(account.lastActiveAt),
    lastError: account.lastError ? String(account.lastError) : null,
    passwordStored: Boolean(account.password),
    accessTokenStored: Boolean(account.accessToken),
    refreshTokenStored: Boolean(account.refreshToken),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
  }
}

const sanitizeManualSession = (session) => {
  if (!session) return null
  const result = session.result && typeof session.result === 'object'
    ? {
        email: session.result.email ? String(session.result.email) : '',
        planType: session.result.planType ? String(session.result.planType) : '',
        accountId: session.result.accountId ? String(session.result.accountId) : '',
        organizationTitle: session.result.organizationTitle ? String(session.result.organizationTitle) : '',
      }
    : null

  return {
    sessionId: String(session.sessionId || ''),
    authUrl: String(session.authUrl || ''),
    status: String(session.status || ''),
    message: session.message ? String(session.message) : '',
    error: session.error ? String(session.error) : '',
    callbackReceived: Boolean(session.callbackReceived),
    callbackSource: session.callbackSource ? String(session.callbackSource) : '',
    autoCallbackAvailable: Boolean(session.autoCallbackAvailable),
    expiresAt: session.expiresAt || null,
    instructions: Array.isArray(session.instructions) ? session.instructions.map(item => String(item || '')) : undefined,
    result,
  }
}

router.use(authenticateToken, requireMenu('autoteam'))

router.get('/summary', async (req, res) => {
  try {
    const summary = await getAutoTeamSummary()
    return res.json(summary)
  } catch (error) {
    console.error('[AutoTeam] get summary failed:', error)
    return res.status(500).json({ error: error?.message || '获取 AutoTeam 汇总失败' })
  }
})

router.get('/diagnostics', async (req, res) => {
  try {
    const [settings, managerCandidates, browserExecutablePath] = await Promise.all([
      getAutoTeamSettings(),
      getAutoTeamManagerCandidates(),
      resolveAutoTeamBrowserExecutablePath(),
    ])
    const browserRuntime = resolveAutoTeamBrowserRuntime(settings)

    let manager = null
    let managerError = ''
    try {
      manager = await getAutoTeamManagerAccount()
    } catch (error) {
      managerError = error?.message || String(error)
    }

    return res.json({
      browser: {
        available: Boolean(browserExecutablePath),
        executablePath: browserExecutablePath || '',
        configuredPath: String(settings?.browser?.executablePath || '').trim(),
        headless: Boolean(browserRuntime.effectiveHeadless),
        requestedHeadless: Boolean(browserRuntime.requestedHeadless),
        effectiveHeadless: Boolean(browserRuntime.effectiveHeadless),
        displayAvailable: Boolean(browserRuntime.displayAvailable),
        forcedHeadless: Boolean(browserRuntime.forcedHeadless),
      },
      cloudmail: {
        configured: Boolean(
          settings?.cloudmail?.baseUrl
          && settings?.cloudmail?.email
          && settings?.cloudmail?.domain
          && settings?.cloudmail?.passwordSet
        ),
        baseUrl: String(settings?.cloudmail?.baseUrl || ''),
        email: String(settings?.cloudmail?.email || ''),
        domain: String(settings?.cloudmail?.domain || ''),
        passwordSet: Boolean(settings?.cloudmail?.passwordSet),
      },
      cpa: {
        enabled: Boolean(settings?.cpa?.enabled),
        configured: Boolean(settings?.cpa?.baseUrl && settings?.cpa?.keySet),
        baseUrl: String(settings?.cpa?.baseUrl || ''),
        keySet: Boolean(settings?.cpa?.keySet),
        syncOnChange: Boolean(settings?.cpa?.syncOnChange),
      },
      manager: {
        configured: Boolean(manager),
        managerAccountId: Number(settings?.managerAccountId || 0),
        candidateCount: Array.isArray(managerCandidates) ? managerCandidates.length : 0,
        account: manager
          ? {
              id: Number(manager.id || 0),
              email: String(manager.email || ''),
              chatgptAccountId: String(manager.chatgptAccountId || ''),
            }
          : null,
        error: managerError,
      },
      oauth: {
        redirectUri: AUTO_TEAM_REDIRECT_URI,
        redirectPort: AUTO_TEAM_REDIRECT_PORT,
        redirectHost: AUTO_TEAM_REDIRECT_HOST,
      },
    })
  } catch (error) {
    console.error('[AutoTeam] get diagnostics failed:', error)
    return res.status(500).json({ error: error?.message || '获取 AutoTeam 诊断信息失败' })
  }
})

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAutoTeamAccountsList()
    return res.json({ accounts: accounts.map(sanitizeAutoTeamAccount) })
  } catch (error) {
    console.error('[AutoTeam] list accounts failed:', error)
    return res.status(500).json({ error: error?.message || '获取 AutoTeam 账号列表失败' })
  }
})

router.delete('/accounts/:id', async (req, res) => {
  try {
    const accountId = toInt(req.params.id, 0)
    if (!accountId) {
      return res.status(400).json({ error: '无效的账号 ID' })
    }
    const removed = await deleteAutoTeamAccountRecord(accountId)
    return res.json({ message: '账号已删除', account: sanitizeAutoTeamAccount(removed) })
  } catch (error) {
    console.error('[AutoTeam] delete account failed:', error)
    return res.status(400).json({ error: error?.message || '删除 AutoTeam 账号失败' })
  }
})

router.patch('/accounts/:id/status', async (req, res) => {
  try {
    const accountId = toInt(req.params.id, 0)
    const status = String(req.body?.status || '').trim().toLowerCase()
    if (!accountId) {
      return res.status(400).json({ error: '无效的账号 ID' })
    }
    if (!ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ error: '无效的账号状态' })
    }
    const account = await setAutoTeamAccountStatus(accountId, status)
    return res.json({ message: '账号状态已更新', account: sanitizeAutoTeamAccount(account) })
  } catch (error) {
    console.error('[AutoTeam] set account status failed:', error)
    return res.status(400).json({ error: error?.message || '更新账号状态失败' })
  }
})

router.get('/settings', async (req, res) => {
  try {
    const settings = await getAutoTeamSettings()
    return res.json(settings)
  } catch (error) {
    console.error('[AutoTeam] get settings failed:', error)
    return res.status(500).json({ error: error?.message || '获取 AutoTeam 设置失败' })
  }
})

router.put('/settings', async (req, res) => {
  try {
    const settings = await updateAutoTeamSettings(req.body || {})
    return res.json({ message: 'AutoTeam 设置已保存', settings })
  } catch (error) {
    console.error('[AutoTeam] update settings failed:', error)
    return res.status(400).json({ error: error?.message || '保存 AutoTeam 设置失败' })
  }
})

router.post('/test-cloudmail', async (req, res) => {
  try {
    const settings = await getAutoTeamSettings({ includeSecrets: true })
    const client = new AutoTeamCloudMailClient({
      baseUrl: settings.cloudmail.baseUrl,
      email: settings.cloudmail.email,
      password: settings.cloudmail.password,
      pollIntervalSeconds: settings.mailPolling.intervalSeconds,
      pollTimeoutSeconds: settings.mailPolling.timeoutSeconds,
    })
    await client.login()
    return res.json({
      ok: true,
      message: 'CloudMail 登录成功',
      cloudmail: {
        baseUrl: settings.cloudmail.baseUrl,
        email: settings.cloudmail.email,
        domain: settings.cloudmail.domain,
      }
    })
  } catch (error) {
    console.error('[AutoTeam] test cloudmail failed:', error)
    return res.status(400).json({
      ok: false,
      error: error?.message || 'CloudMail 测试失败'
    })
  }
})

router.post('/test-cpa', async (req, res) => {
  try {
    const result = await testAutoTeamCpaConnection()
    return res.json({
      ok: true,
      message: `CPA 连接成功，当前共有 ${Number(result.total || 0)} 个认证文件`,
      total: Number(result.total || 0),
      files: Array.isArray(result.files) ? result.files.map(item => ({
        name: String(item.name || ''),
        email: String(item.email || ''),
        size: item.size == null ? null : Number(item.size),
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
      })) : [],
    })
  } catch (error) {
    console.error('[AutoTeam] test cpa failed:', error)
    return res.status(400).json({
      ok: false,
      error: error?.message || 'CPA 测试失败'
    })
  }
})

router.get('/cpa/files', async (req, res) => {
  try {
    const result = await listAutoTeamCpaFiles()
    return res.json({
      total: Number(result.total || 0),
      files: (result.files || []).map(item => ({
        name: String(item.name || ''),
        email: String(item.email || ''),
        size: item.size == null ? null : Number(item.size),
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null,
      })),
    })
  } catch (error) {
    console.error('[AutoTeam] list cpa files failed:', error)
    return res.status(400).json({ error: error?.message || '获取 CPA 文件列表失败' })
  }
})

router.post('/cpa/sync', async (req, res) => {
  try {
    const result = await syncAutoTeamAccountsToCpa()
    return res.json({
      message: `CPA 同步完成：上传 ${Number(result.uploaded || 0)} 个，删除 ${Number(result.deleted || 0)} 个`,
      result,
    })
  } catch (error) {
    console.error('[AutoTeam] sync cpa failed:', error)
    return res.status(400).json({ error: error?.message || '同步到 CPA 失败' })
  }
})

router.get('/manager-candidates', async (req, res) => {
  try {
    const items = await getAutoTeamManagerCandidates()
    return res.json({ items })
  } catch (error) {
    console.error('[AutoTeam] get manager candidates failed:', error)
    return res.status(500).json({ error: error?.message || '获取管理员候选账号失败' })
  }
})

router.post('/manual-oauth/start', async (req, res) => {
  try {
    startAutoTeamOAuthCallbackServer()
    const session = createManualOAuthSession()
    return res.json(sanitizeManualSession(session))
  } catch (error) {
    console.error('[AutoTeam] start manual oauth failed:', error)
    return res.status(500).json({ error: error?.message || '启动手动 OAuth 失败' })
  }
})

router.get('/manual-oauth/:sessionId', async (req, res) => {
  try {
    const session = getManualOAuthSessionStatus(req.params.sessionId)
    if (!session) {
      return res.status(404).json({ error: 'OAuth 会话不存在或已过期' })
    }
    return res.json(sanitizeManualSession(session))
  } catch (error) {
    console.error('[AutoTeam] get manual oauth status failed:', error)
    return res.status(500).json({ error: error?.message || '获取 OAuth 会话状态失败' })
  }
})

router.delete('/manual-oauth/:sessionId', async (req, res) => {
  try {
    const deleted = cancelManualOAuthSession(req.params.sessionId)
    return res.json({ ok: deleted })
  } catch (error) {
    console.error('[AutoTeam] cancel manual oauth failed:', error)
    return res.status(500).json({ error: error?.message || '取消 OAuth 会话失败' })
  }
})

router.post('/manual-oauth/:sessionId/callback', async (req, res) => {
  try {
    const callbackUrl = String(req.body?.callbackUrl || req.body?.url || '').trim()
    if (!callbackUrl) {
      return res.status(400).json({ error: '缺少回调 URL' })
    }
    const session = submitManualOAuthCallback(req.params.sessionId, callbackUrl)
    return res.json(sanitizeManualSession(session))
  } catch (error) {
    console.error('[AutoTeam] submit manual oauth callback failed:', error)
    return res.status(400).json({ error: error?.message || '提交回调 URL 失败' })
  }
})

router.post('/manual-oauth/:sessionId/finalize', async (req, res) => {
  try {
    const password = String(req.body?.password || '').trim()
    const bundle = await finalizeManualOAuthSession(req.params.sessionId)
    const account = await importManualAutoTeamAccount({ bundle, password })
    const session = getManualOAuthSessionStatus(req.params.sessionId)
    return res.json({
      message: 'AutoTeam OAuth 导入完成',
      session: sanitizeManualSession(session),
      account: sanitizeAutoTeamAccount(account),
    })
  } catch (error) {
    console.error('[AutoTeam] finalize manual oauth failed:', error)
    return res.status(400).json({ error: error?.message || '完成 OAuth 导入失败' })
  }
})

router.post('/create', async (req, res) => {
  try {
    const account = await createNewAutoTeamAccount()
    return res.json({ message: 'AutoTeam 新账号创建成功', account: sanitizeAutoTeamAccount(account) })
  } catch (error) {
    console.error('[AutoTeam] create account failed:', error)
    return res.status(400).json({ error: error?.message || '创建 AutoTeam 账号失败' })
  }
})

router.post('/check', async (req, res) => {
  try {
    const thresholdPercent = req.body?.thresholdPercent
    const result = await checkAutoTeamAccounts({ thresholdPercent })
    return res.json({
      thresholdPercent: result.thresholdPercent,
      checkedCount: result.checkedCount,
      lowAccounts: (result.lowAccounts || []).map(sanitizeAutoTeamAccount),
      accounts: (result.accounts || []).map(sanitizeAutoTeamAccount),
    })
  } catch (error) {
    console.error('[AutoTeam] check accounts failed:', error)
    return res.status(400).json({ error: error?.message || '检查 AutoTeam 额度失败' })
  }
})

router.post('/rotate', async (req, res) => {
  try {
    const result = await rotateAutoTeamAccounts({
      targetSeats: req.body?.targetSeats,
      thresholdPercent: req.body?.thresholdPercent,
    })
    return res.json({
      targetSeats: result.targetSeats,
      thresholdPercent: result.thresholdPercent,
      workspaceUsers: result.workspaceUsers,
      removed: (result.removed || []).map(item => ({
        id: Number(item.id || 0),
        email: String(item.email || ''),
        removed: Boolean(item.removed),
        alreadyMissing: Boolean(item.alreadyMissing),
      })),
      reused: (result.reused || []).map(sanitizeAutoTeamAccount),
      created: (result.created || []).map(sanitizeAutoTeamAccount),
      check: {
        thresholdPercent: result.check?.thresholdPercent,
        checkedCount: result.check?.checkedCount,
        lowAccounts: (result.check?.lowAccounts || []).map(sanitizeAutoTeamAccount),
      },
      summary: result.summary,
    })
  } catch (error) {
    console.error('[AutoTeam] rotate accounts failed:', error)
    return res.status(400).json({ error: error?.message || '执行 AutoTeam 智能轮转失败' })
  }
})

export default router
