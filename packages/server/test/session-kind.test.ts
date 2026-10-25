import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 会话类型（迁移 17）：单聊恰好一个内核；群聊只能新建（空历史），单聊永远不会因加成员变成群聊。
 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
}, 30_000)

afterAll(async () => {
  await server?.close()
})

const create = (body: Record<string, unknown>) => server.request('POST', '/api/sessions', { body })
const patch = (id: string, body: Record<string, unknown>) => server.request('PATCH', `/api/sessions/${id}`, { body })

describe('会话类型 kind', () => {
  it('新建单聊：kind single，恰好一个内核；切换内核仍是单聊', async () => {
    const res = await create({ agentIds: ['builtin'] })
    expect(res.status).toBe(201)
    expect(res.json.session).toMatchObject({ kind: 'single', agentIds: ['builtin'], groupName: null })
    const id = res.json.session.id
    const switched = await patch(id, { agentIds: ['kernel-pi'] })
    expect(switched.status).toBe(200)
    expect(switched.json.session).toMatchObject({ kind: 'single', agentIds: ['kernel-pi'] })
    const listed = (await server.request('GET', '/api/sessions')).json.sessions.find((s: any) => s.id === id)
    expect(listed.kind).toBe('single')
  })

  it('单聊不能加成员变成群聊（400），历史与成员都不变', async () => {
    const id = (await create({ agentIds: ['builtin'] })).json.session.id
    const res = await patch(id, { agentIds: ['builtin', 'kernel-pi'] })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('SESSION_KIND')
    const after = (await server.request('GET', `/api/sessions/${id}`)).json.session
    expect(after).toMatchObject({ kind: 'single', agentIds: ['builtin'] })
    // 单聊也不能设群名 / 主管
    expect((await patch(id, { groupName: '外贸小组' })).status).toBe(400)
    expect((await patch(id, { supervisorId: 'none' })).status).toBe(400)
    // 显式 kind single 带多个成员、单聊带主管：拒绝
    expect((await create({ kind: 'single', agentIds: ['builtin', 'kernel-pi'] })).status).toBe(400)
    expect((await create({ agentIds: ['builtin'], supervisorId: 'none' })).status).toBe(400)
  })

  it('新建群聊：总是新会话、空历史，带群名与默认主管；可只有一个成员', async () => {
    const res = await create({ kind: 'group', agentIds: ['builtin', 'kernel-pi'], groupName: '报价小组' })
    expect(res.status).toBe(201)
    expect(res.json.session).toMatchObject({
      kind: 'group',
      agentIds: ['builtin', 'kernel-pi'],
      groupName: '报价小组',
      supervisorId: 'builtin',
      messageCount: 0,
    })
    expect((await server.request('GET', `/api/sessions/${res.json.session.id}`)).json.messages).toEqual([])

    const solo = await create({ kind: 'group', agentIds: ['kernel-pi'], supervisorId: 'none' })
    expect(solo.json.session).toMatchObject({ kind: 'group', agentIds: ['kernel-pi'], supervisorId: 'none' })
  })

  it('群聊内增删成员仍是群聊；减到一个成员也还是群聊；不能清空', async () => {
    const id = (await create({ kind: 'group', agentIds: ['builtin', 'kernel-pi'] })).json.session.id
    let res = await patch(id, { agentIds: ['builtin', 'kernel-pi', 'kernel-hermes'] })
    expect(res.json.session).toMatchObject({ kind: 'group', agentIds: ['builtin', 'kernel-pi', 'kernel-hermes'] })
    res = await patch(id, { agentIds: ['kernel-hermes'] })
    expect(res.status).toBe(200)
    expect(res.json.session).toMatchObject({ kind: 'group', agentIds: ['kernel-hermes'] })
    expect((await patch(id, { agentIds: [] })).status).toBe(400)
    expect((await patch(id, { agentIds: ['nobody'] })).status).toBe(400)
  })

  it('不带 kind 时按成员数推断（兼容旧客户端）；旧 persona id 合并后是单聊', async () => {
    expect((await create({ agentIds: ['builtin', 'kernel-pi'] })).json.session.kind).toBe('group')
    expect((await create({ agentIds: ['hermes', 'claude'] })).json.session).toMatchObject({ kind: 'single', agentIds: ['builtin'] })
    expect((await create({})).json.session.kind).toBe('single')
  })
})

describe('迁移 17：回填 kind', () => {
  it('成员多于一个的旧会话回填为群聊，其余为单聊', async () => {
    process.env.LULUX_ETA_HOME ??= mkdtempSync(join(tmpdir(), 'lulux-kind-home-'))
    const { openDatabase } = await import('../src/db.js')
    const migrations = await import('../src/db/migrations.js')
    const dir = mkdtempSync(join(tmpdir(), 'lulux-kind-'))
    const file = join(dir, 'lulux-eta.db')
    let db = openDatabase(file)
    migrations.runMigrations(db, { backupDir: join(dir, 'backups') })
    // 模拟迁移 16 的库：去掉 kind 列与 17 的记录，放入一个多成员会话、一个单成员会话
    db.exec(`
      ALTER TABLE sessions DROP COLUMN kind;
      DELETE FROM schema_migrations WHERE version = 17;
      INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('ses_many', '多人', 1, 1), ('ses_one', '单人', 1, 1);
      INSERT INTO session_members (session_id, agent_id, position) VALUES
        ('ses_many', 'builtin', 0), ('ses_many', 'kernel-pi', 1), ('ses_one', 'kernel-pi', 0);
    `)
    db.close()
    db = openDatabase(file)
    const result = migrations.runMigrations(db, { backupDir: join(dir, 'backups') })
    expect(result.applied).toEqual([17])
    const kinds = Object.fromEntries(
      (db.prepare("SELECT id, kind FROM sessions WHERE id IN ('ses_many', 'ses_one')").all() as Array<{ id: string; kind: string }>).map(
        (r) => [r.id, r.kind],
      ),
    )
    expect(kinds).toEqual({ ses_many: 'group', ses_one: 'single' })
    db.close()
  })
})
