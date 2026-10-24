import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TestServer } from './helpers.js'

/**
 * 开发客户的两个免费数据源：HMRC（英国进口商名录）与 UN Comtrade（国家市场概览）。
 * 全部用 test/fixtures/trade 下录好的真实响应，绝不访问网络：
 * fetchWithProxy 被替换成按 URL 返回 fixture 的假实现。
 */

const FIXTURES = join(__dirname, 'fixtures', 'trade')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const COMMODITY = fixture('hmrc-commodity-841370.json')
const IMPORTS = fixture('hmrc-import-841370.json')
const COMTRADE_2024 = fixture('comtrade-841370-2024.json')
const HMRC_REJECTED = "Your request has been rejected. Please make sure you haven't exceeded the rate limit."

type HttpModule = typeof import('../src/services/http-client.js')
let http: HttpModule
let hmrc: typeof import('../src/services/trade/hmrc.js')
let comtrade: typeof import('../src/services/trade/comtrade.js')
let tradeErrors: typeof import('../src/services/trade/errors.js')

/** 按 URL 匹配返回响应；记录每次实际请求的 URL */
function stubFetch(routes: Array<{ match: RegExp | ((url: string) => boolean); reply: (url: string, call: number) => string | Response }>) {
  const urls: string[] = []
  const spy = vi.spyOn(http, 'fetchWithProxy').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(url) : route.match.test(url)
      if (!hit) continue
      const reply = route.reply(url, urls.length)
      if (reply instanceof Response) return reply
      return new Response(reply, { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as HttpModule['fetchWithProxy'])
  return { spy, urls }
}

/** HMRC 的两次调用：Commodity 表 + Import 明细 */
function hmrcRoutes(importReply: (url: string, call: number) => string | Response = () => IMPORTS) {
  let importCalls = 0
  return [
    { match: /\/Commodity\?/, reply: () => COMMODITY },
    {
      match: /\/Import\?/,
      reply: (url: string) => {
        importCalls += 1
        return importReply(url, importCalls)
      },
    },
  ]
}

/** URL 里的空格会被 encode 成 %20，断言前先还原成可读形式 */
const readable = (url: string) => {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

beforeAll(async () => {
  process.env.LULUX_ETA_HOME = process.env.LULUX_ETA_HOME || join(__dirname, '.tmp-trade-providers')
  http = await import('../src/services/http-client.js')
  hmrc = await import('../src/services/trade/hmrc.js')
  comtrade = await import('../src/services/trade/comtrade.js')
  tradeErrors = await import('../src/services/trade/errors.js')
})

afterAll(() => {
  vi.restoreAllMocks()
})

const fast = { intervalMs: 0, retryDelaysMs: [0, 0], now: Date.UTC(2025, 5, 15) }

describe('HMRC 英国进口商名录', () => {
  it('HS6 → 只取 8 位 CN8；Import 用 or 拼接且每批 ≤10 个', async () => {
    const { urls } = stubFetch(hmrcRoutes())
    const result = await hmrc.searchUkImporters({ hs: '8413.70', ...fast })

    expect(urls[0]).toContain('/Commodity?')
    expect(readable(urls[0]!)).toContain("Hs6Code eq '841370'")
    // fixture 里 20 个 CN8；每批最多 10 个 → 2 次 Import 请求（fixture 没有 nextLink，所以每批 1 页）
    const importUrls = urls.filter((url) => url.includes('/Import?'))
    expect(importUrls).toHaveLength(2)
    for (const url of importUrls.map(readable)) {
      expect(url).toContain('CommodityId eq')
      expect(url).not.toContain(' in (')
      expect(url).not.toContain('$orderby')
      expect(url).toContain('MonthId ge')
      const ids = [...url.matchAll(/CommodityId eq (\d+)/g)].map((m) => m[1])
      expect(ids.length).toBeLessThanOrEqual(10)
      expect(ids.every((id) => id!.length === 8)).toBe(true)
    }
    expect(result.coverage.commodityIds).toHaveLength(20)
    expect(result.coverage.commodityIds.every((id) => String(id).length === 8)).toBe(true)
    expect(result.coverage.source).toBe('hmrc')
    expect(result.coverage.country).toBe('GB')
    expect(result.coverage.months).toEqual([202504, 202504])
    expect(result.coverage.note).toContain('没有金额和数量')
    // 查询窗口：2025-06 − (12 + 3) 个月 = 2024-03
    expect(readable(importUrls[0]!)).toContain('MonthId ge 202403')
  })

  it('按 TraderId 聚合，地址拼接、lastImportAt 为该月 1 号 UTC、evidence.url 是实际请求 URL', async () => {
    const { urls } = stubFetch(hmrcRoutes())
    const result = await hmrc.searchUkImporters({ hs: '841370', ...fast })
    const rows = JSON.parse(IMPORTS).value as Array<{ TraderId: number }>
    expect(result.items).toHaveLength(new Set(rows.map((row) => row.TraderId)).size)
    expect(result.items).toHaveLength(40)

    const purmo = result.items.find((item) => item.company === 'PURMO GROUP (UK) LTD')!
    expect(purmo.displayName).toBe('Purmo Group (UK) Ltd')
    expect(purmo.country).toBe('GB')
    expect(purmo.address).toBe('EASTERN AVENUE, TEAM VALLEY TRADING ESTATE, GATESHEAD, TYNE AND WEAR, NE11 0PG')
    expect(purmo.lastImportAt).toBe(Date.UTC(2025, 3, 1))
    expect(purmo.hsCodes).toEqual(['84137030'])
    expect(purmo.shipments).toBe(1)
    expect(purmo.evidence).toHaveLength(1)
    expect(purmo.evidence[0]!.kind).toBe('customs')
    expect(purmo.evidence[0]!.source).toBe('hmrc')
    expect(urls).toContain(purmo.evidence[0]!.url)
    expect(purmo.evidence[0]!.url).toContain('/Import?')
    expect(purmo.evidence[0]!.title).toContain('CN8 84137030')
    expect(purmo.evidence[0]!.snippet).toContain('2025-04')
    expect(purmo.evidence[0]!.fields).toContain('lastImportAt')
    expect(purmo.flags).toEqual([])
  })

  it('HMRC 代收地址 / 货代名字标 forwarder', async () => {
    stubFetch(hmrcRoutes())
    const result = await hmrc.searchUkImporters({ hs: '841370', ...fast })
    const grundfos = result.items.find((item) => item.company === 'GRUNDFOS OPERATIONS AS')!
    expect(grundfos.flags).toContain('forwarder')
    expect(grundfos.address).toContain('HM REVENUE AND CUSTOMS')
  })

  it('limit 截断并置 truncated；输出直接喂给 prospectCreateInput 也能过校验', async () => {
    stubFetch(hmrcRoutes())
    const result = await hmrc.searchUkImporters({ hs: '841370', limit: 5, ...fast })
    expect(result.items).toHaveLength(5)
    expect(result.coverage.truncated).toBe(true)

    const { prospectCreateInput } = await import('../src/services/prospect-service.js')
    const { displayName: _displayName, ...item } = result.items[0]!
    const parsed = prospectCreateInput.safeParse(item)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  })

  it('限流文本 → 退避后重试成功', async () => {
    const { urls } = stubFetch(hmrcRoutes((_url, call) => (call <= 2 ? HMRC_REJECTED : IMPORTS)))
    const result = await hmrc.searchUkImporters({ hs: '841370', ...fast })
    expect(result.items.length).toBeGreaterThan(0)
    expect(urls.filter((url) => url.includes('/Import?'))).toHaveLength(4) // 2 次被拒 + 2 批成功
  })

  it('连续被限流 → RATE_LIMITED', async () => {
    stubFetch(hmrcRoutes(() => HMRC_REJECTED))
    await expect(hmrc.searchUkImporters({ hs: '841370', ...fast })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('坏 HS → BAD_ARGS，且不发任何请求', async () => {
    const { spy } = stubFetch(hmrcRoutes())
    for (const hs of ['', '84A1', '8', '12345678901']) {
      await expect(hmrc.searchUkImporters({ hs, ...fast })).rejects.toMatchObject({ code: 'BAD_ARGS' })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('@odata.nextLink 翻页', async () => {
    const first = {
      value: [
        {
          TraderId: 1,
          CommodityId: 84137030,
          MonthId: 202504,
          Trader: { CompanyName: 'ACME PUMPS LTD', Address1: '1 MAIN ST', PostCode: 'AB1 2CD' },
        },
      ],
      '@odata.nextLink': 'https://api.uktradeinfo.com/Import?$skiptoken=abc',
    }
    const second = {
      value: [
        {
          TraderId: 2,
          CommodityId: 84137030,
          MonthId: 202505,
          Trader: { CompanyName: 'BETA PUMPS LTD', Address1: '2 MAIN ST', PostCode: 'AB1 2CD' },
        },
      ],
    }
    const { urls } = stubFetch([
      {
        match: /\/Commodity\?/,
        reply: () =>
          JSON.stringify({
            value: [
              { CommodityId: 84137030, Cn8Code: '84137030', Hs6Code: '841370' },
              { CommodityId: 84, Hs2Code: '84' },
            ],
          }),
      },
      { match: (url) => url.includes('/Import?') && url.includes('skiptoken'), reply: () => JSON.stringify(second) },
      { match: /\/Import\?/, reply: () => JSON.stringify(first) },
    ])
    const result = await hmrc.searchUkImporters({ hs: '841370', ...fast })
    expect(result.coverage.commodityIds).toEqual([84137030]) // 两位的汇总行被丢掉
    expect(result.items.map((item) => item.company).sort()).toEqual(['ACME PUMPS LTD', 'BETA PUMPS LTD'])
    expect(urls.some((url) => url.includes('skiptoken'))).toBe(true)
    expect(result.coverage.months).toEqual([202504, 202505])
  })

  it('ProviderError → toAppError 的 400 / 429 / 502', () => {
    const { ProviderError, toAppError } = tradeErrors
    expect(toAppError(new ProviderError('BAD_ARGS', 'x'))).toMatchObject({ status: 400, code: 'BAD_ARGS' })
    expect(toAppError(new ProviderError('RATE_LIMITED', 'x'))).toMatchObject({ status: 429, code: 'PROVIDER_RATE_LIMITED' })
    expect(toAppError(new ProviderError('UPSTREAM', 'x'))).toMatchObject({ status: 502, code: 'PROVIDER_UPSTREAM' })
    expect(toAppError(new ProviderError('NETWORK', 'x'))).toMatchObject({ status: 502, code: 'PROVIDER_UPSTREAM' })
  })
})

describe('UN Comtrade 市场概览', () => {
  /** 上一年构造：2023 年金额 = 2024 年的一半，其中英国、日本缺数据 */
  function previousYearPayload(): string {
    const current = JSON.parse(COMTRADE_2024) as { data: Array<Record<string, unknown>> }
    const data = current.data
      .filter((row) => row.reporterCode !== 826 && row.reporterCode !== 392)
      .map((row) => ({
        ...row,
        period: '2023',
        refYear: 2023,
        refPeriodId: 20230101,
        primaryValue: Number(row.primaryValue) / 2,
        netWgt: row.netWgt === null ? null : Number(row.netWgt) / 2,
      }))
    return JSON.stringify({ elapsedTime: '0.1 secs', count: data.length, data, error: '' })
  }

  function comtradeRoutes(overrides: { period2024?: () => string | Response; period2023?: string | Response } = {}) {
    return [
      { match: (url: string) => url.includes('period=2024'), reply: overrides.period2024 ?? (() => COMTRADE_2024) },
      { match: (url: string) => url.includes('period=2023'), reply: overrides.period2023 ?? (() => previousYearPayload()) },
    ]
  }

  it('按金额降序、share 占全球合计、ISO2 + 中文国名、growthPct', async () => {
    const { urls } = stubFetch(comtradeRoutes())
    const result = await comtrade.marketOverview({ hs: '841370', years: [2023, 2024], top: 5, intervalMs: 0 })
    expect(result.year).toBe(2024)
    expect(result.rows).toHaveLength(5)
    const values = result.rows.map((row) => row.valueUsd)
    expect([...values].sort((a, b) => b - a)).toEqual(values)
    expect(result.rows[0]!.country).toBe('US')
    expect(result.rows[0]!.countryName).toBe('美国')
    expect(result.rows[0]!.valueUsd).toBe(2024149011)
    expect(result.rows[0]!.netWeightKg).toBeCloseTo(92762504.935, 2)
    expect(result.rows[0]!.growthPct).toBe(100) // 2023 是 2024 的一半
    const shareSum = result.rows.reduce((sum, row) => sum + row.share, 0)
    expect(shareSum).toBeGreaterThan(0)
    const world = result.rows.find((row) => row.country === 'US')!
    expect(world.share).toBeCloseTo((2024149011 / JSON.parse(COMTRADE_2024).data.reduce((sum: number, row: any) => sum + Number(row.primaryValue), 0)) * 100, 1)
    expect(result.source.name).toBe('UN Comtrade')
    expect(result.source.url).toHaveLength(2)
    expect(urls).toEqual(result.source.url)
    expect(result.source.note).toContain('不是企业名单')
  })

  it('最近一年缺数据的国家 growthPct=null，不报错', async () => {
    stubFetch(comtradeRoutes())
    const result = await comtrade.marketOverview({ hs: '841370', years: [2023, 2024], top: 500, intervalMs: 0 })
    // fixture 里有英国（826）、日本（392），上一年被去掉
    const uk = result.rows.find((row) => row.country === 'GB')
    const jp = result.rows.find((row) => row.country === 'JP')
    expect(uk?.growthPct).toBeNull()
    expect(jp?.growthPct).toBeNull()
    expect(result.rows.every((row) => row.country !== null)).toBe(true)
  })

  it('coverage：最新年份还没报数的国家按上一年金额列出', async () => {
    // 反过来：2024 当“上一年”，构造 2025 只有美国报了数
    const only = JSON.parse(COMTRADE_2024) as { data: Array<Record<string, unknown>> }
    const us2025 = only.data.filter((row) => row.reporterCode === 842).map((row) => ({ ...row, period: '2025' }))
    stubFetch([
      { match: (url: string) => url.includes('period=2025'), reply: () => JSON.stringify({ count: 1, data: us2025 }) },
      { match: (url: string) => url.includes('period=2024'), reply: () => COMTRADE_2024 },
    ])
    const result = await comtrade.marketOverview({ hs: '841370', years: [2024, 2025], intervalMs: 0 })
    expect(result.coverage.reporters).toBe(1)
    expect(result.coverage.previousReporters).toBe(25)
    expect(result.coverage.missingInLatest).toHaveLength(10)
    expect(result.coverage.missingInLatest.some((m) => m.country === 'US')).toBe(false)
    const prev = result.coverage.missingInLatest.map((m) => m.previousValueUsd)
    expect([...prev].sort((a, b) => b - a)).toEqual(prev)
  })

  it('netWgt 为空时 null；hs 只取前 6 位', async () => {
    stubFetch(comtradeRoutes())
    const result = await comtrade.marketOverview({ hs: '8413.70.30', years: [2023, 2024], top: 500, intervalMs: 0 })
    const uk = result.rows.find((row) => row.country === 'GB')
    expect(uk?.netWeightKg).toBeNull()
    expect(result.rows.every((row) => Number.isFinite(row.valueUsd))).toBe(true)
  })

  it('默认年份是最近两个完整年', async () => {
    const { spy, urls } = stubFetch([
      ...comtradeRoutes(),
      { match: (url: string) => url.includes('period=2025'), reply: () => JSON.stringify({ count: 0, data: [], error: '' }) },
    ])
    const result = await comtrade.marketOverview({ hs: '841370', intervalMs: 0, now: new Date('2026-10-24T00:00:00Z') })
    expect(urls.every((url) => url.includes('cmdCode=841370'))).toBe(true)
    expect(urls.some((url) => url.includes('period=2024'))).toBe(true)
    expect(urls.some((url) => url.includes('period=2025'))).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    // 最新一年没有数据时不报错，返回空行
    expect(result.year).toBe(2025)
    expect(result.rows).toEqual([])
  })

  it('HTTP 429 → 重试一次 → RATE_LIMITED', async () => {
    stubFetch(comtradeRoutes({ period2024: () => new Response('rate limited', { status: 429 }) }))
    await expect(comtrade.marketOverview({ hs: '841370', years: [2023, 2024], intervalMs: 0 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
  })
})

describe('交易日接口', () => {
  let server: TestServer
  beforeAll(async () => {
    const { startTestServer } = await import('./helpers.js')
    server = await startTestServer()
  })
  afterAll(async () => {
    await server?.close()
  })

  it('未登录 401', async () => {
    const res = await server.request('GET', '/api/trade/market?hs=841370', { token: null })
    expect(res.status).toBe(401)
    const uk = await server.request('GET', '/api/trade/uk-importers?hs=841370', { token: null })
    expect(uk.status).toBe(401)
  })

  it('坏参数 400（不访问网络）', async () => {
    const noHs = await server.request('GET', '/api/trade/market')
    expect(noHs.status).toBe(400)
    expect(noHs.json.error.code).toBe('BAD_ARGS')
    const badHs = await server.request('GET', '/api/trade/uk-importers?hs=84A1')
    expect(badHs.status).toBe(400)
    const badMonths = await server.request('GET', '/api/trade/uk-importers?hs=841370&months=abc')
    expect(badMonths.status).toBe(400)
    const badYears = await server.request('GET', '/api/trade/market?hs=841370&years=20x4')
    expect(badYears.status).toBe(400)
  })
})
