import { computed } from 'vue'
import { createI18n, type MessageCompiler, type MessageContext } from 'vue-i18n'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

/**
 * 界面语言：简体中文（默认，首次启动不看系统语言）/ English / 跟随系统。按设备保存在 localStorage，切换即时生效；
 * 登录页右上角的语言选择与 设置 → 外观 用的是同一个偏好。
 * 桌面端同时交给主进程保存（userData/ui-language.json，preload 启动时同步读出为 window.lulux.languagePref）：
 * 本地服务端口变化会让页面 origin 变化、localStorage 变成空的，这时用主进程保存的那份。
 * 文案按文件分组（scope.key），由 scripts/i18n-extract.mjs 抽取；locales.test.ts 保证两种语言键一致。
 */
export type Locale = 'zh-CN' | 'en'
export type LanguagePref = Locale | 'system'
export const LOCALES: Locale[] = ['zh-CN', 'en']
const KEY = 'lulux.language'

/**
 * 只做 {0} / {name} 占位替换：文案里的 @ | { } 等字符原样输出，不需要转义。
 * 英文单复数：{0:order|orders} 按参数 0 是否等于 1 输出单数或复数词（不输出数字本身）。
 */
export function formatMessage(text: string, get: (key: string) => unknown): string {
  return text.replace(/\{(\w+)(?::([^|{}]*)\|([^{}]*))?\}/g, (raw, k: string, one?: string, many?: string) => {
    const v = get(k)
    if (one !== undefined) return Number(v) === 1 ? one : (many ?? '')
    return v === undefined || v === null ? raw : String(v)
  })
}
const compiler: MessageCompiler = (message) => {
  const text = typeof message === 'string' ? message : ''
  return (ctx: MessageContext) => formatMessage(text, (k) => (/^\d+$/.test(k) ? ctx.list(Number(k)) : ctx.named(k)))
}

export function systemLocale(): Locale {
  const langs = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]
  const first = langs.find(Boolean) ?? 'zh-CN'
  return first.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

const isPref = (v: unknown): v is LanguagePref => v === 'zh-CN' || v === 'en' || v === 'system'

/** 本机保存的语言偏好：localStorage → 桌面主进程保存的 → 简体中文 */
export function loadLanguagePref(): LanguagePref {
  try {
    const v = localStorage.getItem(KEY)
    if (isPref(v)) return v
  } catch {
    /* 隐私模式等 */
  }
  const desktop = (globalThis as { lulux?: { languagePref?: unknown } }).lulux?.languagePref
  return isPref(desktop) ? desktop : 'zh-CN'
}

export { LOCALE_NAMES } from './locale-names'

export function resolveLocale(pref: LanguagePref): Locale {
  return pref === 'system' ? systemLocale() : pref
}

const initialPref = loadLanguagePref()
const initial = resolveLocale(initialPref)

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initial,
  fallbackLocale: 'zh-CN',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: { 'zh-CN': zhCN, en } as any,
  messageCompiler: compiler,
  missingWarn: false,
  fallbackWarn: false,
})

type Params = unknown[] | Record<string, unknown>
const g = i18n.global as unknown as { locale: { value: string }; t: (k: string, p: Params) => string }

/** 脚本里用的翻译函数（组件模板里用 $t） */
export function t(key: string, params?: Params): string {
  return g.t(key, params ?? [])
}

export const locale = computed<Locale>(() => g.locale.value as Locale)

/** 日期 / 数字格式化用的 BCP 47 标签 */
export function intlLocale(): string {
  return locale.value === 'en' ? 'en-US' : 'zh-CN'
}

/** 桌面端：把偏好（不是解析后的语言，'system' 原样）交给主进程保存，并用于原生菜单 / 对话框 */
function applyDocument(l: Locale, pref: LanguagePref): void {
  if (typeof document !== 'undefined') document.documentElement.lang = l
  const bridge = (globalThis as { lulux?: { setLanguage?: (l: LanguagePref) => void } }).lulux
  try {
    bridge?.setLanguage?.(pref)
  } catch {
    /* 旧版桌面壳没有这个接口 */
  }
}
applyDocument(initial, initialPref)

export function setLanguage(pref: LanguagePref): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    /* 隐私模式等 */
  }
  const next = resolveLocale(pref)
  g.locale.value = next
  applyDocument(next, pref)
}

/**
 * 模块顶层的文案表（标签映射、预设列表）：每次读取都按当前语言重新生成，切换语言后立即生效。
 */
export function localized<T extends object>(build: () => T): T {
  let cacheLocale: string | null = null
  let cache: T | null = null
  const get = (): T => {
    const l = g.locale.value
    if (!cache || cacheLocale !== l) {
      cache = build()
      cacheLocale = l
    }
    return cache
  }
  const target = (Array.isArray(build()) ? [] : {}) as T
  return new Proxy(target, {
    get: (_t, k) => {
      const obj = get() as Record<string | symbol, unknown>
      const v = obj[k]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(obj) : v
    },
    has: (_t, k) => k in get(),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (tgt, k) => {
      const own = Reflect.getOwnPropertyDescriptor(tgt, k)
      if (own && !own.configurable) return own
      const d = Reflect.getOwnPropertyDescriptor(get(), k)
      return d ? { ...d, configurable: true } : undefined
    },
  })
}

/** “标签：内容”（英文 “label: value”） */
export function labelled(label: string, value: string): string {
  return t('fmt.labelled', [label, value])
}

/** “正文（补充）”（英文 “text (extra)”） */
export function withParen(text: string, extra: string): string {
  return t('fmt.paren', [text, extra])
}
