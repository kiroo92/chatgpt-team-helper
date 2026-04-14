import { getDatabase } from '../database/init.js'
import { fetchAccountInvites, fetchAccountUsersList, deleteAccountUser, inviteAccountUser } from './account-sync.js'
import { AutoTeamCloudMailClient } from './auto-team-cloudmail.js'
import { getAutoTeamSettings } from './auto-team-config.js'
import { syncAutoTeamCpaIfConfigured } from './auto-team-cpa.js'
import { AUTO_TEAM_STATUSES, createAutoTeamAccount, deleteAutoTeamAccount, getAutoTeamAccountByEmail, getAutoTeamAccountById, listAutoTeamAccounts, sortStandbyAccountsForReuse, updateAutoTeamAccount, upsertAutoTeamAccountByEmail } from './auto-team-db.js'
import { checkCodexQuota, refreshCodexAccessToken } from './auto-team-oauth.js'
import { loginCodexViaBrowser, registerWithInvite } from './auto-team-playwright.js'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const normalizeEmail = (value) => String(value || '').trim().toLowerCase()

const mapManagerRow = (row = []) => ({
  id: Number(row[0]),
  email: String(row[1] || ''),
  token: String(row[2] || ''),
  refreshToken: row[3] == null ? null : String(row[3]),
  chatgptAccountId: String(row[4] || ''),
  oaiDeviceId: row[5] == null ? null : String(row[5]),
  clientProfileKey: row[6] == null ? null : String(row[6]),
  clientUserAgent: row[7] == null ? null : String(row[7]),
  clientAcceptLanguage: row[8] == null ? null : String(row[8]),
  clientOaiLanguage: row[9] == null ? null : String(row[9]),
})

export async function getAutoTeamManagerAccount() {
  const db = await getDatabase()
  const settings = await getAutoTeamSettings({ db })
  const managerAccountId = Number(settings.managerAccountId || 0)
  if (!managerAccountId) {
    throw new Error('未配置 AutoTeam 工作区管理员账号，请先在设置中选择一个 GPT 账号')
  }

  const result = db.exec(`
    SELECT id, email, token, refresh_token, chatgpt_account_id, oai_device_id,
           client_profile_key, client_user_agent, client_accept_language, client_oai_language
      FROM gpt_accounts
     WHERE id = ?
     LIMIT 1
  `, [managerAccountId])
  const row = result[0]?.values?.[0]
  if (!row) {
    throw new Error('配置的 AutoTeam 工作区管理员账号不存在')
  }

  const account = mapManagerRow(row)
  if (!account.token || !account.chatgptAccountId) {
    throw new Error('配置的 AutoTeam 工作区管理员账号缺少 token 或 ChatGPT Workspace ID')
  }
  return account
}

const buildMailClient = async () => {
  const settings = await getAutoTeamSettings({ includeSecrets: true })
  const client = new AutoTeamCloudMailClient({
    baseUrl: settings.cloudmail.baseUrl,
    email: settings.cloudmail.email,
    password: settings.cloudmail.password,
    pollIntervalSeconds: settings.mailPolling.intervalSeconds,
    pollTimeoutSeconds: settings.mailPolling.timeoutSeconds,
  })
  await client.login()
  return client
}

const syncAutoTeamCpaAfterChange = async ({ reason = '', extraManagedEmails = [], force = false } = {}) => {
  return syncAutoTeamCpaIfConfigured({
    reason,
    extraManagedEmails,
    force,
  })
}

const ensureAutoTeamPoolAccount = async (email, patch = {}) => {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    throw new Error('AutoTeam 账号池写入失败：缺少邮箱')
  }

  const upserted = await upsertAutoTeamAccountByEmail(normalizedEmail, {
    ...patch,
    email: normalizedEmail,
  })
  if (upserted?.id) return upserted

  const existing = await getAutoTeamAccountByEmail(normalizedEmail)
  if (existing?.id) {
    const updated = await updateAutoTeamAccount(existing.id, patch)
    if (updated?.id) return updated
    return existing
  }

  const created = await createAutoTeamAccount({
    ...patch,
    email: normalizedEmail,
  })
  if (created?.id) return created

  const fetched = await getAutoTeamAccountByEmail(normalizedEmail)
  if (fetched?.id) return fetched

  throw new Error(`AutoTeam 账号池写入失败：${normalizedEmail}`)
}

const persistBundleToAutoTeamAccount = async (account, bundle, extra = {}) => {
  const nextStatus = extra.status || (bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : AUTO_TEAM_STATUSES.STANDBY)
  const authJson = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    idToken: bundle.idToken,
    accountId: bundle.accountId,
    email: bundle.email,
    planType: bundle.planType,
    expiresIn: bundle.expiresIn,
    organizationId: bundle.organizationId,
    organizationRole: bundle.organizationRole,
    organizationTitle: bundle.organizationTitle,
    organizations: bundle.organizations,
    refreshedAt: new Date().toISOString(),
  }

  return updateAutoTeamAccount(account.id, {
    email: bundle.email || account.email,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken || account.refreshToken,
    idToken: bundle.idToken,
    authJson,
    chatgptAccountId: bundle.accountId || account.chatgptAccountId,
    planType: bundle.planType || account.planType,
    status: nextStatus,
    lastActiveAt: nextStatus === AUTO_TEAM_STATUSES.ACTIVE ? Date.now() : account.lastActiveAt,
    lastError: extra.lastError ?? null,
    password: Object.prototype.hasOwnProperty.call(extra, 'password') ? extra.password : account.password,
    cloudmailAccountId: Object.prototype.hasOwnProperty.call(extra, 'cloudmailAccountId') ? extra.cloudmailAccountId : account.cloudmailAccountId,
  })
}

const applyQuotaInfo = async (account, quotaInfo, { status } = {}) => {
  return updateAutoTeamAccount(account.id, {
    quotaPrimaryPct: quotaInfo?.primaryPct ?? null,
    quotaPrimaryResetsAt: quotaInfo?.primaryResetsAt ?? null,
    quotaWeeklyPct: quotaInfo?.weeklyPct ?? null,
    quotaWeeklyResetsAt: quotaInfo?.weeklyResetsAt ?? null,
    status: status || account.status,
    quotaExhaustedAt: status === AUTO_TEAM_STATUSES.EXHAUSTED ? Date.now() : account.quotaExhaustedAt,
    lastError: null,
  })
}

const remainingPercentFromQuota = (account) => {
  if (account?.quotaPrimaryPct == null) return null
  return Math.max(0, 100 - Number(account.quotaPrimaryPct || 0))
}

const isQuotaRecovered = (account, thresholdPercent) => {
  const resetAt = Number(account?.quotaPrimaryResetsAt || 0)
  if (resetAt && resetAt * 1000 <= Date.now()) return true
  const remainingPercent = remainingPercentFromQuota(account)
  if (remainingPercent == null) return true
  return remainingPercent >= thresholdPercent
}

const listWorkspaceUsersByEmail = async (managerAccount, normalizedEmail) => {
  try {
    return await fetchAccountUsersList(managerAccount.id, {
      accountRecord: managerAccount,
      userListParams: { offset: 0, limit: 20, query: normalizedEmail }
    })
  } catch (error) {
    console.warn('[AutoTeam] 精确查询工作区成员失败，回退到首屏列表再过滤', {
      email: normalizedEmail,
      message: error?.message || String(error)
    })
    return fetchAccountUsersList(managerAccount.id, {
      accountRecord: managerAccount,
      userListParams: { offset: 0, limit: 100, query: '' }
    })
  }
}

const listWorkspaceInvitesByEmail = async (managerAccount, normalizedEmail) => {
  try {
    return await fetchAccountInvites(managerAccount.id, {
      accountRecord: managerAccount,
      inviteListParams: { offset: 0, limit: 20, query: normalizedEmail }
    })
  } catch (error) {
    console.warn('[AutoTeam] 精确查询工作区邀请失败，回退到首屏列表再过滤', {
      email: normalizedEmail,
      message: error?.message || String(error)
    })
    return fetchAccountInvites(managerAccount.id, {
      accountRecord: managerAccount,
      inviteListParams: { offset: 0, limit: 100, query: '' }
    })
  }
}

const findWorkspaceStateByEmail = async (managerAccount, email) => {
  const normalizedEmail = normalizeEmail(email)
  const users = await listWorkspaceUsersByEmail(managerAccount, normalizedEmail)
  const member = (users.items || []).find(item => normalizeEmail(item.email) === normalizedEmail) || null
  const invites = await listWorkspaceInvitesByEmail(managerAccount, normalizedEmail)
  const invite = (invites.items || []).find(item => normalizeEmail(item.email_address) === normalizedEmail) || null
  return { member, invite }
}

const ensureWorkspaceInvite = async (managerAccount, email) => {
  const state = await findWorkspaceStateByEmail(managerAccount, email)
  if (state.member) return { type: 'member', state }
  if (state.invite) return { type: 'invite', state }
  await inviteAccountUser(managerAccount.id, email, { accountRecord: managerAccount })
  return { type: 'invited', state: await findWorkspaceStateByEmail(managerAccount, email) }
}

const removeWorkspaceMemberByEmail = async (managerAccount, email) => {
  const state = await findWorkspaceStateByEmail(managerAccount, email)
  if (!state.member) return { removed: false, alreadyMissing: true }
  const userId = String(state.member.account_user_id || state.member.id || '').replace(/^user-/, '')
  await deleteAccountUser(managerAccount.id, userId, { accountRecord: managerAccount })
  return { removed: true }
}

export async function importManualAutoTeamAccount({ bundle, password = '' }) {
  const email = normalizeEmail(bundle?.email)
  if (!email) throw new Error('OAuth 结果缺少邮箱')
  const existing = await getAutoTeamAccountByEmail(email)
  const base = existing || await ensureAutoTeamPoolAccount(email, { status: AUTO_TEAM_STATUSES.STANDBY, password })
  const account = await persistBundleToAutoTeamAccount(base, bundle, {
    password,
    status: bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : AUTO_TEAM_STATUSES.STANDBY
  })
  await syncAutoTeamCpaAfterChange({ reason: 'manual_import' })
  return account
}

export async function deleteAutoTeamAccountRecord(accountId) {
  const account = await deleteAutoTeamAccount(accountId)
  if (!account) throw new Error('账号不存在')
  await syncAutoTeamCpaAfterChange({ reason: 'delete_account_record', extraManagedEmails: [account.email] })
  return account
}

async function refreshOrReloginAccount(account, { managerAccount, mailClient = null } = {}) {
  let current = account

  if (current.refreshToken) {
    try {
      const bundle = await refreshCodexAccessToken(current.refreshToken)
      current = await persistBundleToAutoTeamAccount(current, bundle, { status: current.status })
    } catch (error) {
      current = await updateAutoTeamAccount(current.id, {
        accessToken: null,
        idToken: null,
        lastError: error?.message || String(error)
      })
    }
  }

  if (current.accessToken) return current

  if (current.password || current.cloudmailAccountId) {
    const bundle = await loginCodexViaBrowser({
      email: current.email,
      password: current.password || '',
      mailClient,
      workspaceAccountId: managerAccount.chatgptAccountId,
    })
    current = await persistBundleToAutoTeamAccount(current, bundle, {
      status: bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : current.status,
    })
  }

  return current
}

export async function checkAutoTeamAccounts(options = {}) {
  const settings = await getAutoTeamSettings()
  const managerAccount = options.managerAccount || await getAutoTeamManagerAccount()
  const thresholdPercent = Math.max(1, Number(options.thresholdPercent || settings.autoCheck.thresholdPercent || 10))
  const shouldSyncCpa = options.syncCpa !== false
  const accounts = await listAutoTeamAccounts()
  const activeAccounts = accounts.filter(account => account.status === AUTO_TEAM_STATUSES.ACTIVE)

  let mailClient = options.mailClient || null
  const lowAccounts = []
  const checkedAccounts = []

  for (const originalAccount of activeAccounts) {
    let account = originalAccount
    try {
      if (!account.accessToken) {
        if (!mailClient) {
          try { mailClient = await buildMailClient() } catch { mailClient = null }
        }
        account = await refreshOrReloginAccount(account, { managerAccount, mailClient })
      }

      if (!account.accessToken) {
        account = await updateAutoTeamAccount(account.id, { lastError: '缺少可用 access token，无法检查额度' })
        checkedAccounts.push(account)
        continue
      }

      let quotaResult = await checkCodexQuota(account.accessToken, account.chatgptAccountId || managerAccount.chatgptAccountId)
      if (quotaResult.status === 'auth_error' && (account.refreshToken || account.password || account.cloudmailAccountId)) {
        if (!mailClient) {
          try { mailClient = await buildMailClient() } catch { mailClient = null }
        }
        account = await updateAutoTeamAccount(account.id, {
          accessToken: null,
          idToken: null,
          lastError: 'access token 已失效，准备自动重新登录'
        })
        account = await refreshOrReloginAccount(account, { managerAccount, mailClient })
        if (account.accessToken) {
          quotaResult = await checkCodexQuota(account.accessToken, account.chatgptAccountId || managerAccount.chatgptAccountId)
        }
      }

      if (quotaResult.status === 'ok' && quotaResult.info) {
        const remaining = Math.max(0, 100 - Number(quotaResult.info.primaryPct || 0))
        const nextStatus = remaining < thresholdPercent ? AUTO_TEAM_STATUSES.EXHAUSTED : AUTO_TEAM_STATUSES.ACTIVE
        account = await applyQuotaInfo(account, quotaResult.info, { status: nextStatus })
        if (nextStatus === AUTO_TEAM_STATUSES.EXHAUSTED) {
          lowAccounts.push({ ...account, remainingPercent: remaining })
        }
      } else if (quotaResult.status === 'exhausted' && quotaResult.info) {
        account = await applyQuotaInfo(account, quotaResult.info, { status: AUTO_TEAM_STATUSES.EXHAUSTED })
        lowAccounts.push({ ...account, remainingPercent: 0 })
      } else {
        account = await updateAutoTeamAccount(account.id, { lastError: '额度检查失败，鉴权可能已过期' })
      }

      checkedAccounts.push(account)
    } catch (error) {
      account = await updateAutoTeamAccount(account.id, { lastError: error?.message || String(error) })
      checkedAccounts.push(account)
    }
  }

  const result = {
    thresholdPercent,
    checkedCount: checkedAccounts.length,
    lowAccounts,
    accounts: checkedAccounts,
  }
  if (shouldSyncCpa) {
    await syncAutoTeamCpaAfterChange({ reason: 'check_accounts' })
  }
  return result
}

async function waitForInviteLink(mailClient, email, timeoutSeconds) {
  const emailData = await mailClient.waitForEmail(email, {
    timeoutSeconds,
    predicate: (item) => {
      const subject = String(item?.subject || '').toLowerCase()
      const text = String(item?.text || item?.content || '').toLowerCase()
      return subject.includes('invite') || subject.includes('invited') || text.includes('chatgpt.com/auth/login?')
    }
  })

  const link = mailClient.extractInviteLink(emailData)
  if (!link) {
    throw new Error('未能从邀请邮件中提取注册链接')
  }
  return link
}

const sortPendingAccountsForRetry = (accounts = []) => {
  const toTime = (value) => {
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : 0
  }

  return [...accounts].sort((a, b) => {
    const timeDiff = toTime(b.updatedAt || b.createdAt) - toTime(a.updatedAt || a.createdAt)
    if (timeDiff !== 0) return timeDiff
    return Number(b.id || 0) - Number(a.id || 0)
  })
}

async function findReusablePendingAutoTeamAccount() {
  const accounts = await listAutoTeamAccounts()
  return sortPendingAccountsForRetry(accounts).find(account =>
    account.status === AUTO_TEAM_STATUSES.PENDING
    && account.email
    && account.cloudmailAccountId
    && !account.accessToken
  ) || null
}

async function findExistingInviteLink(mailClient, email) {
  const emails = await mailClient.searchEmailsByRecipient(email, { size: 20 })
  for (const item of emails) {
    const subject = String(item?.subject || '').toLowerCase()
    const text = String(item?.text || item?.content || '').toLowerCase()
    if (!subject.includes('invite') && !subject.includes('invited') && !text.includes('chatgpt.com/auth/login?')) {
      continue
    }
    const link = mailClient.extractInviteLink(item)
    if (link) {
      return link
    }
  }
  return ''
}

export async function createNewAutoTeamAccount(options = {}) {
  const settings = await getAutoTeamSettings({ includeSecrets: true })
  const managerAccount = options.managerAccount || await getAutoTeamManagerAccount()
  const mailClient = options.mailClient || await buildMailClient()
  const domain = String(settings.cloudmail.domain || '').trim()
  if (!domain) throw new Error('CloudMail 域名未配置')

  const reusablePendingAccount = options.reusePending === false ? null : await findReusablePendingAutoTeamAccount()
  const createdMailbox = reusablePendingAccount
    ? {
        email: reusablePendingAccount.email,
        accountId: reusablePendingAccount.cloudmailAccountId,
      }
    : await mailClient.createTempEmail({ domain })

  let account = reusablePendingAccount
    ? await updateAutoTeamAccount(reusablePendingAccount.id, {
        status: AUTO_TEAM_STATUSES.PENDING,
        lastError: null,
      })
    : await ensureAutoTeamPoolAccount(createdMailbox.email, {
        email: createdMailbox.email,
        password: '',
        cloudmailAccountId: createdMailbox.accountId,
        status: AUTO_TEAM_STATUSES.PENDING,
        lastError: null,
      })

  try {
    let loginFailureMessage = ''
    if (account.password) {
      try {
        const bundle = await loginCodexViaBrowser({
          email: createdMailbox.email,
          password: account.password,
          mailClient,
          workspaceAccountId: managerAccount.chatgptAccountId,
        })

        const savedAccount = await persistBundleToAutoTeamAccount(account, bundle, {
          password: account.password,
          cloudmailAccountId: createdMailbox.accountId,
          status: bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : AUTO_TEAM_STATUSES.PENDING,
          lastError: null,
        })
        await syncAutoTeamCpaAfterChange({ reason: 'reuse_pending_account_login' })
        return savedAccount
      } catch (error) {
        loginFailureMessage = error?.message || String(error)
      }
    }

    let inviteLink = await findExistingInviteLink(mailClient, createdMailbox.email)
    if (!inviteLink && !reusablePendingAccount) {
      await mailClient.deleteEmailsFor(createdMailbox.email).catch(() => 0)
    }
    if (!inviteLink) {
      await ensureWorkspaceInvite(managerAccount, createdMailbox.email)
      inviteLink = await waitForInviteLink(mailClient, createdMailbox.email, settings.mailPolling.timeoutSeconds)
    }

    const registration = await registerWithInvite({
      inviteLink,
      email: createdMailbox.email,
      mailClient,
      password: account.password || '',
      timeoutSeconds: settings.mailPolling.timeoutSeconds,
    })

    account = await ensureAutoTeamPoolAccount(createdMailbox.email, {
      password: registration.password,
      status: AUTO_TEAM_STATUSES.PENDING,
      lastError: null,
    })

    const bundle = await loginCodexViaBrowser({
      email: createdMailbox.email,
      password: registration.password,
      mailClient,
      workspaceAccountId: managerAccount.chatgptAccountId,
    })

    const savedAccount = await persistBundleToAutoTeamAccount(account, bundle, {
      password: registration.password,
      cloudmailAccountId: createdMailbox.accountId,
      status: bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : AUTO_TEAM_STATUSES.PENDING,
    })
    await syncAutoTeamCpaAfterChange({ reason: 'create_account' })
    return savedAccount
  } catch (error) {
    const baseMessage = error?.message || String(error)
    const lastErrorMessage = baseMessage
    const fallbackAccount = account?.id
      ? account
      : await getAutoTeamAccountByEmail(createdMailbox.email).catch(() => null)
    if (fallbackAccount?.id) {
      await updateAutoTeamAccount(fallbackAccount.id, {
        status: AUTO_TEAM_STATUSES.PENDING,
        lastError: lastErrorMessage,
      })
    }
    throw error
  }
}

async function reuseStandbyAccount(account, { managerAccount, mailClient }) {
  await ensureWorkspaceInvite(managerAccount, account.email)
  const bundle = await loginCodexViaBrowser({
    email: account.email,
    password: account.password || '',
    mailClient,
    workspaceAccountId: managerAccount.chatgptAccountId,
  })
  return persistBundleToAutoTeamAccount(account, bundle, {
    status: bundle.planType === 'team' ? AUTO_TEAM_STATUSES.ACTIVE : AUTO_TEAM_STATUSES.PENDING,
  })
}

export async function getAutoTeamSummary() {
  const settings = await getAutoTeamSettings()
  const accounts = await listAutoTeamAccounts()
  const summary = {
    total: accounts.length,
    active: accounts.filter(item => item.status === AUTO_TEAM_STATUSES.ACTIVE).length,
    standby: accounts.filter(item => item.status === AUTO_TEAM_STATUSES.STANDBY).length,
    exhausted: accounts.filter(item => item.status === AUTO_TEAM_STATUSES.EXHAUSTED).length,
    pending: accounts.filter(item => item.status === AUTO_TEAM_STATUSES.PENDING).length,
    targetSeats: Number(settings.targetSeats || 0),
    enabled: Boolean(settings.enabled),
  }

  try {
    const managerAccount = await getAutoTeamManagerAccount()
    const workspaceUsers = await fetchAccountUsersList(managerAccount.id, {
      accountRecord: managerAccount,
      userListParams: { offset: 0, limit: 1, query: '' }
    })
    summary.workspaceUsers = Number(workspaceUsers.total || 0)
    summary.workspaceManager = {
      id: managerAccount.id,
      email: managerAccount.email,
      chatgptAccountId: managerAccount.chatgptAccountId,
    }
  } catch (error) {
    summary.workspaceUsers = null
    summary.workspaceError = error?.message || String(error)
    summary.workspaceManager = null
  }

  return summary
}

export async function rotateAutoTeamAccounts(options = {}) {
  const settings = await getAutoTeamSettings({ includeSecrets: true })
  const managerAccount = options.managerAccount || await getAutoTeamManagerAccount()
  const targetSeats = Math.max(1, Number(options.targetSeats || settings.targetSeats || 5))
  const thresholdPercent = Math.max(1, Number(options.thresholdPercent || settings.autoCheck.thresholdPercent || 10))
  const mailClient = options.mailClient || await buildMailClient()

  const checkResult = await checkAutoTeamAccounts({
    managerAccount,
    mailClient,
    thresholdPercent,
    syncCpa: false,
  })

  const allAccounts = await listAutoTeamAccounts()
  const exhaustedAccounts = allAccounts.filter(account => account.status === AUTO_TEAM_STATUSES.EXHAUSTED)
  const removed = []
  for (const account of exhaustedAccounts) {
    try {
      const outcome = await removeWorkspaceMemberByEmail(managerAccount, account.email)
      await updateAutoTeamAccount(account.id, {
        status: AUTO_TEAM_STATUSES.STANDBY,
        lastError: null,
      })
      removed.push({ id: account.id, email: account.email, ...outcome })
    } catch (error) {
      await updateAutoTeamAccount(account.id, { lastError: error?.message || String(error) })
    }
  }

  const workspaceUsers = await fetchAccountUsersList(managerAccount.id, {
    accountRecord: managerAccount,
    userListParams: { offset: 0, limit: 1, query: '' }
  })
  let currentCount = Number(workspaceUsers.total || 0)
  let vacancies = Math.max(0, targetSeats - currentCount)

  const reused = []
  const created = []

  if (vacancies > 0) {
    const standbyAccounts = sortStandbyAccountsForReuse((await listAutoTeamAccounts()).filter(account => account.status === AUTO_TEAM_STATUSES.STANDBY))
    for (const account of standbyAccounts) {
      if (vacancies <= 0) break
      if (!isQuotaRecovered(account, thresholdPercent)) continue
      try {
        const updated = await reuseStandbyAccount(account, { managerAccount, mailClient })
        reused.push(updated)
        vacancies -= 1
        currentCount += 1
      } catch (error) {
        await updateAutoTeamAccount(account.id, { lastError: error?.message || String(error) })
      }
    }
  }

  while (vacancies > 0) {
    const createdAccount = await createNewAutoTeamAccount({ managerAccount, mailClient })
    created.push(createdAccount)
    vacancies -= 1
    currentCount += 1
    await sleep(1000)
  }

  const result = {
    targetSeats,
    thresholdPercent,
    workspaceUsers: currentCount,
    removed,
    reused,
    created,
    check: checkResult,
    summary: await getAutoTeamSummary(),
  }
  await syncAutoTeamCpaAfterChange({ reason: 'rotate_accounts' })
  return result
}

export async function getAutoTeamAccountsList() {
  return listAutoTeamAccounts()
}

export async function setAutoTeamAccountStatus(accountId, status) {
  const account = await getAutoTeamAccountById(accountId)
  if (!account) throw new Error('账号不存在')
  const updated = await updateAutoTeamAccount(account.id, { status })
  await syncAutoTeamCpaAfterChange({ reason: 'set_account_status' })
  return updated
}
