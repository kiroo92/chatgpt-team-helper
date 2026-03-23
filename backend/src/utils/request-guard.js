const RATE_LIMIT_BUCKETS = new Map()
const RATE_LIMIT_CLEANUP_INTERVAL = 200

let rateLimitOpCount = 0

export const normalizeIp = (value) => {
  const ip = String(value || '').trim()
  if (!ip) return ''
  if (ip === '::1') return '127.0.0.1'
  const match = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (match) return match[1]
  return ip
}

export const getRequestClientIp = (req) => {
  const cfConnectingIp = req?.headers?.['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return normalizeIp(cfConnectingIp.trim())
  }

  const forwardedFor = req?.headers?.['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return normalizeIp(forwardedFor.split(',')[0].trim())
  }

  return normalizeIp(req?.ip)
}

const cleanupRateLimitBuckets = (now) => {
  rateLimitOpCount += 1
  if (rateLimitOpCount % RATE_LIMIT_CLEANUP_INTERVAL !== 0) return

  for (const [key, bucket] of RATE_LIMIT_BUCKETS.entries()) {
    if (!bucket || Number(bucket.resetAt || 0) <= now) {
      RATE_LIMIT_BUCKETS.delete(key)
    }
  }
}

export const consumeRateLimit = ({ key, limit, windowMs, now = Date.now() }) => {
  const normalizedKey = String(key || '').trim()
  const normalizedLimit = Number(limit)
  const normalizedWindowMs = Number(windowMs)

  if (!normalizedKey || !Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
    return { ok: true, remaining: null, resetAt: null, retryAfterMs: 0 }
  }

  if (!Number.isFinite(normalizedWindowMs) || normalizedWindowMs <= 0) {
    return { ok: true, remaining: null, resetAt: null, retryAfterMs: 0 }
  }

  cleanupRateLimitBuckets(now)

  let bucket = RATE_LIMIT_BUCKETS.get(normalizedKey)
  if (!bucket || Number(bucket.resetAt || 0) <= now) {
    bucket = {
      count: 0,
      resetAt: now + normalizedWindowMs
    }
  }

  bucket.count += 1
  RATE_LIMIT_BUCKETS.set(normalizedKey, bucket)

  return {
    ok: bucket.count <= normalizedLimit,
    remaining: Math.max(0, normalizedLimit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterMs: Math.max(0, bucket.resetAt - now)
  }
}
