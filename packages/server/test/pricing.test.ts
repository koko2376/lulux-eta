import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 报价引擎：汇率（缓存 / 主备源 / 旧数据兜底 / 锁汇 / 并发合并）、运价表、报价计算。
 * fetchWithProxy 全部替换成假实现，绝不访问网络。
 */

type HttpModule = typeof import('../src/services/http-client.js')
let server: TestServer
let http: HttpModule
let dbModule: typeof import('../src/db.js')

const FRANK = { amount: 1, base: 'USD', date: '2026-10-23', rates: { CNY: 7, EUR: 0.875, GBP: 0.75 } }
const ERAPI = { result: 'success', time_last_update_unix: 1792800151, rates: { USD: 1, CNY: 7.2, EUR: 0.9, GBP: 0.8 } }

function stubFx(opts: { frank?: 'ok' | 'fail'; erapi?: 'ok' | 'fail'; delayMs?: number } = {}) {
  const urls: string[] = []
  const spy = vi.spyOn(http, 'fetchWithProxy').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    if (url.includes('frankfurter')) {
      return (opts.frank ?? 'ok') === 'ok' ? Response.json(FRANK) : new Response('down', { status: 503 })
    }
    if (url.includes('er-api')) {
      return (opts.erapi ?? 'ok') === 'ok' ? Response.json(ERAPI) : new Response('down', { status: 503 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as HttpModule['fetchWithProxy'])
  return { spy, urls }
}

const req = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const setSetting = (patch: Record<string, unknown>) => req('PATCH', '/api/settings', patch)
const clearFx = () => dbModule.db.prepare('DELETE FROM fx_rates').run()
const backdateFx = (ms: number) => dbModule.db.prepare('UPDATE fx_rates SET fetched_at = fetched_at - ?').run(ms)
const HOUR = 3_600_000

beforeAll(async () => {
  server = await startTestServer()
  http = await import('../src/services/http-client.js')
  dbModule = await import('../src/db.js')
}, 60_000)

afterAll(async () => {
  await server?.close()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await setSetting({ fxLocks: '{}', fxSource: 'auto' })
})

describe('汇率', () => {
  it('Frankfurter 成功：交叉汇率正确，6 小时内不再请求', async () => {
    clearFx()
    const { urls } = stubFx()
    const first = await req('GET', '/api/fx/rates?base=CNY&symbols=EUR,USD')
    expect(first.status, first.text).toBe(200)
    const eur = first.json.rates.find((item: any) => item.to === 'EUR')
    expect(eur.rate).toBeCloseTo(0.875 / 7, 6)
    expect(eur.source).toBe('frankfurter')
    expect(eur.asOf).toBe('2026-10-23')
    const usd = first.json.rates.find((item: any) => item.to === 'USD')
    expect(usd.rate).toBeCloseTo(1 / 7, 6)
    expect(urls).toHaveLength(1)
    backdateFx(5 * HOUR)
    await req('GET', '/api/fx/rates?base=USD&symbols=GBP')
    expect(urls).toHaveLength(1)
  })

  it('过期后主源失败 → 用备源；两者都失败 → 旧数据 stale', async () => {
    clearFx()
    stubFx()
    await req('GET', '/api/fx/rates?base=USD&symbols=CNY')
    vi.restoreAllMocks()
    backdateFx(7 * HOUR)
    const backup = stubFx({ frank: 'fail' })
    const res = await req('GET', '/api/fx/rates?base=USD&symbols=CNY')
    expect(res.json.rates[0].rate).toBe(7.2)
    expect(res.json.rates[0].source).toBe('erapi')
    expect(backup.urls.some((url) => url.includes('frankfurter'))).toBe(true)
    vi.restoreAllMocks()
    backdateFx(7 * HOUR)
    const failing = stubFx({ frank: 'fail', erapi: 'fail' })
    const stale = await req('GET', '/api/fx/rates?base=USD&symbols=CNY')
    expect(stale.status).toBe(200)
    expect(stale.json.rates[0].rate).toBe(7.2)
    expect(stale.json.rates[0].stale).toBe(true)
    expect(stale.json.stale).toBe(true)
    expect(stale.json.error).toContain('503')
    // 失败后 10 分钟内不再重试：离线时每次计算不必等两次超时
    const calls = failing.urls.length
    const again = await req('GET', '/api/fx/rates?base=USD&symbols=EUR')
    expect(again.json.rates[0].stale).toBe(true)
    expect(failing.urls).toHaveLength(calls)
    ;(await import('../src/services/pricing/fx-service.js')).resetFxBackoff()
  })

  it('从未成功过且两源都失败 → 502 FX_UNAVAILABLE', async () => {
    clearFx()
    stubFx({ frank: 'fail', erapi: 'fail' })
    const res = await req('GET', '/api/fx/rates?base=USD&symbols=CNY')
    expect(res.status).toBe(502)
    expect(res.json.error.code).toBe('FX_UNAVAILABLE')
  })

  it('fxSource=erapi 只用备源', async () => {
    clearFx()
    await setSetting({ fxSource: 'erapi' })
    const { urls } = stubFx()
    const res = await req('GET', '/api/fx/rates?base=USD&symbols=CNY')
    expect(res.json.rates[0].rate).toBe(7.2)
    expect(urls.every((url) => url.includes('er-api'))).toBe(true)
  })

  it('锁汇优先于实时汇率，反向取倒数；锁定的币种对不发请求', async () => {
    clearFx()
    expect((await setSetting({ fxLocks: '{"USD/CNY":7.1}' })).status).toBe(200)
    const { urls } = stubFx()
    const res = await req('GET', '/api/fx/rates?base=CNY&symbols=USD')
    expect(res.json.rates[0].rate).toBeCloseTo(1 / 7.1, 9)
    expect(res.json.rates[0].locked).toBe(true)
    expect(res.json.rates[0].source).toBe('locked')
    expect(urls).toHaveLength(0)
  })

  it('并发两次只请求一次', async () => {
    clearFx()
    const { urls } = stubFx({ delayMs: 50 })
    const [a, b] = await Promise.all([
      req('GET', '/api/fx/rates?base=USD&symbols=CNY'),
      req('GET', '/api/fx/rates?base=USD&symbols=EUR'),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(urls).toHaveLength(1)
  })

  it('fxLocks 坏 JSON / 坏键 / 非正数 → 400', async () => {
    for (const bad of ['{oops', '{"usd/cny":7}', '{"USD/CNY":0}', '{"USD-CNY":7}', '[1,2]']) {
      const res = await setSetting({ fxLocks: bad })
      expect(res.status, bad).toBe(400)
    }
  })

  it('POST /api/fx/refresh 强制刷新', async () => {
    const { urls } = stubFx()
    const res = await req('POST', '/api/fx/refresh')
    expect(res.status, res.text).toBe(200)
    expect(res.json.rates.CNY).toBe(7)
    expect(urls).toHaveLength(1)
  })
})

describe('运价表', () => {
  it('CRUD、导入、过期不参与查价、最便宜优先、港口大小写/空格不敏感', async () => {
    const a = await req('POST', '/api/freight-rates', { pol: 'Ningbo', pod: 'Felixstowe', container: '40HQ', price: 2600, currency: 'USD' })
    expect(a.status, a.text).toBe(201)
    const cheap = await req('POST', '/api/freight-rates', { pol: 'Ningbo', pod: 'FELIXSTOWE', container: '40HQ', price: 2400, currency: 'USD' })
    const expired = await req('POST', '/api/freight-rates', { pod: 'felixstowe', container: '40HQ', price: 900, validUntil: '2020-01-01' })
    expect(expired.status).toBe(201)
    const list = await req('GET', '/api/freight-rates?pod=felix%20stowe')
    expect(list.json.map((item: any) => item.price)).toEqual([2400, 2600])
    const all = await req('GET', '/api/freight-rates?pod=Felixstowe&includeExpired=1')
    expect(all.json).toHaveLength(3)
    const patched = await req('PATCH', `/api/freight-rates/${cheap.json.id}`, { price: 2500 })
    expect(patched.json.price).toBe(2500)
    const bad = await req('POST', '/api/freight-rates', { pod: '', container: '40HQ' })
    expect(bad.status).toBe(400)
    // 没价格 / 0 价不能建（否则会被当成“最便宜”选中，运费漏算）
    expect((await req('POST', '/api/freight-rates', { pod: 'Felixstowe', container: '40HQ' })).status).toBe(400)
    expect((await req('POST', '/api/freight-rates', { pod: 'Felixstowe', container: '40HQ', price: 0 })).status).toBe(400)
    // 未来才生效的不出现在默认列表里
    await req('POST', '/api/freight-rates', { pod: 'Felixstowe', container: '40HQ', price: 100, validFrom: '2099-01-01' })
    expect((await req('GET', '/api/freight-rates?pod=Felixstowe')).json.map((item: any) => item.price)).toEqual([2500, 2600])
    const imported = await req('POST', '/api/freight-rates/import', {
      rows: [
        { pol: 'Shanghai', pod: 'Hamburg', container: "40'HC", price: '$3,100', currency: 'USD' },
        { pod: 'Hamburg', container: '45HQ', price: 100 },
        { pod: 'Hamburg', container: '20GP' },
        { pod: 'Rotterdam', container: 'LCL', price: 45, unit: 'CBM' },
      ],
    })
    expect(imported.json.created).toBe(2)
    expect(imported.json.skipped).toBe(2)
    expect(imported.json.errors[0].row).toBe(2)
    const hamburg = await req('GET', '/api/freight-rates?pod=hamburg')
    expect(hamburg.json[0]).toMatchObject({ container: '40HQ', price: 3100 })
    const del = await req('DELETE', `/api/freight-rates/${a.json.id}`)
    expect(del.status).toBe(204)
    expect((await req('DELETE', `/api/freight-rates/${a.json.id}`)).status).toBe(404)
  })
})

describe('报价计算', () => {
  const lock = () => setSetting({ fxLocks: '{"USD/CNY":7}' })

  it('完整 CIF：EXW→FOB→CFR→CIF 阶梯与单价逐项正确', async () => {
    await lock()
    const res = await req('POST', '/api/pricing/calculate', {
      items: [
        { name: '阀门 A', qty: 1000, unitCost: 70, costCurrency: 'CNY', cbmPerUnit: 0.02, kgPerUnit: 1.5 },
        { name: '阀门 B', qty: 500, unitCost: 140, costCurrency: 'CNY', cbmPerUnit: 0.02 },
      ],
      quoteCurrency: 'USD',
      incoterm: 'CIF',
      pricing: { marginPct: 20 },
      costs: { exportPerShipment: 1400, freight: { amount: 2000, currency: 'USD', per: 'shipment' }, insuranceRatePct: 0.11 },
    })
    expect(res.status, res.text).toBe(200)
    const r = res.json
    const [a, b] = r.items
    expect(a.ladderCost.EXW).toBeCloseTo(10, 4)
    expect(b.ladderCost.EXW).toBeCloseTo(20, 4)
    expect(a.ladderCost.FOB).toBeCloseTo(10.1, 4)
    expect(b.ladderCost.FOB).toBeCloseTo(20.2, 4)
    const cfrA = 10.1 + (2000 * (20 / 30)) / 1000
    const cfrB = 20.2 + (2000 * (10 / 30)) / 500
    expect(a.ladderCost.CFR).toBeCloseTo(cfrA, 4)
    expect(b.ladderCost.CFR).toBeCloseTo(cfrB, 4)
    const k = 1 - 1.1 * 0.0011
    expect(a.ladderCost.CIF).toBeCloseTo(cfrA / k, 4)
    expect(a.unitPrice).toBe(Math.round((cfrA / k / 0.8) * 100) / 100)
    expect(b.unitPrice).toBe(Math.round((cfrB / k / 0.8) * 100) / 100)
    expect(a.ladder.FOB).toBe(Math.round((10.1 / 0.8) * 100) / 100)
    expect(a.marginPct).toBe(20)
    expect(r.container).toMatchObject({ type: '40GP', count: 1, cbmUsed: 30 })
    expect(r.totals.kg).toBe(1500)
    expect(r.freight).toMatchObject({ source: 'manual', amount: 2000, currency: 'USD' })
    expect(r.fx[0]).toMatchObject({ pair: 'CNY/USD', source: 'locked', locked: true })
    const keys = r.breakdown.map((row: any) => row.key)
    expect(keys).toEqual(['goods', 'export', 'freight', 'insurance', 'cost', 'profit', 'revenue'])
    expect(r.breakdown.find((row: any) => row.key === 'export').amount).toBe(200)
    expect(r.breakdown.find((row: any) => row.key === 'freight').amount).toBe(2000)
    expect(r.totals.revenue).toBeCloseTo(a.amount + b.amount, 2)
    expect(r.totals.marginPct).toBeCloseTo(20, 0)
    expect(r.warnings).toEqual([])
  })

  it('DDP：关税、增值税、目的港费用；没填税率时提示', async () => {
    await lock()
    const base = {
      items: [{ name: 'Pump', qty: 100, unitCost: 700, cbmPerUnit: 0.1 }],
      incoterm: 'DDP',
      pricing: { marginPct: 0 },
      costs: { freight: { amount: 500, currency: 'USD' }, insuranceRatePct: 0, dutyPct: 10, vatPct: 20, destinationPerShipment: 300 },
    }
    const res = await req('POST', '/api/pricing/calculate', base)
    expect(res.status, res.text).toBe(200)
    const item = res.json.items[0]
    // EXW 100 → CFR 105 → CIF 105 → ×1.1×1.2 = 138.6 → +3 = 141.6
    expect(item.ladderCost.CIF).toBeCloseTo(105, 4)
    expect(item.ladderCost.DDP).toBeCloseTo(141.6, 4)
    expect(item.unitPrice).toBe(141.6)
    const duty = res.json.breakdown.find((row: any) => row.key === 'duty')
    const vat = res.json.breakdown.find((row: any) => row.key === 'vat')
    expect(duty.amount).toBe(1050)
    expect(vat.amount).toBe(2310)
    const noTax = await req('POST', '/api/pricing/calculate', { ...base, costs: { freight: { amount: 500 } } })
    expect(noTax.json.warnings.join()).toContain('未填关税或增值税')
  })

  it('目标价倒算毛利，低毛利与亏本提示；规则三选一', async () => {
    await lock()
    const res = await req('POST', '/api/pricing/calculate', {
      items: [
        { name: 'A', qty: 10, unitCost: 70 },
        { name: 'B', qty: 10, unitCost: 70 },
      ],
      incoterm: 'EXW',
      pricing: { targetUnitPrices: [10.4, 9] },
    })
    expect(res.status, res.text).toBe(200)
    expect(res.json.items[0].marginPct).toBeCloseTo(3.85, 2)
    expect(res.json.items[1].marginPct).toBeLessThan(0)
    expect(res.json.warnings.some((w: string) => w.includes('毛利低于 5%'))).toBe(true)
    expect(res.json.warnings.some((w: string) => w.includes('低于成本'))).toBe(true)
    const both = await req('POST', '/api/pricing/calculate', { items: [{ name: 'A', qty: 1, unitCost: 1 }], incoterm: 'EXW', pricing: { marginPct: 10, markupPct: 10 } })
    expect(both.status).toBe(400)
    const mismatch = await req('POST', '/api/pricing/calculate', { items: [{ name: 'A', qty: 1, unitCost: 1 }], incoterm: 'EXW', pricing: { targetUnitPrices: [1, 2] } })
    expect(mismatch.status).toBe(400)
    const markup = await req('POST', '/api/pricing/calculate', { items: [{ name: 'A', qty: 1, unitCost: 70 }], incoterm: 'EXW', pricing: { markupPct: 25 } })
    expect(markup.json.items[0].unitPrice).toBe(12.5)
    expect(markup.json.items[0].marginPct).toBe(20)
  })

  it('默认毛利率读设置 defaultMarginPct', async () => {
    await lock()
    await setSetting({ defaultMarginPct: 50 })
    const res = await req('POST', '/api/pricing/calculate', { items: [{ name: 'A', qty: 1, unitCost: 70 }], incoterm: 'EXW' })
    expect(res.json.items[0].unitPrice).toBe(20)
    await setSetting({ defaultMarginPct: 15 })
  })

  it('自动选柜：10cbm 拼箱、30cbm 40GP、150cbm 3×40HQ', async () => {
    await lock()
    const calc = (cbm: number) =>
      req('POST', '/api/pricing/calculate', {
        items: [{ name: 'X', qty: 100, unitCost: 7, cbmPerUnit: cbm / 100 }],
        incoterm: 'CFR',
        costs: { freight: { amount: 1000 } },
      })
    expect((await calc(10)).json.container.type).toBe('LCL')
    expect((await calc(30)).json.container.type).toBe('40GP')
    const big = await calc(150)
    expect(big.json.container).toMatchObject({ type: '40HQ', count: 3 })
    expect(big.json.warnings.join()).toContain('3 个 40HQ')
  })

  it('CFR 无运费：缺参数时列出缺什么；运价表命中时按柜数计费', async () => {
    await lock()
    const missing = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'CFR' })
    expect(missing.status).toBe(400)
    expect(missing.json.error.message).toContain('pod')
    expect(missing.json.error.message).toContain('container')
    const none = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'CFR', costs: { pod: 'Nowhere', container: '40HQ' } })
    expect(none.status).toBe(400)
    expect(none.json.error.message).toContain('Nowhere')
    await req('POST', '/api/freight-rates', { pod: 'Le Havre', container: '40HQ', price: 1500, currency: 'USD' })
    const hit = await req('POST', '/api/pricing/calculate', {
      items: [{ name: 'X', qty: 1000, unitCost: 7, cbmPerUnit: 0.1 }],
      incoterm: 'CFR',
      pricing: { marginPct: 0 },
      costs: { pod: 'le havre' },
    })
    expect(hit.status, hit.text).toBe(200)
    expect(hit.json.container).toMatchObject({ type: '40HQ', count: 2 })
    expect(hit.json.freight).toMatchObject({ source: 'rate_table', amount: 3000 })
    expect(hit.json.items[0].unitPrice).toBe(4)
  })

  it('按 cbm 计费：按体积分摊；缺体积时报错', async () => {
    await lock()
    const res = await req('POST', '/api/pricing/calculate', {
      items: [
        { name: 'Big', qty: 10, unitCost: 70, cbmPerUnit: 0.3 },
        { name: 'Small', qty: 10, unitCost: 70, cbmPerUnit: 0.1 },
      ],
      incoterm: 'CFR',
      pricing: { marginPct: 0 },
      costs: { freight: { amount: 50, currency: 'USD', per: 'cbm' } },
    })
    expect(res.json.freight.amount).toBe(200)
    expect(res.json.items[0].ladderCost.CFR).toBeCloseTo(10 + 15, 4)
    expect(res.json.items[1].ladderCost.CFR).toBeCloseTo(10 + 5, 4)
    const noVol = await req('POST', '/api/pricing/calculate', {
      items: [{ name: 'X', qty: 1, unitCost: 7 }],
      incoterm: 'CFR',
      costs: { freight: { amount: 50, per: 'cbm' } },
    })
    expect(noVol.status).toBe(400)
    // 运价表按 cbm 计价、明细没体积 → 报错，不能静默按 1 cbm
    await req('POST', '/api/freight-rates', { pod: 'Antwerp', container: 'LCL', unit: 'cbm', price: 40 })
    const noVolTable = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'CFR', costs: { pod: 'Antwerp', container: 'LCL' } })
    expect(noVolTable.status).toBe(400)
    expect(noVolTable.json.error.message).toContain('cbmPerUnit')
  })

  it('退税冲减成本；产品库补成本并提示；quoteItems 可直接建报价单', async () => {
    await lock()
    const product = await req('POST', '/api/products', { sku: 'V-1', name: 'Gate Valve', price: 113, currency: 'CNY' })
    expect(product.status, product.text).toBe(201)
    const res = await req('POST', '/api/pricing/calculate', {
      items: [{ name: 'Gate Valve', qty: 100, productId: product.json.id }],
      incoterm: 'FOB',
      pricing: { marginPct: 0 },
      costs: { exportRebatePct: 13 },
    })
    expect(res.status, res.text).toBe(200)
    // 113/7 = 16.142857；退税 = 16.142857/1.13×13% = 1.857143 → 14.285714
    expect(res.json.items[0].ladderCost.EXW).toBeCloseTo(14.2857, 3)
    expect(res.json.breakdown.find((row: any) => row.key === 'rebate').amount).toBeCloseTo(-185.71, 2)
    expect(res.json.warnings.join()).toContain('产品库里的售价')
    const customer = await req('POST', '/api/customers', { company: 'Acme Ltd', country: 'GB' })
    expect(customer.status, customer.text).toBe(201)
    const quote = await req('POST', '/api/quotes', { customerId: customer.json.id, currency: 'USD', incoterm: 'FOB', items: res.json.quoteItems })
    expect(quote.status, quote.text).toBe(201)
    expect(quote.json.items[0].unitPrice).toBe(res.json.items[0].unitPrice)
    const missingProduct = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1, productId: 'prd_nope' }], incoterm: 'EXW' })
    expect(missingProduct.status).toBe(404)
    const noCost = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1 }], incoterm: 'EXW' })
    expect(noCost.status).toBe(400)
  })

  it('不支持的术语 / 本次指定汇率', async () => {
    const fca = await req('POST', '/api/pricing/calculate', { items: [{ name: 'X', qty: 1, unitCost: 7 }], incoterm: 'FCA' })
    expect(fca.status).toBe(400)
    expect(fca.json.error.message).toContain('FCA')
    const { urls } = stubFx()
    const manual = await req('POST', '/api/pricing/calculate', {
      items: [{ name: 'X', qty: 1, unitCost: 8 }],
      incoterm: 'EXW',
      pricing: { marginPct: 0 },
      fx: { 'USD/CNY': 8 },
    })
    expect(manual.json.items[0].unitPrice).toBe(1)
    expect(manual.json.fx[0]).toMatchObject({ source: 'manual', pair: 'CNY/USD' })
    expect(urls).toHaveLength(0)
  })
})
