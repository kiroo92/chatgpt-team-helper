<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { authService, purchaseService, userService, type PurchaseMyOrdersSummaryResponse } from '@/services/api'
import { useI18n } from '@/composables/useI18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { Copy, Link2, RefreshCw, Ticket, Users, Coins, ShoppingCart, CheckCircle2, Clock, RotateCcw, Lock, UserRound } from 'lucide-vue-next'

const router = useRouter()

const { t } = useI18n()

const currentUser = ref(authService.getCurrentUser())
const inviteEnabled = computed<boolean | null>(() => {
  const value = currentUser.value?.inviteEnabled
  if (value === undefined || value === null) return null
  return Boolean(value)
})
const syncCurrentUser = () => {
  currentUser.value = authService.getCurrentUser()
}

const { success: showSuccessToast, error: showErrorToast } = useToast()

const inviteCode = ref<string | null>(null)
const inviteLink = computed(() => {
  if (!inviteCode.value) return ''
  try {
    const url = new URL('/register', window.location.origin)
    url.searchParams.set('invite', inviteCode.value)
    return url.toString()
  } catch {
    return `/register?invite=${encodeURIComponent(inviteCode.value)}`
  }
})

const points = ref(0)
const invitedCount = ref(0)

const inviteLoading = ref(false)
const inviteError = ref('')
const summaryLoading = ref(false)
const summaryError = ref('')
const inviteSummaryLoaded = ref(false)

const orderSummary = ref<PurchaseMyOrdersSummaryResponse | null>(null)
const orderSummaryLoading = ref(false)
const orderSummaryError = ref('')

const usernameDraft = ref('')
const usernameLoading = ref(false)
const usernameError = ref('')

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordLoading = ref(false)
const passwordError = ref('')

const statusLabel = (status?: string) => {
  if (status === 'paid') return t('myOrders.status.paid')
  if (status === 'refunded') return t('myOrders.status.refunded')
  if (status === 'expired') return t('myOrders.status.expired')
  if (status === 'failed') return t('myOrders.status.failed')
  if (status === 'pending_payment') return t('myOrders.status.pendingPayment')
  if (status === 'created') return t('myOrders.status.created')
  return status || t('common.unknown')
}

const loadInviteSummary = async () => {
  summaryError.value = ''
  summaryLoading.value = true
  try {
    const result = await userService.getInviteSummary()
    inviteCode.value = result.inviteCode
    points.value = Number(result.points || 0)
    invitedCount.value = Number(result.invitedCount || 0)
  } catch (err: any) {
    summaryError.value = err.response?.data?.error || t('errors.loadFailed')
  } finally {
    summaryLoading.value = false
  }
}

const loadInviteSummaryOnce = async () => {
  if (inviteSummaryLoaded.value) return
  inviteSummaryLoaded.value = true
  await loadInviteSummary()
}

const loadOrderSummary = async () => {
  orderSummaryError.value = ''
  orderSummaryLoading.value = true
  try {
    orderSummary.value = await purchaseService.myOrdersSummary()
  } catch (err: any) {
    orderSummaryError.value = err.response?.data?.error || t('errors.loadFailed')
  } finally {
    orderSummaryLoading.value = false
  }
}

const generateInviteCode = async () => {
  inviteError.value = ''
  inviteLoading.value = true
  try {
    await userService.generateInviteCode()
    await loadInviteSummary()
    showSuccessToast(t('common.success'))
  } catch (err: any) {
    inviteError.value = err.response?.data?.error || t('common.failed')
    showErrorToast(inviteError.value)
  } finally {
    inviteLoading.value = false
  }
}

const updateUsername = async () => {
  usernameError.value = ''
  const next = usernameDraft.value.trim()
  if (!next) {
    usernameError.value = t('errors.requiredField')
    showErrorToast(usernameError.value)
    return
  }
  if (next.length > 64) {
    usernameError.value = t('errors.requiredField')
    showErrorToast(usernameError.value)
    return
  }
  if (String(currentUser.value?.username || '').trim() === next) {
    showSuccessToast(t('common.success'))
    return
  }

  usernameLoading.value = true
  try {
    const result = await userService.updateUsername(next)
    if (result?.user) {
      authService.setCurrentUser(result.user)
      currentUser.value = result.user
    }
    showSuccessToast(result?.message || t('common.success'))
  } catch (err: any) {
    usernameError.value = err.response?.data?.error || t('common.failed')
    showErrorToast(usernameError.value)
  } finally {
    usernameLoading.value = false
  }
}

const updatePassword = async () => {
  passwordError.value = ''
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    passwordError.value = t('errors.requiredField')
    showErrorToast(passwordError.value)
    return
  }
  if (newPassword.value.length < 6) {
    passwordError.value = t('errors.passwordTooShort')
    showErrorToast(passwordError.value)
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = t('errors.passwordMismatch')
    showErrorToast(passwordError.value)
    return
  }

  passwordLoading.value = true
  try {
    await userService.changePassword(currentPassword.value, newPassword.value)
    showSuccessToast(t('common.success'))
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (err: any) {
    passwordError.value = err.response?.data?.error || t('common.failed')
    showErrorToast(passwordError.value)
  } finally {
    passwordLoading.value = false
  }
}

const copyText = async (value: string, successMessage: string) => {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    showSuccessToast(successMessage)
  } catch (error) {
    console.error('Copy failed', error)
    showErrorToast(t('common.copyFailed'))
  }
}

watch(inviteEnabled, async (enabled) => {
  if (enabled === true) {
    await loadInviteSummaryOnce()
  }
})

onMounted(async () => {
  window.addEventListener('auth-updated', syncCurrentUser)
  usernameDraft.value = String(currentUser.value?.username || '').trim()

  try {
    const me = await userService.getMe()
    authService.setCurrentUser(me)
    currentUser.value = me
    usernameDraft.value = String(me?.username || '').trim()
  } catch (error: any) {
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
  }

  await loadOrderSummary()
  if (inviteEnabled.value) {
    await loadInviteSummaryOnce()
  }
})

onUnmounted(() => {
  window.removeEventListener('auth-updated', syncCurrentUser)
})
</script>

<template>
  <div class="space-y-8">
    <div v-if="inviteEnabled" class="grid gap-8 lg:grid-cols-3">
      <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
          <CardTitle class="text-xl font-bold text-gray-900">{{ t('userInfo.account.title') }}</CardTitle>
          <CardDescription class="text-gray-500">
            {{ currentUser?.username || 'User' }}（{{ currentUser?.email || '-' }}）
          </CardDescription>
        </CardHeader>
        <CardContent class="p-8 space-y-4">
          <div class="grid gap-4">
            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <Users class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.invite.stats.invited') }}</div>
                  <div class="text-xs text-gray-500">{{ t('userInfo.invite.desc') }}</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ invitedCount }}</div>
            </div>

            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
                  <Coins class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.invite.stats.points') }}</div>
                  <div class="text-xs text-gray-500">+5 per order</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ points }}</div>
            </div>
          </div>

          <div v-if="summaryError" class="text-sm text-red-600">
            {{ summaryError }}
          </div>

          <Button
            variant="outline"
            class="w-full h-11 rounded-xl bg-white border-gray-200"
            :disabled="summaryLoading"
            @click="loadInviteSummary"
          >
            <RefreshCw class="w-4 h-4 mr-2" :class="summaryLoading ? 'animate-spin' : ''" />
            {{ t('common.refresh') }}
          </Button>
        </CardContent>
      </Card>

      <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
          <CardTitle class="text-xl font-bold text-gray-900">{{ t('userInfo.invite.inviteLink') }}</CardTitle>
          <CardDescription class="text-gray-500">{{ t('userInfo.invite.desc') }}</CardDescription>
        </CardHeader>
        <CardContent class="p-8 space-y-5">
          <div class="grid gap-4">
            <div>
              <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                <Ticket class="w-4 h-4" />
                {{ t('userInfo.invite.inviteCode') }}
              </div>
              <div class="flex flex-col sm:flex-row gap-3 items-stretch">
                <Input
                  :model-value="inviteCode || ''"
                  readonly
                  :placeholder="t('userInfo.invite.generateCode')"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono"
                />
                <div class="flex gap-3">
                  <Button
                    class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
                    :disabled="inviteLoading"
                    @click="generateInviteCode"
                  >
                    {{ inviteCode ? t('userInfo.invite.generateCode') : t('userInfo.invite.generateCode') }}
                  </Button>
                  <Button
                    variant="outline"
                    class="h-11 rounded-xl bg-white border-gray-200"
                    :disabled="!inviteCode"
                    @click="copyText(inviteCode || '', t('userInfo.invite.codeCopied'))"
                  >
                    <Copy class="w-4 h-4 mr-2" />
                    {{ t('userInfo.invite.copyCode') }}
                  </Button>
                </div>
              </div>
              <div v-if="inviteError" class="text-sm text-red-600 mt-2">
                {{ inviteError }}
              </div>
            </div>

            <div>
              <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                <Link2 class="w-4 h-4" />
                {{ t('userInfo.invite.inviteLink') }}
              </div>
              <div class="flex flex-col sm:flex-row gap-3 items-stretch">
                <Input
                  :model-value="inviteLink"
                  readonly
                  :placeholder="t('userInfo.invite.generateCode')"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono"
                />
                <Button
                  variant="outline"
                  class="h-11 rounded-xl bg-white border-gray-200"
                  :disabled="!inviteLink"
                  @click="copyText(inviteLink, t('userInfo.invite.linkCopied'))"
                >
                  <Copy class="w-4 h-4 mr-2" />
                  {{ t('userInfo.invite.copyLink') }}
                </Button>
              </div>
              <div class="text-xs text-gray-500 mt-2">
                {{ t('userInfo.invite.desc') }}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-8 lg:grid-cols-2">
      <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
          <CardTitle class="text-xl font-bold text-gray-900">{{ t('userInfo.orders.title') }}</CardTitle>
          <CardDescription class="text-gray-500">{{ t('userInfo.orders.desc') }}</CardDescription>
        </CardHeader>
        <CardContent class="p-8 space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <ShoppingCart class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.orders.total') }}</div>
                  <div class="text-xs text-gray-500">{{ t('myOrders.bindOrder.desc') }}</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ orderSummary?.total ?? 0 }}</div>
            </div>

            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-green-50 text-green-600 flex items-center justify-center">
                  <CheckCircle2 class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.orders.paid') }}</div>
                  <div class="text-xs text-gray-500">{{ t('myOrders.stats.paid') }}</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ orderSummary?.paid ?? 0 }}</div>
            </div>

            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-yellow-50 text-yellow-600 flex items-center justify-center">
                  <Clock class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.orders.pending') }}</div>
                  <div class="text-xs text-gray-500">{{ t('myOrders.stats.pending') }}</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ orderSummary?.pending ?? 0 }}</div>
            </div>

            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center">
                  <RotateCcw class="w-5 h-5" />
                </div>
                <div>
                  <div class="text-sm font-semibold text-gray-900">{{ t('userInfo.orders.refunded') }}</div>
                  <div class="text-xs text-gray-500">{{ t('myOrders.stats.refunded') }}</div>
                </div>
              </div>
              <div class="text-2xl font-bold text-gray-900">{{ orderSummary?.refunded ?? 0 }}</div>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-sm font-semibold text-gray-900">{{ t('myOrders.orderList.title') }}</div>
              <Button
                variant="outline"
                class="h-9 rounded-xl bg-white border-gray-200"
                :disabled="orderSummaryLoading"
                @click="loadOrderSummary"
              >
                <RefreshCw class="w-4 h-4 mr-2" :class="orderSummaryLoading ? 'animate-spin' : ''" />
                {{ t('common.refresh') }}
              </Button>
            </div>

            <div v-if="orderSummaryError" class="text-sm text-red-600">
              {{ orderSummaryError }}
            </div>

            <div v-if="orderSummaryLoading && !orderSummary" class="py-6 text-sm text-gray-500">
              {{ t('common.loading') }}
            </div>

            <div v-else-if="(orderSummary?.recentOrders || []).length === 0" class="py-6 text-sm text-gray-500">
              {{ t('myOrders.orderList.noOrders') }}
            </div>

            <div v-else class="divide-y divide-gray-100 rounded-2xl border border-gray-100 overflow-hidden">
              <div
                v-for="item in orderSummary?.recentOrders || []"
                :key="item.orderNo"
                class="flex items-center justify-between px-5 py-4 bg-white"
              >
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-gray-900 truncate">
                    {{ item.productName }}
                  </div>
                  <div class="text-xs text-gray-500 font-mono truncate">
                    {{ item.orderNo }}
                  </div>
                </div>
                <div class="text-right flex-shrink-0">
                  <div class="text-sm font-semibold text-gray-900">
                    {{ item.amount }}
                  </div>
                  <div class="text-xs text-gray-500">
                    {{ statusLabel(item.status) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
              @click="router.push('/admin/my-orders')"
            >
              {{ t('userInfo.orders.viewAll') }}
            </Button>
            <Button
              variant="outline"
              class="h-11 rounded-xl bg-white border-gray-200"
              @click="router.push('/purchase')"
            >
              {{ t('common.submit') }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
          <CardTitle class="text-xl font-bold text-gray-900">{{ t('userInfo.password.title') }}</CardTitle>
          <CardDescription class="text-gray-500">{{ t('userInfo.password.desc') }}</CardDescription>
        </CardHeader>
        <CardContent class="p-8 space-y-8">
          <div class="space-y-4">
            <div class="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <UserRound class="w-4 h-4 text-gray-500" />
              {{ t('userInfo.account.updateUsername') }}
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('userInfo.account.username') }}</Label>
              <Input
                v-model="usernameDraft"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :placeholder="t('userInfo.account.usernamePlaceholder')"
                :disabled="usernameLoading"
              />
              <div v-if="usernameError" class="text-sm text-red-600">
                {{ usernameError }}
              </div>
            </div>
            <Button
              class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
              :disabled="usernameLoading"
              @click="updateUsername"
            >
              {{ usernameLoading ? t('userInfo.account.updating') : t('userInfo.account.updateUsername') }}
            </Button>
          </div>

          <div class="h-px bg-gray-100"></div>

          <div class="space-y-4">
            <div class="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Lock class="w-4 h-4 text-gray-500" />
              {{ t('userInfo.password.title') }}
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('userInfo.password.current') }}</Label>
              <Input
                v-model="currentPassword"
                type="password"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :placeholder="t('userInfo.password.currentPlaceholder')"
                :disabled="passwordLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('userInfo.password.new') }}</Label>
              <Input
                v-model="newPassword"
                type="password"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :placeholder="t('userInfo.password.newPlaceholder')"
                :disabled="passwordLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('userInfo.password.confirm') }}</Label>
              <Input
                v-model="confirmPassword"
                type="password"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :placeholder="t('userInfo.password.confirmPlaceholder')"
                :disabled="passwordLoading"
                @keydown.enter.prevent="updatePassword"
              />
              <div v-if="passwordError" class="text-sm text-red-600">
                {{ passwordError }}
              </div>
            </div>
            <Button
              class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
              :disabled="passwordLoading"
              @click="updatePassword"
            >
              {{ passwordLoading ? t('userInfo.password.updating') : t('userInfo.password.update') }}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>

  </div>
</template>
