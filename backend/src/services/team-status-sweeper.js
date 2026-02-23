import axios from 'axios'
import { getDatabase, saveDatabase } from '../database/init.js'
import { fetchAccountUsersList, AccountSyncError } from './account-sync.js'

const LABEL = '[TeamStatusSweeper]'
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const CHECK_STATUS_ALLOWED_RANGE_DAYS = new Set([7, 15, 30])

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isEnabled = () => {
  const raw = String(process.env.TEAM_STATUS_SWEEPER_ENABLED ?? 'false').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const intervalSeconds = () => Math.max(60, toInt(process.env.TEAM_STATUS_SWEEPER_INTERVAL_SECONDS, 1800))
const initialDelayMs = () => Math.max(1000, toInt(process.env.TEAM_STATUS_SWEEPER_INITIAL_DELAY_MS, 20000))
const maxCheckAccounts = () => Math.max(10, toInt(process.env.TEAM_STATUS_SWEEPER_MAX_ACCOUNTS, 300))
const checkConcurrency = () => Math.max(1, Math.min(10, toInt(process.env.TEAM_STATUS_SWEEPER_CONCURRENCY, 3)))

const rangeDays = () => {
  const value = toInt(process.env.TEAM_STATUS_SWEEPER_RANGE_DAYS, 30)
  return CHECK_STATUS_ALLOWED_RANGE_DAYS.has(value) ? value : 30
}

const pad2 = (value) => String(value).padStart(2, '0')
const EXPIRE_AT_PARSE_REGEX = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const parseExpireAtToMs = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = raw.match(EXPIRE_AT_PARSE_REGEX)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] != null ? Number(match[6]) : 0

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null

  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

const eachWithConcurrency = async (items, concurrency, fn) => {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Number(concurrency) || 1)
  if (!list.length) return

  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }).map(async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = cursor++
      if (index >= list.length) break
      await fn(list[index], index)
    }
  })

  await Promise.all(workers)
}

const refreshAccessTokenWithRefreshToken = async (refreshToken) => {
  const normalized = String(refreshToken || '').trim()
  if (!normalized) {
    throw new AccountSyncError('该账号未配置 refresh token', 400)
  }

  const requestData = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CLIENT_ID,
    refresh_token: normalized,
    scope: 'openid profile email'
  }).toString()

  try {
    const response = await axios({
      method: 'POST',
      url: 'https://auth.openai.com/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': requestData.length
      },
      data: requestData,
      timeout: 60000
    })

    if (response.status !== 200 || !response.data?.access_token) {
      throw new AccountSyncError('刷新 token 失败，未返回有效凭证', 502)
    }

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token || normalized
    }
  } catch (error) {
    if (error?.response) {
      const message =
        error.response.data?.error?.message ||
        error.response.data?.error_description ||
        error.response.data?.error ||
        '刷新 token 失败'
      throw new AccountSyncError(message, 502)
    }
    throw new AccountSyncError(error?.message || '刷新 token 网络错误', 503)
  }
}

const persistAccountTokens = async (db, accountId, tokens) => {
  if (!tokens?.accessToken) return null
  const nextRefreshToken = tokens.refreshToken ? String(tokens.refreshToken).trim() : ''

  db.run(
    `UPDATE gpt_accounts SET token = ?, refresh_token = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
    [tokens.accessToken, nextRefreshToken || null, accountId]
  )
  await saveDatabase()
  return {
    accessToken: tokens.accessToken,
    refreshToken: nextRefreshToken || null
  }
}

const markAccountBanned = async (db, accountId) => {
  db.run(
    `
      UPDATE gpt_accounts
      SET is_open = 0,
          is_banned = 1,
          ban_processed = 0,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [accountId]
  )
  await saveDatabase()
}

const loadAccountsForStatusCheck = (db, { threshold, limit }) => {
  const countResult = db.exec(
    `SELECT COUNT(*) FROM gpt_accounts WHERE created_at >= DATETIME('now', 'localtime', ?) AND COALESCE(is_banned, 0) = 0`,
    [threshold]
  )
  const totalEligible = Number(countResult[0]?.values?.[0]?.[0] || 0)

  const dataResult = db.exec(
    `
      SELECT id,
             email,
             token,
             refresh_token,
             chatgpt_account_id,
             oai_device_id,
             expire_at,
             COALESCE(is_banned, 0) AS is_banned,
             created_at
      FROM gpt_accounts
      WHERE created_at >= DATETIME('now', 'localtime', ?)
        AND COALESCE(is_banned, 0) = 0
      ORDER BY created_at DESC
      LIMIT ?
    `,
    [threshold, limit]
  )

  const rows = dataResult[0]?.values || []
  const accounts = rows.map(row => ({
    id: Number(row[0]),
    email: String(row[1] || ''),
    token: row[2] || '',
    refreshToken: row[3] || null,
    chatgptAccountId: row[4] || '',
    oaiDeviceId: row[5] || '',
    expireAt: row[6] || null,
    isBanned: Boolean(row[7]),
    createdAt: row[8]
  }))

  const truncated = totalEligible > accounts.length
  const skipped = truncated ? Math.max(0, totalEligible - accounts.length) : 0

  return { totalEligible, accounts, truncated, skipped }
}

const checkSingleAccountStatus = async (db, account, nowMs) => {
  const base = {
    id: account.id,
    email: account.email,
    createdAt: account.createdAt,
    expireAt: account.expireAt || null,
    refreshed: false
  }

  if (account.isBanned) {
    return { ...base, status: 'banned', reason: null }
  }

  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (expireAtMs != null && expireAtMs < nowMs) {
    return { ...base, status: 'expired', reason: 'expireAt 已过期' }
  }

  try {
    await fetchAccountUsersList(account.id, {
      accountRecord: account,
      userListParams: { offset: 0, limit: 1, query: '' }
    })
    return { ...base, status: 'normal', reason: null }
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error || '')
    const status = Number(error?.status || 0)

    if (message.includes('account_deactivated') || message.includes('已自动标记为封号')) {
      try {
        await markAccountBanned(db, account.id)
      } catch (markError) {
        console.warn(`${LABEL} mark banned failed`, {
          accountId: account.id,
          message: markError?.message || String(markError)
        })
      }
      return { ...base, status: 'banned', reason: message || null }
    }

    if (status === 401) {
      const storedRefreshToken = String(account.refreshToken || '').trim()
      if (!storedRefreshToken) {
        const reason = message || 'Token 已过期或无效（未配置 refresh token）'
        return { ...base, status: 'expired', reason }
      }

      try {
        const refreshedTokens = await refreshAccessTokenWithRefreshToken(storedRefreshToken)
        const persisted = await persistAccountTokens(db, account.id, refreshedTokens)

        const nextAccount = {
          ...account,
          token: persisted?.accessToken || account.token,
          refreshToken: persisted?.refreshToken || account.refreshToken
        }

        try {
          await fetchAccountUsersList(account.id, {
            accountRecord: nextAccount,
            userListParams: { offset: 0, limit: 1, query: '' }
          })
          return {
            ...base,
            status: 'normal',
            refreshed: true,
            reason: 'Token 已过期，已使用 refresh token 自动刷新'
          }
        } catch (recheckError) {
          const reMsg = recheckError?.message ? String(recheckError.message) : String(recheckError || '')
          const reStatus = Number(recheckError?.status || 0)

          if (reMsg.includes('account_deactivated') || reMsg.includes('已自动标记为封号')) {
            try {
              await markAccountBanned(db, account.id)
            } catch (markError) {
              console.warn(`${LABEL} mark banned failed after refresh`, {
                accountId: account.id,
                message: markError?.message || String(markError)
              })
            }
            return { ...base, status: 'banned', refreshed: true, reason: reMsg || null }
          }
          if (reStatus === 401) {
            return { ...base, status: 'expired', refreshed: true, reason: reMsg || 'Token 已过期，已尝试刷新但仍无效' }
          }
          return { ...base, status: 'failed', refreshed: true, reason: reMsg || 'Token 已过期，已刷新但校验失败' }
        }
      } catch (refreshError) {
        const refreshMsg = refreshError?.message ? String(refreshError.message) : String(refreshError || '')
        const reason = refreshMsg
          ? `Token 已过期，refresh token 刷新失败：${refreshMsg}`
          : 'Token 已过期，refresh token 刷新失败'
        return { ...base, status: 'expired', reason }
      }
    }

    return { ...base, status: 'failed', reason: message || '检查失败' }
  }
}

export const startTeamStatusSweeper = () => {
  if (!isEnabled()) {
    console.log(`${LABEL} disabled`)
    return () => {}
  }

  let running = false
  const runOnce = async () => {
    if (running) return
    running = true

    try {
      const db = await getDatabase()
      const days = rangeDays()
      const threshold = `-${days} days`
      const { totalEligible, accounts, truncated, skipped } = loadAccountsForStatusCheck(db, {
        threshold,
        limit: maxCheckAccounts()
      })

      const summary = { normal: 0, expired: 0, banned: 0, failed: 0 }
      let refreshedCount = 0
      const nowMs = Date.now()

      await eachWithConcurrency(accounts, checkConcurrency(), async (account) => {
        const item = await checkSingleAccountStatus(db, account, nowMs)
        if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
          summary[item.status] += 1
        }
        if (item.refreshed) refreshedCount += 1
      })

      console.log(`${LABEL} run completed`, {
        rangeDays: days,
        totalEligible,
        checkedTotal: accounts.length,
        summary,
        refreshedCount,
        truncated,
        skipped
      })
    } catch (error) {
      console.error(`${LABEL} run failed`, { message: error?.message || String(error) })
    } finally {
      running = false
    }
  }

  const delay = initialDelayMs()
  const interval = intervalSeconds()

  const initialTimer = setTimeout(() => {
    void runOnce()
  }, delay)

  const intervalTimer = setInterval(() => {
    void runOnce()
  }, interval * 1000)

  console.log(`${LABEL} started`, {
    enabled: true,
    rangeDays: rangeDays(),
    intervalSeconds: interval,
    initialDelayMs: delay,
    concurrency: checkConcurrency(),
    maxAccounts: maxCheckAccounts()
  })

  return () => {
    clearTimeout(initialTimer)
    clearInterval(intervalTimer)
  }
}

