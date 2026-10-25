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

/** 单价按单证上能印出的精度（最多 4 位小数）参与计算 */
export function roundUnitPrice(value: number): number {
  return Math.round((toNumber(value) + Number.EPSILON) * 10_000) / 10_000
}

/** 行金额 = 按币种取整（数量 × 印出来的单价），与服务端口径一致 */
export function lineAmount(item: Pick<QuoteItem, 'qty' | 'unitPrice'>, currency = 'USD'): number {
  return roundMoney(toNumber(item.qty) * roundUnitPrice(toNumber(item.unitPrice)), currency)
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

/** 单价按实际精度显示：最少按币种的小数位（一般 2 位），最多 4 位，去掉多余的 0 */
export function formatUnitPrice(value: number, currency = 'USD'): string {
  const d = currencyDecimals(currency)
  return `${currency} ${roundUnitPrice(value).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: 4 })}`
}

/** CSV 单元格：加引号；以 = + - @ 开头（或制表符 / 回车）的加前缀 '，防止在表格软件里被当成公式执行 */
export function csvCell(value: unknown): string {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** 报价单导出 CSV（UTF-8 BOM）：表头 + 明细 + 合计行 */
export function quoteToCsv(
  quote: {
    currency: string
    subtotal: number
    items: Array<Pick<QuoteItem, 'name' | 'spec' | 'qty' | 'unit' | 'unitPrice'>>
  },
  headers: string[],
): string {
  const rows: unknown[][] = [
    headers,
    ...quote.items.map((i, n) => [n + 1, i.name, i.spec, i.qty, i.unit, i.unitPrice, lineAmount(i, quote.currency)]),
    ['', '', '', totalQty(quote.items), '', quote.currency, quote.subtotal],
  ]
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
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
