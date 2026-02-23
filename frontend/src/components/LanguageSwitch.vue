<script setup lang="ts">
import { useI18n } from '@/composables/useI18n'
import { Button } from '@/components/ui/button'
import { Globe } from 'lucide-vue-next'

const { locale, setLocale } = useI18n()

const toggleLocale = () => {
  setLocale(locale.value === 'en-US' ? 'zh-CN' : 'en-US')
}
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="h-9 px-3 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100"
    @click="toggleLocale"
  >
    <Globe class="w-4 h-4 mr-1.5" />
    {{ locale === 'en-US' ? '中文' : 'EN' }}
  </Button>
</template>
