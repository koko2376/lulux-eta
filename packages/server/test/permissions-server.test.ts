import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 团队服务器模式的权限上限（契约 §6.11）：管理员按角色 / 成员设上限，服务端截断并对超限的 PATCH 返回 403；
 * 工作流节点的 allowWrite 不能超过负责人的上限。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''

type Who = { token: string; id: string }
let owner: Who
let admin: Who
let alice: Who
let bob: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
const script = async (...responses: unknown[]) =>
  (await fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })).json()

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  expect(created.status, created.text).toBe(201)
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  expect(ok.status, ok.text).toBe(201)
  owner = { token: ok.json.token, id: ok.json.user.id }
  admin = await invite('admin', 'admin@acme.com')
  alice = await invite('member', 'alice@acme.com')
  bob = await invite('member', 'bob@acme.com')
  const provider = await as(owner, 'POST', '/api/providers', {
    name: 'Mock',
    kind: 'openai',
    baseUrl: `${mockBase}/v1`,
    apiKey: 'sk-mock-key-123456',
    model: 'mock-model',
  })
  expect(provider.status, provider.text).toBe(201)
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false, toolLoading: 'all', defaultProviderId: provider.json.id ?? provider.json.provider?.id })
})

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('团队上限', () => {
  it('默认：owner/admin/member 上限 full，viewer read；只有 members:manage 能读改', async () => {
    const caps = await as(admin, 'GET', '/api/team/permission-caps')
    expect(caps.status, caps.text).toBe(200)
    expect(caps.json).toEqual({ roles: { owner: 'full', admin: 'full', member: 'full', viewer: 'read' }, members: {} })
    expect((await as(alice, 'GET', '/api/team/permission-caps')).status).toBe(403)
    expect((await as(alice, 'PATCH', '/api/team/permission-caps', { roles: { member: 'full' } })).status).toBe(403)
    // owner 的上限不能改
    expect((await as(admin, 'PATCH', '/api/team/permission-caps', { roles: { owner: 'read' } })).status).toBe(400)
    expect((await as(alice, 'GET', '/api/permissions')).json).toMatchObject({ cap: 'full', capsEnabled: true })
  })

  it('按角色限制为需审批：成员的选择器上限 ask；PATCH full 403；已存的 full 运行时被截断', async () => {
    const session = (await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })).json.session
    expect(session.permissionLevel).toBe('full')
    const patched = await as(admin, 'PATCH', '/api/team/permission-caps', { roles: { member: 'ask' } })
    expect(patched.status, patched.text).toBe(200)
    expect(patched.json.roles.member).toBe('ask')
    expect((await as(alice, 'GET', '/api/permissions')).json.cap).toBe('ask')
    const denied = await as(alice, 'PATCH', `/api/sessions/${session.id}`, { permissionLevel: 'full' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('PERMISSION_LEVEL_EXCEEDED')
    expect((await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })).status).toBe(403)
    expect((await as(alice, 'PATCH', `/api/sessions/${session.id}`, { permissionLevel: 'read' })).status).toBe(200)
    expect((await as(alice, 'PATCH', `/api/sessions/${session.id}`, { permissionLevel: 'ask' })).status).toBe(200)

    // 管理员限制前已存的 full：运行时按上限截断成 ask（写工具弹卡片）
    const { db } = await import('../src/db.js')
    db.prepare("UPDATE sessions SET permission_level = 'full' WHERE id = ?").run(session.id)
    await script({ text: '好的' })
    const res = await as(alice, 'POST', '/api/chat', { sessionId: session.id, content: 'hi' })
    expect(res.status, res.text).toBe(200)
    expect(parseSse(res.text).find((e) => e.event === 'start')!.data.permissionLevel).toBe('ask')
    // admin 不受 member 的限制
    expect((await as(admin, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })).status).toBe(201)
  })

  it('按成员覆盖：bob 仅可查看，写工具不提供；删除覆盖后回到角色上限', async () => {
    await as(admin, 'PATCH', '/api/team/permission-caps', { members: { [bob.id]: 'read' } })
    expect((await as(bob, 'GET', '/api/permissions')).json.cap).toBe('read')
    expect((await as(alice, 'GET', '/api/permissions')).json.cap).toBe('ask')
    const session = (await as(bob, 'POST', '/api/sessions', { agentIds: ['builtin'] })).json.session
    expect((await as(bob, 'PATCH', `/api/sessions/${session.id}`, { permissionLevel: 'ask' })).status).toBe(403)
    await script({ text: '好的' })
    const start = parseSse((await as(bob, 'POST', '/api/chat', { sessionId: session.id, content: 'hi' })).text).find((e) => e.event === 'start')!.data
    expect(start.permissionLevel).toBe('read')
    // 只剩读工具；记忆工具在“仅可查看”下也不提供，bob 仍可在设置页管理自己的记忆
    expect(start.tools.every((t: any) => t.risk === 'read')).toBe(true)
    expect(start.tools.map((t: any) => t.name)).not.toContain('memory_add')
    expect((await as(bob, 'POST', '/api/memory/entries', { section: 'notes', content: 'bob 只读也能在设置页加记忆' })).status).toBe(201)
    const cleared = await as(admin, 'PATCH', '/api/team/permission-caps', { members: { [bob.id]: null } })
    expect(cleared.json.members).toEqual({})
    expect((await as(bob, 'GET', '/api/permissions')).json.cap).toBe('ask')
  })

  it('工作流：allowWrite=true 也不能超过负责人上限（仅可查看 → 写工具自动拒绝）', async () => {
    await as(admin, 'PATCH', '/api/team/permission-caps', { members: { [alice.id]: 'read' } })
    const wf = await as(alice, 'POST', '/api/workflows', {
      name: '受限',
      nodes: [{ id: 'a', name: 'A', kernelId: 'builtin', prompt: '建个任务', joinStrategy: 'all', allowWrite: true, position: { x: 0, y: 0 } }],
      edges: [],
    })
    expect(wf.status, wf.text).toBe(201)
    await script({ toolCalls: [{ id: 'c1', name: 'create_task', arguments: { title: '受限工作流的任务' } }] }, { text: '已尝试' })
    const started = await as(alice, 'POST', `/api/workflows/${wf.json.id}/run`, {})
    expect(started.status, started.text).toBeLessThan(300)
    let run: any = null
    for (let i = 0; i < 200; i += 1) {
      run = (await as(alice, 'GET', `/api/workflow-runs/${started.json.id}`)).json
      if (['succeeded', 'failed', 'cancelled'].includes(run.status)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(run.status).toBe('succeeded')
    const detail = (await as(alice, 'GET', `/api/sessions/${run.nodes[0].sessionId}`)).json
    expect(detail.session.permissionLevel).toBe('read')
    const trace = detail.messages.find((m: any) => m.role === 'assistant').toolTrace
    expect(trace[0]).toMatchObject({ name: 'create_task', approved: false })
    const tasks = (await as(alice, 'GET', '/api/tasks?status=all')).json.items.map((t: any) => t.title)
    expect(tasks).not.toContain('受限工作流的任务')
  })
})
