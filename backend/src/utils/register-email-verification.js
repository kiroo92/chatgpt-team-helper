import { getSmtpSettings } from './smtp-settings.js'

const PLACEHOLDER_HOST = 'smtp.example.com'

const normalizeHost = (value) => String(value ?? '').trim().toLowerCase()

export const isPlaceholderSmtpHost = (host) => normalizeHost(host) === PLACEHOLDER_HOST

export async function isRegisterEmailVerificationRequired(db) {
  const settings = await getSmtpSettings(db)
  const host = String(settings?.smtp?.host || '').trim()
  const user = String(settings?.smtp?.user || '').trim()
  const pass = String(settings?.smtp?.pass || '').trim()

  if (!host) return false
  if (isPlaceholderSmtpHost(host)) return false

  return Boolean(user && pass)
}

