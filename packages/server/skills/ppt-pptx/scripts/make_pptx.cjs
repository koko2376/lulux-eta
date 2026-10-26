#!/usr/bin/env node
'use strict'
/*
 * 生成 PowerPoint（.pptx）（LULUX ETA 原创，基于 npm 包 pptxgenjs，MIT）。
 * 用法：node make_pptx.cjs deck.json output.pptx
 * deck.json：
 * {
 *   "title": "2027 欧洲市场开拓计划", "author": "销售部",
 *   "theme": { "primary": "1F4E79", "accent": "F4B183", "font": "Microsoft YaHei", "background": "FFFFFF" },
 *   "slides": [
 *     { "layout": "title", "title": "…", "subtitle": "…" },
 *     { "layout": "section", "title": "一、市场概况" },
 *     { "layout": "bullets", "title": "…", "bullets": ["要点", ["二级要点", "二级要点"], "要点"], "notes": "演讲备注" },
 *     { "layout": "two-column", "title": "…", "left": { "heading": "优势", "bullets": [] }, "right": { "heading": "风险", "bullets": [] } },
 *     { "layout": "table", "title": "…", "table": { "headers": ["市场", "金额"], "rows": [["德国", "120k"]] } },
 *     { "layout": "chart", "title": "…", "chart": { "type": "bar|line|pie|doughnut", "labels": ["Q1","Q2"], "series": [{ "name": "出口额", "values": [12, 15] }] } },
 *     { "layout": "kpi", "title": "…", "kpis": [{ "value": "+12%", "label": "同比增长" }] },
 *     { "layout": "image", "title": "…", "image": "相对路径.png", "caption": "…" }
 *   ]
 * }
 */
const fs = require('node:fs')

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}
let PptxGenJS
try {
  PptxGenJS = require('pptxgenjs')
} catch {
  fail('缺少依赖 pptxgenjs：LULUX 会在首次运行时自动安装；若手动运行请先 npm i pptxgenjs')
}

function safeRel(p) {
  if (!p) return p
  if (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p)) fail('只接受工作区内的相对路径')
  return p
}

const W = 13.333
const H = 7.5

function bulletRuns(items, theme, size = 20) {
  const runs = []
  const walk = (list, level) => {
    for (const item of list) {
      if (Array.isArray(item)) walk(item, level + 1)
      else runs.push({ text: String(item), options: { bullet: level === 0 ? true : { indent: 18 }, indentLevel: level, fontSize: level ? size - 3 : size, color: level ? '404040' : '222222', fontFace: theme.font, breakLine: true, paraSpaceAfter: 6 } })
    }
  }
  walk(items || [], 0)
  return runs.length ? runs : [{ text: ' ', options: {} }]
}

function titleBar(slide, text, theme) {
  slide.addShape('rect', { x: 0, y: 0, w: W, h: 0.12, fill: { color: theme.primary }, line: { color: theme.primary } })
  slide.addText(text || '', { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontSize: 28, bold: true, color: theme.primary, fontFace: theme.font })
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (args.length < 2) fail('用法：node make_pptx.cjs deck.json output.pptx')
  const [input, output] = args.map(safeRel)
  if (!output.toLowerCase().endsWith('.pptx')) fail('输出文件需以 .pptx 结尾')
  let deck
  try {
    deck = JSON.parse(fs.readFileSync(input, 'utf8'))
  } catch (e) {
    fail(`deck.json 不是合法 JSON：${e.message}`)
  }
  const theme = { primary: '1F4E79', accent: 'F4B183', font: 'Microsoft YaHei', background: 'FFFFFF', ...(deck.theme || {}) }
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = deck.author || 'LULUX ETA'
  pptx.title = deck.title || ''
  const slides = Array.isArray(deck.slides) ? deck.slides : []
  if (slides.length === 0) fail('slides 不能为空')
  slides.forEach((s, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: theme.background }
    const layout = s.layout || (s.bullets ? 'bullets' : 'title')
    if (layout === 'title') {
      slide.background = { color: theme.primary }
      slide.addText(s.title || deck.title || '', { x: 0.8, y: 2.4, w: W - 1.6, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: theme.font })
      if (s.subtitle) slide.addText(s.subtitle, { x: 0.8, y: 3.9, w: W - 1.6, h: 0.8, fontSize: 20, color: 'E7E6E6', fontFace: theme.font })
      slide.addShape('rect', { x: 0.8, y: 3.8, w: 2.2, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } })
    } else if (layout === 'section') {
      slide.addShape('rect', { x: 0, y: 0, w: 0.35, h: H, fill: { color: theme.accent }, line: { color: theme.accent } })
      slide.addText(s.title || '', { x: 1, y: 2.8, w: W - 2, h: 1.2, fontSize: 36, bold: true, color: theme.primary, fontFace: theme.font })
      if (s.subtitle) slide.addText(s.subtitle, { x: 1, y: 4, w: W - 2, h: 0.7, fontSize: 18, color: '595959', fontFace: theme.font })
    } else {
      titleBar(slide, s.title, theme)
      const body = { x: 0.7, y: 1.45, w: W - 1.4, h: H - 2.1 }
      if (layout === 'bullets') {
        slide.addText(bulletRuns(s.bullets, theme), { ...body, valign: 'top' })
      } else if (layout === 'two-column') {
        const col = (side, x) => {
          const part = s[side] || {}
          if (part.heading) slide.addText(part.heading, { x, y: body.y, w: body.w / 2 - 0.2, h: 0.6, fontSize: 22, bold: true, color: theme.primary, fontFace: theme.font })
          slide.addText(bulletRuns(part.bullets, theme, 18), { x, y: body.y + 0.7, w: body.w / 2 - 0.2, h: body.h - 0.7, valign: 'top' })
        }
        col('left', body.x)
        col('right', body.x + body.w / 2 + 0.2)
      } else if (layout === 'table') {
        const t = s.table || {}
        const head = (t.headers || []).map((h) => ({ text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: theme.primary } } }))
        const rows = (t.rows || []).map((r, i) => r.map((c) => ({ text: String(c ?? ''), options: { fill: { color: i % 2 ? 'F2F2F2' : 'FFFFFF' } } })))
        slide.addTable([head, ...rows], { ...body, h: undefined, fontSize: 14, fontFace: theme.font, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' }, autoPage: true })
      } else if (layout === 'chart') {
        const c = s.chart || {}
        const types = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie, doughnut: pptx.ChartType.doughnut, area: pptx.ChartType.area }
        const type = types[c.type] || pptx.ChartType.bar
        const data = (c.series || []).map((se) => ({ name: se.name, labels: c.labels || [], values: se.values || [] }))
        slide.addChart(type, data, { ...body, showLegend: data.length > 1 || type === pptx.ChartType.pie, legendPos: 'b', showValue: c.showValue !== false, dataLabelFontSize: 11, catAxisLabelFontFace: theme.font, chartColors: c.colors || [theme.primary, theme.accent, '70AD47', 'FFC000', '5B9BD5'], barDir: c.horizontal ? 'bar' : 'col' })
      } else if (layout === 'kpi') {
        const kpis = (s.kpis || []).slice(0, 4)
        const w = body.w / Math.max(1, kpis.length)
        kpis.forEach((k, i) => {
          const x = body.x + i * w
          slide.addShape('roundRect', { x: x + 0.1, y: 2.2, w: w - 0.2, h: 2.6, fill: { color: 'F2F2F2' }, line: { color: 'D9D9D9' }, rectRadius: 0.1 })
          slide.addText(String(k.value ?? ''), { x: x + 0.1, y: 2.5, w: w - 0.2, h: 1.2, fontSize: 40, bold: true, color: theme.primary, align: 'center', fontFace: theme.font })
          slide.addText(String(k.label ?? ''), { x: x + 0.1, y: 3.8, w: w - 0.2, h: 0.7, fontSize: 16, color: '595959', align: 'center', fontFace: theme.font })
        })
      } else if (layout === 'image') {
        const img = safeRel(s.image)
        if (img && fs.existsSync(img)) slide.addImage({ path: img, x: body.x, y: body.y, w: body.w, h: body.h - 0.6, sizing: { type: 'contain', w: body.w, h: body.h - 0.6 } })
        else slide.addText(`（找不到图片 ${s.image || ''}）`, { ...body, color: '999999' })
        if (s.caption) slide.addText(s.caption, { x: body.x, y: H - 1.1, w: body.w, h: 0.5, fontSize: 14, color: '595959', align: 'center', fontFace: theme.font })
      } else {
        slide.addText(String(s.text || ''), { ...body, fontSize: 18, fontFace: theme.font, valign: 'top' })
      }
      slide.addText(`${index + 1}`, { x: W - 1, y: H - 0.5, w: 0.6, h: 0.3, fontSize: 10, color: '999999', align: 'right' })
    }
    if (s.notes) slide.addNotes(String(s.notes))
  })
  pptx.writeFile({ fileName: output }).then(
    () => process.stdout.write(`已生成 ${output}（${slides.length} 页）\n`),
    (error) => fail(error.message),
  )
}

main()
