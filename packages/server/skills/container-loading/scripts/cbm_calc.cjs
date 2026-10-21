#!/usr/bin/env node
'use strict'
/*
 * 装柜与体积计算（LULUX ETA 原创）。
 * 用法：node cbm_calc.cjs cartons.json [--efficiency 0.85] [--out loading.json]   或   echo '{...}' | node cbm_calc.cjs
 * 输入：
 * {
 *   "cartons": [
 *     { "name": "LED Panel", "length": 62, "width": 62, "height": 12, "unit": "cm",   // 外箱尺寸
 *       "grossKg": 9.8, "count": 500,                                                  // 每箱毛重、箱数
 *       "upright": false,                                                              // true = 只能正放（不可侧放/倒置）
 *       "maxStackKg": null }                                                           // 可承受的上方重量（可选）
 *   ],
 *   "efficiency": 0.85,          // 装载率（实际可用体积占柜内容积的比例，杂货 80%~90%）
 *   "pallet": null               // 打托：{ "length":120, "width":100, "height":15, "kg":25, "maxHeight":180, "perPallet": 24 }
 * }
 * 输出：总体积/毛重、各柜型装载率、推荐柜型组合、按单一品种的理论装箱数（考虑 6 种摆放方向的整层排列）。
 */
const fs = require('node:fs')

// 内尺寸（cm）与常用限重（kg）。限重为常见船公司/道路限制的保守值，实际以订舱确认为准。
const CONTAINERS = {
  '20GP': { l: 589.8, w: 235.2, h: 239.3, cbm: 33.2, payload: 21700, label: "20' 普柜" },
  '40GP': { l: 1203.2, w: 235.2, h: 239.3, cbm: 67.7, payload: 26500, label: "40' 普柜" },
  '40HQ': { l: 1203.2, w: 235.2, h: 269.8, cbm: 76.3, payload: 26500, label: "40' 高柜" },
  '45HQ': { l: 1355.6, w: 235.2, h: 269.8, cbm: 86.0, payload: 27600, label: "45' 高柜" },
}

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const round = (v, n = 2) => Math.round((v + Number.EPSILON) * 10 ** n) / 10 ** n

function readInput() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const skip = new Set()
  ;['--efficiency', '--out'].forEach((name) => {
    const i = args.indexOf(name)
    if (i >= 0) skip.add(i).add(i + 1)
  })
  const file = args.find((a, i) => !skip.has(i) && !a.startsWith('--'))
  const safe = (p) => {
    if (p && (p.includes('..') || /^([a-zA-Z]:|\/)/.test(p))) fail('只接受工作区内的相对路径')
    return p
  }
  const raw = file ? fs.readFileSync(safe(file), 'utf8') : fs.readFileSync(0, 'utf8')
  let input
  try {
    input = JSON.parse(raw)
  } catch (e) {
    fail(`输入不是合法 JSON：${e.message}`)
  }
  if (opt('--efficiency')) input.efficiency = Number(opt('--efficiency'))
  return { input, out: safe(opt('--out')) }
}

function toCm(value, unit) {
  if (unit === 'mm') return value / 10
  if (unit === 'm') return value * 100
  if (unit === 'in' || unit === 'inch') return value * 2.54
  return value
}

/** 单一品种整层排列：尝试允许的摆放方向，取能装的最大箱数 */
function fitCount(box, container, upright) {
  const dims = [box.l, box.w, box.h]
  const orientations = upright
    ? [[box.l, box.w, box.h], [box.w, box.l, box.h]]
    : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map((o) => o.map((i) => dims[i]))
  let best = { count: 0, orientation: null, grid: null }
  for (const [a, b, c] of orientations) {
    const nx = Math.floor(container.l / a)
    const ny = Math.floor(container.w / b)
    const nz = Math.floor(container.h / c)
    let count = nx * ny * nz
    // 剩余长度段换一种方向再排一次（常见的“混合摆放”提升）
    const restL = container.l - nx * a
    if (restL > 0) {
      const alt = Math.floor(restL / b) * Math.floor(container.w / a) * nz
      if (b !== a && alt > 0) count += alt
    }
    if (count > best.count) best = { count, orientation: [a, b, c], grid: [nx, ny, nz] }
  }
  return best
}

function main() {
  const { input, out } = readInput()
  const cartons = Array.isArray(input.cartons) ? input.cartons : []
  if (cartons.length === 0) fail('cartons 不能为空')
  const efficiency = Math.min(0.98, Math.max(0.5, num(input.efficiency, 0.85)))
  let totalCbm = 0
  let totalKg = 0
  let totalCartons = 0
  const rows = cartons.map((c, i) => {
    const unit = c.unit || 'cm'
    const box = { l: toCm(num(c.length), unit), w: toCm(num(c.width), unit), h: toCm(num(c.height), unit) }
    if (!box.l || !box.w || !box.h) fail(`第 ${i + 1} 种箱子缺少长宽高`)
    const count = Math.max(0, Math.round(num(c.count, 1)))
    const cbm = (box.l * box.w * box.h) / 1e6
    const volKg = cbm * 167
    totalCbm += cbm * count
    totalKg += num(c.grossKg) * count
    totalCartons += count
    const fits = Object.fromEntries(Object.entries(CONTAINERS).map(([type, ct]) => [type, fitCount(box, ct, Boolean(c.upright))]))
    return { name: c.name || `箱型${i + 1}`, box, count, cbm, grossKg: num(c.grossKg), volKg, fits }
  })

  // 打托：体积按托盘外形计算
  let palletNote = ''
  if (input.pallet && rows.length === 1) {
    const p = input.pallet
    const per = Math.max(1, num(p.perPallet, 1))
    const pallets = Math.ceil(rows[0].count / per)
    const pCbm = (toCm(num(p.length, 120), 'cm') * toCm(num(p.width, 100), 'cm') * toCm(num(p.maxHeight, 160), 'cm')) / 1e6
    totalCbm = pallets * pCbm
    totalKg += pallets * num(p.kg, 25)
    palletNote = `打托 ${pallets} 托（每托 ${per} 箱），按托盘外形计 ${round(totalCbm, 2)} CBM`
  }

  const usage = Object.entries(CONTAINERS).map(([type, ct]) => {
    const usable = ct.cbm * efficiency
    const byVol = totalCbm / usable
    const byKg = totalKg / ct.payload
    return { type, label: ct.label, usableCbm: round(usable, 1), volumePct: round((totalCbm / ct.cbm) * 100, 1), weightPct: round(byKg * 100, 1), needed: Math.max(1, Math.ceil(Math.max(byVol, byKg))) }
  })

  // 推荐：在 20GP/40GP/40HQ 中找总成本指数最低的组合（以 40HQ 运价≈1.0、40GP≈0.95、20GP≈0.6 作为相对权重，仅供比较）
  const weight = { '20GP': 0.6, '40GP': 0.95, '40HQ': 1.0 }
  let best = null
  for (let hq = 0; hq <= 20; hq += 1) {
    for (let gp40 = 0; gp40 <= 2; gp40 += 1) {
      for (let gp20 = 0; gp20 <= 2; gp20 += 1) {
        if (hq + gp40 + gp20 === 0) continue
        const cap = hq * CONTAINERS['40HQ'].cbm * efficiency + gp40 * CONTAINERS['40GP'].cbm * efficiency + gp20 * CONTAINERS['20GP'].cbm * efficiency
        const kgCap = hq * CONTAINERS['40HQ'].payload + gp40 * CONTAINERS['40GP'].payload + gp20 * CONTAINERS['20GP'].payload
        if (cap < totalCbm || kgCap < totalKg) continue
        const cost = hq * weight['40HQ'] + gp40 * weight['40GP'] + gp20 * weight['20GP']
        if (!best || cost < best.cost - 1e-9) best = { hq, gp40, gp20, cost, fill: totalCbm / cap }
      }
    }
  }
  const lclAdvice = totalCbm < 15 ? `体积 ${round(totalCbm, 2)} CBM：通常低于 15 CBM 走拼箱（LCL）更划算，接近 20 CBM 时比较整柜与拼箱的总价` : ''
  const heavy = totalKg / Math.max(totalCbm, 0.001) > 400

  const md = []
  md.push('## 装柜测算')
  md.push(`- 总箱数 ${totalCartons}，总体积 **${round(totalCbm, 3)} CBM**，总毛重 **${round(totalKg, 1)} kg**（装载率按 ${Math.round(efficiency * 100)}% 计）`)
  if (palletNote) md.push(`- ${palletNote}`)
  if (lclAdvice) md.push(`- ${lclAdvice}`)
  if (heavy) md.push('- 货物密度高（> 400 kg/CBM）：可能先到重量上限，20GP 装重货更常见；注意各国道路限重')
  md.push('')
  md.push('| 柜型 | 可用体积 | 体积占用 | 重量占用 | 需要柜数 |')
  md.push('| --- | ---: | ---: | ---: | ---: |')
  for (const u of usage) md.push(`| ${u.type}（${u.label}） | ${u.usableCbm} CBM | ${u.volumePct}% | ${u.weightPct}% | ${u.needed} |`)
  if (best) {
    const parts = [best.hq ? `${best.hq}×40HQ` : '', best.gp40 ? `${best.gp40}×40GP` : '', best.gp20 ? `${best.gp20}×20GP` : ''].filter(Boolean)
    md.push('')
    md.push(`**推荐组合：${parts.join(' + ')}**（综合装载率约 ${round(best.fill * 100, 1)}%；以 40HQ 运价为 1、40GP≈0.95、20GP≈0.6 作相对比较，请用实际运价复核）`)
  }
  md.push('')
  md.push('### 单一品种理论装箱数（整齐码放，未计托盘与加固空间）')
  md.push('| 品名 | 外箱 (cm) | 单箱 CBM | 20GP | 40GP | 40HQ |')
  md.push('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const r of rows) {
    md.push(`| ${r.name} | ${round(r.box.l, 1)}×${round(r.box.w, 1)}×${round(r.box.h, 1)} | ${round(r.cbm, 4)} | ${r.fits['20GP'].count} | ${r.fits['40GP'].count} | ${r.fits['40HQ'].count} |`)
  }
  md.push('')
  md.push('> 理论值通常比实际多 5%~10%：箱子变形、留缝、加固与叉车作业都会占空间。以订舱确认的限重与装箱单为准。')
  process.stdout.write(`${md.join('\n')}\n`)
  const result = { totalCartons, totalCbm: round(totalCbm, 3), totalKg: round(totalKg, 1), efficiency, usage, recommendation: best, cartons: rows.map((r) => ({ name: r.name, cbm: round(r.cbm, 4), fits: Object.fromEntries(Object.entries(r.fits).map(([k, v]) => [k, v.count])) })) }
  if (out) {
    fs.writeFileSync(out, JSON.stringify(result, null, 2))
    process.stdout.write(`\n结果已写入 ${out}\n`)
  }
}

main()
