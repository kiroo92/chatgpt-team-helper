import crypto from 'crypto'
import http from 'http'
import axios from 'axios'

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://auth.openai.com'
const OPENAI_CLIENT_ID = process.env.OPENAI_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
export const AUTO_TEAM_REDIRECT_PORT = Number.parseInt(process.env.AUTO_TEAM_REDIRECT_PORT || '1455', 10) || 1455
export const AUTO_TEAM_REDIRECT_HOST = String(process.env.AUTO_TEAM_REDIRECT_HOST || '127.0.0.1').trim() || '127.0.0.1'
export const AUTO_TEAM_REDIRECT_URI = `http://localhost:${AUTO_TEAM_REDIRECT_PORT}/auth/callback`

const SUCCESS_HTML = '<html><head><meta charset="utf-8"><title>Authentication successful</title></head><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>'
const ERROR_HTML = (message) => `<html><head><meta charset="utf-8"><title>Authentication failed</title></head><body><h1>Authentication failed</h1><p>${String(message || '未知错误')}</p></body></html>`

const manualSessions = new Map()
let callbackServer = null

const cleanupExpiredManualSessions = () => {
  const now = Date.now()
  for (const [sessionId, session] of manualSessions.entries()) {
    if (Number(session.expiresAt || 0) <= now) {
      manualSessions.delete(sessionId)
    }
  }
}

export function generateOpenAIPkce() {
  const codeVerifier = crypto.randomBytes(64).toString('hex')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) throw new Error('Invalid token')
  const segment = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

export function buildAutoTeamAuthUrl({ codeChallenge, state, prompt = 'consent' }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: AUTO_TEAM_REDIRECT_URI,
    scope: 'openid email profile offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })
  return `${OPENAI_BASE_URL}/oauth/authorize?${params.toString()}`
}

const buildBundleFromTokenResponse = (tokenData = {}, fallbackEmail = '') => {
  const idToken = String(tokenData.id_token || '')
  const accessToken = String(tokenData.access_token || '')
  const refreshToken = String(tokenData.refresh_token || '')
  const expiresIn = Number(tokenData.expires_in || 3600)

  if (!idToken || !accessToken) {
    throw new Error('OAuth 未返回有效令牌')
  }

  const payload = decodeJwtPayload(idToken)
  const authClaims = payload['https://api.openai.com/auth'] || {}
  const organizations = Array.isArray(authClaims.organizations) ? authClaims.organizations : []
  const defaultOrg = organizations.find(org => org?.is_default) || organizations[0] || {}

  return {
    accessToken,
    refreshToken,
    idToken,
    expiresIn,
    accountId: String(authClaims.chatgpt_account_id || ''),
    chatgptUserId: String(authClaims.chatgpt_user_id || authClaims.user_id || ''),
    email: String(payload.email || fallbackEmail || '').trim().toLowerCase(),
    name: String(payload.name || ''),
    emailVerified: Boolean(payload.email_verified),
    planType: String(authClaims.chatgpt_plan_type || '').trim().toLowerCase() || 'unknown',
    organizationId: String(defaultOrg.id || ''),
    organizationRole: String(defaultOrg.role || ''),
    organizationTitle: String(defaultOrg.title || ''),
    organizations,
    rawClaims: authClaims,
  }
}

export async function exchangeAuthCode({ code, codeVerifier, fallbackEmail = '' }) {
  const payload = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code || '').trim(),
    redirect_uri: AUTO_TEAM_REDIRECT_URI,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: String(codeVerifier || '').trim(),
  }).toString()

  const response = await axios.post(`${OPENAI_BASE_URL}/oauth/token`, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 60000,
  })

  return buildBundleFromTokenResponse(response.data || {}, fallbackEmail)
}

export async function refreshCodexAccessToken(refreshToken) {
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CLIENT_ID,
    refresh_token: String(refreshToken || '').trim(),
    scope: 'openid profile email',
  }).toString()

  const response = await axios.post(`${OPENAI_BASE_URL}/oauth/token`, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 60000,
  })

  return buildBundleFromTokenResponse(response.data || {})
}

export async function checkCodexQuota(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${String(accessToken || '').trim()}`,
    'Content-Type': 'application/json',
  }
  if (accountId) headers['Chatgpt-Account-Id'] = String(accountId).trim()

  try {
    const response = await axios.get('https://chatgpt.com/backend-api/wham/usage', {
      headers,
      timeout: 30000,
      validateStatus: () => true,
    })

    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_error', info: null }
    }
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
      return { status: 'auth_error', info: null }
    }

    const rateLimit = response.data.rate_limit || {}
    const primary = rateLimit.primary_window || {}
    const secondary = rateLimit.secondary_window || {}
    const quotaInfo = {
      primaryPct: Number(primary.used_percent || 0),
      primaryResetsAt: Number(primary.reset_at || 0) || null,
      weeklyPct: Number(secondary.used_percent || 0),
      weeklyResetsAt: Number(secondary.reset_at || 0) || null,
      limitReached: Boolean(rateLimit.limit_reached),
    }

    if (quotaInfo.limitReached || quotaInfo.primaryPct >= 100) {
      return {
        status: 'exhausted',
        info: quotaInfo,
      }
    }

    return {
      status: 'ok',
      info: quotaInfo,
    }
  } catch {
    return { status: 'auth_error', info: null }
  }
}

export function parseOAuthCallbackUrl(inputText) {
  const trimmed = String(inputText || '').trim()
  if (!trimmed) throw new Error('回调 URL 不能为空')

  let candidate = trimmed
  if (!candidate.includes('://')) {
    if (candidate.startsWith('?')) candidate = `http://localhost${candidate}`
    else if (candidate.includes('=')) candidate = `http://localhost/?${candidate}`
    else if (/[/?#:]/.test(candidate)) candidate = `http://${candidate}`
    else throw new Error('无效的回调 URL')
  }

  const parsedUrl = new URL(candidate)
  const getValue = (name) => parsedUrl.searchParams.get(name) || new URLSearchParams(parsedUrl.hash.replace(/^#/, '')).get(name) || ''
  const code = String(getValue('code') || '').trim()
  const state = String(getValue('state') || '').trim()
  const error = String(getValue('error') || getValue('error_description') || '').trim()
  if (!code && !error) {
    throw new Error('回调 URL 中缺少 code')
  }

  return {
    code,
    state,
    error,
    rawUrl: candidate,
  }
}

export function startAutoTeamOAuthCallbackServer() {
  if (callbackServer) return callbackServer

  callbackServer = http.createServer((req, res) => {
    cleanupExpiredManualSessions()
    if (!req.url || !req.url.startsWith('/auth/callback')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }

    const rawUrl = `http://${req.headers.host || `localhost:${AUTO_TEAM_REDIRECT_PORT}`}${req.url}`

    try {
      const parsed = parseOAuthCallbackUrl(rawUrl)
      let matchedSession = null
      for (const session of manualSessions.values()) {
        if (session.state && parsed.state && session.state === parsed.state) {
          matchedSession = session
          break
        }
      }
      if (!matchedSession) {
        throw new Error('未找到对应的 OAuth 会话，可能已过期')
      }

      matchedSession.callbackPayload = parsed
      matchedSession.callbackSource = 'auto'
      matchedSession.callbackReceived = true
      matchedSession.status = 'pending_finalize'
      matchedSession.message = '已自动接收到 OAuth 回调，可回到管理后台完成导入'

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(SUCCESS_HTML)
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(ERROR_HTML(error?.message || String(error)))
    }
  })

  callbackServer.listen(AUTO_TEAM_REDIRECT_PORT, AUTO_TEAM_REDIRECT_HOST)
  return callbackServer
}

export function createManualOAuthSession() {
  cleanupExpiredManualSessions()
  const { codeVerifier, codeChallenge } = generateOpenAIPkce()
  const state = crypto.randomBytes(16).toString('hex')
  const sessionId = crypto.randomUUID()
  const session = {
    sessionId,
    state,
    codeVerifier,
    codeChallenge,
    authUrl: buildAutoTeamAuthUrl({ codeChallenge, state }),
    callbackPayload: null,
    callbackSource: '',
    callbackReceived: false,
    status: 'pending_callback',
    message: '已生成 OAuth 链接；若当前机器可访问 localhost:1455，将自动接收回调。否则请手动粘贴回调 URL。',
    error: '',
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    result: null,
  }
  manualSessions.set(sessionId, session)
  return {
    sessionId,
    authUrl: session.authUrl,
    status: session.status,
    message: session.message,
    callbackReceived: false,
    callbackSource: '',
    autoCallbackAvailable: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
    instructions: [
      '1. 打开授权链接并登录 OpenAI / Codex',
      '2. 若浏览器与服务端在同一台机器，localhost:1455 会自动接收回调',
      '3. 如果没有自动完成，请复制浏览器最终回调 URL 并粘贴到后台',
      '4. 完成后可选填写密码，便于后续自动复用旧号'
    ]
  }
}

export function getManualOAuthSessionStatus(sessionId) {
  cleanupExpiredManualSessions()
  const session = manualSessions.get(String(sessionId || '').trim())
  if (!session) return null
  return {
    sessionId: session.sessionId,
    authUrl: session.authUrl,
    status: session.status,
    message: session.message,
    error: session.error,
    callbackReceived: Boolean(session.callbackReceived),
    callbackSource: session.callbackSource || '',
    autoCallbackAvailable: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
    result: session.result,
  }
}

export function submitManualOAuthCallback(sessionId, callbackUrl) {
  const session = manualSessions.get(String(sessionId || '').trim())
  if (!session) throw new Error('OAuth 会话不存在或已过期')
  const parsed = parseOAuthCallbackUrl(callbackUrl)
  if (parsed.state && session.state && parsed.state !== session.state) {
    throw new Error('OAuth state 不匹配')
  }
  session.callbackPayload = parsed
  session.callbackReceived = true
  session.callbackSource = 'manual'
  session.status = 'pending_finalize'
  session.message = '已收到手动回调，可继续完成导入'
  return getManualOAuthSessionStatus(sessionId)
}

export async function finalizeManualOAuthSession(sessionId) {
  const session = manualSessions.get(String(sessionId || '').trim())
  if (!session) throw new Error('OAuth 会话不存在或已过期')
  if (session.result) return session.result
  if (!session.callbackPayload) throw new Error('尚未收到 OAuth 回调')
  if (session.callbackPayload.error) {
    session.status = 'error'
    session.error = session.callbackPayload.error
    throw new Error(`OAuth 返回错误：${session.callbackPayload.error}`)
  }

  const bundle = await exchangeAuthCode({
    code: session.callbackPayload.code,
    codeVerifier: session.codeVerifier,
  })

  session.status = 'completed'
  session.error = ''
  session.message = `已完成 OAuth 换码：${bundle.email || '未知邮箱'}`
  session.result = bundle
  return bundle
}

export function cancelManualOAuthSession(sessionId) {
  const key = String(sessionId || '').trim()
  if (!key) return false
  return manualSessions.delete(key)
}
