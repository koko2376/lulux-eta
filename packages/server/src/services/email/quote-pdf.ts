import { existsSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import { customerService } from '../customer-service.js'
import type { Quote } from '../quote-service.js'
import type { QuoteTemplate } from '../quote-template-service.js'

/**
 * 报价单 PDF（pdfkit，MIT）。用于浏览器态与“发送时附上报价单”。
 * 中文字体：LULUX_PDF_FONT 指定，否则按平台查找常见 CJK 字体；都没有时用 Helvetica（非拉丁字符显示为 ?）。
 */
const FONT_CANDIDATES: Array<{ path: string; family?: string }> = [
  // Windows
  { path: 'C:\\Windows\\Fonts\\msyh.ttc', family: 'MicrosoftYaHei' },
  { path: 'C:\\Windows\\Fonts\\msyh.ttf' },
  { path: 'C:\\Windows\\Fonts\\simhei.ttf' },
  { path: 'C:\\Windows\\Fonts\\simsun.ttc', family: 'SimSun' },
  // macOS
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFangSC-Regular' },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', family: 'STHeitiSC-Light' },
  { path: '/Library/Fonts/Arial Unicode.ttf' },
  // Linux
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', family: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', family: 'NotoSerifCJKsc-Regular' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', family: 'WenQuanYiMicroHei' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  { path: '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf' },
]

let cachedFont: { path: string; family?: string } | null | undefined

export function resolvePdfFont(): { path: string; family?: string } | null {
  if (cachedFont !== undefined) return cachedFont
  const custom = process.env.LULUX_PDF_FONT
  if (custom && existsSync(custom)) {
    cachedFont = { path: custom }
    return cachedFont
  }
  cachedFont = FONT_CANDIDATES.find((candidate) => existsSync(candidate.path)) ?? null
  return cachedFont
}

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export async function renderQuotePdf(quote: Quote, template: QuoteTemplate | undefined): Promise<{ buffer: Buffer; font: 'cjk' | 'fallback' }> {
  const customer = customerService.get(quote.customerId)
  const primary = customer?.contacts.find((contact) => contact.isPrimary) ?? customer?.contacts[0]
  const company = template?.company ?? { name: '', address: '', phone: '', email: '', logoDataUrl: '' }
  const doc = new PDFDocument({ size: 'A4', margin: 46, info: { Title: `Quotation ${quote.number}`, Producer: 'LULUX ETA' } })
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
  } else {
    doc.font('Helvetica')
  }
  const text = (value: string): string => (fontKind === 'cjk' ? value : value.replace(/[^\x20-\x7e\u00a0-\u00ff\n]/g, '?'))

  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right

  // 抬头
  const top = doc.y
  if (company.logoDataUrl) {
    try {
      const base64 = company.logoDataUrl.split(',')[1] ?? ''
      doc.image(Buffer.from(base64, 'base64'), left, top, { fit: [160, 48] })
      doc.moveDown(3)
    } catch {
      // logo 格式不受支持（如 webp）时跳过
    }
  }
  doc.fontSize(12).text(text(company.name), left, doc.y, { width: width / 2 })
  doc.fontSize(9).fillColor('#555555').text(text(company.address), { width: width / 2 })
  doc.text(text([company.phone, company.email].filter(Boolean).join('  ')), { width: width / 2 })
  doc.fillColor('#000000').fontSize(20).text('QUOTATION', left + width / 2, top, { width: width / 2, align: 'right' })
  doc.fontSize(10).text(`No. ${text(quote.number)}`, { width: width / 2, align: 'right' })
  doc.text(`Date: ${new Date(quote.createdAt).toISOString().slice(0, 10)}`, { width: width / 2, align: 'right' })
  if (quote.validUntil) doc.text(`Valid until: ${quote.validUntil}`, { width: width / 2, align: 'right' })
  doc.moveDown(2)
  doc.x = left
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).stroke()
  doc.moveDown(0.8)

  // 客户
  doc.fontSize(8).fillColor('#777777').text('TO', left)
  doc.fillColor('#000000').fontSize(11).text(text(customer?.company ?? ''))
  doc.fontSize(9)
  if (customer?.country) doc.text(text(customer.country))
  if (primary) doc.text(text([primary.name, primary.email, primary.phone].filter(Boolean).join('  ')))
  doc.moveDown(1)

  // 明细
  const cols = [
    { title: '#', width: 22, align: 'left' as const },
    { title: 'Description', width: width - 22 - 50 - 40 - 80 - 90, align: 'left' as const },
    { title: 'Qty', width: 50, align: 'right' as const },
    { title: 'Unit', width: 40, align: 'left' as const },
    { title: `Unit Price (${quote.currency})`, width: 80, align: 'right' as const },
    { title: `Amount (${quote.currency})`, width: 90, align: 'right' as const },
  ]
  const drawRow = (cells: string[], bold = false, fill?: string): void => {
    const y = doc.y
    const heights = cells.map((cell, i) => doc.fontSize(9).heightOfString(cell, { width: cols[i]!.width - 6 }))
    const h = Math.max(...heights) + 8
    if (y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage()
      return drawRow(cells, bold, fill)
    }
    if (fill) doc.rect(left, y, width, h).fill(fill).fillColor('#000000')
    let x = left
    cells.forEach((cell, i) => {
      doc.fontSize(bold ? 9.5 : 9).text(cell, x + 3, y + 4, { width: cols[i]!.width - 6, align: cols[i]!.align })
      x += cols[i]!.width
    })
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor('#dddddd').stroke().strokeColor('#000000')
    doc.y = y + h
  }
  drawRow(cols.map((col) => col.title), true, '#f2f2f4')
  quote.items.forEach((item, index) => {
    drawRow([
      String(index + 1),
      text(item.spec ? `${item.name}\n${item.spec}` : item.name),
      String(item.qty),
      text(item.unit),
      money(item.unitPrice),
      money(item.qty * item.unitPrice),
    ])
  })
  drawRow(['', 'TOTAL', '', '', '', `${quote.currency} ${money(quote.subtotal)}`], true)
  doc.moveDown(1)
  doc.x = left

  // 条款
  const terms: Array<[string, string]> = [
    ['Trade terms', [quote.incoterm, quote.port].filter(Boolean).join(' ')],
    ['Payment', quote.paymentTerms],
    ['Lead time', quote.leadTime],
  ]
  doc.fontSize(9)
  for (const [label, value] of terms) {
    if (!value) continue
    doc.fillColor('#777777').text(`${label}: `, left, doc.y, { continued: true }).fillColor('#000000').text(text(value))
  }
  if (quote.notes) {
    doc.moveDown(0.6)
    doc.fillColor('#777777').text('Notes', left).fillColor('#000000').text(text(quote.notes), { width })
  }
  if (template?.footer) {
    doc.moveDown(1.2)
    doc.fontSize(8).fillColor('#777777').text(text(template.footer), left, doc.y, { width })
  }
  doc.end()
  return { buffer: await done, font: fontKind }
}
