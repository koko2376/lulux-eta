import { z } from 'zod'
import { DOC_KINDS, shippingDocsService, type DocBundle, type DocKind } from '../trade/shipping-docs.js'
import { suggestHs } from '../trade/hs-suggest.js'
import { ToolError } from '../tools/tool-error.js'
import { writeWorkspaceBinary } from '../tools/workspace.js'
import type { CrmTool } from './crm-tools.js'

/**
 * 出货单证工具：查看 / 补全单证资料、生成 CI / PL / CO 草稿 PDF、HS 编码建议。
 * 资料不完整（缺 HS、毛净重等）时 docs_generate 不出 PDF，先把问题列给用户补。
 */

function summary(b: DocBundle) {
  return {
    orderId: b.orderId,
    orderNumber: b.orderNumber,
    invoiceNo: b.info.invoiceNo,
    invoiceDate: b.info.invoiceDate,
    shipper: b.info.shipper,
    consignee: b.info.consignee,
    notifyParty: b.info.notifyParty,
    marks: b.info.marks,
    origin: b.info.origin,
    portOfLoading: b.info.portOfLoading,
    portOfDischarge: b.info.portOfDischarge,
    vessel: b.info.vessel,
    terms: `${b.incoterm} · ${b.currency}`,
    lines: b.lines.map((l) => ({
      itemIndex: l.itemIndex,
      product: l.name,
      qty: `${l.qty} ${l.unit}`,
      description: l.description,
      hsCode: l.hsCode,
      cartons: l.cartons,
      netKg: l.netKg,
      grossKg: l.grossKg,
      cbm: l.cbm,
    })),
    totals: b.totals,
    issues: b.issues,
    ready: !b.issues.some((i) => i.level === 'error'),
  }
}

const partySchema = { type: 'object', properties: { name: { type: 'string' }, address: { type: 'string' }, contact: { type: 'string' } } }

export const DOCS_TOOLS: CrmTool[] = [
  {
    name: 'docs_get',
    description: '查看订单的出货单证资料（发票号、收发货人、唛头、港口、每行 HS / 件数 / 毛净重 / 体积）和缺项检查。生成单证前先调用。',
    risk: 'read',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string', description: '订单 id 或订单号' } }, required: ['orderId'] },
    run(args) {
      const { orderId } = z.object({ orderId: z.string().trim().min(1).max(80) }).parse(args)
      return summary(shippingDocsService.get(orderId))
    },
  },
  {
    name: 'docs_update',
    description:
      '补全 / 修改订单的单证资料，只改传入的字段；lines 按 itemIndex（订单明细序号，从 0 开始）合并。' +
      '毛净重、件数、体积必须来自用户或工厂装箱数据，不要估算；HS 编码不确定时先用 hs_suggest 并让用户确认。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        invoiceNo: { type: 'string' },
        invoiceDate: { type: 'string', description: 'YYYY-MM-DD' },
        shipper: partySchema,
        consignee: partySchema,
        notifyParty: { type: 'string' },
        marks: { type: 'string', description: '唛头，无则 N/M' },
        origin: { type: 'string' },
        portOfLoading: { type: 'string' },
        portOfDischarge: { type: 'string' },
        vessel: { type: 'string' },
        packageUnit: { type: 'string', description: '包装单位，默认 CTNS' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemIndex: { type: 'integer' },
              description: { type: 'string', description: '英文品名（报关 / 发票用）' },
              hsCode: { type: 'string' },
              cartons: { type: 'integer' },
              netKg: { type: 'number', description: '该行总净重 kg' },
              grossKg: { type: 'number', description: '该行总毛重 kg' },
              cbm: { type: 'number', description: '该行总体积 m³' },
            },
            required: ['itemIndex'],
          },
        },
      },
      required: ['orderId'],
    },
    run(args) {
      const { orderId, ...patch } = z.object({ orderId: z.string().trim().min(1).max(80) }).passthrough().parse(args)
      return summary(shippingDocsService.update(orderId, patch))
    },
  },
  {
    name: 'docs_generate',
    description:
      '生成出货单证 PDF：ci=商业发票、pl=装箱单、co=原产地证申请草稿（正式证书由贸促会 / 海关签发）。保存到会话产物面板，不会发给任何人。' +
      '资料有缺项时不生成，返回缺项清单。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: DOC_KINDS }, description: '默认 ci + pl' },
      },
      required: ['orderId'],
    },
    async run(args, ctx) {
      const input = z.object({ orderId: z.string().trim().min(1).max(80), kinds: z.array(z.enum(DOC_KINDS as [DocKind, ...DocKind[]])).min(1).max(3).optional() }).strict().parse(args)
      const kinds = [...new Set(input.kinds ?? (['ci', 'pl'] as DocKind[]))]
      const docs = shippingDocsService.get(input.orderId)
      const errors = docs.issues.filter((i) => i.level === 'error')
      if (errors.length) return { generated: false, missing: errors.map((e) => e.message), note: '资料不完整，先向用户要齐这些信息（用 docs_update 补），不要自己编数字。' }
      const files: Array<{ kind: DocKind; path: string | null; bytes: number }> = []
      let font: 'cjk' | 'fallback' = 'cjk'
      // 先全部渲染到内存，全部成功后再写入工作区（避免一半成功一半失败）
      const renderedAll: Array<{ kind: DocKind; rendered: Awaited<ReturnType<typeof shippingDocsService.render>> }> = []
      for (const kind of kinds) renderedAll.push({ kind, rendered: await shippingDocsService.render(input.orderId, kind) })
      for (const { kind, rendered } of renderedAll) {
        font = rendered.font
        if (!ctx?.sessionId) {
          files.push({ kind, path: null, bytes: rendered.buffer.length })
          continue
        }
        const file = await writeWorkspaceBinary(ctx.sessionId, `docs/${rendered.filename}`, rendered.buffer)
        ctx.emitFile?.({ path: file.path, size: file.bytes, title: rendered.filename, mime: 'application/pdf' })
        files.push({ kind, path: file.path, bytes: file.bytes })
      }
      return {
        generated: true,
        files,
        totals: docs.totals,
        warnings: docs.issues.filter((i) => i.level === 'warning').map((i) => i.message),
        note: (font === 'cjk' ? '' : '本机未找到中文字体，中文会显示为方框；单证建议全部用英文。') + (kinds.includes('co') ? '原产地证只是申请草稿，正式证书需在贸促会 / 单一窗口申领。' : ''),
      }
    },
  },
  {
    name: 'hs_suggest',
    description:
      'HS 编码建议：先查产品库和以前单证用过的编码，再查英国税则公开检索（只有前 6 位国际通用）。' +
      '中国出口 10 位编码、监管条件、退税率必须让用户在海关 / 单一窗口核对，不要当成确定结果。用英文品名（材质 + 用途）检索效果最好。',
    risk: 'read',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '品名，如 "brass ball valve" / "LED lamp"' } }, required: ['query'] },
    async run(args, ctx) {
      const { query } = z.object({ query: z.string().trim().min(2).max(200) }).strict().parse(args)
      const result = await suggestHs(query, ctx?.signal)
      if (!result.candidates.length && result.tariffError) throw new ToolError(result.tariffError)
      return result
    },
  },
]
