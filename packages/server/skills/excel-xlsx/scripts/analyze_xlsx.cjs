#!/usr/bin/env node
'use strict'
/*
 * 读取并分析 Excel / CSV（LULUX ETA 原创，基于 exceljs，MIT）。
 * 用法：
 *   node analyze_xlsx.cjs data.xlsx                       # 每个工作表：行列数、列类型、数值统计、前 10 行预览
 *   node analyze_xlsx.cjs data.xlsx --sheet 订单 --rows 30
 *   node analyze_xlsx.cjs data.csv --group 国家 --sum 金额 [--sum 数量] [--sort desc]   # 分组汇总（类似数据透视）
 *   node analyze_xlsx.cjs data.xlsx --export-csv out.csv  # 导出当前工作表为 CSV（便于 workspace_read 查看）
 * 表头默认取第一行非空行；--header-row 3 可指定。
 */
const fs = require('node:fs')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}
let ExcelJS
try {
  ExcelJS = require('exceljs')
} catch {
  fail('缺少依赖 exceljs：LULUX 会在首次运行时自动安装')
}

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { sum: [] }
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--sum') opts.sum.push(args[++i])
    else if (a.startsWith('--')) opts[a.slice(2)] = args[++i]
    else positional.push(a)
  }
  if (!positional[0]) fail('用法：node analyze_xlsx.cjs 文件.xlsx|文件.csv [--sheet 名称] [--group 列 --sum 列]')
  return { file: safeRel(positional[0]), opts }
}

function cellValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if ('formula' in v || 'sharedFormula' in v) return v.result !== undefined ? (typeof v.result === 'object' && v.result && 'error' in v.result ? `#${v.result.error}` : v.result) : `=${v.formula || v.sharedFormula}`
    if ('text' in v) return v.text
    if ('richText' in v) return v.richText.map((r) => r.text).join('')
    if ('hyperlink' in v) return v.text || v.hyperlink
    if ('error' in v) return `#${v.error}`
  }
  return v
}

function csvRows(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  const sep = (src.split('\n')[0].match(/;/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? ';' : ','
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => (/^-?\d+(\.\d+)?$/.test(c.trim()) ? Number(c) : c === '' ? null : c)))
}

const toNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/,/g, '')) : null)
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : String(v ?? ''))
const esc = (v) => fmt(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')

function analyze(name, matrix, opts) {
  const headerRowIdx = opts['header-row'] ? Number(opts['header-row']) - 1 : matrix.findIndex((r) => r.some((c) => c !== null && c !== ''))
  if (headerRowIdx < 0) return `### ${name}\n（空表）\n`
  const headers = matrix[headerRowIdx].map((h, i) => (h === null || h === '' ? `列${i + 1}` : String(h)))
  const data = matrix.slice(headerRowIdx + 1).filter((r) => r.some((c) => c !== null && c !== ''))
  const out = [`### 工作表「${name}」：${data.length} 行 × ${headers.length} 列（表头在第 ${headerRowIdx + 1} 行）`, '']
  out.push('| 列 | 类型 | 非空 | 唯一值 | 最小 | 最大 | 合计 | 平均 | 常见值 |')
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  headers.forEach((h, i) => {
    const values = data.map((r) => r[i]).filter((v) => v !== null && v !== '')
    const nums = values.map(toNum).filter((v) => v !== null)
    const isNum = values.length > 0 && nums.length / values.length > 0.8
    const counts = new Map()
    for (const v of values) counts.set(String(v), (counts.get(String(v)) || 0) + 1)
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, c]) => `${v.slice(0, 20)}(${c})`).join('、')
    const sum = nums.reduce((s, v) => s + v, 0)
    out.push(`| ${esc(h)} | ${isNum ? '数值' : '文本'} | ${values.length} | ${counts.size} | ${isNum ? fmt(Math.min(...nums)) : ''} | ${isNum ? fmt(Math.max(...nums)) : ''} | ${isNum ? fmt(sum) : ''} | ${isNum && nums.length ? fmt(sum / nums.length) : ''} | ${isNum ? '' : esc(top)} |`)
  })
  const limit = Number(opts.rows || 10)
  out.push('', `前 ${Math.min(limit, data.length)} 行：`, '')
  out.push(`| ${headers.map(esc).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`)
  for (const r of data.slice(0, limit)) out.push(`| ${headers.map((_, i) => esc(r[i])).join(' | ')} |`)

  if (opts.group) {
    const gi = headers.indexOf(opts.group)
    if (gi < 0) fail(`找不到分组列：${opts.group}（可用：${headers.join('、')}）`)
    const sums = opts.sum.map((s) => {
      const idx = headers.indexOf(s)
      if (idx < 0) fail(`找不到汇总列：${s}`)
      return idx
    })
    const groups = new Map()
    for (const r of data) {
      const key = String(r[gi] ?? '（空）')
      const g = groups.get(key) || { count: 0, sums: sums.map(() => 0) }
      g.count += 1
      sums.forEach((idx, k) => (g.sums[k] += toNum(r[idx]) || 0))
      groups.set(key, g)
    }
    const list = [...groups].sort((a, b) => (opts.sort === 'asc' ? 1 : -1) * ((a[1].sums[0] ?? a[1].count) - (b[1].sums[0] ?? b[1].count)))
    const totals = sums.map((_, k) => list.reduce((s, [, g]) => s + g.sums[k], 0))
    out.push('', `按「${opts.group}」分组汇总（${list.length} 组）：`, '')
    out.push(`| ${esc(opts.group)} | 行数 | ${opts.sum.map((s) => `${esc(s)} 合计 | 占比`).join(' | ')} |`)
    out.push(`| --- | ---: | ${opts.sum.map(() => '---: | ---:').join(' | ')} |`)
    for (const [key, g] of list.slice(0, 50)) {
      out.push(`| ${esc(key)} | ${g.count} | ${g.sums.map((v, k) => `${fmt(v)} | ${totals[k] ? ((v / totals[k]) * 100).toFixed(1) : '0.0'}%`).join(' | ')} |`)
    }
    if (list.length > 50) out.push(`| …另 ${list.length - 50} 组 | | |`)
  }
  if (opts['export-csv']) {
    const target = safeRel(opts['export-csv'])
    const q = (v) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    fs.writeFileSync(target, `\uFEFF${[headers, ...data].map((r) => headers.map((_, i) => q(r[i])).join(',')).join('\n')}\n`)
    out.push('', `已导出 CSV：${target}`)
  }
  return out.join('\n')
}

async function main() {
  const { file, opts } = parseArgs()
  const lower = file.toLowerCase()
  const parts = []
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    parts.push(analyze(file, csvRows(fs.readFileSync(file, 'utf8')), opts))
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)
    const sheets = wb.worksheets.filter((ws) => !opts.sheet || ws.name === opts.sheet)
    if (sheets.length === 0) fail(`找不到工作表：${opts.sheet}（可用：${wb.worksheets.map((w) => w.name).join('、')}）`)
    for (const ws of sheets) {
      const matrix = []
      ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const values = []
        for (let c = 1; c <= ws.columnCount; c += 1) values.push(cellValue(row.getCell(c).value))
        matrix[rowNumber - 1] = values
      })
      parts.push(analyze(ws.name, Array.from(matrix, (r) => r || []), opts))
    }
  } else if (lower.endsWith('.xls')) {
    fail('不支持旧版 .xls：请在 Excel/WPS 中另存为 .xlsx 或 .csv 后再分析')
  } else fail('只支持 .xlsx / .csv')
  process.stdout.write(`${parts.join('\n\n')}\n`)
}

main().catch((error) => fail(error.stack || error.message))
