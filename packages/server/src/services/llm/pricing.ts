import { settingsService } from '../settings-service.js'
import type { Usage } from './types.js'

/**
 * 费用估算。单价来自设置 `modelPricing`（JSON），单位：每百万 token。
 * 键可以是 `模型名` 或 `Provider名/模型名`，支持 * 通配；更具体（不含 *、带 Provider 名）的优先。
 * 不内置任何价格：各家调价频繁，未配置时 cost=null。
 *   { "deepseek-chat": { "input": 2, "output": 8, "cacheRead": 0.5, "currency": "CNY" },
 *     "OpenAI/gpt-4o*": { "input": 2.5, "output": 10, "currency": "USD" } }
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  currency: string
}

export function sanitizePrice(raw: unknown): ModelPrice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('单价必须是对象')
  const value = raw as Record<string, unknown>
  const num = (key: string, required: boolean): number | undefined => {
    const v = value[key]
    if (v === undefined && !required) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000) throw new Error(`${key} 必须是非负数字`)
    return v
  }
  const currency = value.currency === undefined ? 'USD' : value.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency 必须是三位大写币种代码')
  for (const key of Object.keys(value)) {
    if (!['input', 'output', 'cacheRead', 'cacheWrite', 'currency'].includes(key)) throw new Error(`未知单价字段：${key}`)
  }
  return { input: num('input', true)!, output: num('output', true)!, cacheRead: num('cacheRead', false), cacheWrite: num('cacheWrite', false), currency }
}

interface PriceRule {
  key: string
  pattern: RegExp
  withProvider: boolean
  wildcard: boolean
  price: ModelPrice
}

export function parsePricing(raw: string | undefined | null): PriceRule[] {
  if (!raw || !raw.trim()) return []
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 {"模型名": {input, output, ...}} 形式的 JSON 对象')
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
    key,
    pattern: new RegExp(`^${key.toLowerCase().replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`),
    withProvider: key.includes('/'),
    wildcard: key.includes('*'),
    price: sanitizePrice(value),
  }))
}

export function priceFor(providerName: string, model: string, raw: string | undefined | null = settingsService.get('modelPricing')): ModelPrice | null {
  let rules: PriceRule[]
  try {
    rules = parsePricing(raw)
  } catch {
    return null
  }
  const full = `${providerName}/${model}`.toLowerCase()
  const bare = model.toLowerCase()
  const ranked = rules
    .filter((rule) => (rule.withProvider ? rule.pattern.test(full) : rule.pattern.test(bare)))
    .sort((a, b) => Number(b.withProvider) - Number(a.withProvider) || Number(a.wildcard) - Number(b.wildcard))
  return ranked[0]?.price ?? null
}

/** 估算费用（四舍五入到 1e-6）；inputTokens 含缓存部分 */
export function estimateCost(usage: Usage, price: ModelPrice | null): { cost: number; currency: string } | null {
  if (!price) return null
  const cacheRead = Math.min(usage.cacheReadTokens, usage.inputTokens)
  const cacheWrite = Math.min(usage.cacheWriteTokens, Math.max(0, usage.inputTokens - cacheRead))
  const plainInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
  const cost =
    (plainInput * price.input +
      cacheRead * (price.cacheRead ?? price.input) +
      cacheWrite * (price.cacheWrite ?? price.input) +
      usage.outputTokens * price.output) /
    1_000_000
  return { cost: Math.round(cost * 1e6) / 1e6, currency: price.currency }
}
