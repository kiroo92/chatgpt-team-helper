import en from './locales/en'
import zh from './locales/zh'

export const messages = {
  'en-US': en,
  'en': en,
  'zh-CN': zh,
  'zh': zh,
}

export type LocaleKey = keyof typeof messages

export const defaultLocale: LocaleKey = 'en-US'

export const supportedLocales = [
  { code: 'en-US', name: 'English' },
  { code: 'zh-CN', name: '中文' },
]

export { en, zh }
