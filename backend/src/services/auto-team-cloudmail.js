import axios from 'axios'

const DEFAULT_HEADERS = Object.freeze({
  'Content-Type': 'application/json'
})

export class AutoTeamCloudMailClient {
  constructor(settings = {}) {
    this.baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '')
    this.email = String(settings.email || '').trim()
    this.password = String(settings.password || '').trim()
    this.pollIntervalSeconds = Math.max(1, Number(settings.pollIntervalSeconds) || 3)
    this.pollTimeoutSeconds = Math.max(30, Number(settings.pollTimeoutSeconds) || 180)
    this.token = null
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 60000,
      validateStatus: () => true,
    })
  }

  assertConfigured() {
    if (!this.baseUrl || !this.email || !this.password) {
      throw new Error('CloudMail 配置不完整，请先填写地址、邮箱和密码')
    }
  }

  buildHeaders() {
    return this.token
      ? { ...DEFAULT_HEADERS, Authorization: this.token }
      : { ...DEFAULT_HEADERS }
  }

  async request(method, path, { params, data } = {}) {
    this.assertConfigured()
    const response = await this.client.request({
      url: path,
      method,
      params,
      data,
      headers: this.buildHeaders()
    })

    const rawBodySnippet =
      typeof response.data === 'string'
        ? response.data.trim().slice(0, 500)
        : JSON.stringify(response.data || '').slice(0, 500)

    const payload = response.data && typeof response.data === 'object'
      ? { ...response.data, _httpStatus: response.status, _rawBodySnippet: rawBodySnippet }
      : { code: response.status, data: response.data, _httpStatus: response.status, _rawBodySnippet: rawBodySnippet }

    return payload
  }

  async login() {
    const payload = await this.request('POST', '/login', {
      data: {
        email: this.email,
        password: this.password,
      }
    })

    if (Number(payload?.code) !== 200 || !payload?.data?.token) {
      const detail =
        payload?.message
        || payload?.msg
        || payload?.error
        || payload?.data?.message
        || payload?._rawBodySnippet
        || `HTTP ${payload?._httpStatus || 'unknown'}`
      throw new Error(`CloudMail 登录失败（${this.baseUrl}/login）：${detail}`)
    }

    this.token = String(payload.data.token)
    return this.token
  }

  async createTempEmail({ prefix, domain } = {}) {
    const actualPrefix = String(prefix || `tmp-${Math.random().toString(36).slice(2, 10)}`).trim().toLowerCase()
    const normalizedDomain = String(domain || '').trim()
    if (!actualPrefix || !normalizedDomain) {
      throw new Error('创建临时邮箱失败：缺少前缀或域名')
    }

    const email = `${actualPrefix}${normalizedDomain}`
    const payload = await this.request('POST', '/account/add', { data: { email } })
    if (Number(payload?.code) !== 200 || !payload?.data?.accountId) {
      const detail =
        payload?.message
        || payload?.msg
        || payload?.error
        || payload?._rawBodySnippet
        || `HTTP ${payload?._httpStatus || 'unknown'}`
      throw new Error(`CloudMail 创建邮箱失败：${detail}`)
    }

    return {
      accountId: String(payload.data.accountId),
      email,
      raw: payload,
    }
  }

  async searchEmailsByRecipient(toEmail, { size = 10 } = {}) {
    const payload = await this.request('GET', '/allEmail/list', {
      params: {
        emailId: 0,
        size,
        timeSort: 0,
        accountEmail: String(toEmail || '').trim(),
      }
    })

    if (Number(payload?.code) !== 200) return []
    return Array.isArray(payload?.data?.list) ? payload.data.list : []
  }

  async listEmails(accountId, { size = 10 } = {}) {
    const payload = await this.request('GET', '/email/list', {
      params: {
        accountId,
        type: 1,
        size,
        emailId: 0,
        timeSort: 0,
      }
    })

    if (Number(payload?.code) !== 200) return []
    return Array.isArray(payload?.data?.list) ? payload.data.list : []
  }

  async waitForEmail(toEmail, { timeoutSeconds, senderKeyword, predicate } = {}) {
    const timeout = Math.max(30, Number(timeoutSeconds) || this.pollTimeoutSeconds)
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeout * 1000) {
      const emails = await this.searchEmailsByRecipient(toEmail, { size: 10 })
      for (const email of emails) {
        const sender = String(email?.sendEmail || '')
        if (senderKeyword && !sender.toLowerCase().includes(String(senderKeyword).toLowerCase())) {
          continue
        }
        if (typeof predicate === 'function' && !predicate(email)) {
          continue
        }
        return email
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalSeconds * 1000))
    }

    throw new Error(`等待 CloudMail 邮件超时：${toEmail}`)
  }

  extractInviteLink(emailData = {}) {
    const html = String(emailData?.content || '')
    const text = String(emailData?.text || '')

    const htmlMatch = html.match(/href="(https:\/\/chatgpt\.com\/auth\/login\?[^"]*)"/i)
    if (htmlMatch?.[1]) return htmlMatch[1]

    const textMatch = text.match(/(https:\/\/chatgpt\.com\/auth\/login\?[^\s<>"']+)/i)
    if (textMatch?.[1]) return textMatch[1]

    const genericMatch = (html || text).match(/https?:\/\/[^\s<>"']+(?:invite|accept|join|workspace)[^\s<>"']*/i)
    return genericMatch?.[0] || null
  }

  async deleteEmailsFor(toEmail) {
    const emails = await this.searchEmailsByRecipient(toEmail, { size: 50 })
    let deleted = 0
    for (const email of emails) {
      const emailId = email?.emailId
      if (!emailId) continue
      try {
        await this.request('DELETE', '/email/delete', { params: { emailId } })
        deleted += 1
      } catch {
        // ignore single delete failures
      }
    }
    return deleted
  }

  async deleteAccount(accountId) {
    const payload = await this.request('DELETE', '/account/delete', { params: { accountId } })
    if (Number(payload?.code) !== 200) {
      const detail =
        payload?.message
        || payload?.msg
        || payload?.error
        || payload?._rawBodySnippet
        || `HTTP ${payload?._httpStatus || 'unknown'}`
      throw new Error(`CloudMail 删除邮箱失败：${detail}`)
    }
    return payload
  }
}
