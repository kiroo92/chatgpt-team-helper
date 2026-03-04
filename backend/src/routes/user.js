import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu, requireSuperAdmin } from '../middleware/rbac.js'
import { getAdminMenuTreeForAccessContext, getUserAccessContext } from '../services/rbac.js'
import { withLocks } from '../utils/locks.js'
import { redeemCodeInternal } from './redemption-codes.js'
import { fetchAccountUsersList } from '../services/account-sync.js'
import { inviteUserToChatGPTTeam } from '../services/chatgpt-invite.js'
import { getPointsWithdrawSettings } from '../utils/points-withdraw-settings.js'
import { listUserPointsLedger, safeInsertPointsLedgerEntry } from '../utils/points-ledger.js'

const router = express.Router()

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const generateInviteCode = (length = 10) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(crypto.randomInt(0, chars.length))
  }
  return result
}

// Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec('SELECT id, username, email, COALESCE(invite_enabled, 1) FROM users WHERE id = ?', [req.user.id])

    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: result[0].values[0][0],
      username: result[0].values[0][1],
      email: result[0].values[0][2],
      inviteEnabled: Number(result[0].values[0][3] ?? 1) !== 0,
    }

    const access = await getUserAccessContext(req.user.id, db)
    const adminMenus = await getAdminMenuTreeForAccessContext(access, db)
    res.json({
      ...user,
      roles: access.roles,
      menus: access.menus,
      adminMenus,
    })
  } catch (error) {
    console.error('Get user error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/invite-code', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      'SELECT invite_code, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!result[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteEnabled = Number(result[0].values[0][1] ?? 1) !== 0
    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const inviteCode = result[0].values[0][0] || null
    res.json({ inviteCode: inviteCode || null })
  } catch (error) {
    console.error('Get invite code error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/invite-code', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      'SELECT invite_code, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!result[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteEnabled = Number(result[0].values[0][1] ?? 1) !== 0
    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const existing = result[0].values[0][0] || null
    if (existing) {
      return res.json({ inviteCode: existing })
    }

    let inviteCode = null
    for (let i = 0; i < 10; i++) {
      const candidate = generateInviteCode(10)
      const check = db.exec('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [candidate])
      if (!check[0]?.values?.length) {
        inviteCode = candidate
        break
      }
    }

    if (!inviteCode) {
      return res.status(500).json({ error: '生成邀请码失败，请重试' })
    }

    db.run('UPDATE users SET invite_code = ? WHERE id = ?', [inviteCode, req.user.id])
    saveDatabase()

    res.json({ inviteCode })
  } catch (error) {
    console.error('Generate invite code error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/invite-summary', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()

    const userResult = db.exec(
      'SELECT invite_code, COALESCE(points, 0), COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!userResult[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteCode = userResult[0].values[0][0] || null
    const points = Number(userResult[0].values[0][1] || 0)
    const inviteEnabled = Number(userResult[0].values[0][2] ?? 1) !== 0

    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const invitedCountResult = db.exec(
      'SELECT COUNT(*) FROM users WHERE invited_by_user_id = ?',
      [req.user.id]
    )
    const invitedCount = Number(invitedCountResult[0]?.values?.[0]?.[0] || 0)

    res.json({
      inviteCode,
      points,
      invitedCount
    })
  } catch (error) {
    console.error('Get invite summary error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const TEAM_SEAT_COST_POINTS = Math.max(1, toInt(process.env.TEAM_SEAT_COST_POINTS, 10))
const INVITE_UNLOCK_COST_POINTS = Math.max(1, toInt(process.env.INVITE_UNLOCK_COST_POINTS, 15))
const ACCOUNT_RECOVERY_WINDOW_DAYS = Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_WINDOW_DAYS, 30))

const WITHDRAW_MAX_POINTS_PER_REQUEST = Math.max(0, toInt(process.env.WITHDRAW_MAX_POINTS_PER_REQUEST, 500))
const WITHDRAW_DAILY_MAX_POINTS = Math.max(0, toInt(process.env.WITHDRAW_DAILY_MAX_POINTS, 500))
const WITHDRAW_DAILY_MAX_REQUESTS = Math.max(0, toInt(process.env.WITHDRAW_DAILY_MAX_REQUESTS, 3))
const WITHDRAW_MAX_PENDING = Math.max(0, toInt(process.env.WITHDRAW_MAX_PENDING, 1))
const WITHDRAW_COOLDOWN_SECONDS = Math.max(0, toInt(process.env.WITHDRAW_COOLDOWN_SECONDS, 60))

const toCashCentsFromPoints = (points, withdrawSettings) => {
  const normalized = Number(points)
  if (!Number.isFinite(normalized) || normalized <= 0) return 0
  const ratePoints = Math.max(1, Number(withdrawSettings?.ratePoints) || 1)
  const rateCashCents = Math.max(0, Number(withdrawSettings?.rateCashCents) || 0)
  if (rateCashCents <= 0) return 0
  return Math.round((normalized * rateCashCents) / ratePoints)
}

const formatCashAmount = (cashCents) => {
  const normalized = Number(cashCents)
  if (!Number.isFinite(normalized) || normalized <= 0) return '0.00'
  const yuan = Math.round(normalized) / 100
  return yuan.toFixed(2)
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const extractEmailFromRedeemedBy = (redeemedBy) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''

  const match = raw.match(/email\s*:\s*([^|]+)(?:\||$)/i)
  if (match?.[1]) {
    const candidate = String(match[1]).trim().toLowerCase()
    return EMAIL_REGEX.test(candidate) ? candidate : ''
  }

  const normalized = raw.toLowerCase()
  return EMAIL_REGEX.test(normalized) ? normalized : ''
}

const parseTimeMs = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return Number.isNaN(parsed) ? null : parsed
}

const plusDaysIso = (value, days) => {
  const baseMs = parseTimeMs(value)
  if (baseMs == null) return null
  const plus = baseMs + Math.max(1, Number(days) || 1) * 24 * 60 * 60 * 1000
  const d = new Date(plus)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const isUserCodeOwned = (db, userId, originalCodeId) => {
  const result = db.exec(
    `
      SELECT 1
      FROM points_ledger
      WHERE user_id = ?
        AND action = 'redeem_team_seat'
        AND ref_type = 'redemption_code'
        AND ref_id = ?
      LIMIT 1
    `,
    [userId, String(originalCodeId)]
  )
  return Boolean(result[0]?.values?.length)
}

const insertRecoveryLog = (db, payload = {}) => {
  db.run(
    `
      INSERT INTO account_recovery_logs (
        email,
        original_code_id,
        original_redeemed_at,
        original_account_email,
        recovery_mode,
        recovery_code_id,
        recovery_code,
        recovery_account_email,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [
      payload.email || null,
      payload.originalCodeId || null,
      payload.originalRedeemedAt || null,
      payload.originalAccountEmail || null,
      payload.recoveryMode || null,
      payload.recoveryCodeId || null,
      payload.recoveryCode || null,
      payload.recoveryAccountEmail || null,
      payload.status || 'pending',
      payload.errorMessage || null,
    ]
  )
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

const isBoundAccountRedeemable = (row, nowMs = Date.now()) => {
  if (!row) return false
  const isOpen = Number(row[1] || 0) === 1
  const isBanned = Number(row[2] || 0) === 1
  const token = String(row[3] ?? '').trim()
  const chatgptAccountId = String(row[4] ?? '').trim()
  const expireAtMs = parseExpireAtToMs(row[5])
  return isOpen && !isBanned && Boolean(token) && Boolean(chatgptAccountId) && expireAtMs != null && expireAtMs >= nowMs
}

const SEAT_TYPE_UNDEMOTED = 'undemoted'
const SEAT_TYPE_DEMOTED = 'demoted'

const getTodayCommonCodeCount = (db) => {
  const result = db.exec(
    `
      SELECT COUNT(*)
      FROM redemption_codes rc
      JOIN gpt_accounts ga ON lower(ga.email) = lower(rc.account_email)
      WHERE rc.is_redeemed = 0
        AND rc.channel = 'common'
        AND DATE(rc.created_at) = DATE('now', 'localtime')
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
    `
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

const pickTodayCommonCode = (db) => {
  const row = db.exec(
    `
      SELECT rc.code
      FROM redemption_codes rc
      JOIN gpt_accounts ga ON lower(ga.email) = lower(rc.account_email)
      WHERE rc.is_redeemed = 0
        AND rc.channel = 'common'
        AND DATE(rc.created_at) = DATE('now', 'localtime')
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
      ORDER BY rc.created_at ASC
      LIMIT 1
    `
  )[0]?.values?.[0]

  if (!row?.[0]) return ''
  return String(row[0]).trim().toUpperCase()
}

// 不受日期限制，获取任意可用的兑换码
const pickAvailableCode = (db) => {
  const rows = db.exec(
    `
      SELECT rc.code,
             COALESCE(ga.is_open, 0) AS is_open,
             COALESCE(ga.is_banned, 0) AS is_banned,
             ga.token,
             ga.chatgpt_account_id,
             ga.expire_at
      FROM redemption_codes rc
      JOIN gpt_accounts ga ON lower(ga.email) = lower(rc.account_email)
      WHERE rc.is_redeemed = 0
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
      ORDER BY rc.created_at ASC
      LIMIT 200
    `
  )[0]?.values || []

  const nowMs = Date.now()
  for (const row of rows) {
    if (!row?.[0]) continue
    if (!isBoundAccountRedeemable(row, nowMs)) continue
    return String(row[0]).trim().toUpperCase()
  }
  return ''
}

// 获取所有可用兑换码数量（不受日期限制）
const getAvailableCodeCount = (db) => {
  const rows = db.exec(
    `
      SELECT rc.code,
             COALESCE(ga.is_open, 0) AS is_open,
             COALESCE(ga.is_banned, 0) AS is_banned,
             ga.token,
             ga.chatgpt_account_id,
             ga.expire_at
      FROM redemption_codes rc
      JOIN gpt_accounts ga ON lower(ga.email) = lower(rc.account_email)
      WHERE rc.is_redeemed = 0
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
    `
  )[0]?.values || []

  const nowMs = Date.now()
  let count = 0
  for (const row of rows) {
    if (isBoundAccountRedeemable(row, nowMs)) count += 1
  }
  return count
}

router.get('/points/meta', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const db = await getDatabase()
    const userResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userResult[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const points = Number(userResult[0].values[0][0] || 0)
    const remaining = getAvailableCodeCount(db)
    const withdrawSettings = await getPointsWithdrawSettings(db)

    res.json({
      points,
      seat: {
        costPoints: TEAM_SEAT_COST_POINTS,
        remaining,
      },
      withdraw: {
        enabled: true,
        rate: {
          points: withdrawSettings.ratePoints,
          cashCents: withdrawSettings.rateCashCents,
        },
        minPoints: withdrawSettings.minPoints,
        stepPoints: withdrawSettings.stepPoints,
        maxPointsPerRequest: WITHDRAW_MAX_POINTS_PER_REQUEST,
        dailyMaxPoints: WITHDRAW_DAILY_MAX_POINTS,
        dailyMaxRequests: WITHDRAW_DAILY_MAX_REQUESTS,
        maxPending: WITHDRAW_MAX_PENDING,
        cooldownSeconds: WITHDRAW_COOLDOWN_SECONDS,
      }
    })
  } catch (error) {
    console.error('Get points meta error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/redeem/invite', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const result = await withLocks([`points:redeem-invite`, `points:user:${userId}`], async () => {
      const db = await getDatabase()
      const userResult = db.exec(
        'SELECT COALESCE(points, 0), COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
        [userId]
      )
      const row = userResult[0]?.values?.[0]
      if (!row) {
        return { ok: false, status: 404, error: 'User not found' }
      }

      const points = Number(row[0] || 0)
      const inviteEnabled = Number(row[1] ?? 1) !== 0

      if (inviteEnabled) {
        return { ok: false, status: 409, error: '已拥有邀请权限，无需兑换' }
      }

      if (points < INVITE_UNLOCK_COST_POINTS) {
        return { ok: false, status: 409, error: `积分不足（需要 ${INVITE_UNLOCK_COST_POINTS} 积分）` }
      }

      db.run(
        'UPDATE users SET points = COALESCE(points, 0) - ?, invite_enabled = 1 WHERE id = ?',
        [INVITE_UNLOCK_COST_POINTS, userId]
      )
      safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints: -INVITE_UNLOCK_COST_POINTS,
        pointsBefore: points,
        pointsAfter: points - INVITE_UNLOCK_COST_POINTS,
        action: 'redeem_invite_unlock',
        remark: '开通邀请权限'
      })
      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)
      return { ok: true, points: pointsAfter }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '兑换失败' })
    }

    res.json({
      message: '邀请权限已开通',
      points: result.points,
      invite: {
        enabled: true,
        costPoints: INVITE_UNLOCK_COST_POINTS,
      }
    })
  } catch (error) {
    console.error('Redeem invite unlock error:', error)
    const statusCode = Number(error?.statusCode || error?.status || 0)
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({ error: error?.message || '兑换失败' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/redeem/team', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  // 支持单个 email 或批量 emails 数组
  const requestedEmail = String(req.body?.email || '').trim()
  const requestedEmails = Array.isArray(req.body?.emails) ? req.body.emails : []
  
  // 合并所有邮箱，去重去空
  const allEmails = [...new Set(
    [requestedEmail, ...requestedEmails]
      .map(e => String(e || '').trim().toLowerCase())
      .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  )]

  if (allEmails.length === 0) {
    return res.status(400).json({ error: '请输入有效的邮箱地址' })
  }

  const totalCost = TEAM_SEAT_COST_POINTS * allEmails.length

  try {
    const result = await withLocks([`points:redeem-team`, `points:user:${userId}`], async () => {
      const db = await getDatabase()
      const userResult = db.exec(
        'SELECT email, COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1',
        [userId]
      )
      const userRow = userResult[0]?.values?.[0]
      if (!userRow) {
        return { ok: false, status: 404, error: 'User not found' }
      }

      let currentPoints = Number(userRow[1] || 0)

      if (currentPoints < totalCost) {
        return { ok: false, status: 409, error: `积分不足（需要 ${totalCost} 积分，当前 ${currentPoints} 积分）` }
      }

      const results = []
      const errors = []

      for (const email of allEmails) {
        const code = pickAvailableCode(db)
        if (!code) {
          errors.push({ email, error: '无可用兑换码' })
          continue
        }

        try {
          const redemption = await redeemCodeInternal({
            email,
            code,
            channel: 'common',
            skipCodeFormatValidation: true
          })

          db.run('UPDATE users SET points = COALESCE(points, 0) - ? WHERE id = ?', [TEAM_SEAT_COST_POINTS, userId])
          const pointsBefore = currentPoints
          currentPoints -= TEAM_SEAT_COST_POINTS
          
          safeInsertPointsLedgerEntry(db, {
            userId,
            deltaPoints: -TEAM_SEAT_COST_POINTS,
            pointsBefore,
            pointsAfter: currentPoints,
            action: 'redeem_team_seat',
            refType: 'redemption_code',
            refId: redemption?.metadata?.codeId ?? null,
            remark: `兑换 ChatGPT Team 名额`
          })

          results.push({ email, success: true, redemption })
        } catch (err) {
          errors.push({ email, error: err?.message || '兑换失败' })
        }
      }

      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)

      const remaining = getAvailableCodeCount(db)
      return { ok: true, results, errors, points: pointsAfter, remaining }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '兑换失败' })
    }

    const successCount = result.results.length
    const failCount = result.errors.length
    let message = `兑换成功 ${successCount} 个`
    if (failCount > 0) {
      message += `，失败 ${failCount} 个`
    }

    res.json({
      message,
      points: result.points,
      seat: {
        costPoints: TEAM_SEAT_COST_POINTS,
        remaining: result.remaining,
      },
      results: result.results,
      errors: result.errors,
      redemption: result.results[0]?.redemption // 向后兼容单个兑换
    })
  } catch (error) {
    console.error('Redeem team seat error:', error)
    const statusCode = Number(error?.statusCode || error?.status || 0)
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({ error: error?.message || '兑换失败' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/withdrawals', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const db = await getDatabase()
    const limit = Math.min(50, Math.max(1, toInt(req.query.limit, 20)))

    const result = db.exec(
      `
        SELECT id, points, cash_amount, method, payout_account, status, remark, created_at, updated_at, processed_at
        FROM points_withdrawals
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [userId, limit]
    )

    const rows = result[0]?.values || []
    res.json({
      withdrawals: rows.map(row => ({
        id: row[0],
        points: Number(row[1] || 0),
        cashAmount: row[2] || null,
        method: row[3],
        payoutAccount: row[4],
        status: row[5] || 'pending',
        remark: row[6] || null,
        createdAt: row[7],
        updatedAt: row[8],
        processedAt: row[9] || null,
      }))
    })
  } catch (error) {
    console.error('List withdrawals error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  const pointsRaw = req.body?.points
  const pointsText = String(pointsRaw ?? '').trim()
  if (!/^[0-9]{1,9}$/.test(pointsText)) {
    return res.status(400).json({ error: '请输入有效的提现积分' })
  }

  const pointsToWithdraw = toInt(pointsText, 0)
  const method = String(req.body?.method || '').trim().toLowerCase()
  const payoutAccount = String(req.body?.payoutAccount || req.body?.account || '').trim()

  if (pointsToWithdraw <= 0) {
    return res.status(400).json({ error: '请输入有效的提现积分' })
  }
  if (WITHDRAW_MAX_POINTS_PER_REQUEST > 0 && pointsToWithdraw > WITHDRAW_MAX_POINTS_PER_REQUEST) {
    return res.status(400).json({ error: `单次最多提现 ${WITHDRAW_MAX_POINTS_PER_REQUEST} 积分` })
  }
  if (!['alipay', 'wechat'].includes(method)) {
    return res.status(400).json({ error: '请选择有效的提现方式' })
  }
  if (!payoutAccount) {
    return res.status(400).json({ error: '请输入收款账号' })
  }
  if (/[\r\n]/.test(payoutAccount)) {
    return res.status(400).json({ error: '收款账号格式不正确' })
  }
  if (payoutAccount.length > 120) {
    return res.status(400).json({ error: '收款账号过长' })
  }

  try {
    const result = await withLocks([`points:user:${userId}`], async () => {
      const db = await getDatabase()
      const withdrawSettings = await getPointsWithdrawSettings(db)

      if (pointsToWithdraw < withdrawSettings.minPoints) {
        return { ok: false, status: 400, error: `最低提现 ${withdrawSettings.minPoints} 积分` }
      }
      if (withdrawSettings.stepPoints > 1 && pointsToWithdraw % withdrawSettings.stepPoints !== 0) {
        return { ok: false, status: 400, error: `提现积分需为 ${withdrawSettings.stepPoints} 的倍数` }
      }

      const userResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      if (!userResult[0]?.values?.length) {
        return { ok: false, status: 404, error: 'User not found' }
      }
      const currentPoints = Number(userResult[0].values[0][0] || 0)
      if (currentPoints < pointsToWithdraw) {
        return { ok: false, status: 409, error: '积分不足，无法提现' }
      }

      if (WITHDRAW_MAX_PENDING > 0) {
        const pending = db.exec(
          `SELECT COUNT(*) FROM points_withdrawals WHERE user_id = ? AND status = 'pending'`,
          [userId]
        )
        const pendingCount = Number(pending[0]?.values?.[0]?.[0] || 0)
        if (pendingCount >= WITHDRAW_MAX_PENDING) {
          return { ok: false, status: 429, error: '存在未处理的提现申请，请稍后再试' }
        }
      }

      if (WITHDRAW_COOLDOWN_SECONDS > 0) {
        const cooldown = `-${WITHDRAW_COOLDOWN_SECONDS} seconds`
        const recent = db.exec(
          `
            SELECT COUNT(*)
            FROM points_withdrawals
            WHERE user_id = ?
              AND created_at >= DATETIME('now', 'localtime', ?)
          `,
          [userId, cooldown]
        )
        const recentCount = Number(recent[0]?.values?.[0]?.[0] || 0)
        if (recentCount > 0) {
          return { ok: false, status: 429, error: '操作过于频繁，请稍后再试' }
        }
      }

      if (WITHDRAW_DAILY_MAX_REQUESTS > 0) {
        const todayCountResult = db.exec(
          `
            SELECT COUNT(*)
            FROM points_withdrawals
            WHERE user_id = ?
              AND DATE(created_at) = DATE('now', 'localtime')
          `,
          [userId]
        )
        const todayCount = Number(todayCountResult[0]?.values?.[0]?.[0] || 0)
        if (todayCount >= WITHDRAW_DAILY_MAX_REQUESTS) {
          return { ok: false, status: 429, error: '今日提现次数已达上限' }
        }
      }

      if (WITHDRAW_DAILY_MAX_POINTS > 0) {
        const todaySumResult = db.exec(
          `
            SELECT COALESCE(SUM(points), 0)
            FROM points_withdrawals
            WHERE user_id = ?
              AND DATE(created_at) = DATE('now', 'localtime')
              AND COALESCE(status, '') != 'rejected'
          `,
          [userId]
        )
        const todaySum = Number(todaySumResult[0]?.values?.[0]?.[0] || 0)
        if (todaySum + pointsToWithdraw > WITHDRAW_DAILY_MAX_POINTS) {
          return { ok: false, status: 429, error: `今日最多可提现 ${WITHDRAW_DAILY_MAX_POINTS} 积分` }
        }
      }

      const cashCents = toCashCentsFromPoints(pointsToWithdraw, withdrawSettings)
      if (cashCents <= 0) {
        return { ok: false, status: 400, error: '提现积分不合法' }
      }
      const cashAmount = formatCashAmount(cashCents)

      db.run(
        `
          INSERT INTO points_withdrawals (user_id, points, cash_amount, method, payout_account, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [userId, pointsToWithdraw, cashAmount, method, payoutAccount]
      )
      const withdrawalId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]?.[0] || 0)

      db.run('UPDATE users SET points = COALESCE(points, 0) - ? WHERE id = ?', [pointsToWithdraw, userId])
      safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints: -pointsToWithdraw,
        pointsBefore: currentPoints,
        pointsAfter: currentPoints - pointsToWithdraw,
        action: 'withdraw_request',
        refType: 'points_withdrawal',
        refId: withdrawalId,
        remark: `提现申请（${method}）`
      })
      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)

      const row = db.exec(
        `
          SELECT id, points, cash_amount, method, payout_account, status, remark, created_at, updated_at, processed_at
          FROM points_withdrawals
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `,
        [withdrawalId, userId]
      )[0]?.values?.[0]

      const withdrawal = row
        ? {
            id: row[0],
            points: Number(row[1] || 0),
            cashAmount: row[2] || null,
            method: row[3],
            payoutAccount: row[4],
            status: row[5] || 'pending',
            remark: row[6] || null,
            createdAt: row[7],
            updatedAt: row[8],
            processedAt: row[9] || null,
          }
        : null

      return { ok: true, points: pointsAfter, withdrawal }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '提现失败' })
    }

    res.json({
      message: '提现申请已提交（人工处理）',
      points: result.points,
      withdrawal: result.withdrawal
    })
  } catch (error) {
    console.error('Create withdrawal error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get user stats (email and user count)
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()

    // Get user info
    const userResult = db.exec('SELECT username, email FROM users WHERE id = ?', [req.user.id])

    if (userResult.length === 0 || userResult[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get total user count
    const countResult = db.exec('SELECT COUNT(*) as count FROM users')
    const totalUsers = countResult[0].values[0][0]

    res.json({
      username: userResult[0].values[0][0],
      email: userResult[0].values[0][1],
      totalUsers: totalUsers
    })
  } catch (error) {
    console.error('Get stats error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/ledger', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const db = await getDatabase()
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)))
    const beforeId = req.query.beforeId != null ? toInt(req.query.beforeId, 0) : null
    const withDetails = req.query.withDetails === 'true' || req.query.withDetails === '1'
    const fetched = listUserPointsLedger(db, { userId, limit: limit + 1, beforeId, withDetails })
    const hasMore = fetched.length > limit
    const records = hasMore ? fetched.slice(0, limit) : fetched
    const nextBeforeId = hasMore && records.length ? records[records.length - 1].id : null
    res.json({
      records,
      page: {
        limit,
        hasMore,
        nextBeforeId
      }
    })
  } catch (error) {
    console.error('List points ledger error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/redeem-records', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const db = await getDatabase()
    const status = String(req.query.status || 'all').trim().toLowerCase()
    const search = String(req.query.search || '').trim().toLowerCase()
    const page = Math.max(1, toInt(req.query.page, 1))
    const pageSize = Math.min(200, Math.max(1, toInt(req.query.pageSize, toInt(req.query.limit, 50))))
    const limit = Math.min(900, Math.max(pageSize, Math.max(1, toInt(req.query.limit, 900))))
    const days = Math.max(1, Math.min(90, toInt(req.query.days, 90)))
    const threshold = `-${days} days`

    const ledgerRows = db.exec(
      `
        SELECT id, ref_id
        FROM points_ledger
        WHERE user_id = ?
          AND action = 'redeem_team_seat'
          AND ref_type = 'redemption_code'
          AND ref_id IS NOT NULL
          AND TRIM(ref_id) != ''
          AND created_at >= DATETIME('now', 'localtime', ?)
        ORDER BY id DESC
        LIMIT ?
      `,
      [userId, threshold, limit]
    )[0]?.values || []

    const codeIds = [...new Set(
      ledgerRows
        .map(row => toInt(row[1], 0))
        .filter(id => id > 0)
    )]

    if (codeIds.length === 0) {
      return res.json({
        records: [],
        pagination: {
          page,
          pageSize,
          total: 0,
          totalPages: 1
        },
        summary: {
          total: 0,
          banned: 0,
          recoverable: 0,
          recovered: 0,
          failed: 0
        }
      })
    }

    const placeholders = codeIds.map(() => '?').join(',')
    const codeRows = db.exec(
      `
        SELECT
          rc.id,
          rc.code,
          rc.redeemed_by,
          rc.redeemed_at,
          rc.account_email,
          COALESCE(
            NULLIF((
              SELECT po.order_type
              FROM purchase_orders po
              WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
              ORDER BY po.created_at DESC
              LIMIT 1
            ), ''),
            NULLIF(rc.order_type, ''),
            'warranty'
          ) AS order_type
        FROM redemption_codes rc
        WHERE rc.id IN (${placeholders})
      `,
      codeIds
    )[0]?.values || []

    const latestLogRows = db.exec(
      `
        SELECT
          ar.original_code_id,
          ar.id,
          ar.status,
          ar.error_message,
          ar.recovery_mode,
          ar.recovery_code,
          ar.recovery_account_email,
          ar.created_at
        FROM account_recovery_logs ar
        JOIN (
          SELECT original_code_id, MAX(id) AS latest_id
          FROM account_recovery_logs
          WHERE original_code_id IN (${placeholders})
          GROUP BY original_code_id
        ) latest ON latest.latest_id = ar.id
      `,
      codeIds
    )[0]?.values || []

    const latestCompletedRows = db.exec(
      `
        SELECT
          ar.original_code_id,
          ar.recovery_account_email
        FROM account_recovery_logs ar
        JOIN (
          SELECT original_code_id, MAX(id) AS latest_id
          FROM account_recovery_logs
          WHERE status IN ('success', 'skipped')
            AND original_code_id IN (${placeholders})
          GROUP BY original_code_id
        ) latest ON latest.latest_id = ar.id
      `,
      codeIds
    )[0]?.values || []

    const latestLogByCodeId = new Map()
    for (const row of latestLogRows) {
      const codeId = Number(row[0] || 0)
      if (!codeId) continue
      latestLogByCodeId.set(codeId, {
        id: Number(row[1] || 0),
        status: row[2] ? String(row[2]) : '',
        errorMessage: row[3] ? String(row[3]) : null,
        recoveryMode: row[4] ? String(row[4]) : null,
        recoveryCode: row[5] ? String(row[5]) : null,
        recoveryAccountEmail: row[6] ? String(row[6]) : null,
        createdAt: row[7] ? String(row[7]) : null,
      })
    }

    const completedRecoveryEmailByCodeId = new Map()
    for (const row of latestCompletedRows) {
      const codeId = Number(row[0] || 0)
      if (!codeId) continue
      const accountEmail = row[1] ? String(row[1]).trim() : ''
      completedRecoveryEmailByCodeId.set(codeId, accountEmail)
    }

    const currentAccountEmails = new Set()
    for (const row of codeRows) {
      const codeId = Number(row[0] || 0)
      if (!codeId) continue
      const originalAccountEmail = String(row[4] || '').trim()
      const recoveryAccountEmail = String(completedRecoveryEmailByCodeId.get(codeId) || '').trim()
      const currentAccountEmail = recoveryAccountEmail || originalAccountEmail
      if (currentAccountEmail) currentAccountEmails.add(currentAccountEmail.toLowerCase())
    }

    const currentAccountStatusByEmail = new Map()
    if (currentAccountEmails.size > 0) {
      const accountEmailList = Array.from(currentAccountEmails)
      const accountPlaceholders = accountEmailList.map(() => '?').join(',')
      const accountRows = db.exec(
        `
          SELECT email, COALESCE(is_banned, 0) AS is_banned
          FROM gpt_accounts
          WHERE lower(email) IN (${accountPlaceholders})
        `,
        accountEmailList
      )[0]?.values || []

      for (const row of accountRows) {
        const email = String(row[0] || '').trim().toLowerCase()
        currentAccountStatusByEmail.set(email, Number(row[1] || 0) === 1)
      }
    }

    const groupedByUserEmail = new Map()

    for (const row of codeRows) {
      const codeId = Number(row[0] || 0)
      if (!codeId) continue

      const redeemedBy = String(row[2] || '').trim()
      const userEmail = extractEmailFromRedeemedBy(redeemedBy)
      if (!userEmail) continue

      const redeemedAt = row[3] ? String(row[3]) : null
      const originalAccountEmail = String(row[4] || '').trim()
      const orderType = String(row[5] || 'warranty').trim().toLowerCase()

      const latestLog = latestLogByCodeId.get(codeId) || null
      const completedRecoveryEmail = String(completedRecoveryEmailByCodeId.get(codeId) || '').trim()
      const currentAccountEmail = completedRecoveryEmail || originalAccountEmail
      const currentAccountEmailKey = currentAccountEmail.toLowerCase()
      const isBanned = currentAccountEmail
        ? !currentAccountStatusByEmail.has(currentAccountEmailKey) || currentAccountStatusByEmail.get(currentAccountEmailKey) === true
        : true

      const windowEndsAt = plusDaysIso(redeemedAt, ACCOUNT_RECOVERY_WINDOW_DAYS)
      const windowEndsMs = parseTimeMs(windowEndsAt)
      const inWarranty = windowEndsMs != null && windowEndsMs > Date.now()
      const canRecover = isBanned && inWarranty && orderType !== 'no_warranty'

      let state = 'normal'
      if (isBanned && latestLog?.status === 'failed') {
        state = 'failed'
      } else if (isBanned) {
        state = 'banned'
      } else if (latestLog) {
        state = 'recovered'
      }

      const redeemedAtMs = parseTimeMs(redeemedAt)
      const latestLogAtMs = parseTimeMs(latestLog?.createdAt)
      const latestActivityMs = Math.max(redeemedAtMs || 0, latestLogAtMs || 0)

      const mapped = {
        userEmail,
        originalCodeId: codeId,
        originalCode: String(row[1] || ''),
        redeemedBy,
        redeemedAt,
        originalAccountEmail,
        currentAccountEmail: currentAccountEmail || null,
        orderType,
        state,
        isBanned,
        inWarranty,
        canRecover,
        windowEndsAt,
        latestActivityAt: latestActivityMs > 0 ? new Date(latestActivityMs).toISOString() : redeemedAt,
        latest: latestLog
      }

      const current = groupedByUserEmail.get(userEmail)
      const currentMs = parseTimeMs(current?.latestActivityAt) || 0
      if (!current || latestActivityMs >= currentMs) {
        groupedByUserEmail.set(userEmail, mapped)
      }
    }

    let records = Array.from(groupedByUserEmail.values())
      .sort((a, b) => (parseTimeMs(b.latestActivityAt) || 0) - (parseTimeMs(a.latestActivityAt) || 0))

    if (status === 'banned') {
      records = records.filter(item => item.state === 'banned' || item.state === 'failed')
    } else if (status === 'recoverable') {
      records = records.filter(item => item.canRecover)
    } else if (status === 'recovered') {
      records = records.filter(item => item.state === 'recovered')
    }
    if (search) {
      records = records.filter(item => item.userEmail.includes(search))
    }

    const total = records.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const offset = (safePage - 1) * pageSize
    const pagedRecords = records.slice(offset, offset + pageSize)

    const summary = {
      total,
      banned: records.filter(item => item.state === 'banned' || item.state === 'failed').length,
      recoverable: records.filter(item => item.canRecover).length,
      recovered: records.filter(item => item.state === 'recovered').length,
      failed: records.filter(item => item.state === 'failed').length
    }

    return res.json({
      records: pagedRecords,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages
      },
      summary
    })
  } catch (error) {
    console.error('List user redeem records error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/redeem-records/:originalCodeId/logs', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const originalCodeId = toInt(req.params.originalCodeId, 0)
    if (!originalCodeId) {
      return res.status(400).json({ error: 'Invalid originalCodeId' })
    }

    const db = await getDatabase()
    if (!isUserCodeOwned(db, userId, originalCodeId)) {
      return res.status(404).json({ error: 'Record not found' })
    }

    const codeRow = db.exec(
      `
        SELECT id, code, redeemed_by, redeemed_at, account_email
        FROM redemption_codes
        WHERE id = ?
        LIMIT 1
      `,
      [originalCodeId]
    )[0]?.values?.[0]

    if (!codeRow) {
      return res.status(404).json({ error: 'Record not found' })
    }

    const userEmail = extractEmailFromRedeemedBy(codeRow[2])
    const initialLog = {
      id: 0,
      type: 'invite',
      status: 'success',
      recoveryMode: 'initial',
      recoveryCode: String(codeRow[1] || ''),
      recoveryAccountEmail: codeRow[4] ? String(codeRow[4]) : null,
      errorMessage: null,
      createdAt: codeRow[3] ? String(codeRow[3]) : null,
    }

    const logRows = db.exec(
      `
        SELECT
          id,
          status,
          recovery_mode,
          recovery_code,
          recovery_account_email,
          error_message,
          created_at
        FROM account_recovery_logs
        WHERE original_code_id = ?
        ORDER BY id DESC
      `,
      [originalCodeId]
    )[0]?.values || []

    const logs = [
      ...logRows.map(row => ({
        id: Number(row[0] || 0),
        type: String(row[2] || '').trim() === 'reinvite' ? 'reinvite' : 'recovery',
        status: row[1] ? String(row[1]) : '',
        recoveryMode: row[2] ? String(row[2]) : null,
        recoveryCode: row[3] ? String(row[3]) : null,
        recoveryAccountEmail: row[4] ? String(row[4]) : null,
        errorMessage: row[5] ? String(row[5]) : null,
        createdAt: row[6] ? String(row[6]) : null,
      })),
      initialLog,
    ].sort((a, b) => (parseTimeMs(b.createdAt) || 0) - (parseTimeMs(a.createdAt) || 0))

    return res.json({
      originalCodeId,
      userEmail: userEmail || null,
      logs
    })
  } catch (error) {
    console.error('Get redeem operation logs error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/redeem-records/:originalCodeId/reinvite', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const originalCodeId = toInt(req.params.originalCodeId, 0)
    if (!originalCodeId) {
      return res.status(400).json({ error: 'Invalid originalCodeId' })
    }

    return await withLocks([`user:reinvite:${userId}:${originalCodeId}`], async () => {
      const db = await getDatabase()
      if (!isUserCodeOwned(db, userId, originalCodeId)) {
        return res.status(404).json({ error: 'Record not found' })
      }

      const row = db.exec(
        `
          SELECT id, code, is_redeemed, redeemed_by, redeemed_at, account_email
          FROM redemption_codes
          WHERE id = ?
          LIMIT 1
        `,
        [originalCodeId]
      )[0]?.values?.[0]

      if (!row) {
        return res.status(404).json({ error: 'Record not found' })
      }

      const isRedeemed = Number(row[2] || 0) === 1
      if (!isRedeemed) {
        return res.status(400).json({ error: '该兑换码尚未使用，无法重新邀请' })
      }

      const inviteEmail = extractEmailFromRedeemedBy(row[3])
      if (!inviteEmail) {
        return res.status(400).json({ error: '兑换用户邮箱缺失，无法重新邀请' })
      }

      const accountEmail = String(row[5] || '').trim()
      if (!accountEmail) {
        return res.status(400).json({ error: '该兑换码未绑定账号，无法重新邀请' })
      }

      const accountRow = db.exec(
        `
          SELECT id, email, token, chatgpt_account_id, oai_device_id
          FROM gpt_accounts
          WHERE lower(email) = lower(?)
          LIMIT 1
        `,
        [accountEmail]
      )[0]?.values?.[0]

      if (!accountRow) {
        return res.status(404).json({ error: '所属账号不存在，无法重新邀请' })
      }

      const accountId = Number(accountRow[0] || 0)
      const token = String(accountRow[2] || '').trim()
      const chatgptAccountId = String(accountRow[3] || '').trim()
      const oaiDeviceId = String(accountRow[4] || '').trim()

      if (!token || !chatgptAccountId) {
        return res.status(400).json({ error: '所属账号缺少 token 或 chatgpt_account_id，无法重新邀请' })
      }

      let alreadyInTeam = false
      try {
        const users = await fetchAccountUsersList(accountId, { userListParams: { query: inviteEmail, limit: 20, offset: 0 } })
        alreadyInTeam = Array.isArray(users?.items) && users.items.some(item => String(item?.email || '').trim().toLowerCase() === inviteEmail)
      } catch (error) {
        alreadyInTeam = false
      }

      if (alreadyInTeam) {
        insertRecoveryLog(db, {
          email: inviteEmail,
          originalCodeId,
          originalRedeemedAt: row[4] ? String(row[4]) : null,
          originalAccountEmail: accountEmail,
          recoveryMode: 'reinvite',
          recoveryCodeId: originalCodeId,
          recoveryCode: String(row[1] || ''),
          recoveryAccountEmail: accountEmail,
          status: 'skipped',
          errorMessage: 'already-in-team'
        })
        saveDatabase()
        return res.status(409).json({ error: '用户已加入 Team，无需重新发送邀请' })
      }

      const inviteResult = await inviteUserToChatGPTTeam(inviteEmail, {
        token,
        chatgpt_account_id: chatgptAccountId,
        oai_device_id: oaiDeviceId
      })

      if (!inviteResult?.success) {
        const errorMessage = typeof inviteResult?.error === 'string' && inviteResult.error.trim() ? inviteResult.error.trim() : '重新邀请失败'
        insertRecoveryLog(db, {
          email: inviteEmail,
          originalCodeId,
          originalRedeemedAt: row[4] ? String(row[4]) : null,
          originalAccountEmail: accountEmail,
          recoveryMode: 'reinvite',
          recoveryCodeId: originalCodeId,
          recoveryCode: String(row[1] || ''),
          recoveryAccountEmail: accountEmail,
          status: 'failed',
          errorMessage
        })
        saveDatabase()
        return res.status(503).json({ error: errorMessage })
      }

      insertRecoveryLog(db, {
        email: inviteEmail,
        originalCodeId,
        originalRedeemedAt: row[4] ? String(row[4]) : null,
        originalAccountEmail: accountEmail,
        recoveryMode: 'reinvite',
        recoveryCodeId: originalCodeId,
        recoveryCode: String(row[1] || ''),
        recoveryAccountEmail: accountEmail,
        status: 'success'
      })
      saveDatabase()
      return res.json({ message: '重新邀请已发送' })
    })
  } catch (error) {
    console.error('User reinvite error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/username', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const username = String(req.body?.username ?? '').trim()
    if (!username) {
      return res.status(400).json({ error: '用户名不能为空' })
    }
    if (username.length > 64) {
      return res.status(400).json({ error: '用户名过长' })
    }

    const db = await getDatabase()
    const existingUser = db.exec(
      'SELECT id, username, email, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [userId]
    )
    if (!existingUser[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const currentUsername = String(existingUser[0].values[0][1] || '').trim()
    const email = existingUser[0].values[0][2]
    const inviteEnabled = Number(existingUser[0].values[0][3] ?? 1) !== 0

    if (currentUsername && currentUsername.toLowerCase() === username.toLowerCase()) {
      const access = await getUserAccessContext(userId, db)
      return res.json({
        message: '用户名未变化',
        user: {
          id: userId,
          username: currentUsername,
          email,
          inviteEnabled,
          roles: access.roles,
          menus: access.menus,
        }
      })
    }

    const duplicate = db.exec(
      'SELECT 1 FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1',
      [username, userId]
    )
    if (duplicate[0]?.values?.length) {
      return res.status(409).json({ error: '用户名已存在' })
    }

    db.run('UPDATE users SET username = ? WHERE id = ?', [username, userId])
    saveDatabase()

    const access = await getUserAccessContext(userId, db)
    res.json({
      message: '用户名已更新',
      user: {
        id: userId,
        username,
        email,
        inviteEnabled,
        roles: access.roles,
        menus: access.menus,
      }
    })
  } catch (error) {
    console.error('Update username error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' })
    }

    const db = await getDatabase()

    // Get current user with password
    const userResult = db.exec('SELECT id, username, password FROM users WHERE id = ?', [req.user.id])

    if (userResult.length === 0 || userResult[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: userResult[0].values[0][0],
      username: userResult[0].values[0][1],
      password: userResult[0].values[0][2]
    }

    // Verify current password
    const isPasswordValid = bcrypt.compareSync(currentPassword, user.password)

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' })
    }

    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10)

    // Update password
    db.run(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    )
    saveDatabase()

    res.json({ message: 'Password changed successfully' })
  } catch (error) {
    console.error('Change password error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get API key
router.get('/api-key', authenticateToken, requireSuperAdmin, requireMenu('settings'), async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec('SELECT config_value FROM system_config WHERE config_key = "auto_boarding_api_key"')

    if (result.length === 0 || result[0].values.length === 0) {
      return res.json({ apiKey: null, configured: false })
    }

    res.json({ apiKey: result[0].values[0][0], configured: true })
  } catch (error) {
    console.error('Get API key error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update API key
router.put('/api-key', authenticateToken, requireSuperAdmin, requireMenu('settings'), async (req, res) => {
  try {
    const { apiKey } = req.body

    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' })
    }

    if (apiKey.length < 16) {
      return res.status(400).json({ error: 'API key must be at least 16 characters for security' })
    }

    const db = await getDatabase()

    // Check if key exists
    const checkResult = db.exec('SELECT id FROM system_config WHERE config_key = "auto_boarding_api_key"')

    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      // Insert new
      db.run(
        `INSERT INTO system_config (config_key, config_value, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'))`,
        ['auto_boarding_api_key', apiKey]
      )
    } else {
      // Update existing
      db.run(
        `UPDATE system_config SET config_value = ?, updated_at = DATETIME('now', 'localtime') WHERE config_key = "auto_boarding_api_key"`,
        [apiKey]
      )
    }

    saveDatabase()

    res.json({
      message: 'API key updated successfully',
      apiKey: apiKey
    })
  } catch (error) {
    console.error('Update API key error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
