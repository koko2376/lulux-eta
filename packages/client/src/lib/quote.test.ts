import { describe, expect, it } from 'vitest'
import { formatMoney, lineAmount, quoteSubtotal, roundMoney, totalQty, validateItems } from './quote'

const item = (qty: number, unitPrice: number) => ({ productId: null, name: 'x', spec: '', unit: 'pcs', qty, unitPrice })

describe('报价金额计算', () => {
  it('行金额 = 数量 × 单价，按两位小数四舍五入', () => {
    expect(lineAmount({ qty: 3, unitPrice: 0.1 })).toBe(0.3)
    expect(lineAmount({ qty: 120, unitPrice: 29.995 })).toBe(3599.4)
    expect(lineAmount({ qty: 1, unitPrice: 1.005 })).toBe(1.01)
  })
  it('小计为各行取整后之和，避免浮点误差', () => {
    expect(quoteSubtotal([item(1, 0.1), item(1, 0.2)])).toBe(0.3)
    expect(quoteSubtotal([item(60, 42), item(80, 98), item(120, 26.5)])).toBe(2520 + 7840 + 3180)
  })
  it('JPY 等无小数币种取整', () => {
    expect(roundMoney(1234.5, 'JPY')).toBe(1235)
    expect(quoteSubtotal([item(3, 333.33)], 'JPY')).toBe(1000)
    expect(formatMoney(1000, 'JPY')).toBe('JPY 1,000')
  })
  it('非法输入按 0 处理', () => {
    expect(lineAmount({ qty: Number.NaN, unitPrice: 5 })).toBe(0)
    expect(lineAmount({ qty: '1,200' as unknown as number, unitPrice: 2 })).toBe(2400)
  })
  it('数量合计与格式化', () => {
    expect(totalQty([item(2, 1), item(3.5, 1)])).toBe(5.5)
    expect(formatMoney(13740, 'USD')).toBe('USD 13,740.00')
  })
  it('校验缺少品名、数量非正、单价为负', () => {
    const issues = validateItems([{ ...item(0, 1), name: '' }, item(1, -1), item(2, 3)])
    expect(issues.map((i) => i.index)).toEqual([0, 0, 1])
  })
})

describe('回归：单价精度与报价单 CSV 导出', () => {
  it('单价按实际精度显示（最少 2 位、最多 4 位），行金额 = 数量 × 显示的单价', async () => {
    const { formatUnitPrice, lineAmount } = await import('./quote')
    expect(formatUnitPrice(0.0875)).toBe('USD 0.0875')
    expect(formatUnitPrice(0.1)).toBe('USD 0.10')
    expect(formatUnitPrice(12.5, 'EUR')).toBe('EUR 12.50')
    expect(formatUnitPrice(0.123456)).toBe('USD 0.1235')
    expect(lineAmount({ qty: 5000, unitPrice: 0.0875 })).toBe(437.5)
    expect(lineAmount({ qty: 10000, unitPrice: 0.123456 })).toBe(1235)
  })

  it('CSV 导出防公式注入：= + - @ 开头的加前缀', async () => {
    const { csvCell, quoteToCsv } = await import('./quote')
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell('+1')).toBe(`"'+1"`)
    expect(csvCell('-cmd')).toBe(`"'-cmd"`)
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`)
    expect(csvCell('Bolt M6')).toBe('"Bolt M6"')
    const csv = quoteToCsv(
      { currency: 'USD', subtotal: 1, items: [{ name: '=1+1', spec: '@x', qty: 1, unit: 'pcs', unitPrice: 1 }] },
      ['#', 'Name', 'Spec', 'Qty', 'Unit', 'Price', 'Amount'],
    )
    expect(csv).toContain(`"'=1+1"`)
    expect(csv).toContain(`"'@x"`)
    expect(csv.split('\r\n').some((line) => /(^|,)"[=+\-@]/.test(line))).toBe(false)
  })
})
