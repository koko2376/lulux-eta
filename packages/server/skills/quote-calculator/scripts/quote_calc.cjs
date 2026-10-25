#!/usr/bin/env node
'use strict'
/*
 * 外贸报价计算器（LULUX ETA 原创）：按 Incoterms 2020 从工厂成本逐级推算 EXW / FCA / FOB / CFR / CIF / CPT / CIP / DAP / DDP 报价。
 * 用法：
 *   node quote_calc.cjs input.json            # 读工作区里的 JSON
 *   echo '{...}' | node quote_calc.cjs        # 从标准输入读 JSON
 *   node quote_calc.cjs input.json --out quote-result.json
 * 输出：Markdown 报价明细（stdout）+ 可选 JSON 结果文件（含 create_quote_draft 可直接使用的 items）。
 *
 * 输入 JSON（金额单位见字段名；缺省值见 DEFAULTS）：
 * {
 *   "currency": "USD",                 // 报价币种（USD/EUR/GBP…）
 *   "fx": 7.10,                        // 1 报价币种 = ? 人民币（必填，建议用当天银行现汇买入价并留 1%~2% 缓冲）
 *   "items": [{ "name": "LED Panel 600x600", "spec": "40W 4000K", "qty": 2000, "unit": "pcs",
 *               "costCNY": 52.5,          // 含税采购价/出厂成本（元/件）
 *               "vatIncluded": true,      // costCNY 是否含增值税（影响退税）
 *               "rebateRate": 0.13,       // 出口退税率（按 HS 编码查询，见 hs-code-tax-rebate 技能）
 *               "cbmPerUnit": 0.0085, "kgPerUnit": 1.9 }],
 *   "vatRate": 0.13,                   // 采购发票增值税率
 *   "applyRebate": true,               // 是否把退税计入成本抵减（工厂直接出口/生产企业可退时）
 *   "domestic": { "truckingCNY": 1800, "portChargesCNY": 1200, "customsCNY": 300, "docsCNY": 200, "inspectionCNY": 0, "otherCNY": 0 },
 *   "freight": { "mode": "container", "containers": { "40HQ": 1 }, "ratePerContainer": { "40HQ": 2650 } }
 *            或 { "mode": "lcl", "ratePerCbm": 45, "minCbm": 1 } 或 { "mode": "air", "ratePerKg": 4.2 }（运费以报价币种计）
 *   "destCharges": { "THC": 0, "deliveryToDoor": 650 },    // DAP/DDP：目的港费用与派送（报价币种）
 *   "insurance": { "rate": 0.003, "markup": 1.1 },          // 保险费率与加成（CIF/CIP 按 110% 投保）
 *   "import": { "dutyRate": 0.035, "vatRate": 0.20, "brokerage": 180 },  // DDP：进口关税/增值税（按 CIF 完税价）与清关费
 *   "margin": 0.15,                    // 目标毛利率（按售价计：售价 = 成本 / (1 - 毛利率)）
 *   "terms": ["EXW", "FOB", "CIF", "DDP"],
 *   "port": { "loading": "Ningbo", "destination": "Hamburg" }
 * }
 */
const fs = require('node:fs')

const DEFAULTS = {
  currency: 'USD',
  vatRate: 0.13,
  applyRebate: true,
  margin: 0.15,
  insurance: { rate: 0.003, markup: 1.1 },
  terms: ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'],
}

// FAS 仅适用于散货船边交货，费用结构差异大，不做自动推算
const ORDER = ['EXW', 'FCA', 'FOB', 'CFR', 'CPT', 'CIF', 'CIP', 'DAP', 'DPU', 'DDP']

function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(2)
}

function readInput() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = outIndex >= 0 ? args[outIndex + 1] : null
  const file = args.find((arg, i) => !arg.startsWith('--') && (outIndex < 0 || i !== outIndex + 1))
  let raw = ''
  if (file) {
    if (file.includes('..') || /^([a-zA-Z]:|\/)/.test(file)) fail('只接受工作区内的相对路径')
    raw = fs.readFileSync(file, 'utf8')
  } else {
    raw = fs.readFileSync(0, 'utf8')
  }
  try {
    return { input: JSON.parse(raw), out }
  } catch (error) {
    fail(`输入不是合法 JSON：${error.message}`)
  }
}

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits

function main() {
  const { input, out } = readInput()
  const cfg = { ...DEFAULTS, ...input, insurance: { ...DEFAULTS.insurance, ...(input.insurance || {}) } }
  const fx = num(cfg.fx)
  if (fx <= 0) fail('需要 fx（1 报价币种兑人民币的汇率），例如 7.10')
  if (!Array.isArray(cfg.items) || cfg.items.length === 0) fail('items 不能为空')
  const margin = num(cfg.margin, 0.15)
  if (margin < 0 || margin >= 0.9) fail('margin 应在 0~0.9 之间（按售价计的毛利率）')
  const terms = (Array.isArray(cfg.terms) ? cfg.terms : DEFAULTS.terms).map((t) => String(t).toUpperCase()).filter((t) => ORDER.includes(t))
  const warnings = []

  // 1. 货物成本（人民币）与退税
  let goodsCNY = 0
  let rebateCNY = 0
  let totalCbm = 0
  let totalKg = 0
  const lines = cfg.items.map((item, index) => {
    const qty = num(item.qty)
    const cost = num(item.costCNY)
    if (qty <= 0 || cost <= 0) fail(`第 ${index + 1} 个产品缺少 qty 或 costCNY`)
    const vatIncluded = item.vatIncluded !== false
    const rebateRate = num(item.rebateRate, 0)
    const vatRate = num(item.vatRate, num(cfg.vatRate, 0.13))
    const rebatePerUnit = cfg.applyRebate && vatIncluded && rebateRate > 0 ? (cost / (1 + vatRate)) * Math.min(rebateRate, vatRate) : 0
    if (rebateRate > vatRate) warnings.push(`${item.name}：退税率 ${rebateRate} 高于增值税率 ${vatRate}，已按增值税率封顶`)
    const lineGoods = cost * qty
    goodsCNY += lineGoods
    rebateCNY += rebatePerUnit * qty
    totalCbm += num(item.cbmPerUnit) * qty
    totalKg += num(item.kgPerUnit) * qty
    return { ...item, qty, cost, rebatePerUnit, lineGoods }
  })
  if (totalCbm === 0) warnings.push('未提供 cbmPerUnit：无法校验装柜与拼箱运费，请用 container-loading 技能核算体积')

  const d = cfg.domestic || {}
  const domesticCNY = ['truckingCNY', 'portChargesCNY', 'customsCNY', 'docsCNY', 'inspectionCNY', 'otherCNY'].reduce((s, k) => s + num(d[k]), 0)
  const exwCostCNY = goodsCNY - rebateCNY
  const fobCostCNY = exwCostCNY + domesticCNY

  // 2. 国际运费（报价币种）
  const f = cfg.freight || {}
  let freight = 0
  let freightNote = '未提供运费'
  if (f.mode === 'container') {
    const containers = f.containers || {}
    const rates = f.ratePerContainer || {}
    for (const [type, count] of Object.entries(containers)) {
      if (rates[type] === undefined) warnings.push(`缺少 ${type} 的柜价`)
      freight += num(count) * num(rates[type])
    }
    freightNote = Object.entries(containers).map(([t, c]) => `${c}×${t}@${rates[t] ?? '?'}`).join(' + ')
  } else if (f.mode === 'lcl') {
    const cbm = Math.max(totalCbm, num(f.minCbm, 1))
    freight = cbm * num(f.ratePerCbm) + num(f.fixed)
    freightNote = `拼箱 ${round(cbm, 3)} CBM × ${num(f.ratePerCbm)}${f.fixed ? ` + 固定 ${f.fixed}` : ''}`
  } else if (f.mode === 'air') {
    const volumetric = totalCbm * 167 // 空运体积重 1 CBM = 167 kg（6000 cm³/kg）
    const chargeable = Math.max(totalKg, volumetric)
    freight = chargeable * num(f.ratePerKg) + num(f.fixed)
    freightNote = `空运计费重 ${round(chargeable, 1)} kg × ${num(f.ratePerKg)}`
  } else if (num(f.total) > 0) {
    freight = num(f.total)
    freightNote = '运费总额'
  }
  const needsFreight = terms.some((t) => ['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'].includes(t))
  if (needsFreight && freight === 0) warnings.push('报 CFR/CIF/DAP/DDP 需要运费：请先查询当期运价（见 fx-freight-lookup 技能）')

  // 3. 各术语成本（报价币种，总额）
  const toQ = (cny) => cny / fx
  const costs = {}
  costs.EXW = toQ(exwCostCNY)
  costs.FCA = toQ(exwCostCNY + num(d.truckingCNY) + num(d.customsCNY) + num(d.docsCNY))
  costs.FOB = toQ(fobCostCNY)
  costs.CFR = costs.FOB + freight
  costs.CPT = costs.CFR
  // 投保金额 = CIF × 加成；CIF = CFR / (1 - 加成 × 费率)
  const insRate = num(cfg.insurance.rate)
  const markup = num(cfg.insurance.markup, 1.1)
  costs.CIF = costs.CFR / (1 - markup * insRate)
  costs.CIP = costs.CIF
  const dest = cfg.destCharges || {}
  const destTotal = Object.values(dest).reduce((s, v) => s + num(v), 0)
  costs.DAP = costs.CIF + destTotal
  costs.DPU = costs.DAP + num((cfg.destCharges || {}).unloading)
  const imp = cfg.import || {}
  const dutiable = costs.CIF
  const duty = dutiable * num(imp.dutyRate)
  const importVat = (dutiable + duty) * num(imp.vatRate)
  costs.DDP = costs.DAP + duty + importVat + num(imp.brokerage)
  if (terms.includes('DDP') && imp.dutyRate === undefined) warnings.push('DDP 未提供进口关税税率（import.dutyRate），请按目的国税则核实；DDP 下卖方承担进口税费，风险最大')
  if (terms.includes('DDP') && num(imp.vatRate) > 0) warnings.push('DDP 含进口增值税：卖方通常无法抵扣，需确认是否由买方作为进口商（可考虑 DAP）')

  // 4. 售价 = 成本 / (1 - 毛利率)；按货值占比分摊到每个产品
  const results = terms.map((term) => {
    const cost = costs[term]
    const price = cost / (1 - margin)
    const perItem = lines.map((line) => {
      const share = line.lineGoods / goodsCNY
      const unitPrice = (price * share) / line.qty
      return { name: line.name, spec: line.spec || '', qty: line.qty, unit: line.unit || 'pcs', unitPrice: round(unitPrice, unitPrice < 1 ? 4 : 2) }
    })
    return { term, cost: round(cost), price: round(price), profit: round(price - cost), items: perItem }
  })

  const currency = cfg.currency
  const md = []
  md.push(`## 报价测算（${currency}，汇率 1 ${currency} = ${fx} CNY，目标毛利率 ${round(margin * 100, 1)}%）`)
  md.push('')
  md.push(`- 货值（含税采购）：¥${round(goodsCNY)}；退税抵减：¥${round(rebateCNY)}；国内费用：¥${round(domesticCNY)}`)
  md.push(`- 总体积 ${round(totalCbm, 3)} CBM，总毛重 ${round(totalKg, 1)} kg；运费：${round(freight)} ${currency}（${freightNote}）`)
  if (terms.some((t) => ['CIF', 'CIP'].includes(t))) md.push(`- 保险：费率 ${insRate}，按 ${round(markup * 100)}% 投保，保费 ≈ ${round(costs.CIF - costs.CFR)} ${currency}`)
  if (terms.includes('DDP')) md.push(`- 进口税费（DDP）：关税 ${round(duty)} + 进口增值税 ${round(importVat)} + 清关 ${num(imp.brokerage)} ${currency}`)
  md.push('')
  md.push(`| 术语 | 成本总额 | 报价总额 | 毛利 | ${lines.map((l) => `${l.name} 单价`).join(' | ')} |`)
  md.push(`| --- | ---: | ---: | ---: | ${lines.map(() => '---:').join(' | ')} |`)
  for (const r of results) {
    md.push(`| ${r.term}${cfg.port && ['FOB', 'FCA'].includes(r.term) && cfg.port.loading ? ` ${cfg.port.loading}` : ''}${cfg.port && ['CFR', 'CIF', 'CPT', 'CIP'].includes(r.term) && cfg.port.destination ? ` ${cfg.port.destination}` : ''} | ${r.cost} | ${r.price} | ${r.profit} | ${r.items.map((i) => i.unitPrice).join(' | ')} |`)
  }
  if (warnings.length) {
    md.push('')
    md.push('**注意：**')
    for (const w of warnings) md.push(`- ${w}`)
  }
  md.push('')
  md.push('> 测算结果需人工复核：运价、汇率、退税率与目的国税率均为输入值，请以当期报价与官方税则为准。')
  process.stdout.write(`${md.join('\n')}\n`)

  const result = { currency, fx, margin, totals: { goodsCNY: round(goodsCNY), rebateCNY: round(rebateCNY), domesticCNY: round(domesticCNY), freight: round(freight), cbm: round(totalCbm, 3), kg: round(totalKg, 1) }, quotes: results, warnings }
  if (out) {
    if (out.includes('..') || /^([a-zA-Z]:|\/)/.test(out)) fail('--out 只接受工作区内的相对路径')
    fs.writeFileSync(out, JSON.stringify(result, null, 2))
    process.stdout.write(`\n结果已写入 ${out}\n`)
  }
  process.stdout.write(`\n<!--RESULT_JSON\n${JSON.stringify(result)}\nRESULT_JSON-->\n`)
}

main()
