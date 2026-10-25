import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 开发客户工具（prospecting）：英国 HMRC 进口商名录 → 精简结果 + resultId → 保存线索；
 * 手动录入的证据边界；自动制裁初筛；过期 / 越界 resultId；制裁筛查；线索列表 / 转换 / RBAC。
 *
 * 绝不访问网络：hmrc / comtrade 用 test/fixtures/trade 下录好的真实响应，
 * 把 http-client 的 fetchWithProxy 换成按 URL 返回 fixture 的假实现。
 */

const FIXTURES = join(__dirname, 'fixtures', 'trade')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const COMMODITY = fixture('hmrc-commodity-841370.json')
const IMPORTS = fixture('hmrc-import-841370.json')
const COMTRADE_2024 = fixture('comtrade-841370-2024.json')

let server: TestServer
type HttpModule = typeof import('../src/services/http-client.js')
type Registry = typeof import('../src/services/tools/registry.js')
let http: HttpModule
let registry: Registry
let prospectService: typeof import('../src/services/prospect-service.js')['prospectService']

const ctx = () => ({ sessionId: 'prospect-tools-test', agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })

/** 通过真实注册表调用工具（与 Agent 走同一条 runTool 路径：RBAC、zod、ToolError 都一样） */
async function callTool(name: string, args: Record<string, unknown>) {
  const tool = registry.findTool(name)
  expect(tool, `${name} 未注册`).toBeTruthy()
  const outcome = await registry.runTool(tool!, args, ctx())
  return { ...outcome, json: outcome.ok ? JSON.parse(outcome.text) : null }
}

beforeAll(async () => {
  server = await startTestServer()
  http = await import('../src/services/http-client.js')
  registry = await import('../src/services/tools/registry.js')
  ;({ prospectService } = await import('../src/services/prospect-service.js'))
  const { sanctionsService } = await import('../src/services/sanctions/sanctions-service.js')

  // 两个数据源都只返回本地 fixture
  vi.spyOn(http, 'fetchWithProxy').mockImplementation((async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/Commodity?')) return new Response(COMMODITY, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/Import?')) return new Response(IMPORTS, { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('comtradeapi.un.org')) return new Response(COMTRADE_2024, { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response('not found', { status: 404 })
  }) as unknown as HttpModule['fetchWithProxy'])

  // 自定义名单：Purmo Group UK（与 HMRC 的 PURMO GROUP (UK) LTD 名称等价）
  const imported = sanctionsService.importCustom('name,ref,country,type,program,remarks\nPurmo Group UK,SDN-9,RU,entity,UKRAINE,test list\n')
  expect(imported.count).toBe(1)
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await server?.close()
})

const find = async (extra: Record<string, unknown> = {}) => {
  const res = await callTool('find_uk_importers', { hs: '841370', months: 12, flow: 'import', limit: 50, ...extra })
  expect(res.ok, res.text).toBe(true)
  return res.json
}
const itemOf = (json: any, company: string) => json.items.find((item: any) => item.company === company)

describe('find_uk_importers', () => {
  it('返回 resultId 与精简条目：index / 展示名 / lastImport / months / cn8 / forwarder', async () => {
    const json = await find()
    expect(json.resultId).toMatch(/^uk_[0-9a-f]{8}$/)
    expect(json.items).toHaveLength(40)
    expect(json.hint).toContain('save_prospects')
    expect(json.hint).toContain('forwarder=true')
    expect(json.coverage).toMatchObject({ source: 'hmrc', country: 'GB' })

    const purmo = itemOf(json, 'Purmo Group (UK) Ltd')
    expect(purmo).toMatchObject({ lastImport: '2025-04', months: 1, forwarder: false })
    expect(purmo.cn8).toEqual(['84137030'])
    expect(purmo.address).toContain('GATESHEAD')
    // 精简结果里没有完整证据 / 内部字段
    expect(purmo.evidence).toBeUndefined()
    expect(purmo.index).toBeGreaterThanOrEqual(1)

    // HMRC 代收地址 → forwarder
    expect(itemOf(json, 'Grundfos Operations AS')).toMatchObject({ forwarder: true })
    expect(itemOf(json, 'MMPI Manufacturing Limited')?.forwarder).toBe(false)
  })

  it('ProviderError（坏 HS）按普通错误返回，不抛到编排层', async () => {
    const res = await callTool('find_uk_importers', { hs: '84A1' })
    expect(res.ok).toBe(false)
    expect(res.text).toBe('BAD_ARGS：HS 编码必须是 2–10 位数字')
  })
})

describe('save_prospects：resultId + indexes', () => {
  let resultId = ''
  let ids: string[] = []

  it('用 resultId + indexes 保存 2 条 → created=2，证据 kind=customs', async () => {
    const json = await find()
    resultId = json.resultId
    const mi = itemOf(json, 'MMPI Manufacturing Limited').index
    const econ = itemOf(json, 'Econ Engineering Ltd').index
    const saved = await callTool('save_prospects', { resultId, indexes: [mi, econ] })
    expect(saved.ok, saved.text).toBe(true)
    expect(saved.json).toMatchObject({ created: 2, merged: 0, skipped: [] })
    ids = saved.json.items.map((item: any) => item.id)
    expect(new Set(ids).size).toBe(2)

    for (const id of ids) {
      const prospect = prospectService.require(id)
      expect(prospect.evidence.map((e) => e.kind)).toEqual(['customs'])
      expect(prospect.evidence[0]!.source).toBe('hmrc')
      expect(prospect.evidence[0]!.url).toContain('/Import?')
      expect(prospect.hsCodes).toContain('84137030')
    }
    const econProspect = prospectService.require(ids[1]!)
    expect(econProspect.country).toBe('GB')
    expect(econProspect.lastImportAt).toBe(Date.UTC(2025, 3, 1))
  })

  it('同一批再存一次 → merged=2，不产生重复潜客', async () => {
    const json = await find()
    const mi = itemOf(json, 'MMPI Manufacturing Limited').index
    const econ = itemOf(json, 'Econ Engineering Ltd').index
    const again = await callTool('save_prospects', { resultId: json.resultId, indexes: [mi, econ] })
    expect(again.ok, again.text).toBe(true)
    expect(again.json).toMatchObject({ created: 0, merged: 2 })
    expect(again.json.items.map((item: any) => item.id).sort()).toEqual([...ids].sort())
    for (const id of ids) expect(prospectService.require(id).evidence).toHaveLength(1)
  })

  it("all=true（以及兼容的 indexes='all'）保存全部条目", async () => {
    const json = await find({ limit: 3 })
    const saved = await callTool('save_prospects', { resultId: json.resultId, all: true })
    expect(saved.ok, saved.text).toBe(true)
    expect(saved.json.items).toHaveLength(3)
  })

  it('forwarder 条目照常保存，但返回项带 forwarder:true', async () => {
    const json = await find()
    const grundfos = itemOf(json, 'Grundfos Operations AS')
    expect(grundfos.forwarder).toBe(true)
    const saved = await callTool('save_prospects', { resultId: json.resultId, indexes: [grundfos.index] })
    expect(saved.ok, saved.text).toBe(true)
    expect(saved.json.items[0]).toMatchObject({ forwarder: true })
    expect(prospectService.require(saved.json.items[0].id).flags).toContain('forwarder')
  })

  it('不存在的 resultId → 友好错误；过期 → 友好错误；index 越界 → 列出有效范围', async () => {
    const missing = await callTool('save_prospects', { resultId: 'uk_deadbeef', indexes: [1] })
    expect(missing.ok).toBe(false)
    expect(missing.text).toBe('结果已过期，请重新调用 find_uk_importers')

    const json = await find({ limit: 5 })
    const outOfRange = await callTool('save_prospects', { resultId: json.resultId, indexes: [0, 6] })
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.text).toContain('index 超出范围')
    expect(outOfRange.text).toContain('1–5')

    const noIndexes = await callTool('save_prospects', { resultId: json.resultId })
    expect(noIndexes.ok).toBe(false)
    expect(noIndexes.text).toContain('indexes')

    // 30 分钟后缓存条目过期
    const realNow = Date.now
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31 * 60 * 1000)
    try {
      const expired = await callTool('save_prospects', { resultId: json.resultId, indexes: [1] })
      expect(expired.ok).toBe(false)
      expect(expired.text).toBe('结果已过期，请重新调用 find_uk_importers')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('save_prospects：手动条目与证据边界', () => {
  it("evidence kind='customs' 被拒（模型不能冒充海关证据）", async () => {
    const res = await callTool('save_prospects', {
      prospects: [
        { company: 'Fake Customs Co', country: 'GB', evidence: [{ kind: 'customs', url: 'https://example.com/record' }] },
      ],
    })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('不能由 Agent 填写')
    expect(prospectService.list({ q: 'Fake Customs Co' }).total).toBe(0)
  })

  it('非 manual 证据缺 http/https 链接被拒；空证据也被拒', async () => {
    const noUrl = await callTool('save_prospects', { prospects: [{ company: 'No Url Co', evidence: [{ kind: 'website', title: '官网' }] }] })
    expect(noUrl.ok).toBe(false)
    expect(noUrl.text).toContain('http/https')

    const empty = await callTool('save_prospects', { prospects: [{ company: 'No Evidence Co', evidence: [] }] })
    expect(empty.ok).toBe(false)
    expect(empty.text).toContain('至少需要 1 条证据')

    // manual 可以没有链接（例如展会名片），但必须有来源说明的余地
    const manual = await callTool('save_prospects', {
      prospects: [{ company: 'Manual Card Co', notes: '展会名片', evidence: [{ kind: 'manual', snippet: 'Canton Fair 2026 booth 3B' }] }],
    })
    expect(manual.ok, manual.text).toBe(true)
    expect(manual.json.created).toBe(1)
  })

  it('正常条目保存后证据 kind=website，字段规范化', async () => {
    const res = await callTool('save_prospects', {
      prospects: [
        {
          company: 'Website Evidence GmbH',
          country: 'de',
          website: 'www.website-evidence.example',
          hsCodes: ['8413.70'],
          emails: ['Buyer@Website-Evidence.example'],
          evidence: [{ kind: 'website', url: 'https://www.website-evidence.example/about', title: 'About us', snippet: 'Pumps distributor' }],
        },
      ],
    })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.created).toBe(1)
    const id = res.json.items[0].id
    const prospect = prospectService.require(id)
    expect(prospect.country).toBe('DE')
    expect(prospect.website).toBe('https://www.website-evidence.example/')
    expect(prospect.emails).toEqual(['buyer@website-evidence.example'])
    expect(prospect.evidence[0]).toMatchObject({ kind: 'website', url: 'https://www.website-evidence.example/about', title: 'About us' })
  })

  it('单条失败不中断整批：失败的进 skipped，其余照常保存', async () => {
    // 单机模式本机用户可以改所有潜客，权限失败在服务端模式的 RBAC 测试里覆盖；这里直接让一条 upsert 抛 AppError
    const { AppError } = await import('../src/errors.js')
    const original = prospectService.upsert.bind(prospectService)
    const spy = vi.spyOn(prospectService, 'upsert').mockImplementation((input: unknown) => {
      if ((input as { company?: string }).company === 'Someone Elses Lead Ltd') throw new AppError(403, 'FORBIDDEN', '只能修改自己负责的潜客')
      return original(input)
    })
    try {
      const res = await callTool('save_prospects', {
        prospects: [
          { company: 'Someone Elses Lead Ltd', evidence: [{ kind: 'website', url: 'https://someone-elses.example' }] },
          { company: 'Batch Survivor Ltd', evidence: [{ kind: 'website', url: 'https://batch-survivor.example' }] },
        ],
      })
      expect(res.ok, res.text).toBe(true)
      expect(res.json.created).toBe(1)
      expect(res.json.skipped).toHaveLength(1)
      expect(res.json.skipped[0]).toMatchObject({ company: 'Someone Elses Lead Ltd' })
      expect(res.json.skipped[0].reason).toContain('只能修改自己负责的潜客')
      expect(prospectService.list({ q: 'Batch Survivor' }).total).toBe(1)
      expect(prospectService.list({ q: 'Someone Elses' }).total).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('自动制裁初筛', () => {
  it('保存 PURMO GROUP (UK) LTD → flags 含 sanctions_hit，备注追加初筛行；再存不重复', async () => {
    const payload = {
      prospects: [
        {
          company: 'PURMO GROUP (UK) LTD',
          country: 'GB',
          website: 'https://purmo.example',
          evidence: [{ kind: 'website', url: 'https://purmo.example/about', title: 'Purmo UK' }],
        },
      ],
    }
    const first = await callTool('save_prospects', payload)
    expect(first.ok, first.text).toBe(true)
    expect(first.json.created).toBe(1)
    expect(first.json.items[0].sanctionsHit).toBe(true)
    const id = first.json.items[0].id
    let prospect = prospectService.require(id)
    expect(prospect.flags).toContain('sanctions_hit')
    const line = prospect.notes.split('\n').find((text) => text.startsWith('[制裁名单初筛]'))!
    expect(line).toContain('Purmo Group UK')
    expect(line).toContain('相似度 1.00')
    expect(line).toContain('需人工核实')
    // 命中制裁名单 → 评分归零
    expect(prospect.score).toBe(0)

    const again = await callTool('save_prospects', payload)
    expect(again.ok, again.text).toBe(true)
    expect(again.json).toMatchObject({ created: 0, merged: 1 })
    prospect = prospectService.require(id)
    expect(prospect.notes.split('\n').filter((text) => text.startsWith('[制裁名单初筛]'))).toHaveLength(1)
    expect(prospect.flags.filter((flag) => flag === 'sanctions_hit')).toHaveLength(1)
  })

  it('未达 0.92 的公司不加标记', async () => {
    const res = await callTool('save_prospects', {
      prospects: [{ company: 'Purmo Logistics Europe BV', evidence: [{ kind: 'website', url: 'https://purmo-logistics.example' }] }],
    })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.items[0].sanctionsHit).toBeUndefined()
    expect(prospectService.require(res.json.items[0].id).flags).not.toContain('sanctions_hit')
  })
})

describe('screen_sanctions', () => {
  it('按名字筛查：命中自定义名单；未下载的官方名单明确提示', async () => {
    const res = await callTool('screen_sanctions', { names: ['Purmo Group UK', 'Completely Unrelated Trading Name'] })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.items).toHaveLength(2)
    expect(res.json.items[0].hits[0]).toMatchObject({ list: 'custom', primaryName: 'Purmo Group UK', score: 1, matchedOn: 'exact' })
    expect(res.json.items[1].hits).toEqual([])
    expect(res.json.listsMissing).toEqual(expect.arrayContaining(['ofac', 'eu', 'un']))
    expect(res.json.notice).toContain('以下名单尚未下载：')
    expect(res.json.notice).toContain('本次筛查不完整')
    expect(res.json.disclaimer).toContain('人工核实')
  })

  it('prospectId 方式：用该潜客的公司名与国家筛查，不写库', async () => {
    const created = prospectService.create({ company: 'Purmo Group UK', country: 'RU', evidence: [] })
    const before = prospectService.require(created.id)
    const res = await callTool('screen_sanctions', { prospectId: created.id })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.prospect).toMatchObject({ id: created.id, company: 'Purmo Group UK', country: 'RU' })
    expect(res.json.items[0].name).toBe('Purmo Group UK')
    expect(res.json.items[0].hits[0].list).toBe('custom')
    // 只是初筛：潜客本身没有变化
    expect(prospectService.require(created.id)).toMatchObject({ flags: before.flags, notes: before.notes, score: before.score })
  })

  it('names 与 prospectId 二选一', async () => {
    const both = await callTool('screen_sanctions', { names: ['X'], prospectId: 'prs_x' })
    expect(both.ok).toBe(false)
    expect(both.text).toContain('二选一')
    const neither = await callTool('screen_sanctions', {})
    expect(neither.ok).toBe(false)
  })
})

describe('list_prospects / get_prospect / update_prospect', () => {
  it('hasCustomsEvidence 过滤；返回精简字段', async () => {
    const withCustoms = await callTool('list_prospects', { q: 'MMPI', hasCustomsEvidence: true })
    expect(withCustoms.ok, withCustoms.text).toBe(true)
    expect(withCustoms.json.total).toBe(1)
    const item = withCustoms.json.items[0]
    expect(item).toMatchObject({ company: 'MMPI Manufacturing Limited', country: 'GB', lastImportAt: '2025-04-01' })
    expect(item.evidenceKinds).toEqual(['customs'])
    expect(item.evidence).toBeUndefined()
    expect(item.scoreReasons).toBeUndefined()

    const noCustoms = await callTool('list_prospects', { q: 'Website Evidence', hasCustomsEvidence: false })
    expect(noCustoms.json.items.map((p: any) => p.company)).toContain('Website Evidence GmbH')
    const onlyCustoms = await callTool('list_prospects', { q: 'Website Evidence', hasCustomsEvidence: true })
    expect(onlyCustoms.json.total).toBe(0)

    expect((await callTool('list_prospects', { flag: 'sanctions_hit' })).json.items.some((p: any) => p.company.toUpperCase() === 'PURMO GROUP (UK) LTD')).toBe(true)
    expect((await callTool('list_prospects', { minScore: 50, sort: 'score', limit: 5 })).json.items.length).toBeLessThanOrEqual(5)
  })

  it('get_prospect 返回完整证据与评分理由；update_prospect 改状态 / 标记 / 网站', async () => {
    const saved = await callTool('save_prospects', {
      prospects: [{ company: 'Update Target Ltd', country: 'FR', website: 'https://update-target.example', evidence: [{ kind: 'search', url: 'https://search.example/result' }] }],
    })
    const id = saved.json.items[0].id
    const full = await callTool('get_prospect', { prospectId: id })
    expect(full.ok, full.text).toBe(true)
    expect(full.json.evidence).toHaveLength(1)
    expect(full.json.scoreReasons.length).toBeGreaterThan(0)

    const updated = await callTool('update_prospect', {
      prospectId: id,
      status: 'contacted',
      flags: ['forwarder'],
      website: 'https://www.update-target.example',
    })
    expect(updated.ok, updated.text).toBe(true)
    expect(updated.json.changed.sort()).toEqual(['flags', 'status', 'website'])
    const after = prospectService.require(id)
    expect(after).toMatchObject({ status: 'contacted', website: 'https://www.update-target.example/' })
    expect(after.flags).toEqual(['forwarder'])

    const statusOnly = await callTool('update_prospect', { prospectId: id, status: 'ignored' })
    expect(statusOnly.json.prospect.status).toBe('ignored')
    expect((await callTool('update_prospect', { prospectId: id })).ok).toBe(false)
  })
})

describe('convert_prospect_to_customer', () => {
  it('update_prospect 不能直接把状态改成 converted', async () => {
    const created = await callTool('save_prospects', { prospects: [{ company: 'No Shortcut Convert Ltd', evidence: [{ kind: 'manual', title: '展会名片' }] }] })
    const res = await callTool('update_prospect', { prospectId: created.json.items[0].id, status: 'converted' })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('convert_prospect_to_customer')
  })

  it('正常转换：客户 source=prospect、潜客 converted 并关联', async () => {
    const saved = await callTool('save_prospects', {
      prospects: [
        {
          company: 'Convert Prospect Trading Ltd',
          country: 'NL',
          website: 'https://convert-prospect.example',
          emails: ['sales@convert-prospect.example'],
          evidence: [{ kind: 'directory', url: 'https://directory.example/company/42', title: 'Directory listing' }],
        },
      ],
    })
    const id = saved.json.items[0].id
    const res = await callTool('convert_prospect_to_customer', { prospectId: id })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.converted).toBe(true)
    expect(res.json.prospect).toMatchObject({ id, status: 'converted' })
    const customer = (await server.request('GET', `/api/customers/${res.json.customer.id}`)).json
    expect(customer).toMatchObject({ company: 'Convert Prospect Trading Ltd', source: 'prospect' })
    expect(customer.notes).toContain('https://directory.example/company/42')
  })

  it('组织内已有同名客户：不带 force 返回 duplicate + matches 与提示；带 force 才创建', async () => {
    const customer = (await server.request('POST', '/api/customers', { body: { company: 'Already A Customer Ltd' } })).json
    const saved = await callTool('save_prospects', {
      prospects: [{ company: 'Already A Customer Ltd', evidence: [{ kind: 'website', url: 'https://already-customer.example' }] }],
    })
    expect(saved.json.created).toBe(1)
    const id = saved.json.items[0].id
    const blocked = await callTool('convert_prospect_to_customer', { prospectId: id })
    expect(blocked.ok, blocked.text).toBe(true)
    expect(blocked.json).toMatchObject({ converted: false, duplicate: true })
    expect(blocked.json.matches).toEqual([{ customerId: customer.id, company: 'Already A Customer Ltd', owner: blockOwner(blocked.json.matches[0].owner), matchedBy: ['company'] }])
    expect(blocked.json.hint).toContain('force=true')
    expect(prospectService.require(id).status).toBe('new')

    const forced = await callTool('convert_prospect_to_customer', { prospectId: id, force: true })
    expect(forced.json.converted).toBe(true)
    expect(prospectService.require(id).status).toBe('converted')
  })
})

/** 本机模式的负责人名；断言里只要求与 matches 自身一致 */
const blockOwner = (owner: string) => owner

describe('RBAC', () => {
  it('viewer 角色调用 save_prospects → 无权限（本机模式没有真实角色，用 runAs 模拟 viewer 身份走同一套权限检查）', async () => {
    const { runAs, LOCAL_ACTOR } = await import('../src/context.js')
    const viewer = { ...LOCAL_ACTOR, id: 'viewer-user', name: 'viewer', role: 'viewer' as const }
    const outcome = await runAs(viewer, () =>
      registry.runTool(registry.findTool('save_prospects')!, { prospects: [{ company: 'Viewer Co', evidence: [{ kind: 'manual' }] }] }, ctx()),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('只读角色')
    expect(prospectService.list({ q: 'Viewer Co' }).total).toBe(0)
    // 读工具仍可用
    const read = await runAs(viewer, () => registry.runTool(registry.findTool('list_prospects')!, {}, ctx()))
    expect(read.ok, read.text).toBe(true)
  })
})

describe('market_overview', () => {
  it('原样返回国家行与 coverage', async () => {
    const res = await callTool('market_overview', { hs: '841370', years: [2023, 2024], flow: 'M', top: 5 })
    expect(res.ok, res.text).toBe(true)
    expect(res.json.year).toBe(2024)
    expect(res.json.rows).toHaveLength(5)
    expect(res.json.rows[0].country).toBe('US')
    expect(res.json.rows.every((row: any) => Number.isFinite(row.valueUsd))).toBe(true)
    expect(res.json.coverage).toMatchObject({ reporters: expect.any(Number) })
    expect(res.json.source.name).toBe('UN Comtrade')
  })
})

describe('工具集意图', () => {
  it('“帮我找英国买 8413 水泵的进口商”命中 prospecting；“这个公司在不在制裁名单”也命中', async () => {
    const { TOOLSETS } = await import('../src/services/tools/toolsets.js')
    const prospecting = TOOLSETS.find((set) => set.id === 'prospecting')!
    expect(prospecting.tools).toEqual([
      'find_uk_importers',
      'market_overview',
      'screen_sanctions',
      'save_prospects',
      'list_prospects',
      'get_prospect',
      'update_prospect',
      'convert_prospect_to_customer',
    ])
    expect(prospecting.intent.test('帮我找英国买 8413 水泵的进口商')).toBe(true)
    expect(prospecting.intent.test('这个公司在不在制裁名单')).toBe(true)
    expect(prospecting.intent.test('帮我找一下潜在客户')).toBe(true)
    expect(prospecting.intent.test('查一下这个 HS code 的市场规模')).toBe(true)
    expect(prospecting.intent.test('find importers in the UK for this product')).toBe(true)
    expect(prospecting.intent.test('screen this company against OFAC')).toBe(true)
    // 不误伤不相干的意图
    expect(prospecting.intent.test('你好')).toBe(false)
    expect(prospecting.intent.test('看看这周有哪些逾期应收，帮我催款')).toBe(false)
    expect(prospecting.intent.test('帮我生成一份报价单 PDF')).toBe(false)
  })
})

describe('LULUX MCP 桥', () => {
  it('tools/list 里有 find_uk_importers 与 save_prospects（业务组自动经 MCP 暴露）', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-pi'], permissionLevel: 'full' } })
    expect(session.status, session.text).toBe(201)
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      let id = 0
      const rpc = async (method: string, params: Record<string, unknown> = {}) =>
        (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      const tools = (await rpc('tools/list')).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>
      const names = tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['find_uk_importers', 'market_overview', 'screen_sanctions', 'save_prospects', 'list_prospects', 'get_prospect', 'update_prospect', 'convert_prospect_to_customer']))
      expect(tools.find((tool) => tool.name === 'save_prospects')!.annotations.readOnlyHint).toBe(false)
      expect(tools.find((tool) => tool.name === 'find_uk_importers')!.annotations.readOnlyHint).toBe(true)
      // 经 MCP 也能真正执行（制裁名单本地数据，不访问网络）
      const listed = await rpc('tools/call', { name: 'screen_sanctions', arguments: { names: ['Purmo Group UK'] } })
      expect(listed.result.isError ?? false).toBe(false)
      expect(JSON.parse(listed.result.content[0].text).items[0].hits[0].list).toBe('custom')
    } finally {
      issued.revoke()
    }
  })
})
