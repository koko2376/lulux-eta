import { z } from 'zod'
import { AppError, notFound } from '../../errors.js'
import { settingsService } from '../settings-service.js'
import { parse } from '../../validation.js'
import { currencyCode, productService } from '../product-service.js'
import { fxService } from './fx-service.js'
import { CONTAINERS, freightService, type Container } from './freight-service.js'

/**
 * 报价计算（纯计算，不写库）：成本 → EXW / FOB / CFR / CIF / DDP 成本阶梯 → 按毛利定价。
 *
 * 口径（全部换算成报价币种后计算）：
 * - EXW 成本 = 采购成本 − 出口退税（成本 ÷ 1.13 × 退税率）；
 * - FOB = EXW + 出口费用（拖车/报关/港杂）按货值分摊；
 * - CFR = FOB + 海运费（有体积时按体积分摊，否则按货值）；
 * - CIF = CFR ÷ (1 − 110% × 保险费率)（保费按 CIF × 110% 计）；
 * - DDP = CIF × (1 + 关税) × (1 + 增值税) + 目的港费用按货值分摊。
 * - 定价在“所请求术语的总成本”上加毛利；价格阶梯里每一级都用同一行的毛利率。
 * 汇率优先级：本次传入的 fx → 设置里的锁汇 → 实时汇率（fx-service）。
 */

export const PRICING_INCOTERMS = ['EXW', 'FOB', 'CFR', 'CIF', 'DDP'] as const
export type PricingIncoterm = (typeof PRICING_INCOTERMS)[number]

export interface FxUsed {
  pair: string
  rate: number
  source: 'manual' | 'locked' | 'frankfurter' | 'erapi' | 'identity'
  asOf: string
  locked: boolean
  stale: boolean
}

export interface PricingItemResult {
  productId: string | null
  name: string
  qty: number
  unit: string
  /** 请求术语下每单位总成本（报价币种） */
  unitCost: number
  unitPrice: number
  marginPct: number
  amount: number
  /** 每一级术语的单位成本 */
  ladderCost: Partial<Record<PricingIncoterm, number>>
  /** 每一级术语的单位报价（同一毛利率） */
  ladder: Partial<Record<PricingIncoterm, number>>
}

export interface PricingResult {
  incoterm: PricingIncoterm
  quoteCurrency: string
  items: PricingItemResult[]
  totals: { cost: number; revenue: number; profit: number; marginPct: number; cbm: number; kg: number }
  container: { type: Container; count: number; cbmUsed: number; fillPct: number } | null
  freight: { source: 'manual' | 'rate_table' | 'none'; rateId?: string; amount: number; currency: string }
  fx: FxUsed[]
  breakdown: Array<{ key: string; label: string; amount: number }>
  warnings: string[]
  quoteItems: Array<{ productId: string | null; name: string; spec: string; qty: number; unit: string; unitPrice: number }>
}

export const CONTAINER_CBM: Record<Container, number> = { LCL: 15, '20GP': 28, '40GP': 58, '40HQ': 68 }

/** 自动选柜：≤15 拼箱，≤28 20GP，≤58 40GP，≤68 40HQ，更多用多个 40HQ */
export function pickContainer(cbm: number): { type: Container; count: number } {
  if (cbm <= 15) return { type: 'LCL', count: 1 }
  if (cbm <= 28) return { type: '20GP', count: 1 }
  if (cbm <= 58) return { type: '40GP', count: 1 }
  if (cbm <= 68) return { type: '40HQ', count: 1 }
  return { type: '40HQ', count: Math.ceil(cbm / 68) }
}

const money = z.number().finite().min(0, '金额不能为负数').max(1e12)

const itemInput = z
  .object({
    name: z.string().trim().min(1, '品名不能为空').max(300),
    qty: z.number().finite().positive('数量必须大于 0').max(1e9),
    unit: z.string().trim().max(30).default('pcs'),
    unitCost: money.optional(),
    costCurrency: currencyCode.optional(),
    cbmPerUnit: z.number().finite().min(0, '体积不能为负数').max(1e4).optional(),
    kgPerUnit: z.number().finite().min(0, '重量不能为负数').max(1e6).optional(),
    productId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()

const costsInput = z
  .object({
    exportPerShipment: money.default(0),
    freight: z
      .object({
        amount: money,
        currency: currencyCode.default('USD'),
        per: z.enum(['shipment', 'cbm']).default('shipment'),
      })
      .strict()
      .optional(),
    pol: z.string().trim().max(100).optional(),
    pod: z.string().trim().max(100).optional(),
    container: z.enum(CONTAINERS).optional(),
    insuranceRatePct: z.number().finite().min(0).max(10, '保险费率不能超过 10%').optional(),
    dutyPct: z.number().finite().min(0).max(300).optional(),
    vatPct: z.number().finite().min(0).max(100).optional(),
    destinationPerShipment: money.default(0),
    exportRebatePct: z.number().finite().min(0).max(17, '退税率不能超过 17%').default(0),
  })
  .strict()

const ruleInput = z
  .object({
    marginPct: z.number().finite().min(0, '毛利率不能为负数').max(95, '毛利率不能超过 95%').optional(),
    markupPct: z.number().finite().min(0, '加成率不能为负数').max(1000).optional(),
    targetUnitPrices: z.array(z.number().finite().positive('目标单价必须大于 0').max(1e12)).min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (rule) => [rule.marginPct, rule.markupPct, rule.targetUnitPrices].filter((value) => value !== undefined).length <= 1,
    'pricing 里 marginPct / markupPct / targetUnitPrices 只能选一种',
  )

export const pricingInput = z
  .object({
    items: z.array(itemInput).min(1, '至少需要一条明细').max(200, '明细最多 200 条'),
    quoteCurrency: currencyCode.default('USD'),
    incoterm: z.string().trim().toUpperCase().default('FOB'),
    pricing: ruleInput.default({}),
    costs: costsInput.default({ exportPerShipment: 0, destinationPerShipment: 0, exportRebatePct: 0 }),
    /** 本次计算临时指定的汇率，如 { "USD/CNY": 7.1 }（反向自动取倒数） */
    fx: z
      .record(z.string().regex(/^[A-Z]{3}\/[A-Z]{3}$/, '汇率键应形如 USD/CNY'), z.number().finite().positive())
      .default({}),
  })
  .strict()

export type PricingInput = z.input<typeof pricingInput>

const round2 = (value: number): number => Math.round(value * 100) / 100
/** 单价：≥1 保留 2 位，<1 保留 4 位（小五金、配件常见） */
const roundPrice = (value: number): number => (Math.abs(value) >= 1 ? round2(value) : Math.round(value * 10000) / 10000)
const roundUnit = (value: number): number => Math.round(value * 10000) / 10000
/** 展示用汇率：6 位有效数字（计算仍用全精度） */
const sig6 = (value: number): number => Number(value.toPrecision(6))

const LABELS = {
  goods: '货值成本（EXW）',
  rebate: '出口退税冲减',
  export: '出口费用（拖车/报关/港杂）',
  freight: '海运费',
  insurance: '保险费',
  duty: '进口关税',
  vat: '进口增值税',
  destination: '目的港清关/派送',
  cost: '总成本',
  profit: '毛利',
  revenue: '报价总额',
} as const

function defaultMargin(): number {
  const value = Number(settingsService.get('defaultMarginPct') ?? '15')
  return Number.isFinite(value) && value >= 0 && value < 100 ? value : 15
}

function defaultInsurance(): number {
  const value = Number(settingsService.get('defaultInsuranceRatePct') ?? '0.11')
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : 0.11
}

/** 一次计算里复用汇率，并记录用到的每个币种对 */
class FxBook {
  private readonly cache = new Map<string, number>()
  readonly used: FxUsed[] = []
  constructor(private readonly overrides: Record<string, number>) {}

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1
    const key = `${from}/${to}`
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    let rate: number
    const direct = this.overrides[key]
    const inverse = this.overrides[`${to}/${from}`]
    if (direct !== undefined || inverse !== undefined) {
      rate = direct !== undefined ? direct : 1 / inverse!
      this.used.push({ pair: key, rate: sig6(rate), source: 'manual', asOf: '', locked: true, stale: false })
    } else {
      const fx = await fxService.rate(from, to)
      rate = fx.rate
      this.used.push({ pair: key, rate: sig6(fx.rate), source: fx.source, asOf: fx.asOf, locked: fx.locked, stale: fx.stale })
    }
    this.cache.set(key, rate)
    return rate
  }
}

function needsFreight(term: PricingIncoterm): boolean {
  return term === 'CFR' || term === 'CIF' || term === 'DDP'
}

export const pricingService = {
  async calculate(input: unknown): Promise<PricingResult> {
    const data = parse(pricingInput, input)
    const term = data.incoterm as PricingIncoterm
    if (!(PRICING_INCOTERMS as readonly string[]).includes(term)) {
      throw new AppError(400, 'BAD_ARGS', `${data.incoterm || '空'} 暂不支持报价计算，目前支持 EXW / FOB / CFR / CIF / DDP`)
    }
    const rule = data.pricing
    if (rule.targetUnitPrices && rule.targetUnitPrices.length !== data.items.length) {
      throw new AppError(400, 'BAD_ARGS', `targetUnitPrices 有 ${rule.targetUnitPrices.length} 个，明细有 ${data.items.length} 条，数量必须一致`)
    }
    const costs = data.costs
    const currency = data.quoteCurrency
    const fx = new FxBook(data.fx)
    const warnings: string[] = []
    const termIndex = PRICING_INCOTERMS.indexOf(term)
    const reaches = (level: PricingIncoterm): boolean => termIndex >= PRICING_INCOTERMS.indexOf(level)

    /* 1. 每行 EXW 单位成本（报价币种） */
    let usedProductPrice = false
    const lines: Array<{ productId: string | null; name: string; qty: number; unit: string; base: number; rebate: number; cbm: number; kg: number }> = []
    for (const [index, item] of data.items.entries()) {
      let unitCost = item.unitCost
      let costCurrency = item.costCurrency
      if (item.productId) {
        const product = productService.get(item.productId)
        if (!product) throw notFound(`产品（第 ${index + 1} 行）`)
        if (unitCost === undefined) {
          unitCost = product.price
          costCurrency = costCurrency ?? product.currency
          usedProductPrice = true
        }
      }
      if (unitCost === undefined) {
        throw new AppError(400, 'BAD_ARGS', `第 ${index + 1} 行「${item.name}」缺少 unitCost（单位成本）`)
      }
      const rate = await fx.rate(costCurrency ?? 'CNY', currency)
      const cost = unitCost * rate
      const rebate = costs.exportRebatePct > 0 ? (cost / 1.13) * (costs.exportRebatePct / 100) : 0
      lines.push({
        productId: item.productId ?? null,
        name: item.name,
        qty: item.qty,
        unit: item.unit,
        base: cost,
        rebate,
        cbm: (item.cbmPerUnit ?? 0) * item.qty,
        kg: (item.kgPerUnit ?? 0) * item.qty,
      })
    }
    if (usedProductPrice) warnings.push('有明细没填成本，用的是产品库里的售价当成本，请核对')

    const exwUnit = lines.map((line) => (line.base - line.rebate))
    const exwTotal = lines.reduce((sum, line, i) => sum + exwUnit[i]! * line.qty, 0)
    const valueShare = lines.map((line, i) => (exwTotal > 0 ? (exwUnit[i]! * line.qty) / exwTotal : 1 / lines.length))
    const totalCbm = lines.reduce((sum, line) => sum + line.cbm, 0)
    const totalKg = lines.reduce((sum, line) => sum + line.kg, 0)
    const missingVolume = lines.some((line) => line.cbm <= 0)
    const volumeShare = totalCbm > 0 && !missingVolume ? lines.map((line) => line.cbm / totalCbm) : null

    /* 2. 柜型 */
    let container: PricingResult['container'] = null
    if (costs.container) {
      const cap = CONTAINER_CBM[costs.container]
      const count = costs.container === 'LCL' ? 1 : Math.max(1, Math.ceil(totalCbm / cap))
      container = { type: costs.container, count, cbmUsed: round2(totalCbm), fillPct: totalCbm > 0 ? round2((totalCbm / (cap * count)) * 100) : 0 }
      if (costs.container === 'LCL' && totalCbm > 15) warnings.push(`总体积 ${round2(totalCbm)} cbm，拼箱偏贵，建议考虑整柜`)
    } else if (totalCbm > 0) {
      const picked = pickContainer(totalCbm)
      const cap = CONTAINER_CBM[picked.type]
      container = { type: picked.type, count: picked.count, cbmUsed: round2(totalCbm), fillPct: round2((totalCbm / (cap * picked.count)) * 100) }
    }
    if (container && container.count > 1) warnings.push(`总体积 ${round2(totalCbm)} cbm，需要 ${container.count} 个 ${container.type}`)

    /* 3. 每票费用 */
    const exportFee = reaches('FOB') && costs.exportPerShipment > 0 ? costs.exportPerShipment * (await fx.rate('CNY', currency)) : 0

    let freightTotal = 0
    let freight: PricingResult['freight'] = { source: 'none', amount: 0, currency }
    if (needsFreight(term)) {
      if (costs.freight) {
        if (costs.freight.per === 'cbm' && totalCbm <= 0) {
          throw new AppError(400, 'BAD_ARGS', '运费按 cbm 计价时，每条明细都要填 cbmPerUnit（单位体积）')
        }
        const amount = costs.freight.per === 'cbm' ? costs.freight.amount * totalCbm : costs.freight.amount
        freightTotal = amount * (await fx.rate(costs.freight.currency, currency))
        freight = { source: 'manual', amount: round2(amount), currency: costs.freight.currency }
      } else {
        const missing: string[] = []
        if (!costs.pod) missing.push('pod（目的港）')
        if (!container) missing.push('container（柜型）或每条明细的 cbmPerUnit')
        if (missing.length > 0) {
          throw new AppError(400, 'BAD_ARGS', `${term} 报价需要海运费：请直接填运费（costs.freight），或提供 ${missing.join('、')} 从运价表查`)
        }
        const best = freightService.findBest({ pol: costs.pol, pod: costs.pod!, container: container!.type })
        if (!best) {
          throw new AppError(
            400,
            'BAD_ARGS',
            `运价表里没有 ${costs.pol ? `${costs.pol} → ` : ''}${costs.pod} ${container!.type} 的有效运价：请直接填运费，或先在运价表里添加这条航线`,
          )
        }
        if (best.unit === 'cbm' && totalCbm <= 0) {
          throw new AppError(400, 'BAD_ARGS', '运费按 cbm 计价时，每条明细都要填 cbmPerUnit（单位体积）')
        }
        // 拼箱按体积计费，不足 1 cbm 按 1 cbm（拼箱常见最低计费）
        const amount = best.unit === 'cbm' ? best.price * Math.max(1, totalCbm) : best.price * container!.count
        freightTotal = amount * (await fx.rate(best.currency, currency))
        freight = { source: 'rate_table', rateId: best.id, amount: round2(amount), currency: best.currency }
      }
      if (!volumeShare && freightTotal > 0) warnings.push('部分明细没有体积，海运费改按货值比例分摊')
    }

    const insuranceRate = (costs.insuranceRatePct ?? defaultInsurance()) / 100
    const dutyRate = (costs.dutyPct ?? 0) / 100
    const vatRate = (costs.vatPct ?? 0) / 100
    const destinationFee = term === 'DDP' ? costs.destinationPerShipment : 0
    if (term === 'DDP' && (costs.dutyPct === undefined || costs.vatPct === undefined)) {
      warnings.push('未填关税或增值税，DDP 价不含这部分税费')
    }

    /* 4. 成本阶梯 */
    const freightShare = volumeShare ?? valueShare
    const ladders = lines.map((line, i) => {
      const ladder: Partial<Record<PricingIncoterm, number>> = {}
      const exw = exwUnit[i]!
      ladder.EXW = exw
      if (!reaches('FOB')) return ladder
      const fob = exw + (exportFee * valueShare[i]!) / line.qty
      ladder.FOB = fob
      if (!reaches('CFR')) return ladder
      const cfr = fob + (freightTotal * freightShare[i]!) / line.qty
      ladder.CFR = cfr
      if (!reaches('CIF')) return ladder
      const cif = cfr / (1 - 1.1 * insuranceRate)
      ladder.CIF = cif
      if (!reaches('DDP')) return ladder
      ladder.DDP = cif * (1 + dutyRate) * (1 + vatRate) + (destinationFee * valueShare[i]!) / line.qty
      return ladder
    })

    /* 5. 定价 */
    const margin = rule.marginPct ?? (rule.markupPct === undefined && !rule.targetUnitPrices ? defaultMargin() : undefined)
    const priceOf = (cost: number, i: number): { price: number; marginPct: number } => {
      if (rule.targetUnitPrices) {
        const price = rule.targetUnitPrices[i]!
        return { price, marginPct: ((price - cost) / price) * 100 }
      }
      if (rule.markupPct !== undefined) {
        const price = cost * (1 + rule.markupPct / 100)
        return { price, marginPct: price > 0 ? ((price - cost) / price) * 100 : 0 }
      }
      return { price: cost / (1 - margin! / 100), marginPct: margin! }
    }

    const items: PricingItemResult[] = lines.map((line, i) => {
      const ladderCost = ladders[i]!
      const unitCost = ladderCost[term]!
      const { price, marginPct } = priceOf(unitCost, i)
      const unitPrice = roundPrice(price)
      const ladder: Partial<Record<PricingIncoterm, number>> = {}
      const roundedCost: Partial<Record<PricingIncoterm, number>> = {}
      for (const level of PRICING_INCOTERMS) {
        const cost = ladderCost[level]
        if (cost === undefined) continue
        roundedCost[level] = roundUnit(cost)
        ladder[level] = level === term ? unitPrice : roundPrice(marginPct < 100 ? cost / (1 - marginPct / 100) : cost)
      }
      return {
        productId: line.productId,
        name: line.name,
        qty: line.qty,
        unit: line.unit,
        unitCost: roundUnit(unitCost),
        unitPrice,
        marginPct: round2(marginPct),
        amount: round2(unitPrice * line.qty),
        ladderCost: roundedCost,
        ladder,
      }
    })

    for (const item of items) {
      if (item.marginPct < 0) warnings.push(`「${item.name}」报价低于成本（毛利 ${item.marginPct}%）`)
      else if (item.marginPct < 5) warnings.push(`「${item.name}」毛利低于 5%（${item.marginPct}%）`)
    }

    /* 6. 汇总与明细 */
    const totalCost = lines.reduce((sum, line, i) => sum + ladders[i]![term]! * line.qty, 0)
    const revenue = items.reduce((sum, item) => sum + item.amount, 0)
    const cfrTotal = lines.reduce((sum, line, i) => sum + (ladders[i]!.CFR ?? 0) * line.qty, 0)
    const cifTotal = lines.reduce((sum, line, i) => sum + (ladders[i]!.CIF ?? 0) * line.qty, 0)
    const rebateTotal = lines.reduce((sum, line) => sum + line.rebate * line.qty, 0)
    const breakdown: PricingResult['breakdown'] = [{ key: 'goods', label: LABELS.goods, amount: round2(exwTotal + rebateTotal) }]
    if (rebateTotal > 0) breakdown.push({ key: 'rebate', label: LABELS.rebate, amount: round2(-rebateTotal) })
    if (reaches('FOB') && exportFee > 0) breakdown.push({ key: 'export', label: LABELS.export, amount: round2(exportFee) })
    if (reaches('CFR')) breakdown.push({ key: 'freight', label: LABELS.freight, amount: round2(freightTotal) })
    if (reaches('CIF')) breakdown.push({ key: 'insurance', label: LABELS.insurance, amount: round2(cifTotal - cfrTotal) })
    if (reaches('DDP')) {
      const duty = cifTotal * dutyRate
      breakdown.push({ key: 'duty', label: LABELS.duty, amount: round2(duty) })
      breakdown.push({ key: 'vat', label: LABELS.vat, amount: round2((cifTotal + duty) * vatRate) })
      if (destinationFee > 0) breakdown.push({ key: 'destination', label: LABELS.destination, amount: round2(destinationFee) })
    }
    breakdown.push({ key: 'cost', label: LABELS.cost, amount: round2(totalCost) })
    breakdown.push({ key: 'profit', label: LABELS.profit, amount: round2(revenue - totalCost) })
    breakdown.push({ key: 'revenue', label: LABELS.revenue, amount: round2(revenue) })

    if (fx.used.some((item) => item.stale)) warnings.push('实时汇率更新失败，用的是上次缓存的汇率')

    return {
      incoterm: term,
      quoteCurrency: currency,
      items,
      totals: {
        cost: round2(totalCost),
        revenue: round2(revenue),
        profit: round2(revenue - totalCost),
        marginPct: revenue > 0 ? round2(((revenue - totalCost) / revenue) * 100) : 0,
        cbm: round2(totalCbm),
        kg: round2(totalKg),
      },
      container,
      freight,
      fx: fx.used,
      breakdown,
      warnings,
      quoteItems: items.map((item) => ({
        productId: item.productId,
        name: item.name,
        spec: '',
        qty: item.qty,
        unit: item.unit,
        unitPrice: item.unitPrice,
      })),
    }
  },
}
