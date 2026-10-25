import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 开发客户 / 潜客（prospects）：校验与规范化、upsert 合并、与客户查重、转客户、
 * 行级可见性、列表筛选、评分函数、回收站、导出 / 导入。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
type Who = { token: string; id: string; role: string }
let owner: Who
let alice: Who
let bob: Who
let viewer: Who
let teamId = ''

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })
const DAY = 86_400_000

async function invite(role: string, email: string, team?: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role, ...(team ? { teamId: team } : {}) })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, role }
}

async function createWho(who: Who, body: Record<string, unknown>) {
  const res = await as(who, 'POST', '/api/prospects', body)
  expect(res.status, res.text).toBe(201)
  return res.json
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id, role: 'owner' }
  const team = await as(owner, 'POST', '/api/team/teams', { name: '外贸一组' })
  expect(team.status, team.text).toBe(201)
  teamId = team.json.id
  alice = await invite('member', 'alice@acme.com', teamId)
  bob = await invite('member', 'bob@acme.com', teamId)
  viewer = await invite('viewer', 'viewer@acme.com')
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('校验与规范化', () => {
  it('坏 URL / 坏 HS / 坏邮箱 / 坏国家代码返回 400，错误码与客户接口一致', async () => {
    const badUrl = await as(alice, 'POST', '/api/prospects', { company: 'Bad Url Co', website: 'ftp://files.example.com' })
    expect(badUrl.status).toBe(400)
    expect(badUrl.json.error.code).toBe('VALIDATION_ERROR')
    const jsUrl = await as(alice, 'POST', '/api/prospects', { company: 'Bad Url Co', socialLinks: ['javascript:alert(1)'] })
    expect(jsUrl.status).toBe(400)
    const badHs = await as(alice, 'POST', '/api/prospects', { company: 'Bad Hs Co', hsCodes: ['84A1'] })
    expect(badHs.status).toBe(400)
    expect(badHs.json.error.message).toContain('HS')
    const shortHs = await as(alice, 'POST', '/api/prospects', { company: 'Bad Hs Co', hsCodes: ['8'] })
    expect(shortHs.status).toBe(400)
    const badEmail = await as(alice, 'POST', '/api/prospects', { company: 'Bad Mail Co', emails: ['not-an-email'] })
    expect(badEmail.status).toBe(400)
    const badCountry = await as(alice, 'POST', '/api/prospects', { company: 'Bad Country Co', country: 'USA' })
    expect(badCountry.status).toBe(400)
    const noCompany = await as(alice, 'POST', '/api/prospects', { company: '   ' })
    expect(noCompany.status).toBe(400)
  })

  it('country 规范化为大写两位、链接补协议、HS 去点去空白并去重、邮箱小写去重、证据截断', async () => {
    const snippet = 'x'.repeat(1500)
    const created = await createWho(alice, {
      company: 'Normalize Me s.r.o.',
      country: ' cz ',
      website: 'www.normalize-me.cz/about',
      hsCodes: ['8481.80', '848180', ' 8481 80 ', '8481 90'],
      emails: ['Sales@Normalize-Me.CZ', 'sales@normalize-me.cz', ''],
      socialLinks: ['linkedin.com/company/normalize-me'],
      evidence: [
        { kind: 'customs', source: 'hmrc', url: 'hmrc.gov.uk/record/1', title: 'Import', snippet, observedAt: 1, fields: ['lastImportAt'] },
        { kind: 'customs', source: 'hmrc', url: 'https://hmrc.gov.uk/record/1', title: 'Import', snippet: 'x', fields: [] },
      ],
    })
    expect(created.country).toBe('CZ')
    expect(created.website).toBe('https://www.normalize-me.cz/about')
    expect(created.hsCodes.sort()).toEqual(['848180', '848190'])
    expect(created.emails).toEqual(['sales@normalize-me.cz'])
    expect(created.socialLinks).toEqual(['https://linkedin.com/company/normalize-me'])
    expect(created.evidence).toHaveLength(1)
    expect(created.evidence[0].snippet).toHaveLength(1000)
    // 空国家 / 空链接可以接受
    const empty = await createWho(alice, { company: 'Empty Fields Co', country: '', website: '' })
    expect(empty.country).toBe('')
    expect(empty.website).toBe('')
  })
})

describe('upsert 合并', () => {
  it('按公司名合并且不覆盖已填值；证据去重追加，日期 / 次数取最大，数组取并集', async () => {
    const t1 = Date.now() - 200 * DAY
    const t2 = Date.now() - 10 * DAY
    const first = await as(alice, 'POST', '/api/prospects/upsert', {
      company: 'Nordic Valves AS',
      website: 'nordicvalves.no',
      hsCodes: ['848180'],
      emails: ['buyer@nordicvalves.no'],
      phones: ['+47 22 00 00 00'],
      evidence: [{ kind: 'customs', source: 'importyeti', url: 'https://importyeti.com/x', title: 'Shipment', snippet: 'a', observedAt: t1 }],
      lastImportAt: t1,
      shipments: 5,
      address: '',
    })
    expect(first.status, first.text).toBe(200)
    expect(first.json.created).toBe(true)
    const id = first.json.prospect.id

    const second = await as(alice, 'POST', '/api/prospects/upsert', {
      company: 'NORDIC VALVES',
      website: 'https://www.nordicvalves.no/about',
      hsCodes: ['8481.80', '8481.90'],
      emails: ['SALES@nordicvalves.no', 'other@nordicvalves.no'],
      evidence: [
        { kind: 'customs', source: 'importyeti', url: 'https://importyeti.com/x', title: 'Shipment', snippet: 'a' },
        { kind: 'website', source: 'web', url: 'https://nordicvalves.no', title: 'About', snippet: 'valves' },
      ],
      lastImportAt: t2,
      shipments: 2,
      address: 'Storgata 1, Oslo',
      products: 'Industrial valves',
    })
    expect(second.status, second.text).toBe(200)
    expect(second.json.created).toBe(false)
    const p = second.json.prospect
    expect(p.id).toBe(id)
    expect(p.hsCodes.sort()).toEqual(['848180', '848190'])
    expect(p.emails.sort()).toEqual(['buyer@nordicvalves.no', 'other@nordicvalves.no', 'sales@nordicvalves.no'])
    expect(p.evidence).toHaveLength(2)
    expect(p.evidence.map((e: { kind: string }) => e.kind).sort()).toEqual(['customs', 'website'])
    expect(p.lastImportAt).toBe(t2)
    expect(p.shipments).toBe(5)
    expect(p.address).toBe('Storgata 1, Oslo')
    expect(p.products).toBe('Industrial valves')
    // 公司名保持第一次写入的写法
    expect(p.company).toBe('Nordic Valves AS')

    // 再合并一次：更旧日期不覆盖，非空值不被覆盖
    const third = await as(alice, 'POST', '/api/prospects/upsert', {
      company: 'Nordic Valves',
      address: 'Other address',
      products: 'Other products',
      lastImportAt: t1,
      shipments: 1,
      notes: '追加的备注',
    })
    expect(third.json.created).toBe(false)
    expect(third.json.prospect.address).toBe('Storgata 1, Oslo')
    expect(third.json.prospect.products).toBe('Industrial valves')
    expect(third.json.prospect.lastImportAt).toBe(t2)
    expect(third.json.prospect.shipments).toBe(5)
    // 空的旧值则补上
    expect(third.json.prospect.notes).toBe('追加的备注')
  })

  it('按官网合并：公司名不同但 website_key 相同', async () => {
    const a = await as(alice, 'POST', '/api/prospects/upsert', { company: 'Website Match A', website: 'https://www.websitematch.example' })
    const b = await as(alice, 'POST', '/api/prospects/upsert', { company: 'Website Match B', website: 'websitematch.example/contact' })
    expect(b.json.created).toBe(false)
    expect(b.json.prospect.id).toBe(a.json.prospect.id)
    expect(b.json.prospect.company).toBe('Website Match A')
  })
})

describe('与客户查重', () => {
  it('可见范围内已有客户 → flags 带 customer_exists 并返回 matchedCustomer；别人的私有客户不算', async () => {
    const customer = await as(alice, 'POST', '/api/customers', { company: 'Globex Industrial Ltd', website: 'https://globex-industrial.example' })
    expect(customer.status, customer.text).toBe(201)
    const byCompany = await createWho(alice, { company: 'GLOBEX INDUSTRIAL' })
    expect(byCompany.flags).toContain('customer_exists')
    expect(byCompany.matchedCustomer).toEqual({ id: customer.json.id, company: 'Globex Industrial Ltd' })
    const byWebsite = await as(alice, 'POST', '/api/prospects/upsert', { company: 'Totally Different Name', website: 'globex-industrial.example/about' })
    expect(byWebsite.json.matchedCustomer?.id).toBe(customer.json.id)
    expect(byWebsite.json.prospect.flags).toContain('customer_exists')

    // bob 看不到 alice 的私有客户，也不会被打标记
    const hidden = await as(bob, 'POST', '/api/customers', { company: 'Hidden Buyer Ltd' })
    expect(hidden.status, hidden.text).toBe(201)
    const clean = await createWho(alice, { company: 'Hidden Buyer' })
    expect(clean.flags).not.toContain('customer_exists')
    expect(clean.matchedCustomer).toBeUndefined()
    // 更新公司名后会重新计算标记
    const renamed = await as(alice, 'PATCH', `/api/prospects/${clean.id}`, { company: 'GLOBEX INDUSTRIAL LTD' })
    expect(renamed.json.flags).toContain('customer_exists')
    expect(renamed.json.matchedCustomer.id).toBe(customer.json.id)
  })
})

describe('转为客户', () => {
  it('成功创建客户：source=prospect、备注带证据摘要、潜客标记 converted 并关联', async () => {
    const prospect = await createWho(alice, {
      company: 'Convert Target GmbH',
      country: 'DE',
      website: 'https://convert-target.example',
      emails: ['vertrieb@convert-target.example'],
      phones: ['+49 30 123456'],
      notes: '展会认识的采购',
      evidence: [{ kind: 'customs', source: 'hmrc', url: 'https://hmrc.gov.uk/rec/42', title: 'Import record', snippet: '4 shipments' }],
    })
    const converted = await as(alice, 'POST', `/api/prospects/${prospect.id}/convert`, {})
    expect(converted.status, converted.text).toBe(200)
    expect(converted.json.converted).toBe(true)
    const customerId = converted.json.customer.id
    expect(converted.json.prospect).toMatchObject({ status: 'converted', customerId })

    const customer = await as(alice, 'GET', `/api/customers/${customerId}`)
    expect(customer.status).toBe(200)
    expect(customer.json).toMatchObject({ company: 'Convert Target GmbH', country: 'DE', source: 'prospect' })
    expect(customer.json.notes).toContain('展会认识的采购')
    expect(customer.json.notes).toContain('https://hmrc.gov.uk/rec/42')
    expect(customer.json.contacts[0]).toMatchObject({ email: 'vertrieb@convert-target.example', phone: '+49 30 123456', isPrimary: true })

    const again = await as(alice, 'POST', `/api/prospects/${prospect.id}/convert`, {})
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('PROSPECT_ALREADY_CONVERTED')
  })

  it('与现有客户重复且未 force：不创建、返回 duplicate 报告；force 后创建', async () => {
    const existing = await as(alice, 'POST', '/api/customers', { company: 'Dup Convert Ltd' })
    expect(existing.status, existing.text).toBe(201)
    const prospect = await createWho(alice, { company: 'Dup Convert' })
    const before = (await as(owner, 'GET', '/api/customers?query=Dup%20Convert')).json.total

    const blocked = await as(alice, 'POST', `/api/prospects/${prospect.id}/convert`, {})
    expect(blocked.status, blocked.text).toBe(200)
    expect(blocked.json).toMatchObject({ converted: false, duplicate: true })
    expect(blocked.json.matches).toEqual([{ customerId: existing.json.id, company: 'Dup Convert Ltd', owner: 'alice', matchedBy: ['company'] }])
    expect((await as(alice, 'GET', `/api/prospects/${prospect.id}`)).json.status).toBe('new')
    expect((await as(owner, 'GET', '/api/customers?query=Dup%20Convert')).json.total).toBe(before)

    const forced = await as(alice, 'POST', `/api/prospects/${prospect.id}/convert`, { force: true })
    expect(forced.status, forced.text).toBe(200)
    expect(forced.json.converted).toBe(true)
    expect((await as(owner, 'GET', '/api/customers?query=Dup%20Convert')).json.total).toBe(before + 1)
    expect((await as(alice, 'GET', `/api/prospects/${prospect.id}`)).json.status).toBe('converted')
  })
})

describe('行级可见性（团队模式）', () => {
  it('别人的 private 潜客看不到、改不了；team 共享的同组可读不可改；viewer 只读不能写删', async () => {
    const privateOne = await createWho(alice, { company: 'Alice Private Prospect' })
    expect(privateOne.visibility).toBe('private')
    expect((await as(bob, 'GET', `/api/prospects/${privateOne.id}`)).status).toBe(404)
    expect((await as(bob, 'PATCH', `/api/prospects/${privateOne.id}`, { notes: 'hijack' })).status).toBe(404)
    expect((await as(bob, 'DELETE', `/api/prospects/${privateOne.id}`)).status).toBe(404)
    const bobList = await as(bob, 'GET', '/api/prospects?q=Alice%20Private')
    expect(bobList.status).toBe(200)
    expect(bobList.json.items.some((p: { id: string }) => p.id === privateOne.id)).toBe(false)
    expect((await as(owner, 'GET', `/api/prospects/${privateOne.id}`)).status).toBe(200)

    const shared = await createWho(alice, { company: 'Alice Team Prospect', visibility: 'team', teamId })
    expect((await as(bob, 'GET', `/api/prospects/${shared.id}`)).status).toBe(200)
    expect((await as(bob, 'GET', '/api/prospects?q=Alice%20Team')).json.items.some((p: { id: string }) => p.id === shared.id)).toBe(true)
    expect((await as(bob, 'PATCH', `/api/prospects/${shared.id}`, { notes: 'x' })).status).toBe(403)
    expect((await as(bob, 'DELETE', `/api/prospects/${shared.id}`)).status).toBe(403)
    // 不能共享给自己不在的团队
    const other = await as(owner, 'POST', '/api/team/teams', { name: '二组' })
    expect((await as(alice, 'POST', '/api/prospects', { company: 'Wrong Team', visibility: 'team', teamId: other.json.id })).status).toBe(400)

    expect((await as(viewer, 'GET', '/api/prospects')).status).toBe(200)
    expect((await as(viewer, 'POST', '/api/prospects', { company: 'Viewer Co' })).status).toBe(403)
    expect((await as(viewer, 'DELETE', `/api/prospects/${shared.id}`)).status).toBe(403)
  })
})

describe('列表筛选与排序', () => {
  let alpha = ''
  let beta = ''
  let gamma = ''
  beforeAll(async () => {
    alpha = (
      await createWho(alice, {
        company: 'Filter Alpha Valves',
        website: 'https://filter-alpha.example',
        hsCodes: ['902830'],
        searchQuery: 'flow meters hs:9028 GB 2025',
        emails: ['buyer@filter-alpha.example'],
        evidence: [{ kind: 'bill_of_lading', source: 'importyeti', url: 'https://importyeti.com/a', title: 'BL', snippet: 'x' }],
        lastImportAt: Date.now() - 10 * DAY,
        shipments: 12,
      })
    ).id
    beta = (
      await createWho(alice, {
        company: 'Filter Beta Pumps',
        hsCodes: ['841370'],
        emails: ['beta.pumps@gmail.com'],
        status: 'contacted',
      })
    ).id
    gamma = (
      await createWho(alice, {
        company: 'Filter Gamma Castings',
        products: 'valve bodies and castings',
        website: 'https://filter-gamma.example',
        flags: ['forwarder'],
        status: 'ignored',
      })
    ).id
  })

  const ids = (res: { json: { items: Array<{ id: string }> } }) => res.json.items.map((p) => p.id)

  it('q 匹配公司名 / 网站 / 主营产品 / HS 编码', async () => {
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter')).sort()).toEqual([alpha, beta, gamma].sort())
    expect(ids(await as(alice, 'GET', '/api/prospects?q=castings'))).toEqual([gamma])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter%20alpha'))).toEqual([alpha])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=902'))).toEqual([alpha])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter-gamma.example'))).toEqual([gamma])
  })

  it('status / minScore / hasCustomsEvidence / flag 筛选与 total', async () => {
    const contacted = await as(alice, 'GET', '/api/prospects?q=filter&status=contacted')
    expect(ids(contacted)).toEqual([beta])
    expect(contacted.json.total).toBe(1)
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter&status=ignored'))).toEqual([gamma])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter&minScore=50'))).toEqual([alpha])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter&hasCustomsEvidence=true'))).toEqual([alpha])
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter&hasCustomsEvidence=false')).sort()).toEqual([beta, gamma].sort())
    expect(ids(await as(alice, 'GET', '/api/prospects?q=filter&flag=forwarder'))).toEqual([gamma])
  })

  it('sort=score / updated / lastImport；limit 与 offset', async () => {
    const byScore = await as(alice, 'GET', '/api/prospects?q=filter&sort=score')
    expect(ids(byScore)).toEqual([alpha, beta, gamma])
    expect(byScore.json.items.map((p: { score: number }) => p.score)).toEqual([80, 2, 0])
    const byImport = await as(alice, 'GET', '/api/prospects?q=filter&sort=lastImport')
    expect(ids(byImport)[0]).toBe(alpha)
    const byUpdated = await as(alice, 'GET', '/api/prospects?q=filter&sort=updated')
    expect(ids(byUpdated)[0]).toBe(gamma)
    const paged = await as(alice, 'GET', '/api/prospects?q=filter&sort=score&limit=1&offset=1')
    expect(ids(paged)).toEqual([beta])
    expect(paged.json.total).toBe(3)
    expect((await as(alice, 'GET', '/api/prospects?limit=500')).status).toBe(400)
  })

  it('PATCH 状态与字段后重新计分', async () => {
    const patched = await as(alice, 'PATCH', `/api/prospects/${gamma}`, { flags: [] })
    expect(patched.status, patched.text).toBe(200)
    expect(patched.json.flags).toEqual([])
    expect(patched.json.score).toBe(8)
    const status = await as(alice, 'PATCH', `/api/prospects/${gamma}`, { status: 'contacted' })
    expect(status.json.status).toBe('contacted')
    await as(alice, 'PATCH', `/api/prospects/${gamma}`, { flags: ['forwarder'], status: 'ignored' })
  })
})

describe('targetHsOf', () => {
  it('只认 hs 前缀后的编码，年份等数字不算', async () => {
    const { targetHsOf } = await import('../src/services/prospect-service.js')
    expect(targetHsOf('flow meters hs:9028 GB 2025')).toEqual(['9028'])
    expect(targetHsOf('HS 8413.70, 8414')).toEqual(['841370', '8414'])
    expect(targetHsOf('pumps 2025 UK 500 units')).toEqual([])
    expect(targetHsOf('hs：848180/848190')).toEqual(['848180', '848190'])
  })
})

describe('scoreProspect', () => {
  const base = {
    hsCodes: [] as string[],
    evidence: [] as Array<{ kind: string; source?: string }>,
    lastImportAt: null as number | null,
    shipments: null as number | null,
    website: '',
    emails: [] as string[],
    flags: [] as string[],
  }
  const now = Date.now()

  it('HS 匹配分档、海关证据、进口时效、进口次数、官网 / 企业邮箱、证据来源数', async () => {
    const { scoreProspect } = await import('../src/services/prospect-service.js')
    expect(scoreProspect(base, { now }).score).toBe(0)
    // 6 位 / 4 位 / 2 位
    expect(scoreProspect({ ...base, hsCodes: ['848180'] }, { targetHs: ['848190'], now }).score).toBe(20)
    expect(scoreProspect({ ...base, hsCodes: ['848180'] }, { targetHs: ['8481'], now }).score).toBe(20)
    expect(scoreProspect({ ...base, hsCodes: ['848180'] }, { targetHs: ['84'], now }).score).toBe(8)
    expect(scoreProspect({ ...base, hsCodes: ['848180'] }, { targetHs: ['848180'], now }).score).toBe(30)
    // 没有目标 HS 不加分
    expect(scoreProspect({ ...base, hsCodes: ['848180'] }, { now }).score).toBe(0)

    expect(scoreProspect({ ...base, evidence: [{ kind: 'customs' }] }, { now }).score).toBe(20)
    expect(scoreProspect({ ...base, evidence: [{ kind: 'bill_of_lading' }] }, { now }).score).toBe(20)
    expect(scoreProspect({ ...base, evidence: [{ kind: 'website' }] }, { now }).score).toBe(0)

    expect(scoreProspect({ ...base, lastImportAt: now - 30 * DAY }, { now }).score).toBe(15)
    expect(scoreProspect({ ...base, lastImportAt: now - 200 * DAY }, { now }).score).toBe(8)
    expect(scoreProspect({ ...base, lastImportAt: now - 400 * DAY }, { now }).score).toBe(0)

    expect(scoreProspect({ ...base, shipments: 10 }, { now }).score).toBe(10)
    expect(scoreProspect({ ...base, shipments: 3 }, { now }).score).toBe(5)
    expect(scoreProspect({ ...base, shipments: 2 }, { now }).score).toBe(0)

    expect(scoreProspect({ ...base, website: 'https://x.example' }, { now }).score).toBe(8)
    expect(scoreProspect({ ...base, emails: ['buyer@acme-industries.com'] }, { now }).score).toBe(7)
    expect(scoreProspect({ ...base, emails: ['buyer@gmail.com'] }, { now }).score).toBe(2)
    expect(scoreProspect({ ...base, emails: ['buyer@gmail.com', 'boss@acme-industries.com'] }, { now }).score).toBe(7)

    expect(
      scoreProspect(
        { ...base, evidence: [{ kind: 'customs', source: 'hmrc' }, { kind: 'website', source: 'web' }, { kind: 'search', source: 'importyeti' }] },
        { now },
      ).score,
    ).toBe(25)
    expect(
      scoreProspect({ ...base, evidence: [{ kind: 'customs', source: 'hmrc' }, { kind: 'website', source: 'web' }] }, { now }).score,
    ).toBe(20)
  })

  it('扣分、sanctions_hit 归零、clamp 到 0–100，理由带中文标签', async () => {
    const { scoreProspect } = await import('../src/services/prospect-service.js')
    expect(scoreProspect({ ...base, flags: ['forwarder'] }, { now }).score).toBe(0)
    expect(scoreProspect({ ...base, website: 'https://x.example', flags: ['forwarder'] }, { now }).score).toBe(0)
    expect(scoreProspect({ ...base, flags: ['stale'] }, { now }).score).toBe(0)
    expect(scoreProspect({ ...base, website: 'https://x.example', flags: ['stale', 'website_down'] }, { now }).score).toBe(0)

    const sanctions = scoreProspect({ ...base, hsCodes: ['848180'], website: 'https://x.example', flags: ['sanctions_hit'] }, { targetHs: ['848180'], now })
    expect(sanctions.score).toBe(0)
    expect(sanctions.reasons).toEqual([{ key: 'sanctions_hit', label: '命中制裁名单', points: 0 }])

    const full = scoreProspect(
      {
        hsCodes: ['848180'],
        evidence: [
          { kind: 'customs', source: 'hmrc' },
          { kind: 'website', source: 'web' },
          { kind: 'search', source: 'importyeti' },
        ],
        lastImportAt: now - 10 * DAY,
        shipments: 12,
        website: 'https://acme.example',
        emails: ['buyer@acme.example'],
        flags: ['customer_exists'],
      },
      { targetHs: ['848180'], now },
    )
    expect(full.score).toBe(95)
    expect(full.reasons.map((r) => r.label)).toContain('HS 编码前 6 位匹配')
    expect(full.reasons.every((r) => r.label.length > 0)).toBe(true)
  })
})

describe('回收站', () => {
  it('删除进回收站（实体 prospect，标签「潜客」），列表不再出现，可恢复', async () => {
    const prospect = await createWho(alice, { company: 'Trash Prospect Co' })
    const { TRASH_LABELS } = await import('../src/services/trash.js')
    expect(TRASH_LABELS.prospect).toBe('潜客')

    expect((await as(alice, 'DELETE', `/api/prospects/${prospect.id}`)).status).toBe(204)
    expect((await as(alice, 'GET', `/api/prospects/${prospect.id}`)).status).toBe(404)
    expect((await as(alice, 'GET', '/api/prospects?q=Trash%20Prospect')).json.total).toBe(0)

    const bin = await as(alice, 'GET', '/api/trash?entity=prospect')
    expect(bin.status, bin.text).toBe(200)
    const item = bin.json.items.find((i: { id: string }) => i.id === prospect.id)
    expect(item).toMatchObject({ entity: 'prospect', title: 'Trash Prospect Co' })

    const audit = await as(owner, 'GET', `/api/audit?action=prospect.delete&entityId=${prospect.id}`)
    expect(audit.status).toBe(200)
    expect(audit.json.items[0].meta.snapshot.company).toBe('Trash Prospect Co')

    // 别人看不到也恢复不了
    expect((await as(bob, 'GET', '/api/trash?entity=prospect')).json.items.some((i: { id: string }) => i.id === prospect.id)).toBe(false)
    expect((await as(bob, 'POST', `/api/trash/prospect/${prospect.id}/restore`)).status).toBe(404)

    const restored = await as(alice, 'POST', `/api/trash/prospect/${prospect.id}/restore`)
    expect(restored.status, restored.text).toBe(200)
    expect(restored.json).toMatchObject({ entity: 'prospect', id: prospect.id, restored: 1 })
    expect((await as(alice, 'GET', `/api/prospects/${prospect.id}`)).json.company).toBe('Trash Prospect Co')
  })

  it('viewer 不能删除', async () => {
    const prospect = await createWho(alice, { company: 'Viewer Delete Target' })
    expect((await as(viewer, 'DELETE', `/api/prospects/${prospect.id}`)).status).toBe(403)
  })
})

describe('导出 / 导入', () => {
  it('导出包含 prospects；导入按 id 覆盖并保留转客户关联', async () => {
    const prospect = await createWho(alice, { company: 'Export Prospect Co', hsCodes: ['848180'], country: 'US' })
    const exported = await as(owner, 'GET', '/api/data/export')
    expect(exported.status, exported.text).toBe(200)
    const inExport = exported.json.prospects.find((p: { id: string }) => p.id === prospect.id)
    expect(inExport).toMatchObject({ company: 'Export Prospect Co', country: 'US' })
    expect(exported.json.prospects.length).toBeGreaterThan(0)

    await as(alice, 'DELETE', `/api/prospects/${prospect.id}`)
    expect((await as(alice, 'GET', `/api/prospects/${prospect.id}`)).status).toBe(404)

    const imported = await as(owner, 'POST', '/api/data/import', exported.json)
    expect(imported.status, imported.text).toBe(200)
    expect(imported.json.imported.prospects).toBe(exported.json.prospects.length)
    const restored = await as(alice, 'GET', `/api/prospects/${prospect.id}`)
    expect(restored.status).toBe(200)
    expect(restored.json).toMatchObject({ company: 'Export Prospect Co', country: 'US', hsCodes: ['848180'] })
  })

  it('数据概览包含潜客数量', async () => {
    const summary = await as(owner, 'GET', '/api/data/summary')
    expect(summary.json).toMatchObject({ prospects: expect.any(Number) })
  })
})
