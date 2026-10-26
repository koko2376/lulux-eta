#!/usr/bin/env node
'use strict'
/*
 * Markdown → Word（.docx）（LULUX ETA 原创，基于 npm 包 docx，MIT）。
 * 用法：node make_docx.cjs input.md output.docx [--title "标题"] [--author "作者"] [--header "页眉"] [--footer "页脚"] [--font "Microsoft YaHei"] [--toc]
 * 支持：# ~ ###### 标题、段落、**粗体** *斜体* `代码` [链接](url)、- / * / 1. 列表（两级缩进）、> 引用、
 *       ``` 代码块、| 表格 |、--- 分隔线、空行分段、<!-- pagebreak --> 分页；--toc 在开头插入目录（Word 打开时更新域）。
 */
const fs = require('node:fs')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}

let docx
try {
  docx = require('docx')
} catch {
  fail('缺少依赖 docx：LULUX 会在首次运行时自动安装；若手动运行请先 npm i docx')
}
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType,
  ExternalHyperlink, BorderStyle, Header, Footer, PageNumber, TableOfContents, ShadingType, LevelFormat, PageBreak,
} = docx

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--toc') opts.toc = true
    else if (a.startsWith('--')) {
      opts[a.slice(2)] = args[i + 1]
      i += 1
    } else positional.push(a)
  }
  if (positional.length < 2) fail('用法：node make_docx.cjs input.md output.docx [--title ...]')
  return { input: safeRel(positional[0]), output: safeRel(positional[1]), opts }
}

/** 行内格式：**粗体**、*斜体*、`代码`、[文字](链接) */
function inline(text, base = {}) {
  const runs = []
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), ...base }))
    if (m[2] || m[3]) runs.push(new TextRun({ text: m[2] || m[3], bold: true, ...base }))
    else if (m[4] || m[5]) runs.push(new TextRun({ text: m[4] || m[5], italics: true, ...base }))
    else if (m[6]) runs.push(new TextRun({ text: m[6], font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' }, ...base }))
    else if (m[7]) runs.push(new ExternalHyperlink({ link: m[8], children: [new TextRun({ text: m[7], style: 'Hyperlink', ...base })] }))
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }))
  return runs.length ? runs : [new TextRun({ text: '', ...base })]
}

function tableFrom(lines) {
  const split = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const header = split(lines[0])
  const aligns = split(lines[1]).map((c) => (c.endsWith(':') && c.startsWith(':') ? AlignmentType.CENTER : c.endsWith(':') ? AlignmentType.RIGHT : AlignmentType.LEFT))
  const body = lines.slice(2).map(split)
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' }
  const cell = (text, i, head) =>
    new TableCell({
      children: [new Paragraph({ alignment: aligns[i] || AlignmentType.LEFT, children: inline(text, head ? { bold: true } : {}) })],
      shading: head ? { type: ShadingType.CLEAR, fill: 'D9E2F3' } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, i, true)) }),
      ...body.map((row) => new TableRow({ children: header.map((_, i) => cell(row[i] ?? '', i, false)) })),
    ],
  })
}

function convert(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const children = []
  let para = []
  const flush = () => {
    if (para.length) {
      children.push(new Paragraph({ children: inline(para.join(' ')), spacing: { after: 120 } }))
      para = []
    }
  }
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (/^<!--\s*pagebreak\s*-->$/i.test(trimmed)) {
      flush()
      children.push(new Paragraph({ children: [new PageBreak()] }))
      continue
    }
    if (trimmed.startsWith('```')) {
      flush()
      const code = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++])
      for (const c of code) children.push(new Paragraph({ children: [new TextRun({ text: c || ' ', font: 'Consolas', size: 18 })], shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' } }))
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      flush()
      children.push(new Paragraph({ heading: headings[h[1].length - 1], children: inline(h[2]) }))
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush()
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA', space: 1 } }, children: [] }))
      continue
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush()
      const block = []
      while (i < lines.length && lines[i].trim().startsWith('|')) block.push(lines[i++])
      i -= 1
      children.push(tableFrom(block))
      children.push(new Paragraph({ children: [] }))
      continue
    }
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flush()
      const m = bullet || numbered
      const level = Math.min(1, Math.floor(m[1].replace(/\t/g, '    ').length / 2))
      children.push(new Paragraph({ children: inline(m[3]), numbering: { reference: bullet ? 'bullets' : 'numbers', level } }))
      continue
    }
    if (trimmed.startsWith('>')) {
      flush()
      children.push(new Paragraph({ children: inline(trimmed.replace(/^>\s?/, ''), { italics: true, color: '555555' }), indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 } } }))
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    para.push(trimmed)
  }
  flush()
  return children
}

async function main() {
  const { input, output, opts } = parseArgs()
  if (!output.toLowerCase().endsWith('.docx')) fail('输出文件需以 .docx 结尾')
  const markdown = fs.readFileSync(input, 'utf8')
  const body = convert(markdown)
  const font = opts.font || 'Microsoft YaHei'
  const intro = []
  if (opts.title) intro.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: opts.title })] }))
  if (opts.toc) intro.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }), new Paragraph({ children: [new PageBreak()] }))
  const doc = new Document({
    creator: opts.author || 'LULUX ETA',
    title: opts.title || '',
    styles: { default: { document: { run: { font, size: 22 } } } },
    features: { updateFields: Boolean(opts.toc) },
    numbering: {
      config: [
        { reference: 'bullets', levels: [0, 1].map((level) => ({ level, format: LevelFormat.BULLET, text: level ? '◦' : '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) },
        { reference: 'numbers', levels: [0, 1].map((level) => ({ level, format: level ? LevelFormat.LOWER_LETTER : LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) },
      ],
    },
    sections: [
      {
        properties: {},
        headers: opts.header ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: opts.header, size: 18, color: '777777' })] })] }) } : undefined,
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: opts.footer ? `${opts.footer}    ` : '', size: 18, color: '777777' }), new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 18, color: '777777' })],
              }),
            ],
          }),
        },
        children: [...intro, ...body],
      },
    ],
  })
  const buffer = await Packer.toBuffer(doc)
  fs.writeFileSync(output, buffer)
  process.stdout.write(`已生成 ${output}（${Math.round(buffer.length / 1024)} KB，${body.length} 个段落/表格）\n`)
}

main().catch((error) => fail(error.stack || error.message))
