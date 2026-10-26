/**
 * 单证上的金额 / 单价格式化与舍入（报价单 HTML、报价单 PDF、商业发票共用），
 * 保证印出来的“数量 × 单价”与行金额一致、各行金额相加等于合计。
 */

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** 单价按单证上能印出的精度（最多 4 位小数）参与计算 */
export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

/** 金额：固定 2 位小数，千分位 */
export function formatMoney(value: number): string {
  return round2(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 单价：按实际精度印，最少 2 位、最多 4 位小数，去掉多余的 0（0.0875 → 0.0875，0.1 → 0.10，12.5 → 12.50） */
export function formatUnitPrice(value: number): string {
  return round4(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** 行金额 = 两位舍入（数量 × 印出来的单价） */
export function lineAmount(qty: number, unitPrice: number): number {
  return round2(qty * round4(unitPrice))
}

/** 合计 = 各行（已舍入的）金额相加 */
export function sumLines(lines: Array<{ qty: number; unitPrice: number }>): number {
  return round2(lines.reduce((sum, line) => sum + lineAmount(line.qty, line.unitPrice), 0))
}
