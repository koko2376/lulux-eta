import PDFDocument from 'pdfkit'
import { z } from 'zod'
import { currentActor } from '../../context.js'
import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { assertCanModify, requirePermission, type OwnedRow } from '../../security/access.js'
import { parse } from '../../validation.js'
import { customerService } from '../customer-service.js'
import { resolvePdfFont } from '../email/quote-pdf.js'
import { orderService, type Order } from '../order-service.js'
import { productService } from '../product-service.js'
import { quoteTemplateService } from '../quote-template-service.js'

/**
 * 出货单证：从订单生成商业发票（CI）、装箱单（PL）、原产地证申请草稿（CO）。
 * 单证资料（发票号、收发货人、唛头、每行 HS / 件数 / 毛净重 / 体积）按订单保存，可反复修改再出 PDF；
 * 出 PDF 前做一致性检查（缺 HS、毛重 < 净重、件数为 0 等），有阻断问题时不出。
 * 原产地证只是申请资料草稿：正式证书由贸促会 / 海关签发。
 */

export type DocKind = 'ci' | 'pl' | 'co'
export const DOC_KINDS: DocKind[] = ['ci', 'pl', 'co']

export interface DocLine {
  /** 对应订单明细的序号（0 起） */
  itemIndex: number
  /** 保存时该行订单明细的 品名|规格：订单明细增删 / 改动后不匹配的旧资料作废，避免错位 */
  itemKey?: string
  description: string
  hsCode: string
  cartons: number
  netKg: number
  grossKg: number
  cbm: number
}

export interface DocParty {
  name: string
  address: string
  contact: string
}

export interface DocInfo {
  invoiceNo: string
  invoiceDate: string
  shipper: DocParty
  consignee: DocParty
  notifyParty: string
  marks: string
  origin: string
  portOfLoading: string
  portOfDischarge: string
  vessel: string
  packageUnit: string
  lines: DocLine[]
  updatedAt: number | null
}

export interface DocIssue {
  level: 'error' | 'warning'
  field: string
  /** 界面按 code 本地化；message 是中文说明（给 Agent / 日志） */
  code: string
  params: Array<string | number>
  message: string
}

export interface DocLineView extends DocLine {
  name: string
  spec: string
  qty: number
  unit: string
  unitPrice: number
  amount: number
}

export interface DocBundle {
  orderId: string
  orderNumber: string
  currency: string
  incoterm: string
  paymentTerms: string
  info: DocInfo
  lines: DocLineView[]
  totals: { qty: number; amount: number; cartons: number; netKg: number; grossKg: number; cbm: number }
  issues: DocIssue[]
}

const text = (max: number) => z.string().trim().max(max)
const num = (max: number) => z.number().finite().min(0, '不能为负数').max(max)

const partyInput = z.object({ name: text(300), address: text(1000), contact: text(300) }).partial().strict()

const lineInput = z
  .object({
    itemIndex: z.number().int().min(0).max(999),
    /** 界面回传的旧值，服务端忽略、以当前订单明细为准 */
    itemKey: z.string().max(2000).optional(),
    description: text(500).optional(),
    hsCode: z.string().trim().max(20).regex(/^[0-9.\s]*$/, 'HS 编码只能包含数字和点').optional(),
    cartons: z.number().int().min(0).max(1_000_000).optional(),
    netKg: num(1e8).optional(),
    grossKg: num(1e8).optional(),
    cbm: num(1e6).optional(),
  })
  .strict()

const patchInput = z
  .object({
    invoiceNo: text(60).optional(),
    invoiceDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
      .optional(),
    shipper: partyInput.optional(),
    consignee: partyInput.optional(),
    notifyParty: text(1000).optional(),
    marks: text(1000).optional(),
    origin: text(100).optional(),
    portOfLoading: text(200).optional(),
    portOfDischarge: text(200).optional(),
    vessel: text(200).optional(),
    packageUnit: text(20).optional(),
    lines: z.array(lineInput).max(1000).optional(),
  })
  .strict()

/** 客户国家常存 ISO2（SE）：单证上写英文国名（Sweden） */
function countryName(value: string): string {
  const v = value.trim()
  if (/^[A-Za-z]{2}$/.test(v)) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(v.toUpperCase()) ?? v
    } catch {
      return v
    }
  }
  return v
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

function storedInfo(orderId: string): Partial<DocInfo> | null {
  const row = db.prepare('SELECT data_json, updated_at FROM order_doc_info WHERE order_id = ?').get(orderId) as { data_json: string; updated_at: number } | undefined
  if (!row) return null
  try {
    return { ...(JSON.parse(row.data_json) as Partial<DocInfo>), updatedAt: row.updated_at }
  } catch {
    return null
  }
}

/** 默认值：发货人取默认报价模板的公司信息，收货人取客户，港口 / 船名取订单出运信息，HS 取产品库 */
function defaults(order: Order): DocInfo {
  const company = quoteTemplateService.getDefault()?.company
  const customer = customerService.get(order.customerId)
  const primary = customer?.contacts.find((c) => c.isPrimary) ?? customer?.contacts[0]
  return {
    invoiceNo: order.number,
    invoiceDate: today(),
    shipper: { name: company?.name ?? '', address: company?.address ?? '', contact: [company?.phone, company?.email].filter(Boolean).join('  ') },
    consignee: {
      name: customer?.company ?? order.customerName ?? '',
      address: countryName(customer?.country ?? ''),
      contact: primary ? [primary.name, primary.email, primary.phone].filter(Boolean).join('  ') : '',
    },
    notifyParty: 'SAME AS CONSIGNEE',
    marks: 'N/M',
    origin: 'CHINA',
    portOfLoading: order.shipment.portOfLoading,
    portOfDischarge: order.shipment.portOfDischarge,
    vessel: order.shipment.vessel,
    packageUnit: 'CTNS',
    lines: order.items.map((item, index) => {
      const product = item.productId ? productService.get(item.productId) : undefined
      return { itemIndex: index, itemKey: `${item.name}|${item.spec}|${item.unit}`, description: item.spec ? `${item.name} ${item.spec}` : item.name, hsCode: product?.hsCode ?? '', cartons: 0, netKg: 0, grossKg: 0, cbm: 0 }
    }),
    updatedAt: null,
  }
}

const itemKey = (order: Order, index: number): string => {
  const item = order.items[index]
  return item ? `${item.name}|${item.spec}|${item.unit}` : ''
}

function merge(order: Order, saved: Partial<DocInfo> | null): DocInfo {
  const base = defaults(order)
  if (!saved) return base
  const byIndex = new Map((saved.lines ?? []).map((line) => [line.itemIndex, line]))
  return {
    ...base,
    ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => key !== 'lines' && value !== undefined)),
    shipper: { ...base.shipper, ...(saved.shipper ?? {}) },
    consignee: { ...base.consignee, ...(saved.consignee ?? {}) },
    // 订单明细变了：只保留仍存在的行，新增的行用默认值
    lines: base.lines.map((line) => {
      const old = byIndex.get(line.itemIndex)
      const key = itemKey(order, line.itemIndex)
      if (!old || (old.itemKey !== undefined && old.itemKey !== key)) return { ...line, itemKey: key }
      return { ...line, ...old, itemIndex: line.itemIndex, itemKey: key }
    }),
  } as DocInfo
}

export function checkDocs(order: Order, info: DocInfo): DocIssue[] {
  const issues: DocIssue[] = []
  const push = (level: DocIssue['level'], field: string, code: string, message: string, params: Array<string | number> = []) =>
    issues.push({ level, field, code, params, message })
  if (order.items.length === 0) push('error', 'lines', 'noItems', '订单没有明细')
  if (!info.invoiceNo) push('error', 'invoiceNo', 'invoiceNo', '缺发票号')
  if (!info.shipper.name) push('error', 'shipper.name', 'shipper', '缺发货人（可在报价模板里填公司信息）')
  if (!info.consignee.name) push('error', 'consignee.name', 'consignee', '缺收货人')
  if (!info.consignee.address || info.consignee.address.length < 12) push('warning', 'consignee.address', 'consigneeAddress', '收货人地址不完整')
  if (!info.portOfLoading) push('warning', 'portOfLoading', 'pol', '缺起运港')
  if (!info.portOfDischarge) push('warning', 'portOfDischarge', 'pod', '缺目的港')
  info.lines.forEach((line, i) => {
    const no = i + 1
    const n = `第 ${no} 行`
    const digits = line.hsCode.replace(/\D/g, '')
    if (!digits) push('error', `lines.${i}.hsCode`, 'hsMissing', `${n}缺 HS 编码`, [no])
    else if (digits.length < 6) push('error', `lines.${i}.hsCode`, 'hsShort', `${n} HS 编码至少 6 位`, [no])
    else if (digits.length !== 8 && digits.length !== 10) push('warning', `lines.${i}.hsCode`, 'hsDigits', `${n} HS 编码是 ${digits.length} 位，中国出口报关一般用 10 位`, [no, digits.length])
    if (!line.description) push('error', `lines.${i}.description`, 'description', `${n}缺品名`, [no])
    if (line.cartons <= 0) push('error', `lines.${i}.cartons`, 'cartons', `${n}件数为 0`, [no])
    if (line.netKg <= 0) push('error', `lines.${i}.netKg`, 'netKg', `${n}缺净重`, [no])
    if (line.grossKg <= 0) push('error', `lines.${i}.grossKg`, 'grossKg', `${n}缺毛重`, [no])
    if (line.grossKg > 0 && line.netKg > line.grossKg) push('error', `lines.${i}.grossKg`, 'grossLtNet', `${n}毛重小于净重`, [no])
    if (line.cbm <= 0) push('warning', `lines.${i}.cbm`, 'cbm', `${n}缺体积`, [no])
    if (line.cartons > 0 && line.grossKg / line.cartons > 60) push('warning', `lines.${i}.grossKg`, 'heavyCarton', `${n}单箱毛重超过 60 kg，确认一下`, [no])
  })
  if (Math.abs(order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0) - order.amount) > 0.01) push('warning', 'amount', 'amountMismatch', '明细合计与订单金额不一致，发票按明细合计')
  return issues
}

function bundle(order: Order, info: DocInfo): DocBundle {
  const lines: DocLineView[] = info.lines.map((line) => {
    const item = order.items[line.itemIndex]!
    return { ...line, name: item.name, spec: item.spec, qty: item.qty, unit: item.unit, unitPrice: item.unitPrice, amount: round(item.qty * item.unitPrice, 2) }
  })
  const totals = lines.reduce(
    (acc, line) => ({
      qty: acc.qty + line.qty,
      amount: acc.amount + line.amount,
      cartons: acc.cartons + line.cartons,
      netKg: acc.netKg + line.netKg,
      grossKg: acc.grossKg + line.grossKg,
      cbm: acc.cbm + line.cbm,
    }),
    { qty: 0, amount: 0, cartons: 0, netKg: 0, grossKg: 0, cbm: 0 },
  )
  return {
    orderId: order.id,
    orderNumber: order.number,
    currency: order.currency,
    incoterm: order.incoterm,
    paymentTerms: order.paymentTerms,
    info,
    lines,
    totals: { ...totals, amount: round(totals.amount, 2), netKg: round(totals.netKg, 2), grossKg: round(totals.grossKg, 2), cbm: round(totals.cbm, 3) },
    issues: checkDocs(order, info),
  }
}

// ── 金额大写（英文） ─────────────────────────────────────

const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']

function under1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} HUNDRED`)
    n %= 100
    if (n) parts.push('AND')
  }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : ''))
  else if (n > 0) parts.push(ONES[n]!)
  return parts.join(' ')
}

function integerWords(n: number): string {
  if (n === 0) return 'ZERO'
  const scales = ['', 'THOUSAND', 'MILLION', 'BILLION']
  const out: string[] = []
  let i = 0
  const lowest = n % 1000
  while (n > 0 && i < scales.length) {
    const chunk = n % 1000
    if (chunk) out.unshift(`${under1000(chunk)}${scales[i] ? ` ${scales[i]}` : ''}`)
    n = Math.floor(n / 1000)
    i++
  }
  // 英式写法：末段不足 100 且前面还有千 / 百万时加 AND（THIRTEEN THOUSAND AND SIXTY-FIVE）
  if (out.length > 1 && lowest > 0 && lowest < 100) out[out.length - 1] = `AND ${out[out.length - 1]}`
  return out.join(' ')
}

const CURRENCY_WORDS: Record<string, string> = { USD: 'US DOLLARS', EUR: 'EUROS', GBP: 'POUNDS STERLING', CNY: 'CHINESE YUAN', JPY: 'JAPANESE YEN', AUD: 'AUSTRALIAN DOLLARS', CAD: 'CANADIAN DOLLARS', HKD: 'HONG KONG DOLLARS' }

/** 发票金额大写：SAY US DOLLARS TWELVE THOUSAND THREE HUNDRED AND FORTY-FIVE AND CENTS SIXTY-SEVEN ONLY */
export function amountInWords(amount: number, currency: string): string {
  const cents = Math.round(Number((Math.abs(amount) * 100).toFixed(4)))
  const whole = Math.floor(cents / 100)
  const fraction = cents % 100
  const name = CURRENCY_WORDS[currency.toUpperCase()] ?? currency.toUpperCase()
  return `SAY ${name} ${integerWords(whole)}${fraction ? ` AND CENTS ${integerWords(fraction)}` : ''} ONLY`
}

// ── PDF ─────────────────────────────────────────────

const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kg = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

const TITLES: Record<DocKind, string> = { ci: 'COMMERCIAL INVOICE', pl: 'PACKING LIST', co: 'CERTIFICATE OF ORIGIN' }

export async function renderDocPdf(kind: DocKind, docs: DocBundle): Promise<{ buffer: Buffer; font: 'cjk' | 'fallback' }> {
  const { info } = docs
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${TITLES[kind]} ${info.invoiceNo}`, Producer: 'LULUX ETA' } })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  let fontKind: 'cjk' | 'fallback' = 'fallback'
  const font = resolvePdfFont()
  if (font) {
    try {
      doc.registerFont('body', font.path, font.family)
      doc.font('body')
      fontKind = 'cjk'
    } catch {
      doc.font('Helvetica')
    }
  } else doc.font('Helvetica')
  const t = (value: string): string => (fontKind === 'cjk' ? value : value.replace(/[^\x20-\x7e\u00a0-\u00ff\n]/g, '?'))
  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right

  // 标题
  doc.fontSize(12).text(t(info.shipper.name), left, doc.y, { width, align: 'center' })
  doc.fontSize(8.5).fillColor('#555555').text(t([info.shipper.address, info.shipper.contact].filter(Boolean).join('  ')), { width, align: 'center' })
  doc.moveDown(0.6).fillColor('#000000').fontSize(16).text(TITLES[kind], { width, align: 'center' })
  if (kind === 'co') doc.fontSize(8.5).fillColor('#b52a2a').text('DRAFT FOR APPLICATION — the official certificate is issued by the competent authority', { width, align: 'center' }).fillColor('#000000')
  doc.moveDown(0.8)

  // 抬头两栏
  const boxTop = doc.y
  const half = width / 2
  const block = (label: string, value: string, x: number, w: number) => {
    doc.fontSize(7.5).fillColor('#777777').text(label, x, doc.y, { width: w })
    doc.fontSize(9).fillColor('#000000').text(t(value || '—'), x, doc.y, { width: w })
    doc.moveDown(0.5)
  }
  doc.y = boxTop
  block(kind === 'co' ? '1. Exporter' : 'Shipper / Exporter', [info.shipper.name, info.shipper.address].filter(Boolean).join('\n'), left, half - 10)
  block(kind === 'co' ? '2. Consignee' : 'Consignee', [info.consignee.name, info.consignee.address, info.consignee.contact].filter(Boolean).join('\n'), left, half - 10)
  if (kind !== 'co') block('Notify party', info.notifyParty, left, half - 10)
  const leftEnd = doc.y
  doc.y = boxTop
  const right = left + half + 10
  const meta: Array<[string, string]> = [
    [kind === 'pl' ? 'Invoice No. / P/L No.' : 'Invoice No.', info.invoiceNo],
    ['Date', info.invoiceDate],
    [kind === 'co' ? '3. Means of transport and route' : 'From / To', [info.portOfLoading && `FROM ${info.portOfLoading}`, info.portOfDischarge && `TO ${info.portOfDischarge}`, info.vessel && `BY ${info.vessel}`].filter(Boolean).join(' ')],
  ]
  if (kind === 'ci') meta.push(['Terms', [docs.incoterm, docs.incoterm === 'FOB' || docs.incoterm === 'EXW' ? info.portOfLoading : info.portOfDischarge].filter(Boolean).join(' ')], ['Payment', docs.paymentTerms])
  if (kind === 'co') meta.push(['4. Country of origin', info.origin])
  for (const [label, value] of meta) block(label, value, right, half - 10)
  doc.y = Math.max(leftEnd, doc.y) + 4
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1).stroke()
  doc.moveDown(0.6)

  // 明细表
  type Col = { title: string; width: number; align: 'left' | 'right' }
  const cols: Col[] =
    kind === 'ci'
      ? [
          { title: 'Marks', width: 70, align: 'left' },
          { title: 'Description of goods', width: width - 70 - 70 - 70 - 75 - 85, align: 'left' },
          { title: 'HS Code', width: 70, align: 'left' },
          { title: 'Quantity', width: 70, align: 'right' },
          { title: `Unit price (${docs.currency})`, width: 75, align: 'right' },
          { title: `Amount (${docs.currency})`, width: 85, align: 'right' },
        ]
      : kind === 'pl'
        ? [
            { title: 'Marks', width: 64, align: 'left' },
            { title: 'Description of goods', width: width - 64 - 62 - 70 - 66 - 66 - 58, align: 'left' },
            { title: 'Packages', width: 62, align: 'right' },
            { title: 'Quantity', width: 70, align: 'right' },
            { title: 'N.W. (kg)', width: 66, align: 'right' },
            { title: 'G.W. (kg)', width: 66, align: 'right' },
            { title: 'CBM', width: 58, align: 'right' },
          ]
        : [
            { title: '5. Marks', width: 80, align: 'left' },
            { title: '6. Number and kind of packages; description of goods', width: width - 80 - 80 - 90 - 90, align: 'left' },
            { title: '7. HS Code', width: 80, align: 'left' },
            { title: '8. Quantity', width: 90, align: 'right' },
            { title: '9. Invoice no. & date', width: 90, align: 'left' },
          ]
  const drawRow = (cells: string[], bold = false, fill?: string): void => {
    const heights = cells.map((cell, i) => doc.fontSize(8.5).heightOfString(cell, { width: cols[i]!.width - 6 }))
    const h = Math.max(...heights) + 8
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 60) doc.addPage()
    const y = doc.y
    if (fill) doc.rect(left, y, width, h).fill(fill).fillColor('#000000')
    let x = left
    cells.forEach((cell, i) => {
      doc.fontSize(bold ? 8.8 : 8.5).text(cell, x + 3, y + 4, { width: cols[i]!.width - 6, align: cols[i]!.align })
      x += cols[i]!.width
    })
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor('#cccccc').stroke().strokeColor('#000000')
    doc.y = y + h
  }
  drawRow(cols.map((c) => c.title), true, '#f0f0f2')
  docs.lines.forEach((line, i) => {
    const marks = i === 0 ? t(info.marks) : ''
    const qty = `${line.qty.toLocaleString('en-US')} ${t(line.unit)}`
    if (kind === 'ci') drawRow([marks, t(line.description), line.hsCode, qty, money(line.unitPrice), money(line.amount)])
    else if (kind === 'pl') drawRow([marks, t(line.description), `${line.cartons} ${t(info.packageUnit)}`, qty, kg(line.netKg), kg(line.grossKg), line.cbm.toFixed(3)])
    else drawRow([marks, `${line.cartons} ${t(info.packageUnit)} OF ${t(line.description)}`, line.hsCode, qty, i === 0 ? `${t(info.invoiceNo)}\n${info.invoiceDate}` : ''])
  })
  const T = docs.totals
  if (kind === 'ci') drawRow(['', 'TOTAL', '', T.qty.toLocaleString('en-US'), '', `${docs.currency} ${money(T.amount)}`], true)
  if (kind === 'pl') drawRow(['', 'TOTAL', `${T.cartons} ${t(info.packageUnit)}`, T.qty.toLocaleString('en-US'), kg(T.netKg), kg(T.grossKg), T.cbm.toFixed(3)], true)
  if (kind === 'co') drawRow(['', `TOTAL: ${T.cartons} ${t(info.packageUnit)} ONLY`, '', T.qty.toLocaleString('en-US'), ''], true)
  doc.moveDown(0.8)
  doc.x = left
  if (kind === 'ci') doc.fontSize(9).text(amountInWords(T.amount, docs.currency), left, doc.y, { width })
  if (kind === 'pl') doc.fontSize(9).text(`SAY TOTAL ${integerWords(T.cartons)} (${T.cartons}) ${t(info.packageUnit)} ONLY`, left, doc.y, { width })
  if (kind === 'co') {
    doc.fontSize(8.5).fillColor('#555555')
    doc.text('10. Declaration by the exporter: The undersigned hereby declares that the above details and statements are correct, that all the goods were produced in ' + t(info.origin) + ' and that they comply with the rules of origin.', left, doc.y, { width })
    doc.fillColor('#000000')
  }
  doc.moveDown(2.5)
  doc.fontSize(9).text(t(info.shipper.name), left + width / 2, doc.y, { width: width / 2, align: 'right' })
  doc.moveTo(left + width - 180, doc.y + 26).lineTo(left + width, doc.y + 26).lineWidth(0.5).stroke()
  doc.fontSize(7.5).fillColor('#777777').text('Authorized signature', left + width - 180, doc.y + 30, { width: 180, align: 'right' })
  doc.end()
  return { buffer: await done, font: fontKind }
}

// ── 服务 ─────────────────────────────────────────────

function orderRow(orderId: string): OwnedRow {
  return db.prepare('SELECT org_id, owner_id FROM orders WHERE id = ?').get(orderId) as unknown as OwnedRow
}

/** 允许传订单号（SO-20261024-001）代替 id：Agent 常拿用户说的单号直接调用 */
function resolveOrderId(idOrNumber: string): string {
  const value = idOrNumber.trim()
  if (value.startsWith('ord_')) return value
  const row = db.prepare('SELECT id FROM orders WHERE number = ? AND org_id = ? AND deleted_at IS NULL').get(value, currentActor().orgId) as { id: string } | undefined
  return row?.id ?? value
}

export const shippingDocsService = {
  get(idOrNumber: string): DocBundle {
    const orderId = resolveOrderId(idOrNumber)
    const order = orderService.require(orderId, false)
    return bundle(order, merge(order, storedInfo(orderId)))
  },

  /** 修改单证资料（只改传入的字段；lines 按 itemIndex 合并） */
  update(idOrNumber: string, input: unknown): DocBundle {
    requirePermission('data:write')
    const orderId = resolveOrderId(idOrNumber)
    const order = orderService.require(orderId, false)
    assertCanModify(orderRow(orderId), '订单')
    const patch = parse(patchInput, input)
    const current = merge(order, storedInfo(orderId))
    for (const line of patch.lines ?? []) {
      if (line.itemIndex >= order.items.length) throw new AppError(400, 'BAD_ARGS', `订单只有 ${order.items.length} 行明细，没有第 ${line.itemIndex + 1} 行`)
    }
    const byIndex = new Map((patch.lines ?? []).map((line) => [line.itemIndex, line]))
    const next: DocInfo = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== 'lines' && key !== 'shipper' && key !== 'consignee' && value !== undefined)),
      shipper: { ...current.shipper, ...(patch.shipper ?? {}) },
      consignee: { ...current.consignee, ...(patch.consignee ?? {}) },
      lines: current.lines.map((line) => {
        const change = byIndex.get(line.itemIndex)
        if (!change) return line
        const { itemKey: _clientKey, ...fields } = change
        const merged = { ...line, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), itemKey: line.itemKey } as DocLine
        merged.hsCode = merged.hsCode.replace(/\s+/g, '')
        return merged
      }),
    } as DocInfo
    const { updatedAt: _ignored, ...data } = next
    db.prepare(
      `INSERT INTO order_doc_info (order_id, org_id, data_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET data_json = excluded.data_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(orderId, currentActor().orgId, JSON.stringify(data), currentActor().id, Date.now())
    return shippingDocsService.get(orderId)
  },

  /** 出 PDF：有阻断问题（error）时拒绝，并列出问题 */
  async render(idOrNumber: string, kind: DocKind): Promise<{ buffer: Buffer; font: 'cjk' | 'fallback'; filename: string; bundle: DocBundle }> {
    const docs = shippingDocsService.get(idOrNumber)
    const errors = docs.issues.filter((issue) => issue.level === 'error')
    if (errors.length) throw new AppError(409, 'DOCS_INCOMPLETE', `单证资料还不完整：${errors.map((e) => e.message).join('；')}`)
    const { buffer, font } = await renderDocPdf(kind, docs)
    const prefix = { ci: 'CI', pl: 'PL', co: 'CO-draft' }[kind]
    return { buffer, font, filename: `${prefix}-${docs.info.invoiceNo.replace(/[\\/:*?"<>|\s]+/g, '_')}.pdf`, bundle: docs }
  },
}
