import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import PDFDocument from 'pdfkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 回归：报价单 / PI / 单证输出与金额精度、汇率精度、日期与单号 */
const here = dirname(fileURLToPath(import.meta.url))
const req = createRequire(import.meta.url)
let server: TestServer
let db: typeof import('../src/db.js')['db']
let customerId = ''
const api = (m: string, p: string, body?: unknown) => server.request(m, p, { body })

beforeAll(async () => {
  server = await startTestServer({ LULUX_PDF_FONT: '' })
  ;({ db } = await import('../src/db.js'))
  const c = await api('POST', '/api/customers', { company: 'Regress Buyer GmbH', country: 'DE', contacts: [{ name: 'Anna', email: 'anna@regress-buyer.example.de' }] })
  expect(c.status, c.text).toBe(201)
  customerId = c.json.id
})
afterAll(async () => server?.close())

/** 抓 PDF 里写出的所有文字 */
async function pdfTexts(path: string): Promise<{ status: number; texts: string[] }> {
  const texts: string[] = []
  const proto = PDFDocument.prototype as unknown as { text: (...a: unknown[]) => unknown }
  const orig = proto.text
  const spy = vi.spyOn(proto, 'text').mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'string') texts.push(args[0])
    return orig.apply(this, args)
  })
  const res = await server.request('GET', path)
  spy.mockRestore()
  return { status: res.status, texts }
}

function loadTradeDocs(): { amountInWords: (a: number, c: string) => string } {
  const src = readFileSync(join(here, '../skills/trade-documents/scripts/trade_docs.cjs'), 'utf8')
  const body = src.replace(/^#!.*\n/, '').replace(/main\(\)\.catch[^\n]*\n?$/, '')
  // eslint-disable-next-line no-new-func
  return new Function('require', 'process', `${body}\nreturn { amountInWords }`)(req, process) as { amountInWords: (a: number, c: string) => string }
}

describe('单价按实际精度印出（最少 2 位、最多 4 位），数量 × 单价 = 金额', () => {
  it('formatUnitPrice / lineAmount / sumLines', async () => {
    const { formatUnitPrice, lineAmount, sumLines, formatMoney } = await import('../src/utils/money.js')
    expect(formatUnitPrice(0.0875)).toBe('0.0875')
    expect(formatUnitPrice(0.1)).toBe('0.10')
    expect(formatUnitPrice(12.5)).toBe('12.50')
    expect(formatUnitPrice(3)).toBe('3.00')
    expect(formatUnitPrice(1234.5678)).toBe('1,234.5678')
    expect(formatUnitPrice(0.123456)).toBe('0.1235')
    expect(lineAmount(5000, 0.0875)).toBe(437.5)
    expect(lineAmount(3, 0.665)).toBe(2)
    expect(sumLines([{ qty: 1, unitPrice: 0.005 }, { qty: 1, unitPrice: 0.005 }])).toBe(0.02)
    expect(formatMoney(437.5)).toBe('437.50')
  })

  it('报价引擎给出 4 位单价：HTML / PDF 都按 4 位印，行金额等于 数量 × 印出的单价；不出现成本、毛利、汇率', async () => {
    const calc = await api('POST', '/api/pricing/calculate', { items: [{ name: 'Washer M6', qty: 10000, unitCost: 0.6, costCurrency: 'CNY' }], quoteCurrency: 'USD', incoterm: 'EXW', fx: { 'USD/CNY': 7.1 }, pricing: { marginPct: 20 } })
    expect(calc.status, calc.text).toBe(200)
    const unitPrice = calc.json.items[0].unitPrice as number
    expect(unitPrice).toBeLessThan(1)
    expect(String(unitPrice).split('.')[1]!.length).toBeGreaterThan(2)
    const q = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm: 'EXW', items: calc.json.quoteItems })
    expect(q.status, q.text).toBe(201)
    const shown = unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    const amount = (Math.round(10000 * unitPrice * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    expect(Number(shown) * 10000).toBeCloseTo(Number(amount.replace(/,/g, '')), 6)

    const html = (await api('GET', `/api/quotes/${q.json.id}/html`)).text
    expect(html).toContain(`<td class="num">${shown}</td>`)
    expect(html).toContain(`<td class="num">${amount}</td>`)
    expect(html).toContain(`USD ${amount}`) // 合计 = 行金额相加
    const pdf = await pdfTexts(`/api/quotes/${q.json.id}/pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.texts).toContain(shown)
    expect(pdf.texts).toContain(amount)

    // 对外单证绝不能出现成本 / 毛利 / 汇率
    const unitCost = String(calc.json.items[0].unitCost)
    for (const out of [html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/ style="[^"]*"/g, ''), pdf.texts.join('\n')]) {
      expect(out).not.toMatch(/margin|markup|unit ?cost|毛利|成本|汇率|USD\/CNY|7\.1\b/i)
      expect(out).not.toContain(unitCost)
    }
  })

  it('商业发票：单价 0.0875 按 4 位印，金额 437.50；FCA 术语后面印起运地', async () => {
    const q = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm: 'FCA', port: 'Ningbo', items: [{ name: 'Clip', qty: 5000, unit: 'pcs', unitPrice: 0.0875 }] })
    expect(q.status, q.text).toBe(201)
    const o = await api('POST', `/api/quotes/${q.json.id}/order`, {})
    expect(o.status, o.text).toBeLessThan(300)
    const oid = o.json.id
    expect(o.json.shipment.portOfLoading).toBe('Ningbo')
    expect((await api('PATCH', `/api/orders/${oid}`, { portOfDischarge: 'Hamburg', vessel: 'MSC X' })).status).toBe(200)
    const d = await api('PATCH', `/api/orders/${oid}/docs`, {
      shipper: { name: 'Wenzhou Regress Co', address: 'Longgang, Wenzhou, Zhejiang, China' },
      consignee: { address: 'Hafenstrasse 1, 20457 Hamburg, Germany' },
      lines: [{ itemIndex: 0, hsCode: '7318220000', cartons: 10, netKg: 50, grossKg: 55, cbm: 0.5 }],
    })
    expect(d.status, d.text).toBe(200)
    const pdf = await pdfTexts(`/api/orders/${oid}/docs/ci`)
    expect(pdf.status).toBe(200)
    expect(pdf.texts).toContain('0.0875')
    expect(pdf.texts).not.toContain('0.09')
    expect(pdf.texts).toContain('437.50')
    expect(pdf.texts).toContain('FCA Ningbo')
    expect(pdf.texts).not.toContain('FCA Hamburg')
  })

  it('FAS 同样印起运地；CIF 印目的地', async () => {
    for (const [incoterm, expected] of [['FAS', 'FAS Ningbo'], ['CIF', 'CIF Hamburg']] as const) {
      const q = await api('POST', '/api/quotes', { customerId, currency: 'USD', incoterm, port: incoterm === 'CIF' ? 'Hamburg' : 'Ningbo', items: [{ name: 'Clip', qty: 10, unit: 'pcs', unitPrice: 1 }] })
      const o = await api('POST', `/api/quotes/${q.json.id}/order`, {})
      const oid = o.json.id
      await api('PATCH', `/api/orders/${oid}`, incoterm === 'CIF' ? { portOfLoading: 'Ningbo' } : { portOfDischarge: 'Hamburg' })
      const d = await api('PATCH', `/api/orders/${oid}/docs`, { shipper: { name: 'Shipper Co', address: 'Wenzhou, China' }, consignee: { address: 'Hamburg, Germany' }, lines: [{ itemIndex: 0, hsCode: '7318220000', cartons: 1, netKg: 1, grossKg: 1, cbm: 0.1 }] })
      expect(d.status, d.text).toBe(200)
      const pdf = await pdfTexts(`/api/orders/${oid}/docs/ci`)
      expect(pdf.status, incoterm).toBe(200)
      expect(pdf.texts, incoterm).toContain(expected)
    }
  })
})

describe('交叉汇率全精度计算，只在显示时舍入', () => {
  it('1 635 000 IDR = 100.00 USD（不再因汇率先舍到 6 位小数而少算）', async () => {
    const now = Date.now()
    db.prepare('DELETE FROM fx_rates').run()
    db.prepare("INSERT INTO fx_rates (base, quote, rate, source, as_of, fetched_at) VALUES ('USD','IDR',16350,'frankfurter','2026-10-23',?)").run(now)
    db.prepare("INSERT INTO fx_rates (base, quote, rate, source, as_of, fetched_at) VALUES ('USD','CNY',7.1,'frankfurter','2026-10-23',?)").run(now)
    const calc = await api('POST', '/api/pricing/calculate', { items: [{ name: 'Rattan chair', qty: 100, unitCost: 1_635_000, costCurrency: 'IDR' }], quoteCurrency: 'USD', incoterm: 'EXW', pricing: { markupPct: 0 } })
    expect(calc.status, calc.text).toBe(200)
    expect(calc.json.items[0].unitCost).toBeCloseTo(100, 6)
    // 展示用 6 位有效数字
    expect(calc.json.fx[0].rate).toBe(0.0000611621)
    const { fxService } = await import('../src/services/pricing/fx-service.js')
    const r = await fxService.rate('IDR', 'USD')
    expect(r.rate).toBe(1 / 16350)
    expect(r.displayRate).toBe(0.0000611621)
    expect((await fxService.convert(1_635_000, 'IDR', 'USD')).amount).toBe(100)
  })
})

describe('trade-documents 技能脚本：金额大写与合计', () => {
  it('先换成整数分：0.995 → ONE；1.995 → TWO；从不出现 CENTS ONE HUNDRED', () => {
    const { amountInWords } = loadTradeDocs()
    expect(amountInWords(0.995, 'USD')).toBe('SAY US DOLLARS ONE ONLY')
    expect(amountInWords(3 * 0.665, 'USD')).toBe('SAY US DOLLARS TWO ONLY')
    expect(amountInWords(12345.67, 'USD')).toBe('SAY US DOLLARS TWELVE THOUSAND THREE HUNDRED AND FORTY-FIVE AND CENTS SIXTY-SEVEN ONLY')
    for (const v of [0.995, 1.995, 99.995, 1234.995]) expect(amountInWords(v, 'USD')).not.toContain('CENTS ONE HUNDRED')
  })

  it('合计 = 各行两位舍入后的金额相加；单价最多 4 位；默认日期用本机日期', () => {
    const src = readFileSync(join(here, '../skills/trade-documents/scripts/trade_docs.cjs'), 'utf8')
    const body = src.replace(/^#!.*\n/, '').replace(/main\(\)\.catch[^\n]*\n?$/, '')
    // eslint-disable-next-line no-new-func
    const fns = new Function('require', 'process', `${body}\nreturn { lineAmount, unitPriceText, round2 }`)(req, process) as {
      lineAmount: (it: { qty: number; unitPrice: number }) => number
      unitPriceText: (v: number) => string
      round2: (v: number) => number
    }
    const items = [
      { qty: 1, unitPrice: 0.005 },
      { qty: 1, unitPrice: 0.005 },
      { qty: 3, unitPrice: 0.665 },
    ]
    const total = fns.round2(items.reduce((s, it) => s + fns.lineAmount(it), 0))
    expect(total).toBe(2.02)
    expect(fns.unitPriceText(0.0875)).toBe('0.0875')
    expect(fns.unitPriceText(2)).toBe('2.00')
    expect(src).not.toContain('toISOString().slice(0, 10)')
  })
})

describe('日期校验拒绝不存在的日期', () => {
  it('报价有效期 2026-02-30 → 400；2026-02-28 正常', async () => {
    const bad = await api('POST', '/api/quotes', { customerId, validUntil: '2026-02-30', items: [{ name: 'X', qty: 1, unitPrice: 1 }] })
    expect(bad.status).toBe(400)
    const ok = await api('POST', '/api/quotes', { customerId, validUntil: '2026-02-28', items: [{ name: 'X', qty: 1, unitPrice: 1 }] })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.json.validUntil).toBe('2026-02-28')
  })

  it('isRealIsoDate', async () => {
    const { isRealIsoDate } = await import('../src/utils/dates.js')
    expect(isRealIsoDate('2026-02-30')).toBe(false)
    expect(isRealIsoDate('2026-13-01')).toBe(false)
    expect(isRealIsoDate('2028-02-29')).toBe(true)
    expect(isRealIsoDate('2026-2-3')).toBe(false)
  })
})

describe('报价单日期与单号统一用本机时区', () => {
  it('UTC+8 本机 2026-10-24 07:00 建的报价：报价单 HTML 与 PDF 上的 Date 都是 2026-10-24', async () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'Asia/Shanghai'
    try {
      const q = await api('POST', '/api/quotes', { customerId, number: 'Q-20261024-777', items: [{ name: 'X', qty: 1, unitPrice: 1 }] })
      expect(q.status, q.text).toBe(201)
      const at = Date.UTC(2026, 9, 23, 23, 0) // 2026-10-24 07:00 CST
      db.prepare('UPDATE quotes SET created_at = ? WHERE id = ?').run(at, q.json.id)
      expect(new Date(at).getDate()).toBe(24)
      const html = (await api('GET', `/api/quotes/${q.json.id}/html`)).text
      expect(html).toContain('Date: 2026-10-24')
      const pdf = await pdfTexts(`/api/quotes/${q.json.id}/pdf`)
      expect(pdf.texts).toContain('Date: 2026-10-24')
    } finally {
      process.env.TZ = prevTz
    }
  })
})

describe('同一天超过 999 张，单号自动扩位', () => {
  const stampOf = () => {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  }

  it('报价单：已有 -999 和 -1000 时，下一张是 -1001', async () => {
    const stamp = stampOf()
    for (const n of ['999', '1000']) {
      const r = await api('POST', '/api/quotes', { customerId, number: `Q-${stamp}-${n}`, items: [] })
      expect(r.status, r.text).toBe(201)
    }
    const next = await api('POST', '/api/quotes', { customerId, items: [] })
    expect(next.status, next.text).toBe(201)
    expect(next.json.number).toBe(`Q-${stamp}-1001`)
  })

  it('订单：已有 -999 和 -1000 时，下一张是 -1001', async () => {
    const stamp = stampOf()
    const now = Date.now()
    const ins = db.prepare(`INSERT INTO orders (id, number, customer_id, currency, amount, items, incoterm, payment_terms, deposit_amount, due_date, status, notes, org_id, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, 'USD', 1, '[]', 'FOB', '', 0, '', 'pending_production', '', 'local', 'local', ?, ?)`)
    ins.run('ord_n999', `SO-${stamp}-999`, customerId, now, now)
    ins.run('ord_n1000', `SO-${stamp}-1000`, customerId, now, now)
    const q = await api('POST', '/api/quotes', { customerId, currency: 'USD', items: [{ name: 'X', qty: 1, unitPrice: 1 }] })
    const o = await api('POST', `/api/quotes/${q.json.id}/order`, {})
    expect(o.status, o.text).toBeLessThan(300)
    expect(o.json.number).toBe(`SO-${stamp}-1001`)
  })
})
