import { computed } from 'vue'
import { useAppConfigStore } from '@/stores/appConfig'
import { messages, defaultLocale, type LocaleKey } from '@/i18n'

type Messages = typeof messages['en-US']

function getNestedValue(obj: any, path: string): string | undefined {
  const keys = path.split('.')
  let current = obj
  for (const key of keys) {
    if (current === undefined || current === null) return undefined
    current = current[key]
  }
  return typeof current === 'string' ? current : undefined
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key]
    return value !== undefined ? String(value) : `{${key}}`
  })
}

export function useI18n() {
  const appConfigStore = useAppConfigStore()

  const locale = computed(() => {
    const current = appConfigStore.locale || defaultLocale
    return (current in messages ? current : defaultLocale) as LocaleKey
  })

  const currentMessages = computed(() => messages[locale.value] || messages[defaultLocale])

  function t(key: string, params?: Record<string, string | number>): string {
    const value = getNestedValue(currentMessages.value, key)
    if (value === undefined) {
      console.warn(`[i18n] Missing translation for key: ${key}`)
      return key
    }
    return params ? interpolate(value, params) : value
  }

  function setLocale(newLocale: LocaleKey) {
    appConfigStore.locale = newLocale
  }

  return {
    locale,
    t,
    setLocale,
    messages: currentMessages,
  }
}

export default useI18n
