<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authService, userService } from '@/services/api'
import { useI18n } from '@/composables/useI18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import LanguageSwitch from '@/components/LanguageSwitch.vue'
import { Coins, Gift, RefreshCw } from 'lucide-vue-next'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast } = useToast()
const { t } = useI18n()

const teleportReady = ref(false)

const currentUser = ref(authService.getCurrentUser())
const syncCurrentUser = () => {
  currentUser.value = authService.getCurrentUser()
}

const points = ref(0)
const pointsMetaLoading = ref(false)

// 团队名额兑换
const teamSeatCostPoints = ref(15)
const teamSeatRemaining = ref(0)
const teamSeatEmails = ref('')
const redeemingTeamSeat = ref(false)
const redeemTeamSeatError = ref('')
const redeemTeamSeatResults = ref<Array<{ email: string; success: boolean; error?: string }>>([])

const loadPointsMeta = async () => {
  pointsMetaLoading.value = true
  try {
    const result = await userService.getPointsMeta()
    points.value = Number(result.points || 0)
    teamSeatCostPoints.value = Number(result.seat?.costPoints || 15)
    teamSeatRemaining.value = Number(result.seat?.remaining || 0)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || t('errors.loadFailed'))
  } finally {
    pointsMetaLoading.value = false
  }
}

// 解析邮箱列表（支持逗号、换行、空格分隔）
const parsedEmails = computed(() => {
  return teamSeatEmails.value
    .split(/[,\n\s]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
})

const teamSeatTotalCost = computed(() => parsedEmails.value.length * teamSeatCostPoints.value)

const canRedeemTeamSeat = computed(() => {
  if (redeemingTeamSeat.value) return false
  if (parsedEmails.value.length === 0) return false
  if (points.value < teamSeatTotalCost.value) return false
  return true
})

const teamSeatButtonLabel = computed(() => {
  if (redeemingTeamSeat.value) return t('pointsExchange.teamSeat.buttonLabelRedeeming')
  const count = parsedEmails.value.length
  if (count === 0) return t('pointsExchange.teamSeat.buttonLabelNoEmail')
  if (points.value < teamSeatTotalCost.value) return t('pointsExchange.teamSeat.buttonLabelInsufficient')
  return t('pointsExchange.teamSeat.buttonLabel', { count, cost: teamSeatTotalCost.value })
})

const redeemTeamSeat = async () => {
  redeemTeamSeatError.value = ''
  redeemTeamSeatResults.value = []

  const emails = parsedEmails.value
  if (emails.length === 0) {
    redeemTeamSeatError.value = t('errors.invalidEmail')
    showErrorToast(redeemTeamSeatError.value)
    return
  }

  if (!canRedeemTeamSeat.value) {
    redeemTeamSeatError.value = t('errors.insufficientPoints', { required: teamSeatTotalCost.value })
    showErrorToast(redeemTeamSeatError.value)
    return
  }

  redeemingTeamSeat.value = true
  try {
    const result = await userService.redeemTeamSeat({ emails })
    points.value = Number(result.points || 0)
    teamSeatCostPoints.value = Number(result.seat?.costPoints || teamSeatCostPoints.value)
    teamSeatRemaining.value = Number(result.seat?.remaining || 0)

    // 合并成功和失败的结果
    const allResults: Array<{ email: string; success: boolean; error?: string }> = []
    if (result.results) {
      for (const r of result.results) {
        allResults.push({ email: r.email, success: true })
      }
    }
    if (result.errors) {
      for (const e of result.errors) {
        allResults.push({ email: e.email, success: false, error: e.error })
      }
    }
    redeemTeamSeatResults.value = allResults

    showSuccessToast(result.message || t('common.success'))
    teamSeatEmails.value = ''
  } catch (err: any) {
    redeemTeamSeatError.value = err.response?.data?.error || t('common.failed')
    showErrorToast(redeemTeamSeatError.value)
  } finally {
    redeemingTeamSeat.value = false
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  currentUser.value = authService.getCurrentUser()
  window.addEventListener('auth-updated', syncCurrentUser)

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  try {
    const me = await userService.getMe()
    authService.setCurrentUser(me)
    currentUser.value = me
  } catch (error: any) {
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
  }

  await loadPointsMeta()
})

onUnmounted(() => {
  teleportReady.value = false
  window.removeEventListener('auth-updated', syncCurrentUser)
})
</script>

<template>
  <div class="space-y-8">
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3">
        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="pointsMetaLoading"
          @click="loadPointsMeta"
        >
          <RefreshCw class="h-4 w-4 mr-2" :class="pointsMetaLoading ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>

        <LanguageSwitch />
      </div>
    </Teleport>

    <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
      <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
        <CardTitle class="text-xl font-bold text-gray-900">{{ t('pointsExchange.availablePoints') }}</CardTitle>
        <CardDescription class="text-gray-500">
          {{ t('pointsExchange.availablePointsDesc') }}
        </CardDescription>
      </CardHeader>
      <CardContent class="p-8">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <Coins class="w-6 h-6" />
            </div>
            <div>
              <div class="text-sm font-semibold text-gray-900">{{ t('pointsExchange.currentPoints') }}</div>
              <div class="text-xs text-gray-500">
                {{ currentUser?.email || '-' }}
              </div>
            </div>
          </div>
          <div class="text-4xl font-bold text-gray-900 tabular-nums">
            {{ points }}
          </div>
        </div>
      </CardContent>
    </Card>

    <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
      <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <Gift class="w-5 h-5" />
          </div>
          <div>
            <CardTitle class="text-xl font-bold text-gray-900">{{ t('pointsExchange.teamSeat.title') }}</CardTitle>
            <CardDescription class="text-gray-500">{{ t('pointsExchange.teamSeat.desc', { cost: teamSeatCostPoints }) }}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent class="p-8 space-y-6">
        <div class="space-y-2">
          <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('pointsExchange.teamSeat.emailLabel') }}</Label>
          <textarea
            v-model="teamSeatEmails"
            class="w-full h-24 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 resize-none"
            :placeholder="t('pointsExchange.teamSeat.emailPlaceholder')"
            :disabled="redeemingTeamSeat"
          />
          <div class="text-xs text-gray-500">
            {{ t('pointsExchange.teamSeat.emailsIdentified', { count: parsedEmails.length, cost: teamSeatTotalCost, remaining: teamSeatRemaining }) }}
          </div>
        </div>

        <div v-if="redeemTeamSeatError" class="text-sm text-red-600">
          {{ redeemTeamSeatError }}
        </div>

        <div v-if="redeemTeamSeatResults.length > 0" class="space-y-2">
          <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{{ t('pointsExchange.teamSeat.redeemResult') }}</div>
          <div class="max-h-32 overflow-y-auto space-y-1">
            <div
              v-for="(r, idx) in redeemTeamSeatResults"
              :key="idx"
              class="flex items-center justify-between text-xs px-3 py-2 rounded-lg"
              :class="r.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'"
            >
              <span>{{ r.email }}</span>
              <span>{{ r.success ? t('pointsExchange.teamSeat.redeemSuccess') : r.error }}</span>
            </div>
          </div>
        </div>

        <Button
          class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white w-full"
          :disabled="!canRedeemTeamSeat"
          @click="redeemTeamSeat"
        >
          {{ teamSeatButtonLabel }}
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
