#!/usr/bin/env node
'use strict'
/*
 * 生成 Excel（.xlsx）（LULUX ETA 原创，基于 npm 包 exceljs，MIT）。
 * 用法：node make_xlsx.cjs spec.json output.xlsx        或   node make_xlsx.cjs data.csv output.xlsx [--sheet 名称]
 * spec.json：
 * {
 *   "sheets": [{
 *     "name": "报价明细",
 *     "title": "LED 报价单（可选，放在第 1 行并合并）",
 *     "columns": [ { "header": "品名", "key": "name", "width": 24 },
 *                  { "header": "数量", "key": "qty", "width": 10, "numFmt": "#,##0" },
 *                  { "header": "单价", "key": "price", "width": 12, "numFmt": "#,##0.00" },
 *                  { "header": "金额", "key": "amount", "width": 14, "numFmt": "#,##0.00", "formula": "{qty}*{price}" } ],
 *     "rows": [ { "name": "LED Panel", "qty": 2000, "price": 7.99 } ],     // 也可用二维数组
 *     "totals": { "label": "合计", "sum": ["qty", "amount"] },             // 合计行用 SUM 公式
 *     "freeze": true, "autoFilter": true,
 *     "conditional": [ { "key": "amount", "greaterThan": 10000, "fill": "FFF2CC" } ]
 *   }]
 * }
 * 列的 formula 用 {key} 引用同一行其他列，生成真正的 Excel 公式（打开后可自动重算）。
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
  fail('缺少依赖 exceljs：LULUX 会在首次运行时自动安装；若手动运行请先 npm i exceljs')
}

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
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
  return rows.filter((r) => r.some((c) => c !== ''))
}

const asNumber = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v)

function colLetter(n) {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function buildSheet(wb, spec) {
  const ws = wb.addWorksheet(String(spec.name || 'Sheet1').slice(0, 31).replace(/[\\/?*[\]:]/g, '-'))
  let columns = spec.columns
  let rows = spec.rows || []
  if (!columns && Array.isArray(rows[0])) {
    columns = rows[0].map((h, i) => ({ header: String(h), key: `c${i}` }))
    rows = rows.slice(1).map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, asNumber(v)])))
  }
  if (!Array.isArray(columns) || columns.length === 0) fail(`工作表「${spec.name}」缺少 columns`)
  const startRow = spec.title ? 3 : 1
  if (spec.title) {
    ws.mergeCells(1, 1, 1, columns.length)
    const t = ws.getCell(1, 1)
    t.value = spec.title
    t.font = { bold: true, size: 14 }
    t.alignment = { horizontal: 'center' }
  }
  const keys = columns.map((c) => c.key)
  const headerRow = ws.getRow(startRow)
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = c.header ?? c.key
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    ws.getColumn(i + 1).width = c.width || Math.min(40, Math.max(10, String(c.header ?? c.key).length * 2 + 2))
  })
  rows.forEach((raw, r) => {
    const record = Array.isArray(raw) ? Object.fromEntries(raw.map((v, i) => [keys[i], v])) : raw
    const rowNo = startRow + 1 + r
    const row = ws.getRow(rowNo)
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1)
      if (c.formula) {
        const expr = c.formula.replace(/\{(\w+)\}/g, (_, key) => {
          const idx = keys.indexOf(key)
          if (idx < 0) fail(`公式引用了不存在的列：${key}`)
          return `${colLetter(idx + 1)}${rowNo}`
        })
        // 同时写入计算结果（不重算公式的查看器也能显示数值）；只对纯四则运算求值
        const arithmetic = c.formula.replace(/\{(\w+)\}/g, (_, key) => {
          const v = Number(record[key])
          return Number.isFinite(v) ? `(${v})` : 'NaN'
        })
        let result
        if (/^[\d.+\-*/() eE]+$/.test(arithmetic)) {
          try {
            result = Function(`"use strict"; return (${arithmetic})`)()
          } catch {
            result = undefined
          }
        }
        cell.value = Number.isFinite(result) ? { formula: expr, result } : { formula: expr }
        record[c.key] = Number.isFinite(result) ? result : record[c.key]
      } else cell.value = asNumber(record[c.key] ?? null)
      if (c.numFmt) cell.numFmt = c.numFmt
      cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } }, bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } }, left: { style: 'thin', color: { argb: 'FFBFBFBF' } }, right: { style: 'thin', color: { argb: 'FFBFBFBF' } } }
    })
  })
  const lastData = startRow + rows.length
  if (spec.totals && rows.length > 0) {
    const row = ws.getRow(lastData + 1)
    row.getCell(1).value = spec.totals.label || '合计'
    row.font = { bold: true }
    for (const key of spec.totals.sum || []) {
      const idx = keys.indexOf(key)
      if (idx < 0) continue
      const col = colLetter(idx + 1)
      const cell = row.getCell(idx + 1)
      const total = rows.reduce((sum, raw) => {
        const record = Array.isArray(raw) ? Object.fromEntries(raw.map((v, i) => [keys[i], v])) : raw
        const v = Number(record[key])
        return sum + (Number.isFinite(v) ? v : 0)
      }, 0)
      cell.value = { formula: `SUM(${col}${startRow + 1}:${col}${lastData})`, result: total }
      if (columns[idx].numFmt) cell.numFmt = columns[idx].numFmt
    }
  }
  if (spec.freeze !== false) ws.views = [{ state: 'frozen', ySplit: startRow }]
  if (spec.autoFilter !== false && rows.length > 0) ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: lastData, column: columns.length } }
  for (const rule of spec.conditional || []) {
    const idx = keys.indexOf(rule.key)
    if (idx < 0 || rows.length === 0) continue
    const col = colLetter(idx + 1)
    ws.addConditionalFormatting({
      ref: `${col}${startRow + 1}:${col}${lastData}`,
      rules: [{ type: 'cellIs', operator: rule.lessThan !== undefined ? 'lessThan' : 'greaterThan', formulae: [rule.lessThan ?? rule.greaterThan], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: `FF${rule.fill || 'FFF2CC'}` } } } }],
    })
  }
  return { name: ws.name, rows: rows.length, columns: columns.length }
}

async function main() {
  const args = process.argv.slice(2)
  const sheetIdx = args.indexOf('--sheet')
  const sheetName = sheetIdx >= 0 ? args[sheetIdx + 1] : undefined
  const positional = args.filter((a, i) => !a.startsWith('--') && (sheetIdx < 0 || i !== sheetIdx + 1))
  if (positional.length < 2) fail('用法：node make_xlsx.cjs spec.json|data.csv output.xlsx')
  const [input, output] = positional.map(safeRel)
  if (!output.toLowerCase().endsWith('.xlsx')) fail('输出文件需以 .xlsx 结尾')
  const text = fs.readFileSync(input, 'utf8')
  let spec
  if (input.toLowerCase().endsWith('.csv')) spec = { sheets: [{ name: sheetName || 'Sheet1', rows: parseCsv(text) }] }
  else {
    try {
      spec = JSON.parse(text)
    } catch (e) {
      fail(`spec 不是合法 JSON：${e.message}`)
    }
  }
  const wb = new ExcelJS.Workbook()
  wb.creator = 'LULUX ETA'
  wb.created = new Date()
  const summary = (spec.sheets || []).map((s) => buildSheet(wb, s))
  if (summary.length === 0) fail('sheets 不能为空')
  await wb.xlsx.writeFile(output)
  process.stdout.write(`已生成 ${output}：${summary.map((s) => `${s.name}（${s.rows} 行 × ${s.columns} 列）`).join('，')}\n`)
}

main().catch((error) => fail(error.stack || error.message))
