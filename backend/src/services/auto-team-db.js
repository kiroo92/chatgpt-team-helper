import { getDatabase, saveDatabase } from '../database/init.js'

const normalizeOptionalString = (value) => {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized || null
}

const normalizeStatus = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  if (['active', 'standby', 'exhausted', 'pending'].includes(raw)) return raw
  return 'standby'
}

const safeParseJson = (value, fallback = null) => {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

export const AUTO_TEAM_STATUSES = Object.freeze({
  ACTIVE: 'active',
  STANDBY: 'standby',
  EXHAUSTED: 'exhausted',
  PENDING: 'pending'
})

export const mapAutoTeamAccountRow = (row = []) => ({
  id: Number(row[0]),
  email: String(row[1] || ''),
  password: row[2] == null ? '' : String(row[2]),
  cloudmailAccountId: normalizeOptionalString(row[3]),
  status: normalizeStatus(row[4]),
  accessToken: normalizeOptionalString(row[5]),
  refreshToken: normalizeOptionalString(row[6]),
  idToken: normalizeOptionalString(row[7]),
  authJson: safeParseJson(row[8], null),
  chatgptAccountId: normalizeOptionalString(row[9]),
  planType: normalizeOptionalString(row[10]),
  quotaPrimaryPct: row[11] == null ? null : Number(row[11]),
  quotaPrimaryResetsAt: row[12] == null ? null : Number(row[12]),
  quotaWeeklyPct: row[13] == null ? null : Number(row[13]),
  quotaWeeklyResetsAt: row[14] == null ? null : Number(row[14]),
  quotaExhaustedAt: row[15] == null ? null : Number(row[15]),
  lastActiveAt: row[16] == null ? null : Number(row[16]),
  lastError: normalizeOptionalString(row[17]),
  createdAt: row[18] || null,
  updatedAt: row[19] || null,
})

const BASE_SELECT_SQL = `
  SELECT id,
         email,
         password,
         cloudmail_account_id,
         status,
         access_token,
         refresh_token,
         id_token,
         auth_json,
         chatgpt_account_id,
         plan_type,
         quota_primary_pct,
         quota_primary_resets_at,
         quota_weekly_pct,
         quota_weekly_resets_at,
         quota_exhausted_at,
         last_active_at,
         last_error,
         created_at,
         updated_at
    FROM autoteam_accounts
`

export async function listAutoTeamAccounts() {
  const db = await getDatabase()
  const result = db.exec(`${BASE_SELECT_SQL} ORDER BY created_at DESC, id DESC`)
  const rows = result[0]?.values || []
  return rows.map(mapAutoTeamAccountRow)
}

export async function getAutoTeamAccountById(id) {
  const db = await getDatabase()
  const result = db.exec(`${BASE_SELECT_SQL} WHERE id = ? LIMIT 1`, [id])
  const row = result[0]?.values?.[0]
  return row ? mapAutoTeamAccountRow(row) : null
}

export async function getAutoTeamAccountByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!normalizedEmail) return null
  const db = await getDatabase()
  const result = db.exec(`${BASE_SELECT_SQL} WHERE lower(trim(email)) = ? LIMIT 1`, [normalizedEmail])
  const row = result[0]?.values?.[0]
  return row ? mapAutoTeamAccountRow(row) : null
}

export async function createAutoTeamAccount(payload = {}) {
  const db = await getDatabase()
  const email = String(payload.email || '').trim().toLowerCase()
  if (!email) throw new Error('缺少邮箱')

  const authJson = payload.authJson && typeof payload.authJson === 'object'
    ? JSON.stringify(payload.authJson)
    : (typeof payload.authJson === 'string' ? payload.authJson : null)

  db.run(
    `INSERT INTO autoteam_accounts (
      email,
      password,
      cloudmail_account_id,
      status,
      access_token,
      refresh_token,
      id_token,
      auth_json,
      chatgpt_account_id,
      plan_type,
      quota_primary_pct,
      quota_primary_resets_at,
      quota_weekly_pct,
      quota_weekly_resets_at,
      quota_exhausted_at,
      last_active_at,
      last_error,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
    [
      email,
      normalizeOptionalString(payload.password),
      normalizeOptionalString(payload.cloudmailAccountId),
      normalizeStatus(payload.status),
      normalizeOptionalString(payload.accessToken),
      normalizeOptionalString(payload.refreshToken),
      normalizeOptionalString(payload.idToken),
      authJson,
      normalizeOptionalString(payload.chatgptAccountId),
      normalizeOptionalString(payload.planType),
      payload.quotaPrimaryPct ?? null,
      payload.quotaPrimaryResetsAt ?? null,
      payload.quotaWeeklyPct ?? null,
      payload.quotaWeeklyResetsAt ?? null,
      payload.quotaExhaustedAt ?? null,
      payload.lastActiveAt ?? null,
      normalizeOptionalString(payload.lastError)
    ]
  )

  await saveDatabase()
  const created = db.exec(`${BASE_SELECT_SQL} WHERE id = last_insert_rowid() LIMIT 1`)
  const row = created[0]?.values?.[0]
  return row ? mapAutoTeamAccountRow(row) : null
}

export async function updateAutoTeamAccount(id, patch = {}) {
  const db = await getDatabase()
  const current = await getAutoTeamAccountById(id)
  if (!current) return null

  const next = {
    email: patch.email != null ? String(patch.email).trim().toLowerCase() : current.email,
    password: Object.prototype.hasOwnProperty.call(patch, 'password') ? normalizeOptionalString(patch.password) : normalizeOptionalString(current.password),
    cloudmailAccountId: Object.prototype.hasOwnProperty.call(patch, 'cloudmailAccountId') ? normalizeOptionalString(patch.cloudmailAccountId) : current.cloudmailAccountId,
    status: Object.prototype.hasOwnProperty.call(patch, 'status') ? normalizeStatus(patch.status) : current.status,
    accessToken: Object.prototype.hasOwnProperty.call(patch, 'accessToken') ? normalizeOptionalString(patch.accessToken) : current.accessToken,
    refreshToken: Object.prototype.hasOwnProperty.call(patch, 'refreshToken') ? normalizeOptionalString(patch.refreshToken) : current.refreshToken,
    idToken: Object.prototype.hasOwnProperty.call(patch, 'idToken') ? normalizeOptionalString(patch.idToken) : current.idToken,
    authJson: Object.prototype.hasOwnProperty.call(patch, 'authJson')
      ? (patch.authJson && typeof patch.authJson === 'object' ? JSON.stringify(patch.authJson) : (patch.authJson ? String(patch.authJson) : null))
      : (current.authJson ? JSON.stringify(current.authJson) : null),
    chatgptAccountId: Object.prototype.hasOwnProperty.call(patch, 'chatgptAccountId') ? normalizeOptionalString(patch.chatgptAccountId) : current.chatgptAccountId,
    planType: Object.prototype.hasOwnProperty.call(patch, 'planType') ? normalizeOptionalString(patch.planType) : current.planType,
    quotaPrimaryPct: Object.prototype.hasOwnProperty.call(patch, 'quotaPrimaryPct') ? (patch.quotaPrimaryPct ?? null) : current.quotaPrimaryPct,
    quotaPrimaryResetsAt: Object.prototype.hasOwnProperty.call(patch, 'quotaPrimaryResetsAt') ? (patch.quotaPrimaryResetsAt ?? null) : current.quotaPrimaryResetsAt,
    quotaWeeklyPct: Object.prototype.hasOwnProperty.call(patch, 'quotaWeeklyPct') ? (patch.quotaWeeklyPct ?? null) : current.quotaWeeklyPct,
    quotaWeeklyResetsAt: Object.prototype.hasOwnProperty.call(patch, 'quotaWeeklyResetsAt') ? (patch.quotaWeeklyResetsAt ?? null) : current.quotaWeeklyResetsAt,
    quotaExhaustedAt: Object.prototype.hasOwnProperty.call(patch, 'quotaExhaustedAt') ? (patch.quotaExhaustedAt ?? null) : current.quotaExhaustedAt,
    lastActiveAt: Object.prototype.hasOwnProperty.call(patch, 'lastActiveAt') ? (patch.lastActiveAt ?? null) : current.lastActiveAt,
    lastError: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? normalizeOptionalString(patch.lastError) : current.lastError,
  }

  db.run(
    `UPDATE autoteam_accounts
        SET email = ?,
            password = ?,
            cloudmail_account_id = ?,
            status = ?,
            access_token = ?,
            refresh_token = ?,
            id_token = ?,
            auth_json = ?,
            chatgpt_account_id = ?,
            plan_type = ?,
            quota_primary_pct = ?,
            quota_primary_resets_at = ?,
            quota_weekly_pct = ?,
            quota_weekly_resets_at = ?,
            quota_exhausted_at = ?,
            last_active_at = ?,
            last_error = ?,
            updated_at = DATETIME('now', 'localtime')
      WHERE id = ?`,
    [
      next.email,
      next.password,
      next.cloudmailAccountId,
      next.status,
      next.accessToken,
      next.refreshToken,
      next.idToken,
      next.authJson,
      next.chatgptAccountId,
      next.planType,
      next.quotaPrimaryPct,
      next.quotaPrimaryResetsAt,
      next.quotaWeeklyPct,
      next.quotaWeeklyResetsAt,
      next.quotaExhaustedAt,
      next.lastActiveAt,
      next.lastError,
      id
    ]
  )

  await saveDatabase()
  return getAutoTeamAccountById(id)
}

export async function upsertAutoTeamAccountByEmail(email, patch = {}) {
  const existing = await getAutoTeamAccountByEmail(email)
  if (existing) {
    return updateAutoTeamAccount(existing.id, patch)
  }
  return createAutoTeamAccount({ ...patch, email })
}

export async function deleteAutoTeamAccount(id) {
  const db = await getDatabase()
  const existing = await getAutoTeamAccountById(id)
  if (!existing) return null
  db.run('DELETE FROM autoteam_accounts WHERE id = ?', [id])
  await saveDatabase()
  return existing
}

export const sortStandbyAccountsForReuse = (accounts = []) => {
  const now = Date.now()
  return [...accounts].sort((a, b) => {
    const aRecovered = !a.quotaPrimaryResetsAt || Number(a.quotaPrimaryResetsAt) * 1000 <= now
    const bRecovered = !b.quotaPrimaryResetsAt || Number(b.quotaPrimaryResetsAt) * 1000 <= now
    if (aRecovered !== bRecovered) return aRecovered ? -1 : 1
    return Number(a.quotaExhaustedAt || 0) - Number(b.quotaExhaustedAt || 0)
  })
}
