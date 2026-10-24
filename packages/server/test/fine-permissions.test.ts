import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/** server 模式：按账号的细粒度权限（角色默认值 ± 覆盖项），界面接口、服务层、Agent 工具、MCP 桥、工作流 / 定时任务一致生效 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
const DENY_CUSTOMER = '没有权限：删除客户'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string; role: string }
let owner: Who
let admin: Who
let member: Who
let member2: Who
let viewer: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
async function script(...responses: unknown[]) {
  await fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })
}
async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, role }
}
async function agentCall(who: Who, toolCalls: unknown[]) {
  const session = await as(who, 'POST', '/api/sessions', { agentIds: ['builtin'] })
  expect(session.status, session.text).toBe(201)
  await script({ toolCalls }, { text: 'ok' })
  const res = await as(who, 'POST', '/api/chat', { sessionId: session.json.session.id, content: 'go' })
  const events = parseSse(res.text)
  return {
    results: events.filter((e) => e.event === 'tool_result').map((e) => e.data),
    requests: events.filter((e) => e.event === 'tool_request').map((e) => e.data),
  }
}
async function setOverrides(by: Who, target: Who, overrides: Record<string, 'grant' | 'deny' | null>) {
  return as(by, 'PUT', `/api/team/members/${target.id}/permissions`, { overrides })
}
async function customer(who: Who, company: string): Promise<string> {
  const res = await as(who, 'POST', '/api/customers', { company })
  expect(res.status, res.text).toBe(201)
  return res.json.id
}
async function exists(path: string): Promise<boolean> {
  return (await as(owner, 'GET', path)).status === 200
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id, role: 'owner' }
  admin = await invite('admin', 'admin@acme.com')
  member = await invite('member', 'member@acme.com')
  member2 = await invite('member', 'member2@acme.com')
  viewer = await invite('viewer', 'viewer@acme.com')
  await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, toolApproval: 'auto', llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('细粒度权限：默认值与覆盖项', () => {
  it('角色默认值：member 拥有删除权限（行为不变），viewer 只读；/api/auth/me 返回生效权限', async () => {
    const me = (await as(member, 'GET', '/api/auth/me')).json
    expect(me.permissions).toEqual(expect.arrayContaining(['data:write', 'customer:delete', 'deal:delete', 'quote:delete', 'order:delete', 'task:delete', 'customer:import', 'workflow:manage', 'email:send']))
    expect(me.permissions).not.toContain('data:export')
    expect((await as(viewer, 'GET', '/api/auth/me')).json.permissions).toEqual(['data:read'])
    const catalog = (await as(member, 'GET', '/api/team/permission-catalog')).json
    expect(catalog.groups.map((g: any) => g.id)).toEqual(['customer', 'deal', 'quote_order', 'task', 'data', 'email', 'workflow'])
    expect(catalog.labels['customer:delete']).toBe('删除客户')
  })

  it('覆盖项持久化：成员列表返回覆盖项与生效权限；无需重新登录即生效；写审计', async () => {
    const res = await setOverrides(owner, member, { 'customer:delete': 'deny', 'data:export': 'grant' })
    expect(res.status, res.text).toBe(200)
    expect(res.json.permissionOverrides).toEqual({ 'customer:delete': 'deny', 'data:export': 'grant' })
    expect(res.json.permissions).not.toContain('customer:delete')
    expect(res.json.permissions).toContain('data:export')

    const listed = (await as(owner, 'GET', '/api/team/members')).json.find((u: any) => u.id === member.id)
    expect(listed.permissionOverrides).toEqual({ 'customer:delete': 'deny', 'data:export': 'grant' })
    const me = (await as(member, 'GET', '/api/auth/me')).json
    expect(me.permissions).not.toContain('customer:delete')
    expect(me.permissions).toContain('data:export')

    const { db } = await import('../src/db.js')
    const rows = db.prepare('SELECT permission, effect, updated_by FROM user_permission_overrides WHERE user_id = ? ORDER BY permission').all(member.id) as any[]
    expect(rows).toEqual([
      { permission: 'customer:delete', effect: 'deny', updated_by: owner.id },
      { permission: 'data:export', effect: 'grant', updated_by: owner.id },
    ])
    const audit = (await as(owner, 'GET', '/api/audit?action=member.permissions')).json
    const items = Array.isArray(audit) ? audit : audit.items
    const entry = items.find((a: any) => a.action === 'member.permissions' && a.entityId === member.id)
    expect(entry?.summary).toContain('删除客户→禁止')

    // PATCH /api/team/members/:id 同样接受覆盖项（全量替换）
    const patched = await as(owner, 'PATCH', `/api/team/members/${member.id}`, { permissionOverrides: { 'customer:delete': 'deny' } })
    expect(patched.status, patched.text).toBe(200)
    expect(patched.json.permissionOverrides).toEqual({ 'customer:delete': 'deny' })
    expect((await as(member, 'GET', '/api/auth/me')).json.permissions).not.toContain('data:export')
  })

  it('谁能改：只有 owner / admin；admin 不能改 owner、其他 admin 或自己；不能单独授予组织级权限', async () => {
    expect((await setOverrides(member2, member, { 'customer:delete': 'grant' })).status).toBe(403)
    expect((await setOverrides(viewer, member, {})).status).toBe(403)
    const onOwner = await setOverrides(admin, owner, { 'customer:delete': 'deny' })
    expect(onOwner.status).toBe(403)
    expect(onOwner.json.error.code).toBe('CANNOT_MODIFY_OWNER')
    expect((await setOverrides(owner, owner, {})).status).toBe(403)
    expect((await setOverrides(admin, admin, { 'data:export': 'deny' })).status).toBe(409)
    const security = await setOverrides(admin, member2, { 'security:manage': 'grant' })
    expect(security.status).toBe(400)
    expect((await setOverrides(owner, member2, { 'members:manage': 'grant' })).status).toBe(400)
    // owner 可以改 admin；admin 可以改 member
    const onAdmin = await setOverrides(owner, admin, { 'data:export': 'deny' })
    expect(onAdmin.status, onAdmin.text).toBe(200)
    expect(onAdmin.json.permissions).not.toContain('data:export')
    expect((await as(admin, 'GET', '/api/customers/export')).status).toBe(403)
    await setOverrides(owner, admin, {})
    const ok = await setOverrides(admin, member2, { 'data:export': 'grant' })
    expect(ok.status, ok.text).toBe(200)
    expect((await setOverrides(admin, member2, {})).json.permissionOverrides).toEqual({})
  })
})

describe('细粒度权限：服务端强制', () => {
  it('接口 403：没有 customer:delete 不能删客户，但仍能改；其他人照常', async () => {
    const mine = await customer(member, 'Perm Route Co')
    const del = await as(member, 'DELETE', `/api/customers/${mine}`)
    expect(del.status).toBe(403)
    expect(del.json.error.message).toBe(DENY_CUSTOMER)
    expect(await exists(`/api/customers/${mine}`)).toBe(true)
    expect((await as(member, 'PATCH', `/api/customers/${mine}`, { stage: 'contacted' })).status).toBe(200)

    const other = await customer(member2, 'Perm Route Co 2')
    expect((await as(member2, 'DELETE', `/api/customers/${other}`)).status).toBe(204)
  })

  it('接口 403：删除商机 / 任务 / 报价，导入客户，导出客户，均按各自权限', async () => {
    await setOverrides(owner, member, {
      'customer:delete': 'deny',
      'deal:delete': 'deny',
      'task:delete': 'deny',
      'quote:delete': 'deny',
      'customer:import': 'deny',
    })
    const cid = await customer(member, 'Perm Many Co')
    const deal = await as(member, 'POST', '/api/deals', { customerId: cid, title: 'D1' })
    expect(deal.status, deal.text).toBe(201)
    const dealDel = await as(member, 'DELETE', `/api/deals/${deal.json.id}`)
    expect(dealDel.status).toBe(403)
    expect(dealDel.json.error.message).toBe('没有权限：删除商机')
    const task = await as(member, 'POST', '/api/tasks', { title: 'T1', customerId: cid })
    expect(task.status, task.text).toBe(201)
    expect((await as(member, 'DELETE', `/api/tasks/${task.json.id}`)).json.error.message).toBe('没有权限：删除任务')
    const quote = await as(member, 'POST', '/api/quotes', { customerId: cid })
    expect(quote.status, quote.text).toBe(201)
    expect((await as(member, 'DELETE', `/api/quotes/${quote.json.id}`)).json.error.message).toBe('没有权限：删除报价单')
    const imp = await as(member, 'POST', '/api/customers/import', { rows: [{ c: 'X' }], mapping: { company: 'c' } })
    expect(imp.status).toBe(403)
    expect(imp.json.error.message).toBe('没有权限：导入客户')
    expect((await as(member, 'GET', '/api/customers/export')).status).toBe(403)
    await setOverrides(owner, member, { 'customer:delete': 'deny', 'data:export': 'grant' })
    expect((await as(member, 'GET', '/api/customers/export')).status).toBe(200)
    expect((await as(member, 'DELETE', `/api/tasks/${task.json.id}`)).status).toBe(204)
  })

  it('viewer：即使单独授予 customer:delete，没有 data:write 仍不能删', async () => {
    const cid = await customer(owner, 'Viewer Grant Co')
    await setOverrides(owner, viewer, { 'customer:delete': 'grant' })
    const res = await as(viewer, 'DELETE', `/api/customers/${cid}`)
    expect(res.status).toBe(403)
    expect(res.json.error.message).toBe('没有权限：修改业务数据')
    await setOverrides(owner, viewer, {})
  })

  it('服务层（纵深防御）：直接调用 service 也按生效权限拒绝', async () => {
    const cid = await customer(member, 'Perm Service Co')
    const { runAs } = await import('../src/context.js')
    const { actorForUserId } = await import('../src/services/auth-service.js')
    const { customerService } = await import('../src/services/customer-service.js')
    const { AppError } = await import('../src/errors.js')
    let caught: unknown
    try {
      runAs(actorForUserId(member.id), () => customerService.remove(cid))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as InstanceType<typeof AppError>).status).toBe(403)
    expect((caught as Error).message).toBe(DENY_CUSTOMER)
    expect(await exists(`/api/customers/${cid}`)).toBe(true)
  })

  it('内置 Agent：delete_customer 被拒绝（不弹审批），没有覆盖项的成员可以删自己的客户', async () => {
    const cid = await customer(member, 'Perm Agent Co')
    const r = await agentCall(member, [{ id: 'd', name: 'delete_customer', arguments: { customerId: cid } }])
    const result = r.results.find((x) => x.toolCallId === 'd')
    expect(result.ok).toBe(false)
    expect(result.result).toContain(DENY_CUSTOMER)
    expect(r.requests.find((x) => x.toolCallId === 'd')).toBeUndefined()
    expect(await exists(`/api/customers/${cid}`)).toBe(true)

    const other = await customer(member2, 'Perm Agent Co 2')
    const r2 = await agentCall(member2, [{ id: 'd2', name: 'delete_customer', arguments: { customerId: other } }])
    expect(r2.results.find((x) => x.toolCallId === 'd2'), JSON.stringify(r2.results)).toMatchObject({ ok: true })
    expect(await exists(`/api/customers/${other}`)).toBe(false)
  })

  it('命令行内核经 LULUX MCP：delete_customer 被拒绝；覆盖项在运行中修改也立即生效', async () => {
    const cid = await customer(member, 'Perm MCP Co')
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { actorForUserId } = await import('../src/services/auth-service.js')
    const session = await as(member, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })
    expect(session.status, session.text).toBe(201)
    const issued = luluxMcpTokens.issue({
      actor: actorForUserId(member.id),
      kernelId: 'claude-code',
      bridge: {
        sessionId: session.json.session.id,
        agentId: 'kernel-claude-code',
        signal: new AbortController().signal,
        send: () => undefined,
        trace: () => undefined,
      },
    })
    let id = 0
    const call = async (name: string, args: Record<string, unknown>) =>
      (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } })).json
    try {
      const denied = await call('delete_customer', { customerId: cid })
      expect(denied.result.isError).toBe(true)
      expect(denied.result.content[0].text).toContain(DENY_CUSTOMER)
      expect(await exists(`/api/customers/${cid}`)).toBe(true)

      await setOverrides(owner, member, {})
      const allowed = await call('delete_customer', { customerId: cid })
      expect(allowed.result.isError, JSON.stringify(allowed)).toBeFalsy()
      expect(await exists(`/api/customers/${cid}`)).toBe(false)
    } finally {
      issued.revoke()
      await setOverrides(owner, member, { 'customer:delete': 'deny' })
    }
  })

  it('工作流运行（以负责人身份）：节点里的 delete_customer 被拒绝；收回 workflow:manage 后不能新建 / 修改工作流', async () => {
    const cid = await customer(member, 'Perm Workflow Co')
    const wf = await as(member, 'POST', '/api/workflows', {
      name: '清理客户',
      nodes: [{ id: 'a', name: 'A', kernelId: 'builtin', prompt: '删掉客户', joinStrategy: 'all', allowWrite: true, position: { x: 0, y: 0 } }],
      edges: [],
    })
    expect(wf.status, wf.text).toBe(201)
    await script({ toolCalls: [{ id: 'w1', name: 'delete_customer', arguments: { customerId: cid } }] }, { text: '已尝试' })
    const started = await as(member, 'POST', `/api/workflows/${wf.json.id}/run`, {})
    expect(started.status, started.text).toBe(200)
    let run: any
    for (let i = 0; i < 300; i += 1) {
      run = (await as(member, 'GET', `/api/workflow-runs/${started.json.id}`)).json
      if (['succeeded', 'failed', 'cancelled'].includes(run.status)) break
      await sleep(40)
    }
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    const msgs = (await as(member, 'GET', `/api/sessions/${run.nodes[0].sessionId}`)).json.messages
    const trace = msgs.find((m: any) => m.role === 'assistant').toolTrace
    expect(trace[0].name).toBe('delete_customer')
    expect(trace[0].result).toContain(DENY_CUSTOMER)
    expect(await exists(`/api/customers/${cid}`)).toBe(true)

    await setOverrides(owner, member, { 'customer:delete': 'deny', 'workflow:manage': 'deny' })
    const create = await as(member, 'POST', '/api/workflows', { name: 'x', nodes: [], edges: [] })
    expect(create.status).toBe(403)
    expect(create.json.error.message).toBe('没有权限：管理工作流与定时任务')
    expect((await as(member, 'PATCH', `/api/workflows/${wf.json.id}`, { name: 'y' })).status).toBe(403)
    expect((await as(member, 'POST', '/api/schedules', { name: 's', target: { type: 'prompt', kernelId: 'builtin', prompt: 'p', sessionMode: 'new' }, spec: { type: 'weekly', days: [1], time: '09:00' } })).status).toBe(403)
    await setOverrides(owner, member, { 'customer:delete': 'deny' })
  })

  it('定时任务（后台以负责人身份运行）：delete_customer 被拒绝并给出权限原因', async () => {
    const cid = await customer(member, 'Perm Schedule Co')
    const created = await as(member, 'POST', '/api/schedules', {
      name: '定时清理',
      target: { type: 'prompt', kernelId: 'builtin', prompt: '删掉客户', sessionMode: 'new' },
      spec: { type: 'weekly', days: [1], time: '09:00' },
    })
    expect(created.status, created.text).toBe(201)
    await script({ toolCalls: [{ id: 's1', name: 'delete_customer', arguments: { customerId: cid } }] }, { text: '已尝试' })
    const now = await as(member, 'POST', `/api/schedules/${created.json.id}/run-now`)
    expect(now.status, now.text).toBe(200)
    let run: any
    for (let i = 0; i < 400; i += 1) {
      run = ((await as(member, 'GET', `/api/schedules/${created.json.id}/runs`)).json as any[]).find((r) => r.id === now.json.id)
      if (run && ['succeeded', 'failed', 'cancelled', 'skipped'].includes(run.status)) break
      await sleep(50)
    }
    expect(run?.status, JSON.stringify(run)).toBe('succeeded')
    const msgs = (await as(member, 'GET', `/api/sessions/${run.sessionId}`)).json.messages
    const trace = msgs.find((m: any) => m.role === 'assistant').toolTrace
    expect(trace[0].result).toContain(DENY_CUSTOMER)
    expect(await exists(`/api/customers/${cid}`)).toBe(true)
  })
})
