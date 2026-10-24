import type { MessageUsage, UsageTotals } from '../api'
import { locale, t } from '../i18n'

const SYMBOL: Record<string, string> = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥', HKD: 'HK$' }

/** 1234 → "1,234"；≥10 万显示为 "12.3 万" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 100_000) {
    // 中文按“万”，英文按 K / M
    if (locale.value === 'en') {
      const big = Math.abs(n) >= 1_000_000
      return `${(n / (big ? 1_000_000 : 1_000)).toFixed(1).replace(/\.0$/, '')}${big ? 'M' : 'K'}`
    }
    return t('usage.k1fydwvz', [(n / 10_000).toFixed(1).replace(/\.0$/, '')])
  }
  return Math.round(n).toLocaleString('en-US')
}

/** 费用：小额保留 4 位有效小数，大额 2 位 */
export function formatCost(cost: number, currency: string | null | undefined): string {
  const code = (currency || '').toUpperCase()
  const symbol = SYMBOL[code] ?? (code ? `${code} ` : '')
  const abs = Math.abs(cost)
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2
  return `${symbol}${cost.toFixed(digits)}`
}

/**
 * 消息尾部小字（契约 §6.8-2）：`输入 x（缓存 y）/ 输出 z · 约 ¥0.0027`，估算时加“估”
 */
export function formatMessageUsage(usage: MessageUsage | null | undefined): string {
  if (!usage) return ''
  const cache = usage.cacheReadTokens > 0 ? t('usage.k1ejgmle', [formatTokens(usage.cacheReadTokens)]) : ''
  let text = t('usage.k1iatic5', [
    formatTokens(usage.inputTokens),
    cache ? `${cache}/ ` : ' / ',
    formatTokens(usage.outputTokens),
  ])
  if (usage.reasoningTokens > 0) text += t('usage.knst3o1', [formatTokens(usage.reasoningTokens)])
  if (usage.cost !== null && usage.cost !== undefined)
    text += t('usage.kog4ct', [formatCost(usage.cost, usage.currency)])
  if (usage.estimated) text += t('usage.k1cih6f')
  return text
}

/** 用量汇总里的多币种费用："¥1.23 + $0.40"；没有定价时 "—" */
export function formatCostMap(cost: Record<string, number> | null | undefined): string {
  const entries = Object.entries(cost ?? {}).filter(([, v]) => Number.isFinite(v))
  if (!entries.length) return '—'
  return entries.map(([currency, value]) => formatCost(value, currency)).join(' + ')
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCalls: 0,
    cost: {},
    unpricedCalls: 0,
  }
}

/* ── modelPricing 表格 ⇄ JSON（契约 §6.1） ── */

export interface PricingRow {
  key: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  currency: string
}

export function pricingToRows(json: string): PricingRow[] {
  if (!json.trim()) return []
  const parsed = JSON.parse(json) as Record<string, Record<string, unknown>>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('usage.k6hm47p'))
  return Object.entries(parsed).map(([key, v]) => ({
    key,
    input: v?.input === undefined ? '' : String(v.input),
    output: v?.output === undefined ? '' : String(v.output),
    cacheRead: v?.cacheRead === undefined ? '' : String(v.cacheRead),
    cacheWrite: v?.cacheWrite === undefined ? '' : String(v.cacheWrite),
    currency: typeof v?.currency === 'string' ? v.currency : 'CNY',
  }))
}

/** 校验并转回 JSON；返回 { json } 或 { error }（第几行哪里不对） */
export function rowsToPricing(rows: PricingRow[]): { json: string } | { error: string } {
  const out: Record<string, Record<string, number | string>> = {}
  for (const [i, row] of rows.entries()) {
    const key = row.key.trim()
    const blank = !key && !row.input.trim() && !row.output.trim()
    if (blank) continue
    if (!key) return { error: t('usage.k1i9nxne', [i + 1]) }
    if (out[key]) return { error: t('usage.k1qoc4rg', [key]) }
    const entry: Record<string, number | string> = {}
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const raw = row[field].trim()
      if (!raw) {
        if (field === 'input' || field === 'output')
          return { error: t('usage.k1rjcezo', [key, field === 'input' ? t('usage.k1sikn5s') : t('usage.k1ptvani')]) }
        continue
      }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return { error: t('usage.k7jeuxt', [key, raw]) }
      entry[field] = n
    }
    entry.currency = (row.currency.trim() || 'CNY').toUpperCase()
    out[key] = entry
  }
  return { json: Object.keys(out).length ? JSON.stringify(out) : '' }
}
