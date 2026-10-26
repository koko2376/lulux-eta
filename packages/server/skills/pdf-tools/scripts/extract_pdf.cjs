#!/usr/bin/env node
'use strict'
/*
 * 提取 PDF 文本与元数据（LULUX ETA 原创，基于 npm 包 pdf-parse 1.x，MIT）。
 * 用法：node extract_pdf.cjs input.pdf [--pages 1-3,5] [--out text.md] [--max-chars 60000]
 * 输出：页数、元数据、按页分隔的文本（--- 第 N 页 ---）。扫描件/图片型 PDF 没有文字层，会提示需要 OCR。
 */
const fs = require('node:fs')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}
let pdfParse
try {
  // 直接引用 lib：避免 pdf-parse 1.x 入口在无父模块时进入调试模式
  pdfParse = require('pdf-parse/lib/pdf-parse.js')
} catch {
  fail('缺少依赖 pdf-parse：LULUX 会在首次运行时自动安装；若手动运行请先 npm i pdf-parse@1')
}

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function parseRanges(spec, max) {
  if (!spec) return null
  const set = new Set()
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) fail(`--pages 格式不正确：${spec}（示例 1-3,5）`)
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let p = Math.max(1, a); p <= Math.min(max, b); p += 1) set.add(p)
  }
  return set
}

async function main() {
  const args = process.argv.slice(2)
  const opts = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i]
    else positional.push(args[i])
  }
  if (!positional[0]) fail('用法：node extract_pdf.cjs input.pdf [--pages 1-3] [--out text.md]')
  const input = safeRel(positional[0])
  const buffer = fs.readFileSync(input)
  const pages = []
  const result = await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent({ normalizeWhitespace: true }).then((content) => {
        let lastY = null
        let text = ''
        for (const item of content.items) {
          const y = item.transform[5]
          if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n'
          else if (text && !text.endsWith(' ') && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(item.str)) text += ' '
          text += item.str
          lastY = y
        }
        pages[pageData.pageIndex] = text
        return text
      }),
  })
  const wanted = parseRanges(opts.pages, result.numpages)
  const maxChars = Number(opts['max-chars'] || 60000)
  const info = result.info || {}
  const out = []
  out.push(`# ${input}`)
  out.push(`- 页数：${result.numpages}`)
  for (const [k, label] of [['Title', '标题'], ['Author', '作者'], ['Subject', '主题'], ['Producer', '生成工具'], ['CreationDate', '创建时间']]) {
    if (info[k]) out.push(`- ${label}：${info[k]}`)
  }
  let total = 0
  let emptyPages = 0
  for (let i = 0; i < result.numpages; i += 1) {
    if (wanted && !wanted.has(i + 1)) continue
    const text = (pages[i] || '').trim()
    if (!text) emptyPages += 1
    out.push('', `--- 第 ${i + 1} 页 ---`, text || '（本页没有可提取的文字）')
    total += text.length
  }
  const considered = wanted ? wanted.size : result.numpages
  if (emptyPages > 0 && emptyPages >= considered * 0.5) {
    out.push('', '> 大部分页面没有文字层，可能是扫描件/图片型 PDF，需要 OCR（可让用户提供可复制文字的版本，或在有视觉能力的模型下逐页截图识别）。')
  }
  let text = out.join('\n')
  if (opts.out) {
    fs.writeFileSync(safeRel(opts.out), text)
    process.stdout.write(`已写入 ${opts.out}（${total} 字符，${considered} 页）\n`)
    text = text.slice(0, 4000)
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（已截断；可用 --pages 分段提取或 --out 写入文件）`
  process.stdout.write(`${text}\n`)
}

main().catch((error) => fail(`无法解析 PDF：${error.message}（文件可能已加密或损坏）`))
