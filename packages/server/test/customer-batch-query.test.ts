import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 客户列表的 FTS 搜索镜像、标签规范化表、稳定排序 + 键集游标，
 * 以及 POST /api/customers/batch 服务端批量事务（逐项失败、上限、越权）。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
type Who = { token: string; id: string }
let owner: Who
let alice: Who
let bob: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}
async function customer(who: Who, company: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await as(who, 'POST', '/api/customers', { company, contacts: [{ name: 'Buyer' }], ...extra })
  expect(res.status, res.text).toBe(201)
  return res.json.id
}
async function dbOf() {
  return (await import('../src/db.js')).db
}
const list = async (who: Who, qs: string) => {
  const res = await as(who, 'GET', `/api/customers?${qs}`)
  expect(res.status, res.text).toBe(200)
  return res.json as { items: Array<{ id: string; company: string; stage: string; tags: string[]; ownerId: string }>; total: number; nextCursor: string | null }
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@acme.com')
  bob = await invite('member', 'bob@acme.com')
}, 60_000)

afterAll(async () => server?.close())

describe('搜索镜像与标签表', () => {
  it('按联系人邮箱搜到客户；联系人改名、移到别的客户后镜像同步', async () => {
    const a = await customer(owner, 'Mirror Alpha GmbH', { contacts: [{ name: 'Hans', email: 'hans@alpha-mirror.example.com' }] })
    const b = await customer(owner, 'Mirror Beta SA')
    expect((await list(owner, 'query=alpha-mirror.example')).items.map((c) => c.id)).toEqual([a])

    const db = await dbOf()
    db.prepare("UPDATE contacts SET email = 'hans@renamed-mirror.example.com' WHERE customer_id = ?").run(a)
    expect((await list(owner, 'query=alpha-mirror.example')).total).toBe(0)
    expect((await list(owner, 'query=renamed-mirror')).items.map((c) => c.id)).toEqual([a])

    // 联系人换了客户：新客户能搜到，旧客户不再命中
    db.prepare('UPDATE contacts SET customer_id = ? WHERE customer_id = ? AND email IS NOT NULL').run(b, a)
    expect((await list(owner, 'query=renamed-mirror')).items.map((c) => c.id)).toEqual([b])
  })

  it('搜索词里的 % 和 _ 按字面匹配，不当通配符', async () => {
    const id = await customer(owner, 'Literal 100% Pumps')
    await customer(owner, 'Literal 1000 Pumps')
    expect((await list(owner, 'query=' + encodeURIComponent('100%'))).items.map((c) => c.id)).toEqual([id])
    expect((await list(owner, 'query=' + encodeURIComponent('Literal_1'))).total).toBe(0)
  })

  it('标签筛选大小写不敏感，改标签后同步', async () => {
    const id = await customer(owner, 'Tag Sync Ltd', { tags: ['VIP-Batch'] })
    expect((await list(owner, 'tag=vip-batch')).items.map((c) => c.id)).toEqual([id])
    const res = await as(owner, 'PATCH', `/api/customers/${id}`, { tags: ['other'] })
    expect(res.status, res.text).toBe(200)
    expect((await list(owner, 'tag=vip-batch')).total).toBe(0)
  })
})

describe('稳定排序与键集游标', () => {
  it('游标翻完全部结果不重复不遗漏；翻页期间新增的客户不打乱后续页', async () => {
    const ids: string[] = []
    for (let i = 0; i < 25; i += 1) ids.push(await customer(owner, `Cursor Co ${String(i).padStart(2, '0')}`, { tags: ['cursor-set'] }))
    const seen: string[] = []
    let page = await list(owner, 'tag=cursor-set&sort=company&order=asc&pageSize=10')
    expect(page.total).toBe(25)
    seen.push(...page.items.map((c) => c.id))
    await customer(owner, 'Cursor Co 00a', { tags: ['cursor-set'] }) // 排在已翻过的位置
    while (page.nextCursor) {
      page = await list(owner, `tag=cursor-set&sort=company&order=asc&pageSize=10&cursor=${page.nextCursor}`)
      seen.push(...page.items.map((c) => c.id))
    }
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  it('游标拿到别的筛选或排序上用 → 400', async () => {
    const page = await list(owner, 'tag=cursor-set&pageSize=5')
    expect(page.nextCursor).toBeTruthy()
    const res = await as(owner, 'GET', `/api/customers?tag=other&pageSize=5&cursor=${page.nextCursor}`)
    expect(res.status).toBe(400)
    const bad = await as(owner, 'GET', '/api/customers?cursor=not-a-cursor')
    expect(bad.status).toBe(400)
  })

  it('OFFSET 深分页超过上限 → CURSOR_REQUIRED', async () => {
    const res = await as(owner, 'GET', '/api/customers?page=3000&pageSize=20')
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('CURSOR_REQUIRED')
  })
})

describe('POST /api/customers/batch', () => {
  it('本页勾选改阶段：别人的客户逐项失败，其余照常提交', async () => {
    const mine1 = await customer(alice, 'Batch Mine 1')
    const mine2 = await customer(alice, 'Batch Mine 2')
    const theirs = await customer(bob, 'Batch Theirs')
    const res = await as(alice, 'POST', '/api/customers/batch', { action: 'stage', ids: [mine1, theirs, mine2, mine1], params: { stage: 'quoted' } })
    expect(res.status, res.text).toBe(200)
    expect(res.json.total).toBe(3)
    expect(res.json.succeeded).toBe(2)
    expect(res.json.failed).toHaveLength(1)
    expect(res.json.failed[0].id).toBe(theirs)
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain(res.json.failed[0].code)
    expect((await as(alice, 'GET', `/api/customers/${mine1}`)).json.stage).toBe('quoted')
    expect((await as(bob, 'GET', `/api/customers/${theirs}`)).json.stage).not.toBe('quoted')
  })

  it('加标签 / 去标签（全部筛选结果）', async () => {
    const x = await customer(owner, 'Batch Tag X', { tags: ['batch-scope'] })
    const y = await customer(owner, 'Batch Tag Y', { tags: ['batch-scope'] })
    const add = await as(owner, 'POST', '/api/customers/batch', { action: 'addTag', scope: 'all', filters: { tag: 'batch-scope' }, params: { tag: 'Hot' } })
    expect(add.status, add.text).toBe(200)
    expect(add.json).toMatchObject({ total: 2, succeeded: 2, failed: [] })
    expect((await list(owner, 'tag=hot')).items.map((c) => c.id).sort()).toEqual([x, y].sort())
    const rm = await as(owner, 'POST', '/api/customers/batch', { action: 'removeTag', ids: [x], params: { tag: 'HOT' } })
    expect(rm.json.succeeded).toBe(1)
    expect((await list(owner, 'tag=hot')).items.map((c) => c.id)).toEqual([y])
  })

  it('批量删除：名下有报价的客户被跳过并说明原因，其余进回收站', async () => {
    const free = await customer(owner, 'Batch Delete Free')
    const busy = await customer(owner, 'Batch Delete Busy')
    const q = await as(owner, 'POST', '/api/quotes', { customerId: busy, currency: 'USD', items: [{ name: 'Valve', qty: 1, unitPrice: 1 }] })
    expect(q.status, q.text).toBe(201)
    const res = await as(owner, 'POST', '/api/customers/batch', { action: 'delete', ids: [free, busy] })
    expect(res.status, res.text).toBe(200)
    expect(res.json.succeeded).toBe(1)
    expect(res.json.failed).toEqual([expect.objectContaining({ id: busy, code: 'CUSTOMER_HAS_RECORDS' })])
    expect((await as(owner, 'GET', `/api/customers/${free}`)).status).toBe(404)
    expect((await as(owner, 'GET', `/api/customers/${busy}`)).status).toBe(200)
  })

  it('参数校验：缺目标阶段、空 id、超过 200 个 id、负责人不在本组织', async () => {
    const one = await customer(owner, 'Batch Validate')
    expect((await as(owner, 'POST', '/api/customers/batch', { action: 'stage', ids: [one] })).status).toBe(400)
    expect((await as(owner, 'POST', '/api/customers/batch', { action: 'addTag', ids: [], params: { tag: 'x' } })).status).toBe(400)
    const many = Array.from({ length: 201 }, (_, i) => `id-${i}`)
    expect((await as(owner, 'POST', '/api/customers/batch', { action: 'addTag', ids: many, params: { tag: 'x' } })).status).toBe(400)
    const ghost = await as(owner, 'POST', '/api/customers/batch', { action: 'assign', ids: [one], params: { ownerId: 'no-such-user' } })
    expect(ghost.status).toBe(404)
  })

  it('批量写一条审计', async () => {
    const db = await dbOf()
    const row = db.prepare("SELECT summary FROM audit_log WHERE action = 'customer.batch' ORDER BY rowid DESC LIMIT 1").get() as { summary: string } | undefined
    expect(row?.summary).toMatch(/^批量/)
  })
})
