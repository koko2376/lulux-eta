import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：本机数据目录改用团队服务器模式初始化 owner 时，所有业务表里本机标记（org_id / owner_id = 'local'）的数据
 * 都划给新组织的 owner；之后的「导入数据」只认领本次导入写入的行，不顺手认领遗留数据。
 */
const PASSWORD = 'correct horse battery'
let server: TestServer
let token = ''
let ownerId = ''
const home = mkdtempSync(join(tmpdir(), 'lulux-adopt-'))

beforeAll(async () => {
  // 用 node 直接跑 tsx 的 cli：Windows 上 .bin/tsx 是 .cmd，不能 execFile
  const out = execFileSync(process.execPath, [resolve(__dirname, '../../../node_modules/tsx/dist/cli.mjs'), join(__dirname, 'fixtures/desktop-legacy-seed.ts')], {
    env: { ...process.env, LULUX_ETA_HOME: home, LULUX_MODE: 'desktop', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    encoding: 'utf8',
  })
  expect(out).toContain('SEEDED')
  server = await startTestServer({ LULUX_ETA_HOME: home, LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(home, 'setup-token'), 'utf8').trim()
  const ok = await server.request('POST', '/api/auth/setup', { token: null, body: { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' } })
  expect(ok.status, ok.text).toBe(201)
  token = ok.json.token
  ownerId = ok.json.user.id
}, 60_000)
afterAll(async () => server?.close())

const count = (r: { json: any }) => (Array.isArray(r.json) ? r.json.length : (r.json.items ?? r.json.deals ?? r.json.tasks ?? []).length)

describe('本机数据迁到团队服务器', () => {
  it('owner 初始化后能看到客户、任务、商机、潜客', async () => {
    const customers = await server.request('GET', '/api/customers', { token })
    expect(customers.json.items.map((c: any) => c.company)).toContain('Legacy Co')
    const tasks = await server.request('GET', '/api/tasks?status=all', { token })
    const deals = await server.request('GET', '/api/deals', { token })
    const prospects = await server.request('GET', '/api/prospects', { token })
    expect({ tasks: count(tasks), deals: count(deals), prospects: count(prospects) }).toEqual({ tasks: 1, deals: 1, prospects: 1 })
  })

  it('任何带归属列的表里都不再留有本机标记的行', async () => {
    const { db } = await import('../src/db.js')
    const { ownershipColumns } = await import('../src/services/auth-service.js')
    const columns = ownershipColumns()
    // 新加的业务表会被自动纳入；这里确认几张容易漏的表在列表里
    expect(columns.map((c) => c.table)).toEqual(expect.arrayContaining(['tasks', 'deals', 'orders', 'prospects', 'workflows', 'schedules', 'memory_entries', 'sequences']))
    for (const entry of columns) {
      const where = [entry.orgId ? "org_id = 'local'" : '', entry.ownerId ? "owner_id = 'local'" : ''].filter(Boolean).join(' OR ')
      if (!where) continue
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${entry.table}" WHERE ${where}`).get() as { n: number }
      expect(row.n, entry.table).toBe(0)
    }
    const owned = db.prepare('SELECT owner_id FROM tasks').all() as Array<{ owner_id: string }>
    expect(owned.every((row) => row.owner_id === ownerId)).toBe(true)
  })

  it('导入不认领导入前就存在的遗留行；启动时的补迁会把它们划给 owner', async () => {
    const { db } = await import('../src/db.js')
    const now = Date.now()
    // 模拟早期版本留下的、没被迁走的行
    db.prepare("INSERT INTO tasks (id, title, org_id, owner_id, created_at, updated_at) VALUES ('tsk_legacy_left', 'Left behind', 'local', 'local', ?, ?)").run(now, now)
    const res = await server.request('POST', '/api/data/import', {
      token,
      body: { tasks: [{ id: 'tsk_imported_1', title: 'Imported task', status: 'open', priority: 'normal', createdAt: now, updatedAt: now }] },
    })
    expect(res.status, res.text).toBe(200)
    const left = db.prepare("SELECT org_id, owner_id FROM tasks WHERE id = 'tsk_legacy_left'").get() as { org_id: string; owner_id: string }
    expect(left).toEqual({ org_id: 'local', owner_id: 'local' })
    const imported = db.prepare("SELECT owner_id FROM tasks WHERE id = 'tsk_imported_1'").get() as { owner_id: string } | undefined
    expect(imported?.owner_id).toBe(ownerId)

    const { authService } = await import('../src/services/auth-service.js')
    expect(authService.adoptLegacyLocalData()).toMatchObject({ tasks: 1 })
    const adopted = db.prepare("SELECT owner_id FROM tasks WHERE id = 'tsk_legacy_left'").get() as { owner_id: string }
    expect(adopted.owner_id).toBe(ownerId)
    expect(authService.adoptLegacyLocalData()).toEqual({})
  })
})
