import { getAutoTeamSettings } from './auto-team-config.js'
import { checkAutoTeamAccounts, getAutoTeamSummary, rotateAutoTeamAccounts } from './auto-team-manager.js'

const LABEL = '[AutoTeamScheduler]'
const DEFAULT_IDLE_DELAY_MS = 60 * 1000

let schedulerTimer = null
let running = false
let started = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const resolveDelayMs = async () => {
  try {
    const settings = await getAutoTeamSettings()
    const seconds = Math.max(60, Number(settings?.autoCheck?.intervalSeconds || 300))
    return seconds * 1000
  } catch {
    return DEFAULT_IDLE_DELAY_MS
  }
}

const scheduleNext = async (delayMs = null) => {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer)
    schedulerTimer = null
  }

  const actualDelay = Math.max(10 * 1000, Number(delayMs ?? await resolveDelayMs()) || DEFAULT_IDLE_DELAY_MS)
  schedulerTimer = setTimeout(() => {
    runAutoTeamSchedulerOnce().catch(error => {
      console.error(`${LABEL} uncaught run error:`, error)
    })
  }, actualDelay)
}

export async function runAutoTeamSchedulerOnce() {
  if (running) {
    console.log(`${LABEL} previous run still in progress, skip this tick`)
    await scheduleNext(DEFAULT_IDLE_DELAY_MS)
    return { skipped: true, reason: 'running' }
  }

  running = true
  try {
    const settings = await getAutoTeamSettings()
    const enabled = Boolean(settings?.enabled)
    const autoCheckEnabled = Boolean(settings?.autoCheck?.enabled)
    if (!enabled || !autoCheckEnabled) {
      await scheduleNext(DEFAULT_IDLE_DELAY_MS)
      return {
        skipped: true,
        reason: !enabled ? 'disabled' : 'auto_check_disabled'
      }
    }

    const thresholdPercent = Math.max(1, Number(settings.autoCheck.thresholdPercent || 10))
    const minLow = Math.max(1, Number(settings.autoCheck.minLow || 1))
    const targetSeats = Math.max(1, Number(settings.targetSeats || 1))

    console.log(`${LABEL} start check`, {
      thresholdPercent,
      minLow,
      targetSeats,
      intervalSeconds: settings.autoCheck.intervalSeconds,
    })

    const checkResult = await checkAutoTeamAccounts({ thresholdPercent })
    await sleep(300)
    const summary = await getAutoTeamSummary()
    const lowCount = Array.isArray(checkResult?.lowAccounts) ? checkResult.lowAccounts.length : 0
    const activeCount = Number(summary?.active || 0)
    const shouldRotate = lowCount >= minLow || activeCount < targetSeats

    let rotateResult = null
    if (shouldRotate) {
      console.log(`${LABEL} trigger rotate`, {
        lowCount,
        minLow,
        activeCount,
        targetSeats,
      })
      rotateResult = await rotateAutoTeamAccounts({ thresholdPercent, targetSeats })
    }

    await scheduleNext()
    return {
      skipped: false,
      lowCount,
      activeCount,
      targetSeats,
      shouldRotate,
      checkResult,
      summary,
      rotateResult,
    }
  } catch (error) {
    console.error(`${LABEL} run failed:`, error)
    await scheduleNext(DEFAULT_IDLE_DELAY_MS)
    return {
      skipped: false,
      error: error?.message || String(error),
    }
  } finally {
    running = false
  }
}

export function startAutoTeamScheduler() {
  if (started) {
    return stopAutoTeamScheduler
  }
  started = true
  console.log(`${LABEL} started`)
  scheduleNext(15 * 1000).catch(error => {
    console.error(`${LABEL} failed to schedule initial run:`, error)
  })
  return stopAutoTeamScheduler
}

export function stopAutoTeamScheduler() {
  started = false
  running = false
  if (schedulerTimer) {
    clearTimeout(schedulerTimer)
    schedulerTimer = null
  }
  console.log(`${LABEL} stopped`)
}
