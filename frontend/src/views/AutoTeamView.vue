<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  autoTeamService,
  type AutoTeamAccount,
  type AutoTeamCpaFile,
  type AutoTeamDiagnostics,
  type AutoTeamManagerCandidate,
  type AutoTeamManualOAuthSession,
  type AutoTeamSettings,
  type AutoTeamStatus,
  type AutoTeamSummary,
} from '@/services/api'
import { useToast } from '@/components/ui/toast'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RefreshCw, Plus, RotateCw, ShieldCheck, Trash2, Copy, KeyRound, Search } from 'lucide-vue-next'

const { success: showSuccessToast, error: showErrorToast, info: showInfoToast } = useToast()

const loading = ref(true)
const savingSettings = ref(false)
const testingCloudmail = ref(false)
const testingCpa = ref(false)
const refreshing = ref(false)
const creating = ref(false)
const checking = ref(false)
const rotating = ref(false)
const syncingCpa = ref(false)
const loadingCpaFiles = ref(false)
const deletingAccountId = ref<number | null>(null)
const changingStatusId = ref<number | null>(null)
const errorMessage = ref('')
const operationMessage = ref('')

const summary = ref<AutoTeamSummary | null>(null)
const diagnostics = ref<AutoTeamDiagnostics | null>(null)
const accounts = ref<AutoTeamAccount[]>([])
const cpaFiles = ref<AutoTeamCpaFile[]>([])
const managerCandidates = ref<AutoTeamManagerCandidate[]>([])
const searchQuery = ref('')
const statusFilter = ref<'all' | AutoTeamStatus>('all')

const createDefaultSettings = (): AutoTeamSettings => ({
  enabled: false,
  managerAccountId: 0,
  targetSeats: 5,
  autoCheck: {
    enabled: true,
    intervalSeconds: 300,
    thresholdPercent: 10,
    minLow: 2,
  },
  cloudmail: {
    baseUrl: '',
    email: '',
    domain: '',
    passwordSet: false,
    passwordStored: false,
    password: '',
  },
  browser: {
    executablePath: '',
    headless: true,
  },
  mailPolling: {
    intervalSeconds: 3,
    timeoutSeconds: 180,
  },
  cpa: {
    enabled: false,
    baseUrl: '',
    keySet: false,
    keyStored: false,
    key: '',
    syncOnChange: true,
  },
})

const settingsForm = reactive<AutoTeamSettings>(createDefaultSettings())
const cloudmailPasswordInput = ref('')

const effectiveBrowserHeadless = computed(() => {
  const runtimeHeadless = diagnostics.value?.browser?.effectiveHeadless
  return typeof runtimeHeadless === 'boolean'
    ? runtimeHeadless
    : Boolean(settingsForm.browser.headless)
})

const browserModeDescription = computed(() => {
  if (diagnostics.value?.browser?.forcedHeadless) {
    return 'Headless 模式（服务器无 DISPLAY，已自动降级）'
  }
  return effectiveBrowserHeadless.value ? 'Headless 模式' : '可视化模式'
})

const manualSession = ref<AutoTeamManualOAuthSession | null>(null)
const manualCallbackUrl = ref('')
const manualImportPassword = ref('')
const manualStarting = ref(false)
const manualSubmitting = ref(false)
const manualFinalizing = ref(false)
const manualCancelling = ref(false)
let manualPollTimer: ReturnType<typeof setInterval> | null = null

const resolveError = (error: any, fallback: string) => {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback
}

const applySettings = (incoming?: AutoTeamSettings | null) => {
  const next = incoming || createDefaultSettings()
  settingsForm.enabled = Boolean(next.enabled)
  settingsForm.managerAccountId = Number(next.managerAccountId || 0)
  settingsForm.targetSeats = Number(next.targetSeats || 5)

  settingsForm.autoCheck.enabled = Boolean(next.autoCheck?.enabled)
  settingsForm.autoCheck.intervalSeconds = Number(next.autoCheck?.intervalSeconds || 300)
  settingsForm.autoCheck.thresholdPercent = Number(next.autoCheck?.thresholdPercent || 10)
  settingsForm.autoCheck.minLow = Number(next.autoCheck?.minLow || 2)

  settingsForm.cloudmail.baseUrl = String(next.cloudmail?.baseUrl || '')
  settingsForm.cloudmail.email = String(next.cloudmail?.email || '')
  settingsForm.cloudmail.domain = String(next.cloudmail?.domain || '')
  settingsForm.cloudmail.passwordSet = Boolean(next.cloudmail?.passwordSet)
  settingsForm.cloudmail.passwordStored = Boolean(next.cloudmail?.passwordStored)
  settingsForm.cloudmail.password = ''

  settingsForm.browser.executablePath = String(next.browser?.executablePath || '')
  settingsForm.browser.headless = Boolean(next.browser?.headless)

  settingsForm.mailPolling.intervalSeconds = Number(next.mailPolling?.intervalSeconds || 3)
  settingsForm.mailPolling.timeoutSeconds = Number(next.mailPolling?.timeoutSeconds || 180)

  settingsForm.cpa.enabled = Boolean(next.cpa?.enabled)
  settingsForm.cpa.baseUrl = String(next.cpa?.baseUrl || '')
  settingsForm.cpa.keySet = Boolean(next.cpa?.keySet)
  settingsForm.cpa.keyStored = Boolean(next.cpa?.keyStored)
  settingsForm.cpa.key = ''
  settingsForm.cpa.syncOnChange = Boolean(next.cpa?.syncOnChange ?? true)

  cloudmailPasswordInput.value = ''
}

const refreshCpaFiles = async ({ silent = false } = {}) => {
  const cpaConfigured = Boolean(
    settingsForm.cpa.baseUrl.trim()
    && (settingsForm.cpa.keySet || String(settingsForm.cpa.key || '').trim())
  )

  if (!cpaConfigured) {
    cpaFiles.value = []
    return
  }

  if (!silent) {
    loadingCpaFiles.value = true
  }

  try {
    const result = await autoTeamService.getCpaFiles()
    cpaFiles.value = result.files || []
  } catch (error: any) {
    const message = resolveError(error, '获取 CPA 文件列表失败')
    cpaFiles.value = []
    if (!silent) {
      errorMessage.value = message
      showErrorToast(message)
    }
  } finally {
    loadingCpaFiles.value = false
  }
}

const loadData = async ({ silent = false } = {}) => {
  if (!silent) {
    loading.value = true
  } else {
    refreshing.value = true
  }
  errorMessage.value = ''

  try {
    const [summaryData, diagnosticsData, accountData, settingsData, candidatesData] = await Promise.all([
      autoTeamService.getSummary(),
      autoTeamService.getDiagnostics(),
      autoTeamService.getAccounts(),
      autoTeamService.getSettings(),
      autoTeamService.getManagerCandidates(),
    ])
    summary.value = summaryData
    diagnostics.value = diagnosticsData
    accounts.value = accountData.accounts || []
    applySettings(settingsData)
    managerCandidates.value = candidatesData.items || []
    await refreshCpaFiles({ silent: true })
  } catch (error: any) {
    errorMessage.value = resolveError(error, '加载 AutoTeam 数据失败')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

const reloadAccountsAndSummary = async () => {
  const [summaryData, diagnosticsData, accountData] = await Promise.all([
    autoTeamService.getSummary(),
    autoTeamService.getDiagnostics(),
    autoTeamService.getAccounts(),
  ])
  summary.value = summaryData
  diagnostics.value = diagnosticsData
  accounts.value = accountData.accounts || []
  await refreshCpaFiles({ silent: true })
}

const buildSettingsPayload = (): AutoTeamSettings => {
  const payload: AutoTeamSettings = {
    enabled: Boolean(settingsForm.enabled),
    managerAccountId: Number(settingsForm.managerAccountId || 0),
    targetSeats: Math.max(1, Number(settingsForm.targetSeats || 1)),
    autoCheck: {
      enabled: Boolean(settingsForm.autoCheck.enabled),
      intervalSeconds: Math.max(60, Number(settingsForm.autoCheck.intervalSeconds || 300)),
      thresholdPercent: Math.max(1, Math.min(100, Number(settingsForm.autoCheck.thresholdPercent || 10))),
      minLow: Math.max(1, Number(settingsForm.autoCheck.minLow || 1)),
    },
    cloudmail: {
      baseUrl: String(settingsForm.cloudmail.baseUrl || '').trim(),
      email: String(settingsForm.cloudmail.email || '').trim(),
      domain: String(settingsForm.cloudmail.domain || '').trim(),
      passwordSet: Boolean(settingsForm.cloudmail.passwordSet),
      passwordStored: Boolean(settingsForm.cloudmail.passwordStored),
    },
    browser: {
      executablePath: String(settingsForm.browser.executablePath || '').trim(),
      headless: Boolean(settingsForm.browser.headless),
    },
    mailPolling: {
      intervalSeconds: Math.max(1, Number(settingsForm.mailPolling.intervalSeconds || 3)),
      timeoutSeconds: Math.max(30, Number(settingsForm.mailPolling.timeoutSeconds || 180)),
    },
    cpa: {
      enabled: Boolean(settingsForm.cpa.enabled),
      baseUrl: String(settingsForm.cpa.baseUrl || '').trim(),
      keySet: Boolean(settingsForm.cpa.keySet),
      keyStored: Boolean(settingsForm.cpa.keyStored),
      syncOnChange: Boolean(settingsForm.cpa.syncOnChange),
    },
  }

  if (cloudmailPasswordInput.value.trim()) {
    payload.cloudmail.password = cloudmailPasswordInput.value.trim()
  }

  const cpaKey = String(settingsForm.cpa.key || '').trim()
  if (cpaKey) {
    payload.cpa.key = cpaKey
  }

  return payload
}

const saveSettings = async () => {
  savingSettings.value = true
  errorMessage.value = ''
  try {
    const response = await autoTeamService.updateSettings(buildSettingsPayload())
    applySettings(response.settings)
    operationMessage.value = response.message || 'AutoTeam 设置已保存'
    showSuccessToast(operationMessage.value)
    await loadData({ silent: true })
  } catch (error: any) {
    const message = resolveError(error, '保存 AutoTeam 设置失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    savingSettings.value = false
  }
}

const testCloudMail = async () => {
  testingCloudmail.value = true
  try {
    const result = await autoTeamService.testCloudMail()
    const message = result.message || 'CloudMail 登录成功'
    operationMessage.value = message
    showSuccessToast(message)
  } catch (error: any) {
    const message = resolveError(error, 'CloudMail 测试失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    testingCloudmail.value = false
  }
}

const testCpa = async () => {
  testingCpa.value = true
  try {
    const result = await autoTeamService.testCpa()
    const message = result.message || `CPA 连接成功，当前 ${result.total || 0} 个认证文件`
    operationMessage.value = message
    cpaFiles.value = result.files || []
    showSuccessToast(message)
  } catch (error: any) {
    const message = resolveError(error, 'CPA 测试失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    testingCpa.value = false
  }
}

const syncToCpa = async () => {
  syncingCpa.value = true
  try {
    const result = await autoTeamService.syncToCpa()
    operationMessage.value = result.message || 'CPA 同步完成'
    showSuccessToast(operationMessage.value)
    await refreshCpaFiles({ silent: true })
  } catch (error: any) {
    const message = resolveError(error, '同步到 CPA 失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    syncingCpa.value = false
  }
}

const copyText = async (value: string, successText: string) => {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    showInfoToast(successText)
  } catch {
    showErrorToast('复制失败，请手动复制')
  }
}

const formatDateTime = (value?: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

const formatUnixSeconds = (value?: number | null) => {
  if (!value) return '-'
  return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false })
}

const formatUnixMs = (value?: number | null) => {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const quotaRemainingLabel = (account: AutoTeamAccount) => {
  if (account.quotaPrimaryPct == null) return '未检查'
  return `${Math.max(0, 100 - Number(account.quotaPrimaryPct || 0)).toFixed(0)}%`
}

const statusClass = (status: string) => {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-700'
    case 'standby':
      return 'bg-slate-100 text-slate-700'
    case 'exhausted':
      return 'bg-amber-100 text-amber-700'
    case 'pending':
      return 'bg-blue-100 text-blue-700'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

const statusText = (status: string) => {
  switch (status) {
    case 'active':
      return '活跃'
    case 'standby':
      return '待命'
    case 'exhausted':
      return '额度不足'
    case 'pending':
      return '处理中'
    default:
      return status || '-'
  }
}

const activeAccounts = computed(() => accounts.value.filter(item => item.status === 'active').length)
const unhealthyAccounts = computed(() => accounts.value.filter(item => item.lastError).length)
const filteredAccounts = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase()
  return accounts.value.filter((account) => {
    const matchesStatus = statusFilter.value === 'all' ? true : account.status === statusFilter.value
    if (!matchesStatus) return false
    if (!keyword) return true
    return [
      account.email,
      account.planType || '',
      account.chatgptAccountId || '',
      account.lastError || '',
      String(account.id || ''),
    ].some(value => String(value || '').toLowerCase().includes(keyword))
  })
})
const diagnosticWarnings = computed(() => {
  const warnings: string[] = []
  if (!diagnostics.value?.browser?.available) {
    warnings.push('未检测到 Chromium / Chrome 可执行文件，自动注册与浏览器登录暂不可用。')
  }
  if (!diagnostics.value?.cloudmail?.configured) {
    warnings.push('CloudMail 配置不完整，邮箱验证码与自动注册暂不可用。')
  }
  if (!diagnostics.value?.manager?.configured) {
    warnings.push(diagnostics.value?.manager?.error || '尚未配置工作区管理员账号。')
  }
  if (settingsForm.cpa.enabled && !diagnostics.value?.cpa?.configured) {
    warnings.push('已启用 CPA 自动同步，但 CPA Base URL / 管理密钥尚未配置完整。')
  }
  if (!managerCandidates.value.length) {
    warnings.push('当前没有可选的 GPT 管理账号，请先在账号管理中准备一个带 token 和 workspace ID 的账号。')
  }
  return warnings
})

const createAccount = async () => {
  creating.value = true
  errorMessage.value = ''
  try {
    const response = await autoTeamService.createAccount()
    operationMessage.value = response.message || 'AutoTeam 新账号创建成功'
    showSuccessToast(operationMessage.value)
    await reloadAccountsAndSummary()
  } catch (error: any) {
    const message = resolveError(error, '创建 AutoTeam 账号失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    creating.value = false
  }
}

const checkAccounts = async () => {
  checking.value = true
  errorMessage.value = ''
  try {
    const result = await autoTeamService.checkAccounts(settingsForm.autoCheck.thresholdPercent)
    operationMessage.value = `已完成额度巡检：检查 ${result.checkedCount} 个活跃账号，低额度 ${result.lowAccounts.length} 个`
    showSuccessToast(operationMessage.value)
    await reloadAccountsAndSummary()
  } catch (error: any) {
    const message = resolveError(error, '检查额度失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    checking.value = false
  }
}

const rotateAccounts = async () => {
  rotating.value = true
  errorMessage.value = ''
  try {
    const result = await autoTeamService.rotateAccounts({
      targetSeats: settingsForm.targetSeats,
      thresholdPercent: settingsForm.autoCheck.thresholdPercent,
    })
    operationMessage.value = `轮转完成：移出 ${result.removed.length} 个，复用 ${result.reused.length} 个，新建 ${result.created.length} 个`
    showSuccessToast(operationMessage.value)
    await reloadAccountsAndSummary()
  } catch (error: any) {
    const message = resolveError(error, '执行轮转失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    rotating.value = false
  }
}

const deleteAccount = async (account: AutoTeamAccount) => {
  const confirmed = window.confirm(`确认删除账号 ${account.email} 吗？该操作只删除 AutoTeam 记录，不会自动删除 GPT 主账号。`)
  if (!confirmed) return

  deletingAccountId.value = account.id
  try {
    const result = await autoTeamService.deleteAccount(account.id)
    operationMessage.value = result.message || `已删除账号 ${account.email}`
    showSuccessToast(operationMessage.value)
    await reloadAccountsAndSummary()
  } catch (error: any) {
    const message = resolveError(error, '删除账号失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    deletingAccountId.value = null
  }
}

const setAccountStatus = async (account: AutoTeamAccount, status: AutoTeamStatus) => {
  changingStatusId.value = account.id
  try {
    const result = await autoTeamService.setAccountStatus(account.id, status)
    operationMessage.value = result.message || `已更新 ${account.email} 状态`
    showSuccessToast(operationMessage.value)
    await reloadAccountsAndSummary()
  } catch (error: any) {
    const message = resolveError(error, '更新账号状态失败')
    errorMessage.value = message
    showErrorToast(message)
  } finally {
    changingStatusId.value = null
  }
}

const stopManualPolling = () => {
  if (manualPollTimer) {
    clearInterval(manualPollTimer)
    manualPollTimer = null
  }
}

const refreshManualSession = async () => {
  if (!manualSession.value?.sessionId) return
  try {
    manualSession.value = await autoTeamService.getManualOAuthSession(manualSession.value.sessionId)
    const status = manualSession.value.status || ''
    if (status === 'completed' || status === 'error') {
      stopManualPolling()
    }
  } catch (error: any) {
    stopManualPolling()
    showErrorToast(resolveError(error, '获取 OAuth 会话状态失败'))
  }
}

const startManualPolling = () => {
  stopManualPolling()
  manualPollTimer = setInterval(() => {
    refreshManualSession().catch(() => undefined)
  }, 3000)
}

const startManualOAuth = async () => {
  manualStarting.value = true
  try {
    manualSession.value = await autoTeamService.startManualOAuth()
    manualCallbackUrl.value = ''
    manualImportPassword.value = ''
    operationMessage.value = '已生成 Codex OAuth 链接'
    showSuccessToast(operationMessage.value)
    startManualPolling()
  } catch (error: any) {
    showErrorToast(resolveError(error, '启动手动 OAuth 失败'))
  } finally {
    manualStarting.value = false
  }
}

const submitManualCallback = async () => {
  if (!manualSession.value?.sessionId) return
  if (!manualCallbackUrl.value.trim()) {
    showErrorToast('请先粘贴完整回调 URL')
    return
  }

  manualSubmitting.value = true
  try {
    manualSession.value = await autoTeamService.submitManualOAuthCallback(manualSession.value.sessionId, manualCallbackUrl.value.trim())
    showSuccessToast('已提交回调 URL，可以继续完成导入')
  } catch (error: any) {
    showErrorToast(resolveError(error, '提交回调 URL 失败'))
  } finally {
    manualSubmitting.value = false
  }
}

const finalizeManualOAuth = async () => {
  if (!manualSession.value?.sessionId) return
  manualFinalizing.value = true
  try {
    const result = await autoTeamService.finalizeManualOAuth(manualSession.value.sessionId, manualImportPassword.value.trim() || undefined)
    manualSession.value = result.session
    operationMessage.value = result.message || 'OAuth 导入完成'
    showSuccessToast(operationMessage.value)
    stopManualPolling()
    await reloadAccountsAndSummary()
  } catch (error: any) {
    showErrorToast(resolveError(error, '完成 OAuth 导入失败'))
  } finally {
    manualFinalizing.value = false
  }
}

const cancelManualOAuth = async () => {
  if (!manualSession.value?.sessionId) return
  manualCancelling.value = true
  try {
    await autoTeamService.cancelManualOAuthSession(manualSession.value.sessionId)
    manualSession.value = null
    manualCallbackUrl.value = ''
    manualImportPassword.value = ''
    stopManualPolling()
    showInfoToast('已取消当前 OAuth 会话')
  } catch (error: any) {
    showErrorToast(resolveError(error, '取消 OAuth 会话失败'))
  } finally {
    manualCancelling.value = false
  }
}

onMounted(() => {
  loadData()
})

onUnmounted(() => {
  stopManualPolling()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">AutoTeam</h1>
        <p class="text-sm text-muted-foreground">
          CloudMail 临时邮箱、Codex OAuth、账号池轮转与后台巡检的一体化面板。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" :disabled="refreshing" @click="loadData({ silent: true })">
          <RefreshCw class="mr-2 h-4 w-4" :class="refreshing ? 'animate-spin' : ''" />
          刷新
        </Button>
        <Button variant="outline" :disabled="syncingCpa" @click="syncToCpa">
          {{ syncingCpa ? '同步中...' : '同步到 CPA' }}
        </Button>
        <Button :disabled="manualStarting" @click="startManualOAuth">
          <KeyRound class="mr-2 h-4 w-4" />
          手动 OAuth 导入
        </Button>
        <Button variant="outline" :disabled="creating" @click="createAccount">
          <Plus class="mr-2 h-4 w-4" />
          自动注册新号
        </Button>
        <Button variant="outline" :disabled="checking" @click="checkAccounts">
          <Search class="mr-2 h-4 w-4" />
          检查额度
        </Button>
        <Button variant="outline" :disabled="rotating" @click="rotateAccounts">
          <RotateCw class="mr-2 h-4 w-4" />
          立即轮转
        </Button>
      </div>
    </div>

    <div v-if="errorMessage" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="operationMessage" class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
      {{ operationMessage }}
    </div>
    <div v-if="diagnosticWarnings.length" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div class="font-medium">运行前检查</div>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li v-for="item in diagnosticWarnings" :key="item">{{ item }}</li>
      </ul>
    </div>

    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>账号总数</CardDescription>
          <CardTitle class="text-3xl">{{ summary?.total ?? 0 }}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>活跃账号</CardDescription>
          <CardTitle class="text-3xl">{{ summary?.active ?? activeAccounts }}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>待命 / 可复用</CardDescription>
          <CardTitle class="text-3xl">{{ summary?.standby ?? 0 }}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>额度不足</CardDescription>
          <CardTitle class="text-3xl">{{ summary?.exhausted ?? 0 }}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>目标席位</CardDescription>
          <CardTitle class="text-3xl">{{ summary?.targetSeats ?? settingsForm.targetSeats }}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardDescription>异常账号</CardDescription>
          <CardTitle class="text-3xl">{{ unhealthyAccounts }}</CardTitle>
        </CardHeader>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>运行概览</CardTitle>
        <CardDescription>
          当前工作区管理员：{{ summary?.workspaceManager?.email || '未配置' }}
          <span v-if="summary?.workspaceUsers != null">，工作区成员数：{{ summary.workspaceUsers }}</span>
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">自动巡检</div>
          <div class="mt-2 font-medium">{{ settingsForm.autoCheck.enabled ? '已开启' : '已关闭' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">每 {{ settingsForm.autoCheck.intervalSeconds }} 秒检查一次</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">轮转阈值</div>
          <div class="mt-2 font-medium">剩余额度低于 {{ settingsForm.autoCheck.thresholdPercent }}% 判定为低额度</div>
          <div class="mt-1 text-xs text-muted-foreground">低额度账号达到 {{ settingsForm.autoCheck.minLow }} 个时自动轮转</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">CloudMail</div>
          <div class="mt-2 font-medium">{{ settingsForm.cloudmail.baseUrl || '未配置' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">域名：{{ settingsForm.cloudmail.domain || '-' }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">浏览器</div>
          <div class="mt-2 font-medium">{{ diagnostics?.browser?.executablePath || settingsForm.browser.executablePath || '自动探测' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">{{ browserModeDescription }}</div>
        </div>
      </CardContent>
      <CardContent class="grid gap-3 pt-0 md:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">OAuth 回调地址</div>
          <div class="mt-2 break-all font-medium">{{ diagnostics?.oauth?.redirectUri || 'http://localhost:1455/auth/callback' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">监听地址：{{ diagnostics?.oauth?.redirectHost || '127.0.0.1' }}:{{ diagnostics?.oauth?.redirectPort || 1455 }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">CloudMail 账号</div>
          <div class="mt-2 font-medium">{{ diagnostics?.cloudmail?.email || settingsForm.cloudmail.email || '未配置' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">密码：{{ diagnostics?.cloudmail?.passwordSet ? '已保存' : '未保存' }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">管理账号候选数</div>
          <div class="mt-2 font-medium">{{ diagnostics?.manager?.candidateCount ?? managerCandidates.length }}</div>
          <div class="mt-1 text-xs text-muted-foreground">当前选择：{{ diagnostics?.manager?.account?.email || '未配置' }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">浏览器探测</div>
          <div class="mt-2 font-medium">{{ diagnostics?.browser?.available ? '可用' : '不可用' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">需要 Chromium/Chrome 才能运行 Playwright 自动化</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-sm text-muted-foreground">CPA 同步</div>
          <div class="mt-2 font-medium">{{ settingsForm.cpa.enabled ? '已启用' : '已关闭' }}</div>
          <div class="mt-1 text-xs text-muted-foreground">
            {{ diagnostics?.cpa?.configured ? `文件数：${cpaFiles.length}` : '未配置 CPA Base URL / Key' }}
          </div>
        </div>
      </CardContent>
      <CardContent v-if="summary?.workspaceError" class="pt-0">
        <div class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          工作区查询失败：{{ summary.workspaceError }}
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>AutoTeam 设置</CardTitle>
        <CardDescription>配置管理账号、CloudMail、CPA、浏览器路径以及自动巡检策略。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label class="flex items-center gap-3 rounded-lg border p-4 text-sm">
            <input v-model="settingsForm.enabled" type="checkbox" class="h-4 w-4" />
            <div>
              <div class="font-medium">启用 AutoTeam</div>
              <div class="text-xs text-muted-foreground">关闭后不会执行自动巡检和自动轮转</div>
            </div>
          </label>
          <label class="flex items-center gap-3 rounded-lg border p-4 text-sm">
            <input v-model="settingsForm.autoCheck.enabled" type="checkbox" class="h-4 w-4" />
            <div>
              <div class="font-medium">启用自动巡检</div>
              <div class="text-xs text-muted-foreground">后台定时检查额度并按阈值触发轮转</div>
            </div>
          </label>
          <label class="flex items-center gap-3 rounded-lg border p-4 text-sm">
            <input v-model="settingsForm.browser.headless" type="checkbox" class="h-4 w-4" />
            <div>
              <div class="font-medium">浏览器 Headless</div>
              <div class="text-xs text-muted-foreground">建议服务器保持开启；若无 DISPLAY / Wayland，系统也会自动回退到 Headless</div>
            </div>
          </label>
          <label class="flex items-center gap-3 rounded-lg border p-4 text-sm">
            <input v-model="settingsForm.cpa.enabled" type="checkbox" class="h-4 w-4" />
            <div>
              <div class="font-medium">启用 CPA 同步</div>
              <div class="text-xs text-muted-foreground">把活跃 AutoTeam 账号的 Codex 认证自动推送到 CLIProxyAPI</div>
            </div>
          </label>
          <label class="flex items-center gap-3 rounded-lg border p-4 text-sm">
            <input v-model="settingsForm.cpa.syncOnChange" type="checkbox" class="h-4 w-4" />
            <div>
              <div class="font-medium">状态变更自动同步</div>
              <div class="text-xs text-muted-foreground">创建 / 手动导入 / 巡检 / 轮转 / 删除后自动同步到 CPA</div>
            </div>
          </label>
          <div class="rounded-lg border p-4 text-sm">
            <div class="font-medium">CloudMail 密码</div>
            <div class="mt-1 text-xs text-muted-foreground">
              {{ settingsForm.cloudmail.passwordSet ? '已保存，留空表示保持不变' : '尚未保存，请首次填写' }}
            </div>
          </div>
          <div class="rounded-lg border p-4 text-sm">
            <div class="font-medium">CPA 管理密钥</div>
            <div class="mt-1 text-xs text-muted-foreground">
              {{ settingsForm.cpa.keySet ? '已保存，留空表示保持不变' : '尚未保存，请首次填写' }}
            </div>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="space-y-2 xl:col-span-2">
            <Label>工作区管理员账号</Label>
            <select v-model.number="settingsForm.managerAccountId" class="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm">
              <option :value="0">请选择 GPT 管理账号</option>
              <option v-for="item in managerCandidates" :key="item.id" :value="item.id">
                #{{ item.id }} · {{ item.email }} · user={{ item.userCount }} · invite={{ item.inviteCount }}
              </option>
            </select>
          </div>
          <div class="space-y-2">
            <Label>目标席位数</Label>
            <Input v-model.number="settingsForm.targetSeats" type="number" min="1" />
          </div>
          <div class="space-y-2">
            <Label>巡检间隔（秒）</Label>
            <Input v-model.number="settingsForm.autoCheck.intervalSeconds" type="number" min="60" />
          </div>
          <div class="space-y-2">
            <Label>低额度阈值（%）</Label>
            <Input v-model.number="settingsForm.autoCheck.thresholdPercent" type="number" min="1" max="100" />
          </div>
          <div class="space-y-2">
            <Label>触发轮转的低额度数</Label>
            <Input v-model.number="settingsForm.autoCheck.minLow" type="number" min="1" />
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="space-y-2 xl:col-span-2">
            <Label>CloudMail Base URL</Label>
            <Input v-model="settingsForm.cloudmail.baseUrl" placeholder="https://cloudmail.example.com/api" />
          </div>
          <div class="space-y-2">
            <Label>CloudMail 登录邮箱</Label>
            <Input v-model="settingsForm.cloudmail.email" placeholder="admin@example.com" />
          </div>
          <div class="space-y-2">
            <Label>CloudMail 登录密码</Label>
            <Input v-model="cloudmailPasswordInput" type="password" placeholder="留空则保持不变" />
          </div>
          <div class="space-y-2">
            <Label>临时邮箱域名</Label>
            <Input v-model="settingsForm.cloudmail.domain" placeholder="@mail.example.com" />
          </div>
          <div class="space-y-2 xl:col-span-2">
            <Label>Chromium / Chrome 路径</Label>
            <Input v-model="settingsForm.browser.executablePath" placeholder="/usr/bin/chromium 或留空自动探测" />
          </div>
          <div class="space-y-2">
            <Label>邮箱轮询间隔（秒）</Label>
            <Input v-model.number="settingsForm.mailPolling.intervalSeconds" type="number" min="1" />
          </div>
          <div class="space-y-2">
            <Label>邮箱等待超时（秒）</Label>
            <Input v-model.number="settingsForm.mailPolling.timeoutSeconds" type="number" min="30" />
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="space-y-2 xl:col-span-2">
            <Label>CPA Base URL</Label>
            <Input v-model="settingsForm.cpa.baseUrl" placeholder="http://127.0.0.1:8317" />
          </div>
          <div class="space-y-2 xl:col-span-2">
            <Label>CPA 管理密钥</Label>
            <Input v-model="settingsForm.cpa.key" type="password" placeholder="留空则保持不变" />
          </div>
          <div class="rounded-lg border p-4 text-sm md:col-span-2 xl:col-span-4">
            <div class="font-medium">同步规则</div>
            <div class="mt-1 text-xs text-muted-foreground">
              仅 active 状态且具备有效 access token 的账号会上传到 CPA；本地已管理但非 active 的旧文件会自动从 CPA 删除。
            </div>
          </div>
        </div>

        <div class="flex justify-end">
          <div class="flex gap-2">
            <Button variant="outline" :disabled="testingCloudmail" @click="testCloudMail">
              {{ testingCloudmail ? '测试中...' : '测试 CloudMail' }}
            </Button>
            <Button variant="outline" :disabled="testingCpa" @click="testCpa">
              {{ testingCpa ? '测试中...' : '测试 CPA' }}
            </Button>
            <Button variant="outline" :disabled="syncingCpa" @click="syncToCpa">
              {{ syncingCpa ? '同步中...' : '立即同步 CPA' }}
            </Button>
            <Button :disabled="savingSettings" @click="saveSettings">
              <ShieldCheck class="mr-2 h-4 w-4" />
              {{ savingSettings ? '保存中...' : '保存设置' }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card v-if="manualSession">
      <CardHeader>
        <CardTitle>手动 OAuth 导入</CardTitle>
        <CardDescription>
          支持 localhost 自动回调，也支持手动粘贴浏览器最终回调 URL。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="rounded-lg border p-4 text-sm">
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="font-medium">当前状态：{{ manualSession.status }}</div>
              <div class="mt-1 text-muted-foreground">{{ manualSession.message || '等待处理' }}</div>
              <div class="mt-1 text-xs text-muted-foreground">回调来源：{{ manualSession.callbackSource || '未收到' }} · 过期时间：{{ formatDateTime(manualSession.expiresAt) }}</div>
            </div>
            <Button variant="outline" @click="copyText(manualSession.authUrl, '授权链接已复制')">
              <Copy class="mr-2 h-4 w-4" />
              复制授权链接
            </Button>
          </div>
          <div class="mt-3 break-all rounded-md bg-muted p-3 text-xs">{{ manualSession.authUrl }}</div>
          <div v-if="manualSession.error" class="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            {{ manualSession.error }}
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label>浏览器回调 URL</Label>
            <textarea
              v-model="manualCallbackUrl"
              class="min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="粘贴浏览器最后跳转到 localhost:1455/auth/callback?... 的完整地址"
            />
          </div>
          <div class="space-y-2">
            <Label>可选密码</Label>
            <Input v-model="manualImportPassword" type="password" placeholder="保存后可用于后续自动复用登录" />
            <div class="rounded-lg border p-3 text-sm text-muted-foreground">
              <div>1. 打开上方授权链接并登录 OpenAI / Codex。</div>
              <div>2. 若服务端所在机器能访问 localhost:1455，会自动收到回调。</div>
              <div>3. 如果没有自动完成，请把浏览器地址栏完整 URL 粘贴到左侧。</div>
              <div>4. 点击“完成导入”后会把账号写入 AutoTeam 账号池。</div>
            </div>
            <div v-if="manualSession.result" class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              已换码成功：{{ manualSession.result.email || '-' }} / {{ manualSession.result.planType || '-' }}
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button variant="outline" :disabled="manualSubmitting" @click="submitManualCallback">
            {{ manualSubmitting ? '提交中...' : '提交回调 URL' }}
          </Button>
          <Button :disabled="manualFinalizing" @click="finalizeManualOAuth">
            {{ manualFinalizing ? '导入中...' : '完成导入' }}
          </Button>
          <Button variant="outline" :disabled="manualCancelling" @click="refreshManualSession">
            查询状态
          </Button>
          <Button variant="outline" :disabled="manualCancelling" @click="cancelManualOAuth">
            {{ manualCancelling ? '取消中...' : '取消会话' }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>CPA 文件概览</CardTitle>
        <CardDescription>
          查看当前 CLIProxyAPI 中的认证文件，并确认 AutoTeam 活跃账号是否已同步进去。
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-lg border p-4">
            <div class="text-sm text-muted-foreground">CPA 开关</div>
            <div class="mt-2 font-medium">{{ settingsForm.cpa.enabled ? '已启用' : '未启用' }}</div>
          </div>
          <div class="rounded-lg border p-4">
            <div class="text-sm text-muted-foreground">自动同步</div>
            <div class="mt-2 font-medium">{{ settingsForm.cpa.syncOnChange ? '开启' : '关闭' }}</div>
          </div>
          <div class="rounded-lg border p-4">
            <div class="text-sm text-muted-foreground">CPA 文件数</div>
            <div class="mt-2 font-medium">{{ cpaFiles.length }}</div>
          </div>
          <div class="rounded-lg border p-4">
            <div class="text-sm text-muted-foreground">活跃 AutoTeam 账号</div>
            <div class="mt-2 font-medium">{{ activeAccounts }}</div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button variant="outline" :disabled="loadingCpaFiles" @click="refreshCpaFiles()">
            {{ loadingCpaFiles ? '刷新中...' : '刷新 CPA 文件列表' }}
          </Button>
          <Button variant="outline" :disabled="testingCpa" @click="testCpa">
            {{ testingCpa ? '测试中...' : '测试连接' }}
          </Button>
          <Button :disabled="syncingCpa" @click="syncToCpa">
            {{ syncingCpa ? '同步中...' : '同步当前活跃账号' }}
          </Button>
        </div>

        <div v-if="!settingsForm.cpa.enabled" class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          当前未启用 CPA 自动同步。你仍可以填写配置并手动点击“同步当前活跃账号”。
        </div>
        <div v-else-if="!diagnostics?.cpa?.configured" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          CPA 已开启，但 Base URL 或管理密钥尚未配置完整。
        </div>
        <div v-else-if="loadingCpaFiles" class="py-10 text-center text-sm text-muted-foreground">
          正在加载 CPA 文件列表...
        </div>
        <div v-else-if="cpaFiles.length === 0" class="py-10 text-center text-sm text-muted-foreground">
          当前 CPA 中还没有可见的 Codex 认证文件。
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead>
              <tr class="text-left text-muted-foreground">
                <th class="px-3 py-3 font-medium">文件名</th>
                <th class="px-3 py-3 font-medium">邮箱</th>
                <th class="px-3 py-3 font-medium">大小</th>
                <th class="px-3 py-3 font-medium">创建时间</th>
                <th class="px-3 py-3 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="file in cpaFiles" :key="file.name">
                <td class="px-3 py-3 font-mono text-xs">{{ file.name }}</td>
                <td class="px-3 py-3">{{ file.email || '-' }}</td>
                <td class="px-3 py-3">{{ file.size == null ? '-' : `${file.size} B` }}</td>
                <td class="px-3 py-3">{{ formatDateTime(file.createdAt) }}</td>
                <td class="px-3 py-3">{{ formatDateTime(file.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>账号池</CardTitle>
        <CardDescription>状态机会根据额度检查结果自动切换：active / standby / exhausted / pending。</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
          <Input v-model="searchQuery" placeholder="搜索邮箱 / plan / workspace id / 错误信息" />
          <select v-model="statusFilter" class="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm">
            <option value="all">全部状态</option>
            <option value="active">活跃</option>
            <option value="standby">待命</option>
            <option value="exhausted">额度不足</option>
            <option value="pending">处理中</option>
          </select>
        </div>
        <div v-if="loading" class="py-10 text-center text-sm text-muted-foreground">正在加载 AutoTeam 数据...</div>
        <div v-else-if="accounts.length === 0" class="py-10 text-center text-sm text-muted-foreground">
          当前还没有 AutoTeam 账号，可先导入一个已有 OAuth 账号，或直接自动注册新号。
        </div>
        <div v-else-if="filteredAccounts.length === 0" class="py-10 text-center text-sm text-muted-foreground">
          没有符合当前筛选条件的账号。
        </div>
        <div v-else class="overflow-x-auto">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead>
              <tr class="text-left text-muted-foreground">
                <th class="px-3 py-3 font-medium">邮箱</th>
                <th class="px-3 py-3 font-medium">状态</th>
                <th class="px-3 py-3 font-medium">Plan</th>
                <th class="px-3 py-3 font-medium">剩余额度</th>
                <th class="px-3 py-3 font-medium">额度重置</th>
                <th class="px-3 py-3 font-medium">最后活跃</th>
                <th class="px-3 py-3 font-medium">错误信息</th>
                <th class="px-3 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              <tr v-for="account in filteredAccounts" :key="account.id" class="align-top">
                <td class="px-3 py-3">
                  <div class="font-medium">{{ account.email }}</div>
                  <div class="mt-1 text-xs text-muted-foreground">
                    #{{ account.id }} · workspace={{ account.chatgptAccountId || '-' }}
                  </div>
                  <div class="mt-1 text-xs text-muted-foreground">
                    密码={{ account.passwordStored ? '已存' : '未存' }} / refresh={{ account.refreshTokenStored ? '已存' : '未存' }}
                  </div>
                </td>
                <td class="px-3 py-3">
                  <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(account.status)">
                    {{ statusText(account.status) }}
                  </span>
                </td>
                <td class="px-3 py-3">{{ account.planType || '-' }}</td>
                <td class="px-3 py-3">
                  <div>{{ quotaRemainingLabel(account) }}</div>
                  <div class="mt-1 text-xs text-muted-foreground">已用 {{ account.quotaPrimaryPct == null ? '-' : `${Number(account.quotaPrimaryPct).toFixed(0)}%` }}</div>
                </td>
                <td class="px-3 py-3">
                  <div>{{ formatUnixSeconds(account.quotaPrimaryResetsAt) }}</div>
                  <div class="mt-1 text-xs text-muted-foreground">周额度：{{ account.quotaWeeklyPct == null ? '-' : `${Number(account.quotaWeeklyPct).toFixed(0)}%` }}</div>
                </td>
                <td class="px-3 py-3">
                  <div>{{ formatUnixMs(account.lastActiveAt) }}</div>
                  <div class="mt-1 text-xs text-muted-foreground">耗尽时间：{{ formatUnixMs(account.quotaExhaustedAt) }}</div>
                </td>
                <td class="px-3 py-3">
                  <div class="max-w-[260px] break-words text-xs text-muted-foreground">{{ account.lastError || '-' }}</div>
                </td>
                <td class="px-3 py-3">
                  <div class="flex flex-col gap-2">
                    <Button
                      v-if="account.status !== 'standby'"
                      variant="outline"
                      size="sm"
                      :disabled="changingStatusId === account.id"
                      @click="setAccountStatus(account, 'standby')"
                    >
                      标记待命
                    </Button>
                    <Button
                      v-if="account.status !== 'active'"
                      variant="outline"
                      size="sm"
                      :disabled="changingStatusId === account.id"
                      @click="setAccountStatus(account, 'active')"
                    >
                      标记活跃
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      :disabled="deletingAccountId === account.id"
                      @click="deleteAccount(account)"
                    >
                      <Trash2 class="mr-2 h-4 w-4" />
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
