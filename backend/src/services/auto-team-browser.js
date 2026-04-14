import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright-core'
import { getDatabase } from '../database/init.js'
import { getAutoTeamSettings } from './auto-team-config.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

const CANDIDATE_EXECUTABLES = [
  process.env.AUTO_TEAM_BROWSER_EXECUTABLE,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

const hasVisibleBrowserDisplay = () => {
  const display = String(process.env.DISPLAY || '').trim()
  const waylandDisplay = String(process.env.WAYLAND_DISPLAY || '').trim()
  return Boolean(display || waylandDisplay)
}

export const resolveAutoTeamBrowserRuntime = (settings = null) => {
  const requestedHeadless = Boolean(settings?.browser?.headless)
  const displayAvailable = hasVisibleBrowserDisplay()
  const forcedHeadless = !requestedHeadless && !displayAvailable

  return {
    requestedHeadless,
    displayAvailable,
    forcedHeadless,
    effectiveHeadless: requestedHeadless || !displayAvailable,
  }
}

export const resolveAutoTeamArtifactsDir = () => {
  const explicit = String(process.env.AUTO_TEAM_ARTIFACTS_DIR || '').trim()
  if (explicit) return explicit
  const dbPath = String(process.env.DATABASE_PATH || '').trim()
  if (dbPath) {
    const baseDir = path.dirname(path.resolve(dbPath))
    return path.join(baseDir, 'autoteam-artifacts')
  }
  return path.resolve(process.cwd(), 'data', 'autoteam-artifacts')
}

export async function resolveAutoTeamBrowserExecutablePath() {
  const db = await getDatabase()
  const settings = await getAutoTeamSettings({ db })
  const preferred = String(settings?.browser?.executablePath || '').trim()
  const candidates = preferred ? [preferred, ...CANDIDATE_EXECUTABLES] : CANDIDATE_EXECUTABLES
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore invalid paths
    }
  }
  return ''
}

export async function launchAutoTeamBrowser() {
  const db = await getDatabase()
  const settings = await getAutoTeamSettings({ db })
  const executablePath = await resolveAutoTeamBrowserExecutablePath()
  const browserRuntime = resolveAutoTeamBrowserRuntime(settings)
  if (!executablePath) {
    throw new Error('未找到 Chromium/Chrome 可执行文件，请在系统设置中填写浏览器路径，或在服务器安装 chromium')
  }

  if (browserRuntime.forcedHeadless) {
    console.warn('[AutoTeam] browser.headless=false 但当前环境未检测到 DISPLAY/WAYLAND_DISPLAY，已自动切换为 headless 模式')
  }

  const browser = await chromium.launch({
    executablePath,
    headless: browserRuntime.effectiveHeadless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  })

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    userAgent: DEFAULT_USER_AGENT,
  })

  return { browser, context, executablePath, ...browserRuntime }
}

export async function takeAutoTeamScreenshot(page, name) {
  if (!page || !name) return null
  try {
    const baseDir = resolveAutoTeamArtifactsDir()
    const screenshotsDir = path.join(baseDir, 'screenshots')
    fs.mkdirSync(screenshotsDir, { recursive: true })
    const filePath = path.join(screenshotsDir, name)
    await page.screenshot({ path: filePath, fullPage: true })
    return filePath
  } catch {
    return null
  }
}
