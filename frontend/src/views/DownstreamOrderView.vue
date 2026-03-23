<template>
  <RedeemShell :maxWidth="'max-w-[760px]'">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <RouterLink
        to="/downstream"
        class="inline-flex items-center gap-2 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-2 text-[13px] font-medium text-[#007AFF] hover:text-[#005FCC] transition-colors"
      >
        返回下单
      </RouterLink>

      <div
        v-if="isPolling"
        class="inline-flex items-center gap-2.5 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-1.5 shadow-sm"
      >
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#FF9500]"></span>
        </span>
        <span class="text-[13px] font-medium text-gray-600 dark:text-gray-300 tracking-wide">正在轮询支付结果</span>
      </div>
    </div>

    <div class="text-center space-y-3">
      <h1
        class="text-[36px] leading-tight font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-emerald-500 via-cyan-500 to-sky-600 dark:from-emerald-400 dark:via-cyan-400 dark:to-sky-400 drop-shadow-sm animate-gradient-x"
      >
        订单查询
      </h1>
    </div>

    <div class="relative group perspective-1000">
      <div
        class="absolute -inset-1 bg-gradient-to-r from-emerald-500 via-cyan-500 to-sky-600 rounded-[2rem] blur opacity-25 group-hover:opacity-40 transition duration-700"
      ></div>
      <AppleCard
        variant="glass"
        className="relative overflow-hidden shadow-2xl shadow-black/10 border border-white/40 dark:border-white/10 ring-1 ring-black/5 backdrop-blur-3xl transition-all duration-500 hover:shadow-3xl hover:scale-[1.01]"
      >
        <div class="p-8 sm:p-10 space-y-8">
          <form class="space-y-6" @submit.prevent="handleQuery">
            <AppleInput
              v-model.trim="email"
              label="联系方式"
              placeholder="name@example.com"
              type="email"
              variant="filled"
              :disabled="loading"
              helperText="请填写下单时使用的邮箱"
              :error="email && !isValidEmail ? '请输入有效的邮箱格式' : ''"
            />

            <AppleInput
              v-model.trim="orderNo"
              label="订单号"
              placeholder="20260322123456000001"
              type="text"
              variant="filled"
              :disabled="loading"
              helperText="支持商户订单号或支付交易号查询"
            />

            <AppleButton type="submit" variant="primary" size="lg" class="w-full h-[50px]" :loading="loading" :disabled="loading">
              {{ loading ? '正在查询...' : '查询订单' }}
            </AppleButton>
          </form>

          <div v-if="errorMessage" class="rounded-2xl bg-[#FF3B30]/10 border border-[#FF3B30]/20 p-5 text-sm text-[#1d1d1f]/80 dark:text-white/80">
            {{ errorMessage }}
          </div>

          <div v-if="result?.order" class="space-y-5">
            <div class="rounded-2xl bg-white/50 dark:bg-black/20 border border-black/5 dark:border-white/10 p-5 space-y-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-[13px] text-[#86868b]">订单号</p>
                  <p class="text-[15px] font-semibold tabular-nums text-[#1d1d1f] dark:text-white">{{ result.order.orderNo }}</p>
                </div>
                <div class="text-right">
                  <p class="text-[13px] text-[#86868b]">状态</p>
                  <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">{{ statusLabel(result.order.status) }}</p>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-4">
                <div>
                  <p class="text-[13px] text-[#86868b]">总金额</p>
                  <p class="text-[15px] font-semibold tabular-nums text-[#1d1d1f] dark:text-white">¥ {{ result.order.amount }}</p>
                </div>
                <div>
                  <p class="text-[13px] text-[#86868b]">数量</p>
                  <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">{{ result.order.quantity }}</p>
                </div>
                <div>
                  <p class="text-[13px] text-[#86868b]">单价</p>
                  <p class="text-[15px] font-semibold tabular-nums text-[#1d1d1f] dark:text-white">¥ {{ result.order.unitAmount || '-' }}</p>
                </div>
                <div>
                  <p class="text-[13px] text-[#86868b]">已兑数量</p>
                  <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">{{ redeemedCount }}/{{ result.order.items.length }}</p>
                </div>
              </div>

            </div>

            <div v-if="showQrImage" class="rounded-2xl border border-sky-100 bg-sky-50/70 p-5 space-y-4">
              <div class="space-y-1">
                <p class="text-sm font-semibold text-sky-900">待支付</p>
                <p class="text-sm text-sky-800/80">可继续扫码或打开支付链接完成付款。</p>
              </div>
              <img :src="showQrImage" alt="支付二维码" class="mx-auto h-52 w-52 rounded-2xl border border-white/80 bg-white p-3 shadow-sm" />
              <AppleButton type="button" variant="secondary" size="lg" class="w-full h-[46px]" @click="openPayUrl(result.order.payUrl)">
                打开支付链接
              </AppleButton>
            </div>

            <div v-if="showDeliveredItems" class="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-5 space-y-4">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="space-y-1">
                  <p class="text-sm font-semibold text-emerald-900">兑换码已发放</p>
                </div>
                <AppleButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  class="shrink-0"
                  :disabled="!canExportCodes"
                  @click="downloadCodesTxt"
                >
                  导出 TXT
                </AppleButton>
              </div>

              <div class="space-y-3">
                <div
                  v-for="item in result.order.items"
                  :key="item.publicCode"
                  class="rounded-2xl bg-white/90 border border-emerald-100 px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p class="text-xs uppercase tracking-[0.24em] text-emerald-500">兑换码</p>
                    <p class="mt-2 break-all font-mono text-base font-semibold text-[#1d1d1f]">{{ item.publicCode }}</p>
                  </div>
                  <div class="text-sm sm:text-right">
                    <p class="font-semibold" :class="item.status === 'redeemed' ? 'text-emerald-700' : 'text-slate-700'">
                      {{ item.status === 'redeemed' ? '已兑换' : '未兑换' }}
                    </p>
                    <p class="mt-1 text-[#86868b]">
                      {{ item.redeemedAt ? `兑换时间：${item.redeemedAt}` : '等待终端买家兑换' }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </AppleCard>
    </div>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import RedeemShell from '@/components/RedeemShell.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import { downstreamService, type DownstreamOrderQueryResponse } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'

const route = useRoute()

const email = ref('')
const orderNo = ref('')
const loading = ref(false)
const errorMessage = ref('')
const result = ref<DownstreamOrderQueryResponse | null>(null)
const pollTimer = ref<number | null>(null)

const isValidEmail = computed(() => {
  if (!email.value) return true
  return EMAIL_REGEX.test(email.value.trim())
})

const isPolling = computed(() => pollTimer.value !== null)
const showQrImage = computed(() => {
  const order = result.value?.order
  if (!order || !['created', 'pending_payment'].includes(order.status)) return ''
  return order.img || order.qrcode || ''
})
const showDeliveredItems = computed(() => {
  const order = result.value?.order
  if (!order) return false
  return order.status === 'paid' && order.items.length > 0
})
const redeemedCount = computed(() => (result.value?.order.items || []).filter(item => item.status === 'redeemed').length)
const deliveredCodes = computed(() => (result.value?.order.items || []).map(item => item.publicCode).filter(Boolean))
const canExportCodes = computed(() => deliveredCodes.value.length > 0)

const statusLabel = (status?: string) => {
  if (status === 'paid') return '已支付'
  if (status === 'refunded') return '已退款'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '失败'
  if (status === 'pending_payment') return '待支付'
  if (status === 'created') return '已创建'
  return status || '未知'
}

const stopPolling = () => {
  if (pollTimer.value !== null) {
    window.clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}

const openPayUrl = (url?: string | null) => {
  const normalized = String(url || '').trim()
  if (!normalized) return
  window.open(normalized, '_blank', 'noopener,noreferrer')
}

const downloadCodesTxt = () => {
  if (!canExportCodes.value || typeof window === 'undefined' || typeof document === 'undefined') return

  const orderId = (result.value?.order.orderNo || 'downstream-order').replace(/[^\w-]+/g, '-')
  const blob = new Blob([`${deliveredCodes.value.join('\n')}\n`], {
    type: 'text/plain;charset=utf-8'
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `兑换码-${orderId}.txt`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

const queryOrder = async (sync: boolean) => {
  errorMessage.value = ''
  const normalizedEmail = email.value.trim()
  const normalizedOrderNo = orderNo.value.trim()
  if (!normalizedEmail) {
    errorMessage.value = '请输入联系方式'
    return
  }
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    errorMessage.value = '请输入有效的邮箱格式'
    return
  }
  if (!normalizedOrderNo) {
    errorMessage.value = '请输入订单号'
    return
  }

  loading.value = true
  try {
    result.value = await downstreamService.getOrder(normalizedOrderNo, normalizedEmail, { sync })
  } catch (error: any) {
    result.value = null
    errorMessage.value = error?.response?.data?.error || '查询失败，请稍后再试'
  } finally {
    loading.value = false
  }
}

const handleQuery = async () => {
  await queryOrder(true)
}

const fillFromRoute = () => {
  const routeOrderNo = Array.isArray(route.query.orderNo) ? route.query.orderNo[0] : route.query.orderNo
  const routeEmail = Array.isArray(route.query.email) ? route.query.email[0] : route.query.email
  if (typeof routeOrderNo === 'string' && routeOrderNo.trim()) {
    orderNo.value = routeOrderNo.trim()
  }
  if (typeof routeEmail === 'string' && routeEmail.trim()) {
    email.value = routeEmail.trim()
  }
}

watch(() => result.value?.order?.status, (status) => {
  if (status === 'created' || status === 'pending_payment') {
    if (pollTimer.value !== null) return
    pollTimer.value = window.setInterval(() => {
      void queryOrder(true)
    }, 4000)
    return
  }
  stopPolling()
})

onMounted(async () => {
  fillFromRoute()
  if (email.value && orderNo.value) {
    await queryOrder(true)
  }
})

onUnmounted(() => {
  stopPolling()
})
</script>
