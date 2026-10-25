#!/usr/bin/env node
'use strict'
/*
 * 静态 SVG 图表生成（LULUX ETA 原创，无依赖）。产物面板的 HTML 不执行脚本，所以图表一律输出静态 SVG。
 * 用法：node chart_svg.cjs chart.json output.svg      或   echo '{...}' | node chart_svg.cjs - output.svg
 * chart.json：
 * {
 *   "type": "bar" | "hbar" | "line" | "area" | "pie" | "donut" | "stacked",
 *   "title": "2026 各市场出口额", "subtitle": "单位：千美元",
 *   "labels": ["德国", "美国", "法国"],
 *   "series": [ { "name": "2025", "values": [120, 90, 60] }, { "name": "2026", "values": [140, 85, 75] } ],
 *   "width": 800, "height": 460, "valueFormat": "0,0.0", "colors": ["#1F4E79", "#F4B183"], "showValues": true
 * }
 */
const fs = require('node:fs')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}
function safeRel(p) {
  if (!p || p === '-') return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

const PALETTE = ['#1F4E79', '#F4B183', '#70AD47', '#FFC000', '#5B9BD5', '#C55A11', '#7F6084', '#264478', '#9E480E', '#636363']
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const FONT = "font-family=\"'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',Arial,sans-serif\""

function fmt(v, pattern) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  const digits = pattern && pattern.includes('.') ? pattern.split('.')[1].length : Number.isInteger(v) ? 0 : 1
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function niceMax(max) {
  if (max <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(max))
  const f = max / exp
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * exp
}

function render(c) {
  const W = c.width || 800
  const H = c.height || 460
  const colors = c.colors || PALETTE
  const labels = c.labels || []
  const series = (c.series || []).map((s) => ({ name: s.name || '', values: (s.values || []).map(Number) }))
  if (series.length === 0) fail('series 不能为空')
  const type = c.type || 'bar'
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`)
  parts.push(`<rect width="${W}" height="${H}" fill="#FFFFFF"/>`)
  let top = 20
  if (c.title) {
    parts.push(`<text x="${W / 2}" y="34" font-size="20" font-weight="bold" text-anchor="middle" fill="#222">${esc(c.title)}</text>`)
    top = 50
  }
  if (c.subtitle) {
    parts.push(`<text x="${W / 2}" y="${top + 6}" font-size="13" text-anchor="middle" fill="#777">${esc(c.subtitle)}</text>`)
    top += 18
  }
  const legendH = series.length > 1 || type === 'pie' || type === 'donut' ? 30 : 0

  if (type === 'pie' || type === 'donut') {
    const values = series[0].values
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1
    const cx = W * 0.38
    const cy = top + (H - top - 20) / 2
    const r = Math.min(W * 0.3, (H - top - 40) / 2)
    let angle = -Math.PI / 2
    values.forEach((v, i) => {
      const a = (Math.max(0, v) / total) * Math.PI * 2
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(angle + a)
      const y2 = cy + r * Math.sin(angle + a)
      const large = a > Math.PI ? 1 : 0
      const path = a >= Math.PI * 2 - 1e-6 ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0` : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
      parts.push(`<path d="${path}" fill="${colors[i % colors.length]}" stroke="#fff" stroke-width="2"/>`)
      const mid = angle + a / 2
      if (a > 0.25) parts.push(`<text x="${cx + r * 0.65 * Math.cos(mid)}" y="${cy + r * 0.65 * Math.sin(mid) + 5}" font-size="13" text-anchor="middle" fill="#fff" font-weight="bold">${((v / total) * 100).toFixed(1)}%</text>`)
      angle += a
    })
    if (type === 'donut') parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff"/><text x="${cx}" y="${cy + 6}" font-size="18" text-anchor="middle" fill="#333">${esc(fmt(total, c.valueFormat))}</text>`)
    labels.forEach((label, i) => {
      const y = top + 30 + i * 26
      parts.push(`<rect x="${W * 0.72}" y="${y - 12}" width="14" height="14" fill="${colors[i % colors.length]}"/>`)
      parts.push(`<text x="${W * 0.72 + 22}" y="${y}" font-size="14" fill="#333">${esc(label)}：${esc(fmt(values[i], c.valueFormat))}</text>`)
    })
    parts.push('</svg>')
    return parts.join('\n')
  }

  const horizontal = type === 'hbar'
  const stacked = type === 'stacked'
  const left = horizontal ? 120 : 70
  const right = 30
  const bottom = 50 + legendH
  const plotW = W - left - right
  const plotH = H - top - bottom
  const maxVal = stacked ? Math.max(...labels.map((_, i) => series.reduce((s, se) => s + Math.max(0, se.values[i] || 0), 0))) : Math.max(...series.flatMap((s) => s.values.filter(Number.isFinite)))
  const minVal = Math.min(0, ...series.flatMap((s) => s.values.filter(Number.isFinite)))
  const vmax = niceMax(maxVal)
  const vmin = minVal < 0 ? -niceMax(-minVal) : 0
  const scale = (v) => (v - vmin) / (vmax - vmin)
  const ticks = 5
  for (let t = 0; t <= ticks; t += 1) {
    const v = vmin + ((vmax - vmin) * t) / ticks
    if (horizontal) {
      const x = left + scale(v) * plotW
      parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plotH}" stroke="#E5E5E5"/>`)
      parts.push(`<text x="${x}" y="${top + plotH + 18}" font-size="12" text-anchor="middle" fill="#666">${esc(fmt(v, c.valueFormat))}</text>`)
    } else {
      const y = top + plotH - scale(v) * plotH
      parts.push(`<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="#E5E5E5"/>`)
      parts.push(`<text x="${left - 8}" y="${y + 4}" font-size="12" text-anchor="end" fill="#666">${esc(fmt(v, c.valueFormat))}</text>`)
    }
  }
  const n = labels.length || Math.max(...series.map((s) => s.values.length))
  const band = (horizontal ? plotH : plotW) / n
  if (type === 'line' || type === 'area') {
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => [left + band * (i + 0.5), top + plotH - scale(v) * plotH])
      if (type === 'area') parts.push(`<path d="M ${pts[0][0]} ${top + plotH} ${pts.map((p) => `L ${p[0]} ${p[1]}`).join(' ')} L ${pts[pts.length - 1][0]} ${top + plotH} Z" fill="${colors[k % colors.length]}" opacity="0.25"/>`)
      parts.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${colors[k % colors.length]}" stroke-width="3"/>`)
      pts.forEach((p, i) => {
        parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${colors[k % colors.length]}"/>`)
        if (c.showValues !== false && series.length <= 2) parts.push(`<text x="${p[0]}" y="${p[1] - 10}" font-size="12" text-anchor="middle" fill="#333">${esc(fmt(s.values[i], c.valueFormat))}</text>`)
      })
    })
  } else {
    const groupPad = band * 0.2
    const barSize = stacked ? band - groupPad * 2 : (band - groupPad * 2) / series.length
    labels.forEach((_, i) => {
      let acc = 0
      series.forEach((s, k) => {
        const v = s.values[i] || 0
        const color = colors[k % colors.length]
        const start = stacked ? acc : 0
        const end = stacked ? acc + v : v
        acc = end
        const a = scale(Math.min(start, end))
        const b = scale(Math.max(start, end))
        if (horizontal) {
          const y = top + band * i + groupPad + (stacked ? 0 : k * barSize)
          parts.push(`<rect x="${left + a * plotW}" y="${y}" width="${Math.max(0, (b - a) * plotW)}" height="${barSize}" fill="${color}"/>`)
          if (c.showValues !== false) parts.push(`<text x="${left + b * plotW + 4}" y="${y + barSize / 2 + 4}" font-size="12" fill="#333">${esc(fmt(v, c.valueFormat))}</text>`)
        } else {
          const x = left + band * i + groupPad + (stacked ? 0 : k * barSize)
          parts.push(`<rect x="${x}" y="${top + plotH - b * plotH}" width="${barSize}" height="${Math.max(0, (b - a) * plotH)}" fill="${color}"/>`)
          if (c.showValues !== false && (!stacked || (b - a) * plotH > 16)) {
            const ty = stacked ? top + plotH - ((a + b) / 2) * plotH + 4 : top + plotH - b * plotH - 6
            parts.push(`<text x="${x + barSize / 2}" y="${ty}" font-size="12" text-anchor="middle" fill="${stacked ? '#fff' : '#333'}">${esc(fmt(v, c.valueFormat))}</text>`)
          }
        }
      })
    })
  }
  labels.forEach((label, i) => {
    if (horizontal) parts.push(`<text x="${left - 8}" y="${top + band * (i + 0.5) + 4}" font-size="13" text-anchor="end" fill="#333">${esc(label)}</text>`)
    else parts.push(`<text x="${left + band * (i + 0.5)}" y="${top + plotH + 20}" font-size="13" text-anchor="middle" fill="#333">${esc(label)}</text>`)
  })
  parts.push(`<line x1="${left}" y1="${top + plotH - scale(0) * plotH}" x2="${left + plotW}" y2="${top + plotH - scale(0) * plotH}" stroke="#999"/>`)
  if (legendH) {
    const totalW = series.reduce((s, se) => s + 40 + String(se.name).length * 14, 0)
    let x = (W - totalW) / 2
    const y = H - 18
    series.forEach((s, k) => {
      parts.push(`<rect x="${x}" y="${y - 11}" width="14" height="14" fill="${colors[k % colors.length]}"/>`)
      parts.push(`<text x="${x + 20}" y="${y + 1}" font-size="13" fill="#333">${esc(s.name)}</text>`)
      x += 40 + String(s.name).length * 14
    })
  }
  parts.push('</svg>')
  return parts.join('\n')
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (args.length < 2) fail('用法：node chart_svg.cjs chart.json output.svg')
  const input = safeRel(args[0])
  const output = safeRel(args[1])
  if (!output.toLowerCase().endsWith('.svg')) fail('输出文件需以 .svg 结尾')
  let chart
  try {
    chart = JSON.parse(input === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(input, 'utf8'))
  } catch (e) {
    fail(`chart.json 不是合法 JSON：${e.message}`)
  }
  const svg = render(chart)
  fs.writeFileSync(output, svg)
  process.stdout.write(`已生成 ${output}（${Math.round(svg.length / 1024)} KB）。可用 create_artifact(language=svg) 展示，或插入 Word/PPT。\n`)
}

main()
