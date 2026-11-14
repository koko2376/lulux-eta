import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from '../../config.js'
import { AppError } from '../../errors.js'
import { logger } from '../logger.js'

/**
 * WhatsApp 输入翻译引擎。
 *
 * 与 WhatsApp 引擎同一策略：**不打进 package.json、不随应用安装**，只从
 *   LULUX_WHATSAPP_TRANSLATOR_DIR → <dataDir>/whatsapp/translator → .eta-engines/translator
 * 动态加载运行时包；包必须导出 `createTranslator()`。
 *
 * 内置可注入的 `fake` 引擎（`LULUX_WHATSAPP_TRANSLATOR=fake`）用于界面与契约验证；
 * 本地离线 MT（Argos）与付费云/LLM 都只保留 provider 接口，未下载模型、未接网络。
 * 引擎缺失时显式返回 `TRANSLATOR_NOT_INSTALLED`，绝不返回原文冒充译文。
 */

export type TranslatorKind = 'local' | 'cloud' | 'llm'

export interface TranslatorInput {
  text: string
  /** `auto` 由服务层解析成具体源语言 */
  sourceLang: string
  targetLang: string
}

export interface TranslatorResult {
  text: string
  sourceLang: string
  targetLang: string
}

export interface TranslatorProvider {
  readonly id: string
  readonly kind: TranslatorKind
  /** 付费云/LLM provider 默认禁用；只有显式启用的 provider 才允许被调用 */
  readonly enabled: boolean
  translate(input: TranslatorInput): Promise<TranslatorResult>
}

export interface TranslatorInfo {
  id: string
  kind: TranslatorKind
  installed: boolean
  enabled: boolean
  dir: string | null
  error: { code: string; message: string } | null
}

/** 目标语言清单：默认 en；`auto` 保留但绝不是初始值（调研 §8.1） */
export const TRANSLATOR_TARGET_LANGUAGES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'ru',
  'es',
  'pt',
  'fr',
  'de',
  'ar',
  'th',
  'vi',
  'id',
  'auto',
] as const

export type TranslatorTargetLanguage = (typeof TRANSLATOR_TARGET_LANGUAGES)[number]

/**
 * 假翻译器：只用于单测与浏览器验收。
 * provider id 固定为 `fake`，界面会显示来源，避免把测试用译文当成真实离线 MT。
 */
const FAKE_PHRASES: Array<[RegExp, string]> = [
  [/^你好[，,]?\s*我想咨询一下产品报价[。.!！]?$/, 'Hello, I would like to ask about your product quotation.'],
  [/^你好[。!！]?$/, 'Hello.'],
  [/^谢谢[。!！]?$/, 'Thank you.'],
  [/^多少钱[？?]?$/, 'How much does it cost?'],
  [/^价格$/, 'price'],
  [/^产品$/, 'product'],
  [/^报价$/, 'quotation'],
]

export class FakeTranslator implements TranslatorProvider {
  readonly id = 'fake'
  readonly kind: TranslatorKind = 'local'
  readonly enabled = true

  async translate(input: TranslatorInput): Promise<TranslatorResult> {
    const targetLang = input.targetLang === 'auto' ? 'en' : input.targetLang
    if (targetLang === 'zh-Hans' && !/[一-鿿]/.test(input.text)) {
      return { text: `（假引擎译文）${input.text}`, sourceLang: input.sourceLang, targetLang }
    }
    for (const [pattern, replacement] of FAKE_PHRASES) {
      if (pattern.test(input.text.trim())) {
        return { text: replacement, sourceLang: input.sourceLang, targetLang }
      }
    }
    return {
      text: `[fake:${targetLang}] ${input.text}`,
      sourceLang: input.sourceLang,
      targetLang,
    }
  }
}

let cached: { key: string; provider: TranslatorProvider } | null = null
let cachedError: { key: string; info: TranslatorInfo } | null = null

function translatorDirs(): string[] {
  const dirs: string[] = []
  const explicit = process.env.LULUX_WHATSAPP_TRANSLATOR_DIR?.trim()
  if (explicit) dirs.push(resolve(explicit))
  dirs.push(join(config.home, 'whatsapp', 'translator'))
  // 仓库外置目录：兼容从仓库根或 packages/server 启动
  const cwd = process.cwd()
  for (const base of [cwd, resolve(cwd, '..'), resolve(cwd, '..', '..'), resolve(cwd, '..', '..', '..')]) {
    dirs.push(join(base, '.eta-engines', 'translator'))
  }
  return [...new Set(dirs)]
}

function cacheKey(): string {
  return `${process.env.LULUX_WHATSAPP_TRANSLATOR ?? ''}|${process.env.LULUX_WHATSAPP_TRANSLATOR_DIR ?? ''}|${config.home}|${process.cwd()}`
}

export function inspectTranslator(): TranslatorInfo {
  const mode = process.env.LULUX_WHATSAPP_TRANSLATOR?.trim()
  if (mode === 'fake') {
    return { id: 'fake', kind: 'local', installed: true, enabled: true, dir: null, error: null }
  }
  const key = cacheKey()
  if (cachedError && cachedError.key === key) return cachedError.info
  for (const dir of translatorDirs()) {
    const packageFile = join(dir, 'package.json')
    if (!existsSync(packageFile)) continue
    try {
      const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        name?: string
        version?: string
        main?: string
        module?: string
        exports?: string | Record<string, unknown>
      }
      return {
        id: manifest.name ?? 'translator',
        kind: 'local',
        installed: true,
        enabled: true,
        dir,
        error: null,
      }
    } catch (error) {
      const info: TranslatorInfo = {
        id: 'translator',
        kind: 'local',
        installed: true,
        enabled: false,
        dir,
        error: { code: 'TRANSLATOR_LOAD_FAILED', message: messageOf(error) },
      }
      cachedError = { key, info }
      return info
    }
  }
  const info: TranslatorInfo = {
    id: 'none',
    kind: 'local',
    installed: false,
    enabled: false,
    dir: null,
    error: {
      code: 'TRANSLATOR_NOT_INSTALLED',
      message: '未安装 WhatsApp 翻译引擎（见 docs/WHATSAPP-TRANSLATOR.md）',
    },
  }
  cachedError = { key, info }
  return info
}

export async function loadTranslator(): Promise<TranslatorProvider> {
  const mode = process.env.LULUX_WHATSAPP_TRANSLATOR?.trim()
  const key = cacheKey()
  if (mode === 'fake') {
    if (!cached || cached.key !== key) cached = { key, provider: new FakeTranslator() }
    return cached.provider
  }
  if (cached && cached.key === key) return cached.provider
  const info = inspectTranslator()
  if (!info.installed) {
    throw new AppError(
      503,
      'TRANSLATOR_NOT_INSTALLED',
      '未安装 WhatsApp 翻译引擎，无法翻译输入；请先安装本地离线翻译引擎（见 docs/WHATSAPP-TRANSLATOR.md）',
      undefined,
      { installHint: 'docs/WHATSAPP-TRANSLATOR.md', dirs: translatorDirs() },
    )
  }
  if (!info.dir) {
    throw new AppError(503, 'TRANSLATOR_LOAD_FAILED', '翻译引擎目录不可用，请重新安装')
  }
  try {
    const provider = await importRuntimeTranslator(info.dir)
    if (!provider.enabled) {
      throw new AppError(503, 'TRANSLATOR_DISABLED', '翻译引擎已安装但未启用（付费云/LLM provider 默认关闭）')
    }
    cached = { key, provider }
    return provider
  } catch (error) {
    if (error instanceof AppError) throw error
    logger.warn('whatsapp translator load failed', { message: messageOf(error) })
    throw new AppError(
      503,
      'TRANSLATOR_LOAD_FAILED',
      `翻译引擎加载失败：${messageOf(error)}`,
      undefined,
      { dir: info.dir },
    )
  }
}

async function importRuntimeTranslator(dir: string): Promise<TranslatorProvider> {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    main?: string
    module?: string
    exports?: string | { import?: string; default?: string }
  }
  const exportsField = manifest.exports
  const entry =
    (typeof exportsField === 'string' ? exportsField : exportsField?.import ?? exportsField?.default) ??
    manifest.module ??
    manifest.main ??
    'index.js'
  const file = join(dir, entry)
  const url = pathToFileURL(file).href
  const module = (await import(url)) as {
    createTranslator?: () => TranslatorProvider
    default?: unknown
  }
  const defaultExport = module.default
  const defaultFactory =
    typeof defaultExport === 'object' &&
    defaultExport !== null &&
    'createTranslator' in defaultExport
      ? (defaultExport as { createTranslator?: () => TranslatorProvider }).createTranslator
      : undefined
  const factory =
    module.createTranslator ??
    defaultFactory ??
    (typeof defaultExport === 'function' ? (defaultExport as () => TranslatorProvider) : undefined)
  if (typeof factory !== 'function') {
    throw new Error('运行时翻译引擎必须导出 createTranslator()')
  }
  const provider = factory()
  if (!provider || typeof provider.translate !== 'function') {
    throw new Error('createTranslator() 返回的 provider 缺少 translate()')
  }
  return provider
}

/**
 * 付费云/LLM 仅保留接口：不注册、不读取 API key、默认禁用。
 * 未来 provider 必须显式声明 `enabled: true` 才会被 loadTranslator 采用。
 */
export interface ReservedPaidTranslatorConfig {
  id: string
  kind: Extract<TranslatorKind, 'cloud' | 'llm'>
  enabled: false
  apiKeyEnv: string
}

export const RESERVED_PAID_TRANSLATORS: ReservedPaidTranslatorConfig[] = [
  { id: 'cloud-reserved', kind: 'cloud', enabled: false, apiKeyEnv: 'LULUX_TRANSLATOR_CLOUD_KEY' },
  { id: 'llm-reserved', kind: 'llm', enabled: false, apiKeyEnv: 'LULUX_TRANSLATOR_LLM_KEY' },
]

export function detectTextLanguage(text: string): 'zh-Hans' | 'en' | 'unknown' {
  if (/[一-鿿]/.test(text)) return 'zh-Hans'
  if (/[A-Za-z]/.test(text)) return 'en'
  return 'unknown'
}

/** `auto` 目标语言：按会话最近一条入站消息检测；检测不出时回退 en */
export function resolveAutoTarget(text: string | null): 'en' | 'zh-Hans' {
  const detected = text ? detectTextLanguage(text) : 'unknown'
  return detected === 'zh-Hans' ? 'zh-Hans' : 'en'
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
