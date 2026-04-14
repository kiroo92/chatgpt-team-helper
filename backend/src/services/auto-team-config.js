import { getDatabase, saveDatabase } from '../database/init.js'
import { getSystemConfigValue, upsertSystemConfigValue } from '../utils/system-config.js'

const CONFIG_KEYS = Object.freeze({
  enabled: 'autoteam_enabled',
  managerAccountId: 'autoteam_manager_account_id',
  targetSeats: 'autoteam_target_seats',
  autoCheckEnabled: 'autoteam_auto_check_enabled',
  autoCheckIntervalSeconds: 'autoteam_auto_check_interval_seconds',
  autoCheckThresholdPercent: 'autoteam_auto_check_threshold_percent',
  autoCheckMinLow: 'autoteam_auto_check_min_low',
  cloudmailBaseUrl: 'autoteam_cloudmail_base_url',
  cloudmailEmail: 'autoteam_cloudmail_email',
  cloudmailPassword: 'autoteam_cloudmail_password',
  cloudmailDomain: 'autoteam_cloudmail_domain',
  browserExecutablePath: 'autoteam_browser_executable_path',
  browserHeadless: 'autoteam_browser_headless',
  emailPollIntervalSeconds: 'autoteam_email_poll_interval_seconds',
  emailPollTimeoutSeconds: 'autoteam_email_poll_timeout_seconds',
  cpaEnabled: 'autoteam_cpa_enabled',
  cpaBaseUrl: 'autoteam_cpa_base_url',
  cpaKey: 'autoteam_cpa_key',
  cpaSyncOnChange: 'autoteam_cpa_sync_on_change',
})

const normalizeOptionalString = (value) => {
  if (value == null) return ''
  return String(value).trim()
}

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

const parseInteger = (value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const buildSettingsResponse = (stored = {}, { includeSecrets = false } = {}) => {
  const cloudmailPassword = normalizeOptionalString(stored.cloudmailPassword)
  const cpaKey = normalizeOptionalString(stored.cpaKey)

  return {
    enabled: parseBoolean(stored.enabled, false),
    managerAccountId: parseInteger(stored.managerAccountId, 0, { min: 0 }),
    targetSeats: parseInteger(stored.targetSeats, 5, { min: 1, max: 999 }),
    autoCheck: {
      enabled: parseBoolean(stored.autoCheckEnabled, true),
      intervalSeconds: parseInteger(stored.autoCheckIntervalSeconds, 300, { min: 60, max: 86400 }),
      thresholdPercent: parseInteger(stored.autoCheckThresholdPercent, 10, { min: 1, max: 100 }),
      minLow: parseInteger(stored.autoCheckMinLow, 2, { min: 1, max: 100 }),
    },
    cloudmail: {
      baseUrl: normalizeOptionalString(stored.cloudmailBaseUrl),
      email: normalizeOptionalString(stored.cloudmailEmail),
      domain: normalizeOptionalString(stored.cloudmailDomain),
      passwordSet: Boolean(cloudmailPassword),
      passwordStored: Boolean(cloudmailPassword),
      ...(includeSecrets ? { password: cloudmailPassword } : {})
    },
    browser: {
      executablePath: normalizeOptionalString(stored.browserExecutablePath),
      headless: parseBoolean(stored.browserHeadless, true),
    },
    mailPolling: {
      intervalSeconds: parseInteger(stored.emailPollIntervalSeconds, 3, { min: 1, max: 300 }),
      timeoutSeconds: parseInteger(stored.emailPollTimeoutSeconds, 180, { min: 30, max: 3600 }),
    },
    cpa: {
      enabled: parseBoolean(stored.cpaEnabled, false),
      baseUrl: normalizeOptionalString(stored.cpaBaseUrl),
      keySet: Boolean(cpaKey),
      keyStored: Boolean(cpaKey),
      syncOnChange: parseBoolean(stored.cpaSyncOnChange, true),
      ...(includeSecrets ? { key: cpaKey } : {})
    },
  }
}

export async function getAutoTeamSettings(options = {}) {
  const db = options.db || await getDatabase()
  const stored = {}
  for (const [field, key] of Object.entries(CONFIG_KEYS)) {
    stored[field] = getSystemConfigValue(db, key)
  }
  return buildSettingsResponse(stored, options)
}

export async function updateAutoTeamSettings(payload = {}) {
  const db = await getDatabase()

  const enabled = parseBoolean(payload.enabled, false)
  const managerAccountId = parseInteger(payload.managerAccountId, 0, { min: 0 })
  const targetSeats = parseInteger(payload.targetSeats, 5, { min: 1, max: 999 })
  const autoCheck = payload.autoCheck && typeof payload.autoCheck === 'object' ? payload.autoCheck : {}
  const cloudmail = payload.cloudmail && typeof payload.cloudmail === 'object' ? payload.cloudmail : {}
  const browser = payload.browser && typeof payload.browser === 'object' ? payload.browser : {}
  const mailPolling = payload.mailPolling && typeof payload.mailPolling === 'object' ? payload.mailPolling : {}
  const cpa = payload.cpa && typeof payload.cpa === 'object' ? payload.cpa : {}

  upsertSystemConfigValue(db, CONFIG_KEYS.enabled, enabled ? 'true' : 'false')
  upsertSystemConfigValue(db, CONFIG_KEYS.managerAccountId, String(managerAccountId || 0))
  upsertSystemConfigValue(db, CONFIG_KEYS.targetSeats, String(targetSeats))
  upsertSystemConfigValue(db, CONFIG_KEYS.autoCheckEnabled, parseBoolean(autoCheck.enabled, true) ? 'true' : 'false')
  upsertSystemConfigValue(db, CONFIG_KEYS.autoCheckIntervalSeconds, String(parseInteger(autoCheck.intervalSeconds, 300, { min: 60, max: 86400 })))
  upsertSystemConfigValue(db, CONFIG_KEYS.autoCheckThresholdPercent, String(parseInteger(autoCheck.thresholdPercent, 10, { min: 1, max: 100 })))
  upsertSystemConfigValue(db, CONFIG_KEYS.autoCheckMinLow, String(parseInteger(autoCheck.minLow, 2, { min: 1, max: 100 })))
  upsertSystemConfigValue(db, CONFIG_KEYS.cloudmailBaseUrl, normalizeOptionalString(cloudmail.baseUrl))
  upsertSystemConfigValue(db, CONFIG_KEYS.cloudmailEmail, normalizeOptionalString(cloudmail.email))
  upsertSystemConfigValue(db, CONFIG_KEYS.cloudmailDomain, normalizeOptionalString(cloudmail.domain))
  if (Object.prototype.hasOwnProperty.call(cloudmail, 'password')) {
    upsertSystemConfigValue(db, CONFIG_KEYS.cloudmailPassword, normalizeOptionalString(cloudmail.password))
  }
  upsertSystemConfigValue(db, CONFIG_KEYS.browserExecutablePath, normalizeOptionalString(browser.executablePath))
  upsertSystemConfigValue(db, CONFIG_KEYS.browserHeadless, parseBoolean(browser.headless, true) ? 'true' : 'false')
  upsertSystemConfigValue(db, CONFIG_KEYS.emailPollIntervalSeconds, String(parseInteger(mailPolling.intervalSeconds, 3, { min: 1, max: 300 })))
  upsertSystemConfigValue(db, CONFIG_KEYS.emailPollTimeoutSeconds, String(parseInteger(mailPolling.timeoutSeconds, 180, { min: 30, max: 3600 })))
  upsertSystemConfigValue(db, CONFIG_KEYS.cpaEnabled, parseBoolean(cpa.enabled, false) ? 'true' : 'false')
  upsertSystemConfigValue(db, CONFIG_KEYS.cpaBaseUrl, normalizeOptionalString(cpa.baseUrl))
  upsertSystemConfigValue(db, CONFIG_KEYS.cpaSyncOnChange, parseBoolean(cpa.syncOnChange, true) ? 'true' : 'false')
  if (Object.prototype.hasOwnProperty.call(cpa, 'key')) {
    upsertSystemConfigValue(db, CONFIG_KEYS.cpaKey, normalizeOptionalString(cpa.key))
  }

  await saveDatabase()
  return getAutoTeamSettings({ db })
}

export async function getAutoTeamManagerCandidates() {
  const db = await getDatabase()
  const result = db.exec(`
    SELECT id, email, user_count, invite_count, chatgpt_account_id, COALESCE(is_banned, 0) AS is_banned, COALESCE(is_open, 0) AS is_open
      FROM gpt_accounts
     WHERE token IS NOT NULL AND trim(token) != ''
       AND chatgpt_account_id IS NOT NULL AND trim(chatgpt_account_id) != ''
     ORDER BY created_at DESC, id DESC
  `)

  const rows = result[0]?.values || []
  return rows.map(row => ({
    id: Number(row[0]),
    email: String(row[1] || ''),
    userCount: Number(row[2] || 0),
    inviteCount: Number(row[3] || 0),
    chatgptAccountId: String(row[4] || ''),
    isBanned: Boolean(row[5]),
    isOpen: Boolean(row[6])
  }))
}
