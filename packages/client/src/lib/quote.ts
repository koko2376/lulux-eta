import type { QuoteItem } from '../api'
import { t } from '../i18n'

/** 无小数位的币种 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND'])

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2
}

/** 按币种精度四舍五入（避免 0.1 + 0.2 之类的浮点误差） */
export function roundMoney(value: number, currency = 'USD'): number {
  const d = currencyDecimals(currency)
  const f = 10 ** d
  return Math.round((value + Number.EPSILON) * f) / f
}

export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

export function lineAmount(item: Pick<QuoteItem, 'qty' | 'unitPrice'>, currency = 'USD'): number {
  return roundMoney(toNumber(item.qty) * toNumber(item.unitPrice), currency)
}

/** 小计 = 各行（已按币种取整）金额之和，与服务端 subtotal 口径一致 */
export function quoteSubtotal(items: Array<Pick<QuoteItem, 'qty' | 'unitPrice'>>, currency = 'USD'): number {
  return roundMoney(
    items.reduce((sum, item) => sum + lineAmount(item, currency), 0),
    currency,
  )
}

export function totalQty(items: Array<Pick<QuoteItem, 'qty'>>): number {
  return items.reduce((sum, item) => sum + toNumber(item.qty), 0)
}

export function formatMoney(value: number, currency = 'USD'): string {
  const d = currencyDecimals(currency)
  return `${currency} ${toNumber(value).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}

export interface ItemIssue {
  index: number
  message: string
}

export function validateItems(items: QuoteItem[]): ItemIssue[] {
  const issues: ItemIssue[] = []
  items.forEach((item, index) => {
    if (!item.name.trim()) issues.push({ index, message: t('quote.k1jlkg7s', [index + 1]) })
    if (!(toNumber(item.qty) > 0)) issues.push({ index, message: t('quote.k188xtri', [index + 1]) })
    if (toNumber(item.unitPrice) < 0) issues.push({ index, message: t('quote.kzxqkuw', [index + 1]) })
  })
  return issues
}
