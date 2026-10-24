import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 产品库：分类字段、批量导入（按 SKU 更新）、catalog:write 权限 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
type Who = { token: string; id: string }
let owner: Who
let member: Who
let viewer: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  member = await invite('member', 'member@acme.com')
  viewer = await invite('viewer', 'viewer@acme.com')
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('产品库', () => {
  it('分类字段可写可改，列表返回', async () => {
    const created = await as(member, 'POST', '/api/products', { name: 'Ball Valve DN50', sku: 'BV-50', category: '阀门', price: 12.5, moq: 100, hsCode: '8481.80' })
    expect(created.status, created.text).toBe(201)
    expect(created.json.category).toBe('阀门')
    const patched = await as(member, 'PATCH', `/api/products/${created.json.id}`, { category: 'Valves' })
    expect(patched.json.category).toBe('Valves')
    const list = await as(viewer, 'GET', '/api/products')
    expect(list.status).toBe(200)
    expect(list.json.find((p: { id: string }) => p.id === created.json.id).category).toBe('Valves')
  })

  it('只读角色不能新建 / 修改 / 删除 / 导入', async () => {
    const p = (await as(owner, 'POST', '/api/products', { name: 'Gate Valve' })).json
    expect((await as(viewer, 'POST', '/api/products', { name: 'x' })).status).toBe(403)
    expect((await as(viewer, 'PATCH', `/api/products/${p.id}`, { price: 1 })).status).toBe(403)
    expect((await as(viewer, 'DELETE', `/api/products/${p.id}`)).status).toBe(403)
    expect((await as(viewer, 'POST', '/api/products/import', { rows: [{ name: 'x' }] })).status).toBe(403)
  })

  it('批量导入：按 SKU 更新已有产品，新 SKU 新建，坏行给出行号', async () => {
    const res = await as(member, 'POST', '/api/products/import', {
      rows: [
        { sku: 'bv-50', name: 'Ball Valve DN50', price: '13.80', category: '阀门' },
        { sku: 'CV-25', name: 'Check Valve DN25', price: '1,200.5', moq: '50', currency: 'eur', unit: 'set' },
        { sku: 'BAD-1', name: '', price: '1' },
        { sku: 'BAD-2', name: 'Neg', price: '-3' },
        { name: 'No SKU Product' },
      ],
    })
    expect(res.status, res.text).toBe(200)
    expect(res.json.created).toBe(2)
    expect(res.json.updated).toBe(1)
    expect(res.json.errors.map((e: { row: number }) => e.row)).toEqual([3, 4])
    const list = (await as(member, 'GET', '/api/products')).json as Array<{ sku: string; price: number; currency: string; moq: number; unit: string; category: string }>
    const bv = list.filter((p) => p.sku.toLowerCase() === 'bv-50')
    expect(bv).toHaveLength(1)
    expect(bv[0]!.price).toBe(13.8)
    expect(bv[0]!.category).toBe('阀门')
    const cv = list.find((p) => p.sku === 'CV-25')!
    expect(cv).toMatchObject({ price: 1200.5, currency: 'EUR', moq: 50, unit: 'set' })
    const skipped = await as(member, 'POST', '/api/products/import', { rows: [{ sku: 'CV-25', name: 'x', price: 1 }], onDuplicate: 'skip' })
    expect(skipped.json).toMatchObject({ created: 0, updated: 0, skipped: 1 })
  })

  it('按组织隔离：别的组织的产品看不到、改不了，导入同 SKU 不会覆盖它', async () => {
    const { db } = await import('../src/db.js')
    const now = Date.now()
    db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run('org_other', 'Other', now)
    db.prepare(
      `INSERT INTO products (id, org_id, sku, name, spec, unit, price, currency, moq, hs_code, category, created_at, updated_at)
       VALUES ('prd_other', 'org_other', 'ZZ-1', 'Other Org Pump', '', 'pcs', 9, 'USD', 0, '', '', ?, ?)`,
    ).run(now, now)
    const list = (await as(owner, 'GET', '/api/products')).json as Array<{ id: string }>
    expect(list.some((p) => p.id === 'prd_other')).toBe(false)
    expect((await as(owner, 'PATCH', '/api/products/prd_other', { price: 1 })).status).toBe(404)
    expect((await as(owner, 'DELETE', '/api/products/prd_other')).status).toBe(404)
    const imported = await as(owner, 'POST', '/api/products/import', { rows: [{ sku: 'zz-1', name: 'Own Pump', price: '5' }] })
    expect(imported.json).toMatchObject({ created: 1, updated: 0 })
    const other = db.prepare("SELECT name, price FROM products WHERE id = 'prd_other'").get() as { name: string; price: number }
    expect(other).toEqual({ name: 'Other Org Pump', price: 9 })
    const created = (await as(owner, 'POST', '/api/products', { name: 'Scoped' })).json
    const orgId = (await as(owner, 'GET', '/api/auth/me')).json.org.id
    expect((db.prepare('SELECT org_id FROM products WHERE id = ?').get(created.id) as { org_id: string }).org_id).toBe(orgId)
  })
})

describe('迁移 28：产品归属组织', () => {
  it('已有产品回填到第一个组织；没有组织时保持本机', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS, runMigrations } = await import('../src/db/migrations.js')
    const before = MIGRATIONS.filter((m) => m.version < 28)
    const m28 = MIGRATIONS.filter((m) => m.version === 28)

    const withOrg = new DatabaseSync(':memory:')
    runMigrations(withOrg, {}, before)
    withOrg.exec(`
      INSERT INTO orgs (id, name, created_at) VALUES ('org_b', 'B', 2), ('org_a', 'A', 1);
      INSERT INTO products (id, sku, name, created_at, updated_at) VALUES ('p1', 'S1', 'One', 1, 1);
    `)
    runMigrations(withOrg, {}, m28)
    expect(withOrg.prepare("SELECT org_id FROM products WHERE id = 'p1'").get()).toEqual({ org_id: 'org_a' })
    withOrg.close()

    const local = new DatabaseSync(':memory:')
    runMigrations(local, {}, before)
    local.exec(`INSERT INTO products (id, sku, name, created_at, updated_at) VALUES ('p1', 'S1', 'One', 1, 1);`)
    runMigrations(local, {}, m28)
    expect(local.prepare("SELECT org_id FROM products WHERE id = 'p1'").get()).toEqual({ org_id: 'local' })
    local.close()
  })
})
