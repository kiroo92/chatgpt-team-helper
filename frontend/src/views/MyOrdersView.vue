<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authService, purchaseService, redemptionCodeService, userService, type PurchaseOrder, type PurchaseMyOrdersParams, type PointsRedeemRecord } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { useI18n } from '@/composables/useI18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import LanguageSwitch from '@/components/LanguageSwitch.vue'
import { Link2, RefreshCw, ShoppingCart, CheckCircle2, Clock, RotateCcw, Ban, AlertCircle, Coins, Download, LifeBuoy } from 'lucide-vue-next'

const router = useRouter()
const appConfigStore = useAppConfigStore()
const { t } = useI18n()
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast } = useToast()

const orders = ref<PurchaseOrder[]>([])
const loading = ref(false)
const error = ref('')
const teleportReady = ref(false)

const paginationMeta = ref({ page: 1, pageSize: 20, total: 0 })
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

const bindOrderNo = ref('')
const binding = ref(false)

// 积分兑换记录（按邮箱聚合，显示最新状态）
const redemptionRecords = ref<PointsRedeemRecord[]>([])
const redemptionLoading = ref(false)
const redemptionError = ref('')
const redemptionFilter = ref<'all' | 'banned' | 'recoverable' | 'recovered'>('all')
const recoveringEmail = ref('')
const redemptionPagination = ref({ page: 1, pageSize: 20, total: 0, totalPages: 1 })

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const statusLabel = (status?: string) => {
  if (status === 'paid') return t('myOrders.status.paid')
  if (status === 'refunded') return t('myOrders.status.refunded')
  if (status === 'expired') return t('myOrders.status.expired')
  if (status === 'failed') return t('myOrders.status.failed')
  if (status === 'pending_payment') return t('myOrders.status.pendingPayment')
  if (status === 'created') return t('myOrders.status.created')
  return status || t('common.unknown')
}

const getStatusColor = (status?: string) => {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-700 border-green-200'
    case 'refunded': return 'bg-purple-100 text-purple-700 border-purple-200'
    case 'pending_payment': return 'bg-yellow-100 text-yellow-700 border-yellow-200'
    case 'created': return 'bg-gray-100 text-gray-700 border-gray-200'
    case 'failed': return 'bg-red-100 text-red-700 border-red-200'
    case 'expired': return 'bg-gray-100 text-gray-500 border-gray-200'
    default: return 'bg-gray-100 text-gray-700 border-gray-200'
  }
}

const stats = computed(() => {
  const total = paginationMeta.value.total
  const paid = orders.value.filter(o => o.status === 'paid').length
  const refunded = orders.value.filter(o => o.status === 'refunded').length
  const pending = orders.value.filter(o => o.status === 'pending_payment' || o.status === 'created').length
  return { total, paid, refunded, pending }
})

const redemptionStats = computed(() => {
  const total = redemptionRecords.value.length
  const banned = redemptionRecords.value.filter(r => r.state === 'banned' || r.state === 'failed').length
  const recoverable = redemptionRecords.value.filter(r => r.canRecover).length
  const recovered = redemptionRecords.value.filter(r => r.state === 'recovered').length
  return { total, banned, recoverable, recovered }
})

const getRedemptionStateLabel = (item: PointsRedeemRecord) => {
  if (item.state === 'recovered') return t('myOrders.redemption.state.recovered')
  if (item.state === 'failed') return t('myOrders.redemption.state.failed')
  if (item.state === 'banned') return t('myOrders.redemption.state.banned')
  return t('myOrders.redemption.state.normal')
}

const getRedemptionStateClass = (item: PointsRedeemRecord) => {
  if (item.state === 'recovered') return 'bg-green-100 text-green-700 border-green-200'
  if (item.state === 'failed') return 'bg-red-100 text-red-700 border-red-200'
  if (item.state === 'banned') return 'bg-amber-100 text-amber-700 border-amber-200'
  return 'bg-gray-100 text-gray-700 border-gray-200'
}

const buildParams = (): PurchaseMyOrdersParams => ({
  page: paginationMeta.value.page,
  pageSize: paginationMeta.value.pageSize,
})

const loadOrders = async () => {
  loading.value = true
  error.value = ''
  try {
    const response = await purchaseService.myListOrders(buildParams())
    orders.value = response.orders || []
    paginationMeta.value = response.pagination || { page: 1, pageSize: 20, total: 0 }
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || t('errors.loadFailed')
    error.value = message
    showErrorToast(message)
  } finally {
    loading.value = false
  }
}

const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  paginationMeta.value.page = page
  loadOrders()
}

const loadRedemptionRecords = async () => {
  redemptionLoading.value = true
  redemptionError.value = ''
  try {
    const response = await userService.listRedeemRecords({
      status: redemptionFilter.value,
      page: redemptionPagination.value.page,
      pageSize: redemptionPagination.value.pageSize,
      days: 90
    })
    redemptionRecords.value = response.records || []
    redemptionPagination.value = response.pagination || redemptionPagination.value
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || t('errors.loadFailed')
    redemptionError.value = message
    showErrorToast(message)
  } finally {
    redemptionLoading.value = false
  }
}

const changeRedemptionFilter = async (filter: 'all' | 'banned' | 'recoverable' | 'recovered') => {
  if (redemptionFilter.value === filter) return
  redemptionFilter.value = filter
  redemptionPagination.value.page = 1
  await loadRedemptionRecords()
}

const goToRedemptionPage = async (page: number) => {
  if (redemptionLoading.value) return
  if (page < 1 || page > redemptionPagination.value.totalPages || page === redemptionPagination.value.page) return
  redemptionPagination.value.page = page
  await loadRedemptionRecords()
}

const triggerRecover = async (item: PointsRedeemRecord) => {
  if (!item.canRecover || recoveringEmail.value) return
  recoveringEmail.value = item.userEmail
  try {
    await redemptionCodeService.recoverAccount({ email: item.userEmail })
    showSuccessToast(t('myOrders.redemption.toast.recoverTriggered', { email: item.userEmail }))
    await loadRedemptionRecords()
  } catch (err: any) {
    const message = err?.response?.data?.message || err?.response?.data?.error || t('myOrders.redemption.toast.recoverFailed')
    showErrorToast(message)
  } finally {
    recoveringEmail.value = ''
  }
}

const exportRecentRecovery = async () => {
  try {
    const all: PointsRedeemRecord[] = []
    let page = 1
    const pageSize = 200
    let totalPages = 1

    while (page <= totalPages) {
      const response = await userService.listRedeemRecords({
        status: redemptionFilter.value,
        page,
        pageSize,
        days: 90
      })
      all.push(...(response.records || []))
      totalPages = Math.max(1, Number(response.pagination?.totalPages || 1))
      page += 1
    }

    const now = Date.now()
    const recentMs = 30 * 24 * 60 * 60 * 1000
    const rows = all.filter(item => {
      const latestAt = item.latest?.createdAt ? new Date(item.latest.createdAt).getTime() : 0
      return latestAt > 0 && now - latestAt <= recentMs
    })

    if (rows.length === 0) {
      showWarningToast(t('myOrders.redemption.toast.noRecentRecovery'))
      return
    }

    const csvHeader = [
      t('myOrders.redemption.columns.userEmail'),
      t('myOrders.redemption.columns.latestState'),
      t('myOrders.redemption.columns.originalAccount'),
      t('myOrders.redemption.columns.currentAccount'),
      t('myOrders.redemption.columns.redeemTime'),
      t('myOrders.redemption.columns.recoveryTime'),
      t('myOrders.redemption.columns.recoveryMode'),
      t('myOrders.redemption.columns.failureReason')
    ]
    const csvRows = rows.map(item => ([
      item.userEmail,
      getRedemptionStateLabel(item),
      item.originalAccountEmail || '',
      item.currentAccountEmail || '',
      item.redeemedAt || '',
      item.latest?.createdAt || '',
      item.latest?.recoveryMode || '',
      item.latest?.errorMessage || ''
    ]))

    const escapeCsv = (value: unknown) => {
      const text = String(value ?? '')
      const escaped = text.replace(/"/g, '""')
      return `"${escaped}"`
    }

    const content = [csvHeader, ...csvRows].map(line => line.map(escapeCsv).join(',')).join('\r\n')
    const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const date = new Date()
    const filenamePrefix = t('myOrders.redemption.exportFilenamePrefix')
    const filename = `${filenamePrefix}-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}.csv`
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    showSuccessToast(t('myOrders.redemption.toast.exported', { count: rows.length }))
  } catch (err: any) {
    const message = err?.response?.data?.error || t('myOrders.redemption.toast.exportFailed')
    showErrorToast(message)
  }
}

const bindOrder = async () => {
  const orderNo = bindOrderNo.value.trim()
  if (!orderNo) {
    showWarningToast(t('myOrders.bindOrder.placeholder'))
    return
  }
  binding.value = true
  try {
    await purchaseService.myBindOrder(orderNo)
    showSuccessToast(t('common.success'))
    bindOrderNo.value = ''
    paginationMeta.value.page = 1
    await loadOrders()
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || t('common.failed')
    showErrorToast(message)
  } finally {
    binding.value = false
  }
}

const openPayUrl = (url?: string | null) => {
  const normalized = String(url || '').trim()
  if (!normalized) {
    showErrorToast(t('errors.notFound'))
    return
  }
  window.open(normalized, '_blank')
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }
  await Promise.all([loadOrders(), loadRedemptionRecords()])
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-8">
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3">
        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="loading"
          @click="loadOrders"
        >
          <RefreshCw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
          {{ t('myOrders.refreshList') }}
        </Button>

        <LanguageSwitch />
      </div>
    </Teleport>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
      <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-500">{{ t('myOrders.stats.totalOrders') }}</span>
          <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
            <ShoppingCart class="w-5 h-5" />
          </div>
        </div>
        <div>
          <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.total }}</span>
          <span class="text-xs text-gray-400 ml-2">{{ t('myOrders.stats.unit') }}</span>
        </div>
      </div>

      <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-500">{{ t('myOrders.stats.paid') }}</span>
          <div class="w-10 h-10 rounded-2xl bg-green-50 flex items-center justify-center text-green-600">
            <CheckCircle2 class="w-5 h-5" />
          </div>
        </div>
        <div>
          <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.paid }}</span>
          <span class="text-xs text-gray-400 ml-2">{{ t('myOrders.stats.unit') }}</span>
        </div>
      </div>

      <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-500">{{ t('myOrders.stats.pending') }}</span>
          <div class="w-10 h-10 rounded-2xl bg-yellow-50 flex items-center justify-center text-yellow-600">
            <Clock class="w-5 h-5" />
          </div>
        </div>
        <div>
          <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.pending }}</span>
          <span class="text-xs text-gray-400 ml-2">{{ t('myOrders.stats.unit') }}</span>
        </div>
      </div>

      <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-500">{{ t('myOrders.stats.refunded') }}</span>
          <div class="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center text-purple-600">
            <RotateCcw class="w-5 h-5" />
          </div>
        </div>
        <div>
          <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.refunded }}</span>
          <span class="text-xs text-gray-400 ml-2">{{ t('myOrders.stats.unit') }}</span>
        </div>
      </div>
    </div>

    <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
      <div class="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
        <div class="space-y-1">
          <h3 class="text-lg font-semibold text-gray-900">{{ t('myOrders.bindOrder.title') }}</h3>
          <p class="text-sm text-gray-500">{{ t('myOrders.bindOrder.desc') }}</p>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 w-full lg:w-auto">
          <Input
            v-model="bindOrderNo"
            class="h-10 rounded-xl bg-white"
            :placeholder="t('myOrders.bindOrder.placeholder')"
            :disabled="binding"
            @keydown.enter.prevent="bindOrder"
          />
          <Button class="h-10 rounded-xl" :disabled="binding" @click="bindOrder">
            <Link2 class="h-4 w-4 mr-2" :class="binding ? 'animate-pulse' : ''" />
            {{ t('myOrders.bindOrder.button') }}
          </Button>
        </div>
      </div>
    </div>

    <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
      <div class="flex items-center justify-between gap-4 mb-4">
        <h3 class="text-lg font-semibold text-gray-900">{{ t('myOrders.orderList.title') }}</h3>
        <div class="text-sm text-gray-500">{{ t('common.page') }} {{ paginationMeta.page }} / {{ totalPages }}</div>
      </div>

      <div v-if="loading" class="py-16 text-center text-gray-500">
        <RefreshCw class="h-5 w-5 inline-block mr-2 animate-spin" />
        {{ t('common.loading') }}
      </div>

      <div v-else-if="error" class="py-10 rounded-2xl bg-red-50 border border-red-100 px-4">
        <div class="flex items-start gap-3">
          <AlertCircle class="h-5 w-5 text-red-500 mt-0.5" />
          <div>
            <p class="text-sm font-semibold text-red-700">{{ t('errors.loadFailed') }}</p>
            <p class="text-sm text-red-600 mt-1">{{ error }}</p>
          </div>
        </div>
      </div>

      <div v-else-if="orders.length === 0" class="py-16 text-center text-gray-500">
        <Ban class="h-5 w-5 inline-block mr-2" />
        {{ t('myOrders.orderList.noOrders') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500 border-b">
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.orderList.orderNo') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.orderList.product') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.orderList.amount') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.orderList.status') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.orderList.createdAt') }}</th>
              <th class="py-3 pr-0 font-medium text-right">{{ t('myOrders.orderList.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in orders" :key="order.orderNo" class="border-b last:border-b-0 hover:bg-gray-50/60">
              <td class="py-3 pr-4 font-mono text-xs text-gray-900 whitespace-nowrap">{{ order.orderNo }}</td>
              <td class="py-3 pr-4 text-gray-900">{{ order.productName }}</td>
              <td class="py-3 pr-4 tabular-nums text-gray-900">¥ {{ order.amount }}</td>
              <td class="py-3 pr-4">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full border text-xs font-medium" :class="getStatusColor(order.status)">
                  {{ statusLabel(order.status) }}
                </span>
              </td>
              <td class="py-3 pr-4 text-gray-600 whitespace-nowrap">{{ formatDate(order.createdAt) }}</td>
              <td class="py-3 pr-0 text-right whitespace-nowrap">
                <Button
                  v-if="order.status === 'pending_payment' && order.img"
                  variant="outline"
                  size="sm"
                  class="h-8 text-xs border-gray-200 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                  @click="openPayUrl(order.img)"
                >
                  <Link2 class="h-3 w-3 mr-1.5" />
                  {{ t('myOrders.orderList.pay') }}
                </Button>
                <span v-else class="text-gray-300 text-xs">-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="flex items-center justify-between mt-4">
        <Button variant="outline" class="h-9 rounded-xl" :disabled="paginationMeta.page <= 1" @click="goToPage(paginationMeta.page - 1)">
          {{ t('common.previous') }}
        </Button>
        <div class="text-sm text-gray-500">{{ t('common.total') }} {{ paginationMeta.total }} {{ t('myOrders.stats.unit') }}</div>
        <Button
          variant="outline"
          class="h-9 rounded-xl"
          :disabled="paginationMeta.page >= totalPages"
          @click="goToPage(paginationMeta.page + 1)"
        >
          {{ t('common.next') }}
        </Button>
      </div>
    </div>

    <!-- 积分兑换记录 -->
    <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600">
            <Coins class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-lg font-semibold text-gray-900">{{ t('myOrders.redemption.title') }}</h3>
            <p class="text-sm text-gray-500">
              {{
                t('myOrders.redemption.summaryLatest', {
                  total: redemptionStats.total,
                  banned: redemptionStats.banned,
                  recoverable: redemptionStats.recoverable,
                  recovered: redemptionStats.recovered
                })
              }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-9 rounded-xl" :disabled="redemptionLoading" @click="exportRecentRecovery">
            <Download class="h-4 w-4 mr-2" />
            {{ t('myOrders.redemption.exportRecent') }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="h-9 rounded-xl"
            :disabled="redemptionLoading"
            @click="loadRedemptionRecords"
          >
            <RefreshCw class="h-4 w-4 mr-2" :class="redemptionLoading ? 'animate-spin' : ''" />
            {{ t('common.refresh') }}
          </Button>
        </div>
      </div>

      <div class="mb-4 flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" class="h-8 rounded-lg" :class="redemptionFilter === 'all' ? 'border-black text-black' : ''" @click="changeRedemptionFilter('all')">{{ t('myOrders.redemption.filters.all') }}</Button>
        <Button variant="outline" size="sm" class="h-8 rounded-lg" :class="redemptionFilter === 'banned' ? 'border-amber-500 text-amber-700' : ''" @click="changeRedemptionFilter('banned')">{{ t('myOrders.redemption.filters.banned') }}</Button>
        <Button variant="outline" size="sm" class="h-8 rounded-lg" :class="redemptionFilter === 'recoverable' ? 'border-blue-500 text-blue-700' : ''" @click="changeRedemptionFilter('recoverable')">{{ t('myOrders.redemption.filters.recoverable') }}</Button>
        <Button variant="outline" size="sm" class="h-8 rounded-lg" :class="redemptionFilter === 'recovered' ? 'border-green-500 text-green-700' : ''" @click="changeRedemptionFilter('recovered')">{{ t('myOrders.redemption.filters.recovered') }}</Button>
      </div>

      <div v-if="redemptionLoading" class="py-10 text-center text-gray-500">
        <RefreshCw class="h-5 w-5 inline-block mr-2 animate-spin" />
        {{ t('common.loading') }}
      </div>

      <div v-else-if="redemptionError" class="py-8 rounded-2xl bg-red-50 border border-red-100 px-4">
        <div class="flex items-start gap-3">
          <AlertCircle class="h-5 w-5 text-red-500 mt-0.5" />
          <div>
            <p class="text-sm font-semibold text-red-700">{{ t('errors.loadFailed') }}</p>
            <p class="text-sm text-red-600 mt-1">{{ redemptionError }}</p>
          </div>
        </div>
      </div>

      <div v-else-if="redemptionRecords.length === 0" class="py-10 text-center text-gray-500">
        <Ban class="h-5 w-5 inline-block mr-2" />
        {{ t('myOrders.redemption.noRecords') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500 border-b">
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.userEmail') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.latestState') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.currentAccount') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.redeemTime') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.recoveryTime') }}</th>
              <th class="py-3 pr-4 font-medium">{{ t('myOrders.redemption.columns.warrantyEnds') }}</th>
              <th class="py-3 pr-0 font-medium text-right">{{ t('myOrders.orderList.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in redemptionRecords" :key="`${record.originalCodeId}-${record.userEmail}`" class="border-b last:border-b-0 hover:bg-gray-50/60">
              <td class="py-3 pr-4 text-gray-900">{{ record.userEmail }}</td>
              <td class="py-3 pr-4">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full border text-xs font-medium" :class="getRedemptionStateClass(record)">
                  {{ getRedemptionStateLabel(record) }}
                </span>
              </td>
              <td class="py-3 pr-4 text-gray-600 text-xs">{{ record.currentAccountEmail || record.originalAccountEmail || '-' }}</td>
              <td class="py-3 pr-4 text-gray-600 whitespace-nowrap">{{ formatDate(record.redeemedAt) }}</td>
              <td class="py-3 pr-4 text-gray-600 whitespace-nowrap">{{ formatDate(record.latest?.createdAt) }}</td>
              <td class="py-3 pr-4 text-gray-600 whitespace-nowrap">{{ formatDate(record.windowEndsAt) }}</td>
              <td class="py-3 pr-0 text-right whitespace-nowrap">
                <Button
                  size="sm"
                  variant="outline"
                  class="h-8 text-xs border-gray-200 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                  :disabled="!record.canRecover || recoveringEmail === record.userEmail"
                  @click="triggerRecover(record)"
                >
                  <LifeBuoy class="h-3.5 w-3.5 mr-1.5" />
                  {{ recoveringEmail === record.userEmail ? t('myOrders.redemption.actions.recovering') : t('myOrders.redemption.actions.recover') }}
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="redemptionPagination.totalPages > 1" class="flex items-center justify-between mt-4">
        <Button
          variant="outline"
          class="h-9 rounded-xl"
          :disabled="redemptionLoading || redemptionPagination.page <= 1"
          @click="goToRedemptionPage(redemptionPagination.page - 1)"
        >
          {{ t('common.previous') }}
        </Button>
        <div class="text-sm text-gray-500">
          {{ t('myOrders.redemption.pagination', { page: redemptionPagination.page, totalPages: redemptionPagination.totalPages, total: redemptionPagination.total }) }}
        </div>
        <Button
          variant="outline"
          class="h-9 rounded-xl"
          :disabled="redemptionLoading || redemptionPagination.page >= redemptionPagination.totalPages"
          @click="goToRedemptionPage(redemptionPagination.page + 1)"
        >
          {{ t('common.next') }}
        </Button>
      </div>
    </div>
  </div>
</template>
