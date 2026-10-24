import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestServer, type TestServer } from './helpers.js'
import { nameKey, similarity, screen, SanctionsIndex, type ScreeningEntry } from '../src/services/sanctions/match.js'
import { parseCsv, parseOfac, parseEu, parseUn, parseCustomCsv } from '../src/services/sanctions/parse.js'

/** 制裁名单：解析（OFAC / EU / UN / 自定义）、名称匹配、下载更新、路由权限。全部离线。 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/sanctions', name), 'utf8')
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'

let server: TestServer
let ownerToken = ''
let memberToken = ''
type Service = typeof import('../src/services/sanctions/sanctions-service.js')
let svc: Service['sanctionsService']
let http: typeof import('../src/services/http-client.js')

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  // 服务模块要在测试服务（数据目录）就绪后再加载
  svc = (await import('../src/services/sanctions/sanctions-service.js')).sanctionsService
  http = await import('../src/services/http-client.js')
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await server.request('POST', '/api/auth/setup', { body: { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' } })
  ownerToken = ok.json.token
  const invite = await server.request('POST', '/api/team/invites', { body: { role: 'member' }, token: ownerToken })
  const accepted = await server.request('POST', '/api/auth/invites/accept', {
    body: { code: invite.json.code, email: 'member@acme.com', password: PASSWORD, name: 'member' },
    token: null,
  })
  expect(accepted.status, accepted.text).toBe(201)
  memberToken = accepted.json.token
}, 60_000)

afterAll(async () => {
  await server?.close()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CSV 解析器', () => {
  it('引号内的分隔符 / 换行 / 双引号转义，BOM 与 CRLF，跳过空行', () => {
    const { rows } = parseCsv('\uFEFFa,"b, c","line1\nline2"\r\n\r\n"say ""hi""",x,\n')
    expect(rows).toEqual([
      ['a', 'b, c', 'line1\nline2'],
      ['say "hi"', 'x', ''],
    ])
  })

  it('自定义分隔符与表头', () => {
    const { headers, rows } = parseCsv('h1;h2\n1;"2;3"', { delimiter: ';', hasHeader: true })
    expect(headers).toEqual(['h1', 'h2'])
    expect(rows).toEqual([['1', '2;3']])
  })
})

describe('名单解析', () => {
  it('OFAC：主名 + ALT 别名展开，-0- 视为空，备注取第 12 列', () => {
    const entries = parseOfac(fixture('sdn.csv'), fixture('alt.csv'))
    const john = entries.find((e) => e.ref === '100' && e.isAlias === 0)!
    expect(john.name).toBe('John DOE')
    expect(john.entityType).toBe('individual')
    expect(john.programs).toBe('SDNTK')
    expect(john.remarks).toContain('test individual')
    const aliases = entries.filter((e) => e.ref === '100' && e.isAlias === 1)
    expect(aliases.map((a) => a.name).sort()).toEqual(['DOE, J.', 'DOE, Johnathan'])
    expect(aliases.every((a) => a.primaryName === 'John DOE')).toBe(true)
    // 名字为 -0- 的行没有可匹配的名字，跳过
    expect(entries.some((e) => e.ref === '102')).toBe(false)
    expect(entries.find((e) => e.ref === '101' && e.isAlias === 1)!.name).toBe('Acme Trade Limited')
  })

  it('OFAC：真实格式里实体的 SDN_Type 是 -0-，记为 entity', () => {
    const entries = parseOfac('306,"BANCO NACIONAL DE CUBA",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"a.k.a. \'BNC\'."\n')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ ref: '306', entityType: 'entity', programs: 'CUBA', remarks: "a.k.a. 'BNC'." })
  })

  it('EU：同一实体多行聚合，第一个名字为主名、其余为别名，国家去重', () => {
    const entries = parseEu(fixture('eu.csv'))
    expect(entries).toHaveLength(6)
    const alpha = entries.filter((e) => e.ref === 'EU-001')
    expect(alpha.map((e) => [e.name, e.isAlias])).toEqual([
      ['Alpha Industrial GmbH', 0],
      ['Alpha Industries GmbH & Co. KG', 1],
    ])
    expect(alpha.every((e) => e.primaryName === 'Alpha Industrial GmbH')).toBe(true)
    expect(alpha[0].countries.sort()).toEqual(['AT', 'DE'])
    expect(entries.find((e) => e.name === 'Gamma Logistics OOO')!.countries.sort()).toEqual(['BY', 'RU'])
  })

  it('EU：person / enterprise 映射为 individual / entity', () => {
    const csv = 'Entity_LogicalId;NameAlias_WholeName;Entity_SubjectType_ClassificationCode\n1;Ivan Petrov;person\n2;Petro Corp;enterprise\n'
    const entries = parseEu(csv)
    expect(entries.map((e) => e.entityType)).toEqual(['individual', 'entity'])
  })

  it('UN：个人与实体、别名、编号取 REFERENCE_NUMBER，XML 实体解码', () => {
    const entries = parseUn(fixture('un.xml'))
    const ali = entries.filter((e) => e.ref === 'UN12345')
    expect(ali.find((e) => e.isAlias === 0)!.name).toBe('Ali Hassan Mohamed')
    expect(ali.filter((e) => e.isAlias === 1).map((e) => e.name)).toEqual(['Ali H. Mohamed', 'Abu Hassan'])
    expect(entries.find((e) => e.ref === 'UN11111')!).toMatchObject({ name: 'Eastern Trading FZE', entityType: 'entity' })
    expect(entries.find((e) => e.ref === 'UN22222')!.countries).toEqual(['RU'])
    const decoded = parseUn('<ENTITIES><ENTITY><REFERENCE_NUMBER>X1</REFERENCE_NUMBER><FIRST_NAME>A &amp; B &#39;Co&#39;</FIRST_NAME></ENTITY></ENTITIES>')
    expect(decoded[0].name).toBe("A & B 'Co'")
  })

  it('自定义 CSV：name 必需，表头大小写不敏感', () => {
    const entries = parseCustomCsv('Name,Country,Type,Program,Ref,Remarks\nFoo Bar Inc,us,entity,X-1,REF-1,note\n,US,,,,\n')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'Foo Bar Inc', countries: ['US'], ref: 'REF-1', programs: 'X-1', remarks: 'note' })
    expect(parseCustomCsv('company\nFoo\n')).toEqual([])
  })
})

describe('名称匹配', () => {
  it('nameKey 剥公司后缀、去重音、合并空白；全是后缀词时保留原词', () => {
    expect(nameKey('Acme Trading Ltd.')).toBe('acme')
    expect(nameKey('École Internationale S.A.')).toBe('ecole internationale')
    expect(nameKey('  The   Global   Shipping  Corp  ')).toBe('global shipping')
    expect(nameKey('Trading Group Ltd')).toBe('trading group ltd')
    expect(nameKey('温州阀门有限公司')).toBe('温州阀门有限公司')
  })

  it('similarity：后缀不同仍高分，不同名字低分', () => {
    expect(similarity('Acme Trading Ltd', 'Acme Trading Limited')).toBe(1)
    expect(similarity('Global Shipping Holdings', 'Global Shiping Holdings')).toBeGreaterThan(0.85)
    expect(similarity('Acme Trading Ltd', 'Totally Different GmbH')).toBeLessThan(0.5)
  })

  it('screen：精确 / 模糊 / 阈值 / 国家加分 / 同编号去重 / limit', () => {
    const entries: ScreeningEntry[] = [...parseOfac(fixture('sdn.csv'), fixture('alt.csv')), ...parseEu(fixture('eu.csv'))]
    const exact = screen('JOHN doe', { entries })
    expect(exact[0]).toMatchObject({ ref: '100', score: 1, matchedOn: 'exact', primaryName: 'John DOE' })
    // 主名与别名都命中同一编号时只返回一条
    expect(exact.filter((h) => h.ref === '100')).toHaveLength(1)
    const fuzzy = screen('Global Shiping Holdings', { entries })
    expect(fuzzy[0]).toMatchObject({ ref: '103', matchedOn: 'fuzzy' })
    expect(screen('Global Shiping Holdings', { entries, threshold: 0.999 })).toEqual([])
    expect(screen('Global Shipping Lines', { entries, threshold: 0.95 })).toEqual([])
    const noCountry = screen('Gamma Logistic', { entries, threshold: 0.8 })[0]
    const withCountry = screen('Gamma Logistic', { entries, threshold: 0.8, country: 'ru' })[0]
    expect(withCountry.score).toBeCloseTo(Math.min(1, noCountry.score + 0.03), 3)
    expect(screen('Alpha', { entries, threshold: 0, limit: 1 })).toHaveLength(1)
    expect(screen('Wenzhou Valve Co Ltd', { entries })).toEqual([])
    expect(screen('Ltd', { entries })).toEqual([])
  })

  it('性能：10 万条目的索引上单次查询 < 50ms', () => {
    const words = ['north', 'south', 'global', 'ocean', 'metal', 'energy', 'star', 'alpha', 'delta', 'union']
    const entries: ScreeningEntry[] = []
    for (let i = 0; i < 100_000; i++) {
      const name = `${words[i % 10]} ${Math.random().toString(36).slice(2, 8)} ${words[(i * 7) % 10]} Ltd`
      entries.push({ id: `id-${i}`, list: 'custom', ref: `ref-${i}`, name, primaryName: name, entityType: 'entity', programs: '', countries: [], isAlias: 0, nameKey: nameKey(name) })
    }
    const index = new SanctionsIndex(entries)
    const queries = ['Global Abc123 Metal Ltd', 'North Star Energy', entries[500].name, 'Unrelated Pumps Co']
    const start = performance.now()
    for (const q of queries) index.screen(q)
    const avg = (performance.now() - start) / queries.length
    expect(avg).toBeLessThan(50)
    expect(index.screen(entries[500].name)[0]).toMatchObject({ ref: 'ref-500', matchedOn: 'exact' })
  })
})

describe('名单服务', () => {
  it('importCustom 整表替换 custom 名单，并立即可筛', () => {
    expect(svc.importCustom('name,country\nFoo Bar Inc,US\nBaz Holdings,CN\n').count).toBe(2)
    expect(svc.importCustom('name,country\nFoo Bar Inc,US\n').count).toBe(1)
    expect(svc.status().find((s) => s.list === 'custom')!.entryCount).toBe(1)
    const result = svc.screen('foo bar incorporated')
    expect(result.hits[0]).toMatchObject({ list: 'custom', name: 'Foo Bar Inc', matchedOn: 'exact' })
    expect(svc.screen('Baz Holdings').hits).toEqual([])
    expect(result.checkedLists).toContain('custom')
    expect(result.listsMissing.sort()).toEqual(['eu', 'ofac', 'un'])
  })

  it('refresh 成功：OFAC 同时取 SDN 与 ALT，替换数据', async () => {
    const urls: string[] = []
    vi.spyOn(http, 'fetchWithProxy').mockImplementation(async (url: string | URL) => {
      urls.push(String(url))
      return new Response(String(url).includes('ALT') ? fixture('alt.csv') : fixture('sdn.csv'))
    })
    const result = await svc.refresh('ofac')
    expect(result).toEqual({ updated: ['ofac'], failed: [] })
    expect(urls.some((u) => u.includes('SDN.CSV'))).toBe(true)
    expect(urls.some((u) => u.includes('ALT.CSV'))).toBe(true)
    const status = svc.status().find((s) => s.list === 'ofac')!
    expect(status.error).toBeNull()
    expect(status.entryCount).toBe(7)
    expect(svc.screen('Acme Trade Limited').hits[0]).toMatchObject({ list: 'ofac', ref: '101' })
  })

  it('refresh 失败：保留旧数据并记录错误；全部失败才抛错', async () => {
    vi.spyOn(http, 'fetchWithProxy').mockRejectedValue(new Error('network error'))
    await expect(svc.refresh('ofac')).rejects.toThrow(/network error/)
    const ofac = svc.status().find((s) => s.list === 'ofac')!
    expect(ofac.error).toContain('network error')
    expect(ofac.entryCount).toBe(7)
    expect(ofac.updatedAt).not.toBeNull()
    expect(svc.screen('John Doe').hits[0]).toMatchObject({ list: 'ofac', ref: '100' })
  })

  it('refresh all：一份失败不影响另一份', async () => {
    vi.spyOn(http, 'fetchWithProxy').mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('europa')) return new Response(fixture('eu.csv'))
      if (u.includes('un.org')) return new Response('oops', { status: 503 })
      return new Response(u.includes('ALT') ? fixture('alt.csv') : fixture('sdn.csv'))
    })
    const result = await svc.refresh('all')
    expect(result.updated.sort()).toEqual(['eu', 'ofac'])
    expect(result.failed).toEqual([{ list: 'un', error: 'HTTP 503' }])
    expect(svc.screen('x').listsMissing).toEqual(['un'])
  })

  it('解析结果为空视为失败（格式变化），不清旧数据', async () => {
    vi.spyOn(http, 'fetchWithProxy').mockResolvedValue(new Response('Entity_LogicalId;Other\n'))
    await expect(svc.refresh('eu')).rejects.toThrow(/为空/)
    expect(svc.status().find((s) => s.list === 'eu')!.entryCount).toBe(6)
  })
})

describe('路由', () => {
  it('status / screen 登录即可', async () => {
    const status = await server.request('GET', '/api/sanctions/status', { token: memberToken })
    expect(status.status).toBe(200)
    expect(status.json.lists.map((l: { list: string }) => l.list).sort()).toEqual(['custom', 'eu', 'ofac', 'un'])
    const res = await server.request('POST', '/api/sanctions/screen', { body: { name: 'John DOE' }, token: memberToken })
    expect(res.status, res.text).toBe(200)
    expect(res.json.hits[0].ref).toBe('100')
    expect(res.json.disclaimer).toContain('人工核实')
    expect((await server.request('POST', '/api/sanctions/screen', { body: { name: '' }, token: memberToken })).status).toBe(400)
    expect((await server.request('POST', '/api/sanctions/screen', { body: { name: 'x' }, token: null })).status).toBe(401)
  })

  it('refresh / import 需要设置写权限：成员 403，所有者可以', async () => {
    expect((await server.request('POST', '/api/sanctions/refresh', { body: { list: 'ofac' }, token: memberToken })).status).toBe(403)
    expect((await server.request('POST', '/api/sanctions/import', { body: { csv: 'name\nX\n' }, token: memberToken })).status).toBe(403)
    const imported = await server.request('POST', '/api/sanctions/import', { body: { csv: 'name\nRoute Test Co\n' }, token: ownerToken })
    expect(imported.status, imported.text).toBe(200)
    expect(imported.json.count).toBe(1)
  })
})
