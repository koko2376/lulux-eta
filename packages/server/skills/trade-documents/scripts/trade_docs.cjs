#!/usr/bin/env node
'use strict'
/*
 * 形式发票 PI / 商业发票 CI / 装箱单 PL 生成（LULUX ETA 原创），输出 PDF（pdfkit，随 LULUX 自带，无需联网）。
 * 用法：node trade_docs.cjs doc.json [--type PI|CI|PL|ALL] [--out-dir docs]
 * 输入 JSON 字段见 templates/document-input.example.json。
 * 中文：自动在系统字体中寻找中文字体（Windows 微软雅黑/黑体、macOS 苹方/华文黑体、Linux Noto CJK/文泉驿），找不到时中文会显示为方块，
 *       可在输入里用 "font": "相对路径/字体.ttf" 指定。外贸单据通常全英文，不受影响。
 */
const fs = require('node:fs')
const path = require('node:path')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}

let PDFDocument
try {
  PDFDocument = require('pdfkit')
} catch {
  fail('找不到 pdfkit（LULUX 自带；如在别处运行请先 npm i pdfkit）')
}

const FONT_CANDIDATES = [
  ['C:\\Windows\\Fonts\\msyh.ttc', 'MicrosoftYaHei'],
  ['C:\\Windows\\Fonts\\msyh.ttf', null],
  ['C:\\Windows\\Fonts\\simhei.ttf', null],
  ['C:\\Windows\\Fonts\\simsun.ttc', 'SimSun'],
  ['/System/Library/Fonts/PingFang.ttc', 'PingFangSC-Regular'],
  ['/System/Library/Fonts/STHeiti Light.ttc', 'STHeitiSC-Light'],
  ['/Library/Fonts/Arial Unicode.ttf', null],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
  ['/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
  ['/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
  ['/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', 'WenQuanYiMicroHei'],
  ['/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc', 'WenQuanYiMicroHei'],
]

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function registerFont(doc, custom) {
  const list = custom ? [[safeRel(custom), null]] : FONT_CANDIDATES
  for (const [file, family] of list) {
    if (!fs.existsSync(file)) continue
    try {
      if (family) doc.registerFont('CJK', file, family)
      else doc.registerFont('CJK', file)
      doc.font('CJK')
      return 'CJK'
    } catch {
      // 下一个
    }
  }
  return 'Helvetica'
}

const n = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const money = (v, cur) => `${cur} ${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 金额英文大写（发票常用：SAY US DOLLARS ... ONLY） */
function amountInWords(amount, currency) {
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']
  const chunk = (x) => {
    let s = ''
    if (x >= 100) {
      s += `${ones[Math.floor(x / 100)]} HUNDRED`
      x %= 100
      if (x) s += ' AND '
    }
    if (x >= 20) {
      s += tens[Math.floor(x / 10)]
      if (x % 10) s += `-${ones[x % 10]}`
    } else if (x > 0) s += ones[x]
    return s
  }
  const whole = Math.floor(amount)
  const cents = Math.round((amount - whole) * 100)
  const units = [[1e9, 'BILLION'], [1e6, 'MILLION'], [1e3, 'THOUSAND']]
  let rest = whole
  const parts = []
  for (const [size, name] of units) {
    if (rest >= size) {
      parts.push(`${chunk(Math.floor(rest / size))} ${name}`)
      rest %= size
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(rest === 0 ? 'ZERO' : chunk(rest))
  const names = { USD: 'US DOLLARS', EUR: 'EUROS', GBP: 'POUNDS STERLING', CNY: 'CHINESE YUAN', JPY: 'JAPANESE YEN', AUD: 'AUSTRALIAN DOLLARS', CAD: 'CANADIAN DOLLARS' }
  return `SAY ${names[currency] || currency} ${parts.join(' ')}${cents ? ` AND CENTS ${chunk(cents)}` : ''} ONLY`
}

function header(doc, data, title) {
  const s = data.seller || {}
  doc.fontSize(15).text(s.name || 'SELLER', { align: 'center' })
  doc.fontSize(8.5).text([s.address, [s.tel && `Tel: ${s.tel}`, s.email && `Email: ${s.email}`].filter(Boolean).join('   ')].filter(Boolean).join('\n'), { align: 'center' })
  doc.moveDown(0.6)
  doc.fontSize(16).text(title, { align: 'center', underline: true })
  doc.moveDown(0.6)
}

function partyBlock(doc, data, labelNo) {
  const b = data.buyer || {}
  const top = doc.y
  const left = doc.page.margins.left
  const mid = left + 290
  doc.fontSize(9)
  doc.text('TO (BUYER):', left, top, { width: 280, continued: false })
  doc.text([b.name, b.address, b.contact && `Attn: ${b.contact}`, b.tel && `Tel: ${b.tel}`, b.taxId && `Tax/VAT ID: ${b.taxId}`].filter(Boolean).join('\n'), left, doc.y, { width: 280 })
  const leftEnd = doc.y
  const info = [
    [labelNo, data.number || ''],
    ['DATE:', data.date || new Date().toISOString().slice(0, 10)],
    data.contractNo ? ['CONTRACT NO.:', data.contractNo] : null,
    data.lcNo ? ['L/C NO.:', data.lcNo] : null,
    data.poNo ? ["BUYER'S PO:", data.poNo] : null,
    ['TERMS:', [data.incoterm, data.incotermPlace].filter(Boolean).join(' ') + (data.incoterm ? ' (Incoterms 2020)' : '')],
    data.from || data.to ? ['SHIPMENT:', `From ${data.from || '-'} To ${data.to || '-'}`] : null,
    data.vessel ? ['VESSEL/VOY:', data.vessel] : null,
  ].filter(Boolean)
  let y = top
  for (const [k, v] of info) {
    doc.text(k, mid, y, { width: 95 })
    doc.text(v, mid + 95, y, { width: 175 })
    y = Math.max(doc.y, y + 12)
  }
  doc.y = Math.max(leftEnd, y) + 8
  doc.x = left
}

function table(doc, columns, rows, totals) {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const totalWeight = columns.reduce((s, c) => s + c.w, 0)
  const cols = columns.map((c) => ({ ...c, px: (c.w / totalWeight) * width }))
  const drawRow = (cells, bold) => {
    const heights = cells.map((cell, i) => doc.heightOfString(String(cell ?? ''), { width: cols[i].px - 6 }))
    const h = Math.max(14, ...heights) + 6
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 40) doc.addPage()
    const y = doc.y
    let x = left
    cells.forEach((cell, i) => {
      doc.rect(x, y, cols[i].px, h).stroke('#999999')
      doc.fillColor('#000000').text(String(cell ?? ''), x + 3, y + 3, { width: cols[i].px - 6, align: cols[i].align || 'left' })
      x += cols[i].px
    })
    doc.y = y + h
    if (bold) doc.fillColor('#000000')
  }
  doc.fontSize(8.5)
  drawRow(cols.map((c) => c.title), true)
  for (const row of rows) drawRow(row)
  if (totals) drawRow(totals, true)
  doc.x = left
  doc.moveDown(0.5)
}

function footer(doc, data, extra) {
  const s = data.seller || {}
  doc.fontSize(9)
  for (const [k, v] of extra) {
    if (!v) continue
    doc.text(`${k} ${v}`)
  }
  if (data.remarks) {
    doc.moveDown(0.4)
    doc.text(`REMARKS: ${data.remarks}`)
  }
  doc.moveDown(1.5)
  doc.text(`For and on behalf of ${s.name || 'SELLER'}`, { align: 'right' })
  doc.moveDown(2)
  doc.text('______________________________', { align: 'right' })
  doc.text('Authorized Signature', { align: 'right' })
}

function makeInvoice(data, type, file, fontFile) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${type} ${data.number || ''}`, Author: (data.seller || {}).name || '' } })
  const stream = fs.createWriteStream(file)
  doc.pipe(stream)
  registerFont(doc, fontFile)
  const cur = data.currency || 'USD'
  const items = Array.isArray(data.items) ? data.items : []
  const total = items.reduce((s, it) => s + n(it.qty) * n(it.unitPrice), 0)
  header(doc, data, type === 'PI' ? 'PROFORMA INVOICE' : 'COMMERCIAL INVOICE')
  partyBlock(doc, data, type === 'PI' ? 'PI NO.:' : 'INVOICE NO.:')
  table(
    doc,
    [
      { title: 'NO.', w: 4, align: 'center' },
      { title: 'MARKS', w: 9 },
      { title: 'DESCRIPTION OF GOODS', w: 26 },
      { title: 'HS CODE', w: 9 },
      { title: 'QTY', w: 8, align: 'right' },
      { title: 'UNIT', w: 6, align: 'center' },
      { title: `UNIT PRICE (${cur})`, w: 11, align: 'right' },
      { title: `AMOUNT (${cur})`, w: 12, align: 'right' },
    ],
    items.map((it, i) => [
      i + 1,
      it.marks || (i === 0 ? data.marks || 'N/M' : ''),
      [it.name, it.spec, it.model && `Model: ${it.model}`].filter(Boolean).join('\n'),
      it.hsCode || '',
      n(it.qty).toLocaleString('en-US'),
      it.unit || 'PCS',
      n(it.unitPrice).toFixed(n(it.unitPrice) < 1 ? 4 : 2),
      (n(it.qty) * n(it.unitPrice)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    ]),
    ['', '', 'TOTAL', '', items.reduce((s, it) => s + n(it.qty), 0).toLocaleString('en-US'), '', '', total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
  )
  doc.fontSize(9).text(`TOTAL AMOUNT: ${money(total, cur)}`)
  doc.text(amountInWords(total, cur))
  doc.moveDown(0.6)
  const bank = data.bank || {}
  const extra = [
    ['PAYMENT TERMS:', data.paymentTerms],
    ['DELIVERY TIME:', type === 'PI' ? data.leadTime : null],
    ['VALIDITY:', type === 'PI' ? data.validity : null],
    ['PACKING:', data.packing],
    ['COUNTRY OF ORIGIN:', data.origin || 'CHINA'],
    ['PORT OF LOADING:', data.from],
    ['PORT OF DISCHARGE:', data.to],
    ['BENEFICIARY BANK:', bank.name ? [bank.name, bank.address].filter(Boolean).join(', ') : null],
    ['SWIFT:', bank.swift],
    ['ACCOUNT NAME:', bank.accountName],
    ['ACCOUNT NO.:', bank.account],
  ]
  footer(doc, data, extra)
  doc.end()
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(total))
    stream.on('error', reject)
  })
}

function makePackingList(data, file, fontFile) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `PL ${data.number || ''}` } })
  const stream = fs.createWriteStream(file)
  doc.pipe(stream)
  registerFont(doc, fontFile)
  const items = Array.isArray(data.items) ? data.items : []
  header(doc, data, 'PACKING LIST')
  partyBlock(doc, data, 'INVOICE NO.:')
  let ctns = 0
  let nw = 0
  let gw = 0
  let cbm = 0
  const rows = items.map((it, i) => {
    const cartons = n(it.cartons, it.qtyPerCarton ? Math.ceil(n(it.qty) / n(it.qtyPerCarton)) : 0)
    const lineNw = n(it.netKgPerCarton) * cartons
    const lineGw = n(it.grossKgPerCarton) * cartons
    const dims = it.cartonSize || {}
    const lineCbm = it.cbm !== undefined ? n(it.cbm) : (n(dims.length) * n(dims.width) * n(dims.height) * cartons) / 1e6
    ctns += cartons
    nw += lineNw
    gw += lineGw
    cbm += lineCbm
    return [
      i + 1,
      it.marks || (i === 0 ? data.marks || 'N/M' : ''),
      [it.name, it.spec].filter(Boolean).join('\n'),
      n(it.qty).toLocaleString('en-US') + ` ${it.unit || 'PCS'}`,
      cartons,
      lineNw.toFixed(2),
      lineGw.toFixed(2),
      dims.length ? `${dims.length}×${dims.width}×${dims.height}` : '',
      lineCbm.toFixed(3),
    ]
  })
  table(
    doc,
    [
      { title: 'NO.', w: 4, align: 'center' },
      { title: 'MARKS', w: 9 },
      { title: 'DESCRIPTION', w: 24 },
      { title: 'QTY', w: 10, align: 'right' },
      { title: 'CTNS', w: 6, align: 'right' },
      { title: 'N.W.(KG)', w: 9, align: 'right' },
      { title: 'G.W.(KG)', w: 9, align: 'right' },
      { title: 'CTN SIZE (CM)', w: 12, align: 'center' },
      { title: 'CBM', w: 8, align: 'right' },
    ],
    rows,
    ['', '', 'TOTAL', '', ctns, nw.toFixed(2), gw.toFixed(2), '', cbm.toFixed(3)],
  )
  doc.fontSize(9).text(`TOTAL: ${ctns} CARTONS, N.W. ${nw.toFixed(2)} KGS, G.W. ${gw.toFixed(2)} KGS, MEAS. ${cbm.toFixed(3)} CBM`)
  doc.text(`SAY TOTAL ${ctns} CARTONS ONLY`)
  doc.moveDown(0.6)
  footer(doc, data, [['CONTAINER NO./SEAL NO.:', data.containerNo], ['SHIPPING MARKS:', data.marks]])
  doc.end()
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve({ ctns, nw, gw, cbm }))
    stream.on('error', reject)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const skip = new Set()
  ;['--type', '--out-dir'].forEach((name) => {
    const i = args.indexOf(name)
    if (i >= 0) skip.add(i).add(i + 1)
  })
  const file = args.find((a, i) => !skip.has(i) && !a.startsWith('--'))
  const raw = file ? fs.readFileSync(safeRel(file), 'utf8') : fs.readFileSync(0, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    fail(`输入不是合法 JSON：${e.message}`)
  }
  const type = String(opt('--type') || data.type || 'ALL').toUpperCase()
  const outDir = safeRel(opt('--out-dir') || 'documents')
  fs.mkdirSync(outDir, { recursive: true })
  const base = String(data.number || 'DOC').replace(/[^A-Za-z0-9_-]+/g, '-')
  const made = []
  const warnings = []
  if (!data.seller?.name) warnings.push('缺少卖方名称 seller.name')
  if (!data.buyer?.name) warnings.push('缺少买方名称 buyer.name')
  if ((type === 'CI' || type === 'ALL') && data.lcNo) warnings.push('信用证项下：品名、数量、单价、术语、唛头须与 L/C 条款逐字一致，请对照 L/C 46A/45A 复核')
  if (!['PI', 'CI', 'PL', 'ALL'].includes(type)) fail('--type 只能是 PI、CI、PL 或 ALL')
  for (const kind of ['PI', 'CI', 'PL']) {
    if (type !== kind && type !== 'ALL') continue
    const file = path.join(outDir, `${kind}-${base}.pdf`)
    if (kind === 'PL') await makePackingList(data, file, data.font)
    else await makeInvoice(data, kind, file, data.font)
    made.push(file)
  }
  process.stdout.write(`已生成：\n${made.map((f) => `- ${f.split(path.sep).join('/')}`).join('\n')}\n`)
  if (warnings.length) process.stdout.write(`\n注意：\n${warnings.map((w) => `- ${w}`).join('\n')}\n`)
}

main().catch((error) => fail(error.message))
