import crypto from 'crypto'
import { launchAutoTeamBrowser, takeAutoTeamScreenshot } from './auto-team-browser.js'
import { AUTO_TEAM_REDIRECT_PORT, buildAutoTeamAuthUrl, exchangeAuthCode, generateOpenAIPkce } from './auto-team-oauth.js'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const isLocatorVisible = async (locator, timeout = 3000) => {
  try {
    await locator.waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

const firstVisibleLocator = async (page, selectors = [], timeout = 3000) => {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      if (await isLocatorVisible(locator, timeout)) {
        return locator
      }
    } catch {
      // ignore selector errors
    }
  }
  return null
}

const clickFirstVisible = async (page, selectors = [], timeout = 3000) => {
  const locator = await firstVisibleLocator(page, selectors, timeout)
  if (!locator) return false
  try {
    await locator.click({ force: true, timeout })
    return true
  } catch {
    return false
  }
}

const waitForCloudflare = async (page, maxWaitSeconds = 60) => {
  const deadline = Date.now() + maxWaitSeconds * 1000
  while (Date.now() < deadline) {
    try {
      const html = String(await page.content()).slice(0, 2000).toLowerCase()
      const url = String(page.url() || '').toLowerCase()
      if (!html.includes('verify you are human') && !url.includes('challenge')) {
        return true
      }
    } catch {
      // ignore transient page errors
    }
    await sleep(5000)
  }
  return false
}

const extractOtpCodeFromText = (value) => {
  const match = String(value || '').match(/\b(\d{6})\b/)
  return match?.[1] || ''
}

const waitForOtpCode = async (mailClient, email, {
  timeoutSeconds = 180,
  sinceEmailId = 0,
  senderKeywords = ['openai', 'chatgpt'],
  skipInviteMessages = true,
} = {}) => {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const emails = await mailClient.searchEmailsByRecipient(email, { size: 10 })
    for (const item of emails) {
      const emailId = Number(item?.emailId || 0)
      if (emailId && emailId <= sinceEmailId) continue
      const subject = String(item?.subject || '').toLowerCase()
      if (skipInviteMessages && (subject.includes('invited') || subject.includes('invitation'))) {
        continue
      }
      const sender = String(item?.sendEmail || '').toLowerCase()
      if (senderKeywords.length && !senderKeywords.some(keyword => sender.includes(keyword))) {
        continue
      }
      const code = extractOtpCodeFromText(item?.text || item?.content || '')
      if (code) {
        return { code, emailId, item }
      }
    }
    await sleep(3000)
  }
  return null
}

const fillSingleCharCodeInputs = async (page, code) => {
  try {
    const inputs = await page.locator('input[maxlength="1"]').all()
    if (!inputs.length) return false
    for (let index = 0; index < code.length && index < inputs.length; index += 1) {
      await inputs[index].fill(code[index])
      await sleep(150)
    }
    return true
  } catch {
    return false
  }
}

const clickPrimarySubmit = async (page, fallbackLocator = null, labels = ['Continue', '继续', 'Verify', 'Submit', 'Allow', 'Accept', 'Join']) => {
  const selectors = labels.map(label => `button:has-text("${label}")`)
  selectors.push('button[type="submit"]', 'input[type="submit"]')
  if (await clickFirstVisible(page, selectors, 2500)) return true
  if (fallbackLocator) {
    try {
      await fallbackLocator.press('Enter')
      return true
    } catch {
      return false
    }
  }
  return false
}

export async function registerWithInvite({ inviteLink, email, mailClient, password = '', timeoutSeconds = 180 }) {
  if (!inviteLink) throw new Error('缺少邀请链接')
  const { browser, context } = await launchAutoTeamBrowser()
  let page = null

  try {
    page = await context.newPage()
    await page.goto(inviteLink, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(5000)
    await waitForCloudflare(page)
    await takeAutoTeamScreenshot(page, 'autoteam_reg_01_invite.png')

    await clickFirstVisible(page, [
      'button:has-text("Sign up")',
      'a:has-text("Sign up")',
      'button:has-text("Create account")',
      'a:has-text("Create account")',
      'button:has-text("注册")',
    ], 4000)
    await sleep(3000)

    const emailField = await firstVisibleLocator(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
      'input[id="email"]',
      '#email-input',
    ], 5000)

    if (emailField) {
      await emailField.fill(email)
      await sleep(500)
      await clickPrimarySubmit(page, emailField, ['Continue', '继续'])
      await sleep(5000)
    }
    await takeAutoTeamScreenshot(page, 'autoteam_reg_02_after_email.png')

    const passwordField = await firstVisibleLocator(page, [
      'input[name="password"]',
      'input[type="password"]',
      'input[id="password"]',
    ], 5000)

    let finalPassword = password
    if (passwordField) {
      if (!finalPassword) {
        finalPassword = `Tmp_${Math.random().toString(36).slice(2, 14)}!`
      }
      await passwordField.fill(finalPassword)
      await sleep(500)
      await clickPrimarySubmit(page, passwordField, ['Continue', '继续'])
      await sleep(5000)
    }
    await takeAutoTeamScreenshot(page, 'autoteam_reg_03_after_password.png')

    const otp = await waitForOtpCode(mailClient, email, { timeoutSeconds })
    if (!otp) {
      throw new Error(`等待注册验证码超时：${email}`)
    }

    const singleFilled = await fillSingleCharCodeInputs(page, otp.code)
    if (!singleFilled) {
      const codeField = await firstVisibleLocator(page, [
        'input[name="code"]',
        'input[placeholder*="code" i]',
        'input[inputmode="numeric"]',
        'input[autocomplete="one-time-code"]',
      ], 5000)
      if (!codeField) {
        throw new Error('未找到注册验证码输入框')
      }
      await codeField.fill(otp.code)
      await sleep(300)
      await clickPrimarySubmit(page, codeField, ['Continue', '继续', 'Verify'])
    }
    await sleep(8000)
    await takeAutoTeamScreenshot(page, 'autoteam_reg_04_after_code.png')

    const nameField = await firstVisibleLocator(page, ['input[name="name"]'], 3000)
    if (nameField) {
      await nameField.fill('User')
      await sleep(300)
      try {
        const ageField = page.locator('input[name="age"]').first()
        if (await isLocatorVisible(ageField, 1500)) {
          await ageField.fill('25')
        }
      } catch {
        // ignore
      }
      await clickPrimarySubmit(page, nameField, ['完成帐户创建', 'Continue', '继续'])
      await sleep(6000)
    }

    await clickFirstVisible(page, [
      'button:has-text("Accept")',
      'button:has-text("Join")',
      'button:has-text("加入")',
    ], 3000)
    await sleep(5000)
    await takeAutoTeamScreenshot(page, 'autoteam_reg_05_final.png')

    return {
      success: true,
      password: finalPassword,
      finalUrl: page.url(),
    }
  } finally {
    try { await page?.close() } catch {}
    try { await context.close() } catch {}
    try { await browser.close() } catch {}
  }
}

const maybeHandleLoginOtp = async ({ page, mailClient, email, sinceEmailId = 0, timeoutSeconds = 120 }) => {
  const codeField = await firstVisibleLocator(page, [
    'input[name="code"]',
    'input[placeholder*="code" i]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
  ], 2500)

  if (!codeField) return false
  if (!mailClient) throw new Error('当前登录流程需要邮箱验证码，但未配置 CloudMail')

  const otp = await waitForOtpCode(mailClient, email, {
    sinceEmailId,
    timeoutSeconds,
    senderKeywords: ['openai', 'chatgpt'],
    skipInviteMessages: true,
  })
  if (!otp) {
    throw new Error(`等待登录验证码超时：${email}`)
  }

  const singleFilled = await fillSingleCharCodeInputs(page, otp.code)
  if (!singleFilled) {
    await codeField.fill(otp.code)
  }
  await sleep(300)
  await clickPrimarySubmit(page, codeField, ['Continue', '继续', 'Verify'])
  await sleep(6000)
  return true
}

export async function loginCodexViaBrowser({ email, password = '', mailClient = null, workspaceAccountId = '' }) {
  const { codeVerifier, codeChallenge } = generateOpenAIPkce()
  const state = crypto.randomBytes(16).toString('hex')
  const authUrl = buildAutoTeamAuthUrl({ codeChallenge, state })
  const { browser, context } = await launchAutoTeamBrowser()

  let sinceEmailId = 0
  if (mailClient) {
    try {
      const emails = await mailClient.searchEmailsByRecipient(email, { size: 1 })
      sinceEmailId = Number(emails?.[0]?.emailId || 0)
    } catch {
      sinceEmailId = 0
    }
  }

  if (workspaceAccountId) {
    const cookies = [
      {
        name: '_account',
        value: String(workspaceAccountId),
        domain: 'chatgpt.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: '_account',
        value: String(workspaceAccountId),
        domain: 'auth.openai.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      }
    ]
    try {
      await context.addCookies(cookies)
    } catch {
      // ignore cookie injection failures
    }
  }

  let authCode = ''
  const captureCodeFromUrl = (maybeUrl) => {
    try {
      const parsed = new URL(maybeUrl)
      if (
        !parsed.host.includes(`localhost:${AUTO_TEAM_REDIRECT_PORT}`)
        && !parsed.href.includes(`localhost:${AUTO_TEAM_REDIRECT_PORT}/auth/callback`)
      ) return
      const code = parsed.searchParams.get('code')
      if (code) authCode = code
    } catch {
      // ignore parse errors
    }
  }

  try {
    const prePage = await context.newPage()
    await prePage.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(5000)
    await waitForCloudflare(prePage)

    await clickFirstVisible(prePage, [
      'button:has-text("登录")',
      'button:has-text("Log in")',
    ], 4000)
    await sleep(2500)

    const preEmailField = await firstVisibleLocator(prePage, [
      'input[name="email"]',
      'input[type="email"]',
      'input[id="email"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
    ], 5000)
    if (preEmailField) {
      await preEmailField.fill(email)
      await sleep(300)
      await clickPrimarySubmit(prePage, preEmailField, ['Continue', '继续'])
      await sleep(3000)
    }

    const prePasswordField = await firstVisibleLocator(prePage, [
      'input[name="password"]',
      'input[type="password"]',
    ], 3000)
    if (prePasswordField) {
      if (password) {
        await prePasswordField.fill(password)
        await sleep(300)
        await clickPrimarySubmit(prePage, prePasswordField, ['Continue', '继续', 'Log in'])
      } else {
        await clickFirstVisible(prePage, [
          'button:has-text("一次性验证码")',
          'button:has-text("one-time")',
          'button:has-text("email login")',
        ], 2000)
      }
      await sleep(5000)
    }

    await maybeHandleLoginOtp({ page: prePage, mailClient, email, sinceEmailId, timeoutSeconds: 120 }).catch(() => false)
    await takeAutoTeamScreenshot(prePage, 'autoteam_codex_00_chatgpt_login.png')

    await prePage.close()

    const page = await context.newPage()
    page.on('request', request => captureCodeFromUrl(request.url()))
    page.on('response', response => captureCodeFromUrl(response.url()))
    page.on('framenavigated', frame => captureCodeFromUrl(frame.url()))

    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(3000)
    await takeAutoTeamScreenshot(page, 'autoteam_codex_01_auth_page.png')

    const emailField = await firstVisibleLocator(page, [
      'input[name="email"]',
      'input[id="email-input"]',
      'input[id="email"]',
      'input[type="email"]',
    ], 5000)
    if (emailField) {
      await emailField.fill(email)
      await sleep(300)
      await clickPrimarySubmit(page, emailField, ['Continue', '继续'])
      await sleep(3000)
    }

    const passwordField = await firstVisibleLocator(page, [
      'input[name="password"]',
      'input[type="password"]',
    ], 3000)
    if (passwordField) {
      if (password) {
        await passwordField.fill(password)
        await sleep(300)
        await clickPrimarySubmit(page, passwordField, ['Continue', '继续', 'Log in'])
      } else {
        await clickFirstVisible(page, [
          'button:has-text("一次性验证码")',
          'button:has-text("one-time")',
          'button:has-text("email login")',
        ], 2000)
      }
      await sleep(5000)
    }

    await maybeHandleLoginOtp({ page, mailClient, email, sinceEmailId, timeoutSeconds: 120 }).catch(() => false)

    const nameField = await firstVisibleLocator(page, ['input[name="name"]'], 2000)
    if (nameField) {
      await nameField.fill('User')
      await sleep(300)
      await clickPrimarySubmit(page, nameField, ['完成帐户创建', 'Continue', '继续'])
      await sleep(5000)
    }

    for (let step = 0; step < 12 && !authCode; step += 1) {
      await maybeHandleLoginOtp({ page, mailClient, email, sinceEmailId, timeoutSeconds: 60 }).catch(() => false)
      await clickFirstVisible(page, [
        'button:has-text("继续")',
        'button:has-text("Continue")',
        'button:has-text("Allow")',
        'button:has-text("Accept")',
        'button:has-text("Join")',
        'button[type="submit"]',
      ], 2500)
      await sleep(3000)
      captureCodeFromUrl(page.url())
    }

    captureCodeFromUrl(page.url())
    await takeAutoTeamScreenshot(page, authCode ? 'autoteam_codex_02_success.png' : 'autoteam_codex_02_no_callback.png')

    if (!authCode) {
      throw new Error(`未获取到 Codex OAuth authorization code：${page.url()}`)
    }

    return await exchangeAuthCode({ code: authCode, codeVerifier, fallbackEmail: email })
  } finally {
    try { await context.close() } catch {}
    try { await browser.close() } catch {}
  }
}
