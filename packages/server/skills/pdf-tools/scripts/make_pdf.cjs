#!/usr/bin/env node
'use strict'
/*
 * Markdown → PDF（LULUX ETA 原创，基于 pdfkit，MIT；pdfkit 随 LULUX 自带，无需联网）。
 * 用法：node make_pdf.cjs input.md output.pdf [--title "标题"] [--font 相对路径.ttf] [--size A4|Letter] [--landscape]
 * 支持：标题（# ~ ###）、段落、- / 1. 列表、> 引用、``` 代码块、| 表格 |、--- 分隔线、<!-- pagebreak -->；
 *       行内 **粗体** 以粗体字重显示（中文字体无粗体时以颜色区分）。页脚自动页码。
 * 中文字体：自动查找系统字体（微软雅黑/黑体/苹方/Noto CJK/文泉驿）；找不到时用 --font 指定工作区里的 .ttf/.otf。
 */
const fs = require('node:fs')

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
  ['C:\\Windows\\Fonts\\msyh.ttc', 'MicrosoftYaHei', 'C:\\Windows\\Fonts\\msyhbd.ttc', 'MicrosoftYaHei-Bold'],
  ['C:\\Windows\\Fonts\\simhei.ttf', null],
  ['C:\\Windows\\Fonts\\simsun.ttc', 'SimSun'],
  ['/System/Library/Fonts/PingFang.ttc', 'PingFangSC-Regular', '/System/Library/Fonts/PingFang.ttc', 'PingFangSC-Semibold'],
  ['/System/Library/Fonts/STHeiti Light.ttc', 'STHeitiSC-Light', '/System/Library/Fonts/STHeiti Medium.ttc', 'STHeitiSC-Medium'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'NotoSansCJKsc-Bold'],
  ['/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular', '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc', 'NotoSansCJKsc-Bold'],
  ['/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular'],
  ['/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', 'WenQuanYiMicroHei'],
  ['/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc', 'WenQuanYiMicroHei'],
]

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function setupFonts(doc, custom) {
  const fonts = { regular: 'Helvetica', bold: 'Helvetica-Bold', mono: 'Courier', cjk: false }
  const list = custom ? [[safeRel(custom), null]] : FONT_CANDIDATES
  for (const [file, family, boldFile, boldFamily] of list) {
    if (!fs.existsSync(file)) continue
    try {
      if (family) doc.registerFont('R', file, family)
      else doc.registerFont('R', file)
      fonts.regular = 'R'
      fonts.bold = 'R'
      fonts.mono = 'R'
      fonts.cjk = true
      if (boldFile && fs.existsSync(boldFile)) {
        try {
          doc.registerFont('B', boldFile, boldFamily)
          fonts.bold = 'B'
        } catch {
          // 无粗体
        }
      }
      return fonts
    } catch {
      // 下一个
    }
  }
  return fonts
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--landscape') opts.landscape = true
    else if (a.startsWith('--')) opts[a.slice(2)] = args[++i]
    else positional.push(a)
  }
  if (positional.length < 2) fail('用法：node make_pdf.cjs input.md output.pdf')
  return { input: safeRel(positional[0]), output: safeRel(positional[1]), opts }
}

function inlineSegments(text) {
  const segs = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*]*)\*/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) })
    if (m[1]) segs.push({ text: m[1], bold: true })
    else if (m[2]) segs.push({ text: m[2], code: true })
    else if (m[3]) segs.push({ text: m[3], link: m[4] })
    else segs.push({ text: m[5] })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  return segs.length ? segs : [{ text: '' }]
}

function writeInline(doc, fonts, text, options = {}) {
  const segs = inlineSegments(text)
  segs.forEach((seg, i) => {
    doc.font(seg.bold ? fonts.bold : seg.code ? fonts.mono : fonts.regular)
    doc.fillColor(seg.link ? '#1F4E79' : seg.bold && fonts.bold === fonts.regular ? '#000000' : options.color || '#222222')
    doc.text(seg.text, { ...options, continued: i < segs.length - 1, link: seg.link || null, underline: Boolean(seg.link) })
  })
  doc.font(fonts.regular).fillColor('#222222')
}

function drawTable(doc, fonts, lines) {
  const split = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\*\*/g, ''))
  const header = split(lines[0])
  const aligns = split(lines[1]).map((c) => (c.endsWith(':') && c.startsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
  const rows = lines.slice(2).map(split)
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const colW = width / header.length
  const drawRow = (cells, head) => {
    doc.font(head ? fonts.bold : fonts.regular).fontSize(9.5)
    const h = Math.max(...cells.map((c) => doc.heightOfString(c || ' ', { width: colW - 8 }))) + 8
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage()
    const y = doc.y
    cells.forEach((c, i) => {
      if (head) doc.rect(left + i * colW, y, colW, h).fillAndStroke('#D9E2F3', '#999999')
      else doc.rect(left + i * colW, y, colW, h).stroke('#999999')
      doc.fillColor('#222222').text(c || '', left + i * colW + 4, y + 4, { width: colW - 8, align: aligns[i] || 'left' })
    })
    doc.y = y + h
  }
  drawRow(header, true)
  for (const r of rows) drawRow(header.map((_, i) => r[i] ?? ''), false)
  doc.x = left
  doc.moveDown(0.6)
  doc.font(fonts.regular).fontSize(11)
}

function main() {
  const { input, output, opts } = parseArgs()
  if (!output.toLowerCase().endsWith('.pdf')) fail('输出文件需以 .pdf 结尾')
  const markdown = fs.readFileSync(input, 'utf8')
  const doc = new PDFDocument({ size: opts.size || 'A4', layout: opts.landscape ? 'landscape' : 'portrait', margin: 56, bufferPages: true, info: { Title: opts.title || '', Author: 'LULUX ETA' } })
  const stream = fs.createWriteStream(output)
  doc.pipe(stream)
  const fonts = setupFonts(doc, opts.font)
  doc.font(fonts.regular).fontSize(11).fillColor('#222222')
  if (opts.title) {
    doc.font(fonts.bold).fontSize(22).text(opts.title, { align: 'center' })
    doc.moveDown(1)
    doc.font(fonts.regular).fontSize(11)
  }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let para = []
  const flush = () => {
    if (!para.length) return
    writeInline(doc, fonts, para.join(fonts.cjk ? '' : ' '), { lineGap: 3 })
    doc.moveDown(0.5)
    para = []
  }
  const sizes = [20, 16, 13.5, 12, 11, 11]
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    if (/^<!--\s*pagebreak\s*-->$/i.test(t)) {
      flush()
      doc.addPage()
      continue
    }
    if (t.startsWith('```')) {
      flush()
      const code = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
      doc.font(fonts.mono).fontSize(9).fillColor('#333333')
      const x = doc.x
      const y = doc.y
      const text = code.join('\n') || ' '
      const h = doc.heightOfString(text, { width: doc.page.width - 112 - 12 }) + 10
      doc.rect(x, y, doc.page.width - 112, h).fill('#F5F5F5')
      doc.fillColor('#333333').text(text, x + 6, y + 5, { width: doc.page.width - 112 - 12 })
      doc.x = x
      doc.moveDown(0.6)
      doc.font(fonts.regular).fontSize(11).fillColor('#222222')
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      flush()
      doc.moveDown(h[1].length === 1 ? 0.6 : 0.3)
      doc.font(fonts.bold).fontSize(sizes[h[1].length - 1]).fillColor(h[1].length <= 2 ? '#1F4E79' : '#222222').text(h[2].replace(/\*\*/g, ''))
      doc.moveDown(0.3)
      doc.font(fonts.regular).fontSize(11).fillColor('#222222')
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush()
      const y = doc.y + 4
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke('#BBBBBB')
      doc.moveDown(0.8)
      continue
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush()
      const block = []
      while (i < lines.length && lines[i].trim().startsWith('|')) block.push(lines[i++])
      i -= 1
      drawTable(doc, fonts, block)
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const level = Math.min(2, Math.floor(li[1].length / 2))
      const marker = /\d/.test(li[2]) ? li[2] : level ? '◦' : '•'
      doc.text(`${marker} `, doc.page.margins.left + 14 + level * 16, doc.y, { continued: true })
      writeInline(doc, fonts, li[3], { lineGap: 2 })
      doc.x = doc.page.margins.left
      continue
    }
    if (t.startsWith('>')) {
      flush()
      const y = doc.y
      writeInline(doc, fonts, t.replace(/^>\s?/, ''), { color: '#555555', indent: 14 })
      doc.moveTo(doc.page.margins.left + 4, y).lineTo(doc.page.margins.left + 4, doc.y).lineWidth(2).stroke('#BBBBBB').lineWidth(1)
      doc.moveDown(0.4)
      continue
    }
    if (!t) {
      flush()
      continue
    }
    para.push(t)
  }
  flush()
  const range = doc.bufferedPageRange()
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p)
    const bottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font(fonts.regular).fontSize(8.5).fillColor('#888888').text(`${p + 1} / ${range.count}`, 0, doc.page.height - 36, { align: 'center', width: doc.page.width, lineBreak: false })
    doc.page.margins.bottom = bottom
  }
  doc.end()
  stream.on('finish', () => {
    process.stdout.write(`已生成 ${output}（${range.count} 页${fonts.cjk ? '' : '；未找到中文字体，中文可能显示为方块，可用 --font 指定'}）\n`)
  })
}

main()
