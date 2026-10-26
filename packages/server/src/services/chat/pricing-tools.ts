import { z } from 'zod'
import { requirePermission } from '../../security/access.js'
import { customerService } from '../customer-service.js'
import { quoteService } from '../quote-service.js'
import { fxService } from '../pricing/fx-service.js'
import { CONTAINERS, freightService } from '../pricing/freight-service.js'
import { pricingService, type PricingResult } from '../pricing/pricing-service.js'
import { ToolError } from '../tools/tool-error.js'
import { CRM_TOOLS, type CrmTool } from './crm-tools.js'

/**
 * 报价引擎工具：汇率、运价表、按成本算价、一键出 PI。
 * - quote_calculate 只计算不写库（read）；quote_generate_pi 新建草稿报价单 + 生成 PDF（write，需审批）。
 * - 汇率来源与是否锁汇都写进结果，模型必须如实告诉用户用的哪个汇率。
 */

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '品名' },
    qty: { type: 'number', description: '数量' },
    unit: { type: 'string', description: '单位，默认 pcs' },
    unitCost: { type: 'number', description: '单位采购成本（含税出厂价）；不填且给了 productId 时用产品库价格' },
    costCurrency: { type: 'string', description: '成本币种，默认 CNY' },
    cbmPerUnit: { type: 'number', description: '每单位体积（立方米），用于选柜和按体积分摊运费' },
    kgPerUnit: { type: 'number', description: '每单位毛重（kg）' },
    productId: { type: 'string', description: '产品库 id（可选）' },
  },
  required: ['name', 'qty'],
} as const

const CALC_PROPERTIES = {
  items: { type: 'array', items: ITEM_SCHEMA, description: '明细 1–200 条' },
  quoteCurrency: { type: 'string', description: '报价币种，默认 USD' },
  incoterm: { type: 'string', enum: ['EXW', 'FOB', 'CFR', 'CIF', 'DDP'], description: '贸易术语，默认 FOB' },
  pricing: {
    type: 'object',
    description: '定价规则三选一：marginPct 毛利率（按售价，默认读设置，通常 15）/ markupPct 加成率 / targetUnitPrices 目标单价（倒算毛利）',
    properties: {
      marginPct: { type: 'number' },
      markupPct: { type: 'number' },
      targetUnitPrices: { type: 'array', items: { type: 'number' } },
    },
  },
  costs: {
    type: 'object',
    description: '费用。CFR/CIF/DDP 需要海运费：直接给 freight，或给 pod（+pol/container）查运价表',
    properties: {
      exportPerShipment: { type: 'number', description: '每票出口费用（拖车+报关+港杂，人民币）' },
      freight: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string', description: '默认 USD' },
          per: { type: 'string', enum: ['shipment', 'cbm'], description: '整票总价 / 每立方米' },
        },
        required: ['amount'],
      },
      pol: { type: 'string', description: '起运港' },
      pod: { type: 'string', description: '目的港' },
      container: { type: 'string', enum: [...CONTAINERS], description: '柜型；不填按总体积自动选' },
      insuranceRatePct: { type: 'number', description: '保险费率 %，默认 0.11' },
      dutyPct: { type: 'number', description: 'DDP：进口关税 %' },
      vatPct: { type: 'number', description: 'DDP：进口增值税 %' },
      destinationPerShipment: { type: 'number', description: 'DDP：目的港清关+派送（报价币种）' },
      exportRebatePct: { type: 'number', description: '出口退税率 %（如 13），冲减成本' },
    },
  },
  fx: { type: 'object', description: '本次临时指定汇率，如 {"USD/CNY": 7.1}；不填用锁汇或实时汇率', additionalProperties: { type: 'number' } },
} as const

/** 给模型看的精简结果（去掉成本阶梯里的小数噪音之外全部保留） */
function compact(result: PricingResult) {
  return {
    incoterm: result.incoterm,
    quoteCurrency: result.quoteCurrency,
    items: result.items.map((item) => ({
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      unitCost: item.unitCost,
      unitPrice: item.unitPrice,
      marginPct: item.marginPct,
      amount: item.amount,
      priceLadder: item.ladder,
    })),
    totals: result.totals,
    container: result.container,
    freight: result.freight,
    fx: result.fx,
    breakdown: result.breakdown,
    warnings: result.warnings,
  }
}

const calcInputSchema = { type: 'object', properties: CALC_PROPERTIES, required: ['items'] } as const

export const PRICING_TOOLS: CrmTool[] = [
  {
    name: 'fx_rates',
    description:
      '查汇率：base 对 symbols 的当前汇率（欧洲央行 Frankfurter 为主，open.er-api.com 为备，缓存 6 小时）。' +
      '结果带 source 与 asOf；locked=true 表示用户在设置里手动锁定了该汇率；stale=true 表示实时更新失败、用的是旧缓存。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: '基准币种，默认 USD' },
        symbols: { type: 'array', items: { type: 'string' }, description: '目标币种，默认 ["CNY","EUR"]' },
      },
    },
    async run(args) {
      const input = z
        .object({ base: z.string().trim().default('USD'), symbols: z.array(z.string().trim()).max(30).default(['CNY', 'EUR']) })
        .parse(args)
      return fxService.table(input.base, input.symbols.length > 0 ? input.symbols : ['CNY', 'EUR'])
    },
  },
  {
    name: 'quote_calculate',
    description:
      '按成本算报价（只计算，不保存）：采购成本 → EXW / FOB / CFR / CIF / DDP 价格阶梯 → 按毛利率 / 加成率 / 目标价定价。' +
      '自动换汇（本次指定 > 设置里锁汇 > 实时）、按总体积自动选柜、CFR 以上可从运价表取运费、DDP 可加关税增值税、可扣出口退税。' +
      '返回每条明细的单价与毛利、各术语价格对比（priceLadder）、费用拆分、用到的汇率和 warnings。' +
      '把结果告诉用户时要说明用的汇率与来源；有 warnings 必须转告。确认后用 quote_generate_pi 出报价单和 PI。',
    risk: 'read',
    inputSchema: calcInputSchema,
    async run(args) {
      return compact(await pricingService.calculate(args))
    },
  },
  {
    name: 'quote_generate_pi',
    description:
      '按成本算价后直接为客户新建草稿报价单（status=draft，不会发给客户）并生成 PI PDF（会话产物面板可下载）。' +
      '参数同 quote_calculate，另加 customerId（必填）、port、paymentTerms、leadTime、validUntil、notes、templateId。' +
      '报价单上不会出现成本、毛利、汇率等内部信息（只在本工具结果里返回）。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        ...CALC_PROPERTIES,
        port: { type: 'string', description: '港口（FOB 写起运港，CFR/CIF 写目的港；不填自动用 costs.pol / costs.pod）' },
        paymentTerms: { type: 'string' },
        leadTime: { type: 'string' },
        validUntil: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' },
        templateId: { type: 'string', description: '报价模板 id，不填用默认模板' },
      },
      required: ['customerId', 'items'],
    },
    async run(args, ctx) {
      requirePermission('data:write')
      const meta = z
        .object({
          customerId: z.string().trim().min(1).max(80),
          port: z.string().trim().max(200).optional(),
          paymentTerms: z.string().trim().max(1000).optional(),
          leadTime: z.string().trim().max(200).optional(),
          validUntil: z.string().trim().max(10).optional(),
          notes: z.string().max(5000).optional(),
          templateId: z.string().trim().min(1).max(80).optional(),
        })
        .passthrough()
        .parse(args)
      const { customerId, port, paymentTerms, leadTime, validUntil, notes, templateId, ...calcArgs } = meta
      if (!customerService.get(customerId)) throw new ToolError('客户不存在或你没有权限')
      const result = await pricingService.calculate(calcArgs)
      const costs = (calcArgs.costs ?? {}) as { pol?: string; pod?: string }
      const autoPort = result.incoterm === 'EXW' || result.incoterm === 'FOB' ? costs.pol : costs.pod
      const quote = quoteService.create({
        customerId,
        currency: result.quoteCurrency,
        incoterm: result.incoterm,
        port: port ?? autoPort ?? '',
        ...(paymentTerms !== undefined ? { paymentTerms } : {}),
        leadTime: leadTime ?? '',
        validUntil: validUntil ?? '',
        // 备注会印在 PI 上给客户看：只放用户/模型给的 notes，汇率与成本等内部信息绝不写进去
        notes: notes?.trim() ?? '',
        items: result.quoteItems,
        status: 'draft',
      })
      const pdfTool = CRM_TOOLS.find((tool) => tool.name === 'generate_quote_pdf')!
      // 报价单已建好：PDF 失败时不抛错（否则模型重试会建出重复的草稿），如实告诉它报价单已存在
      let pdf: Record<string, unknown>
      try {
        pdf = (await pdfTool.run({ quoteId: quote.id, ...(templateId ? { templateId } : {}) }, ctx)) as Record<string, unknown>
      } catch (error) {
        pdf = { path: null, note: `报价单 ${quote.number} 已创建，但 PI PDF 生成失败：${error instanceof Error ? error.message : String(error)}。不要重复创建，可用 generate_quote_pdf 重试。` }
      }
      return {
        created: true,
        quote: { id: quote.id, number: quote.number, currency: quote.currency, incoterm: quote.incoterm, subtotal: quote.subtotal, status: quote.status },
        pdf: { path: pdf.path ?? null, note: pdf.note },
        calculation: compact(result),
      }
    },
  },
  {
    name: 'list_freight_rates',
    description: '查运价表（用户维护的海运/拼箱价格）。可按目的港 pod、起运港 pol、柜型筛选；默认不含已过期的。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        pod: { type: 'string' },
        pol: { type: 'string' },
        container: { type: 'string', enum: [...CONTAINERS] },
        includeExpired: { type: 'boolean' },
      },
    },
    run(args) {
      const input = z
        .object({
          pod: z.string().trim().max(100).optional(),
          pol: z.string().trim().max(100).optional(),
          container: z.enum(CONTAINERS).optional(),
          includeExpired: z.boolean().optional(),
        })
        .parse(args)
      const rows = freightService.list(input)
      return { total: rows.length, items: rows.slice(0, 50) }
    },
  },
  {
    name: 'save_freight_rate',
    description: '新增或修改一条运价（给 id 即修改）。字段：pol、pod、podCountry、container（20GP/40GP/40HQ/LCL）、price、currency、unit（container/cbm）、carrier、validFrom、validUntil（YYYY-MM-DD）、notes。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        pol: { type: 'string' },
        pod: { type: 'string' },
        podCountry: { type: 'string' },
        container: { type: 'string', enum: [...CONTAINERS] },
        price: { type: 'number' },
        currency: { type: 'string' },
        unit: { type: 'string', enum: ['container', 'cbm'] },
        carrier: { type: 'string' },
        validFrom: { type: 'string' },
        validUntil: { type: 'string' },
        notes: { type: 'string' },
      },
    },
    run(args) {
      const { id, ...rest } = args as Record<string, unknown>
      if (typeof id === 'string' && id.trim()) return { updated: true, rate: freightService.update(id.trim(), rest) }
      return { created: true, rate: freightService.create(rest) }
    },
  },
]
