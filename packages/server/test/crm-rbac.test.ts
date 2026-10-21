import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/** server 模式：CRM Agent 工具与任务接口的 RBAC / 行级可见性 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string; role: string }
let owner: Who
let member: Who
let member2: Who
let viewer: Who

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
  return parseSse(res.text).filter((e) => e.event === 'tool_result').map((e) => e.data)
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

describe('CRM Agent 工具 RBAC（server 模式）', () => {
  it('member 只能改自己的客户；看不到别人的私有客户；viewer 写工具无权限', async () => {
    const ownersCustomer = (await as(owner, 'POST', '/api/customers', { company: 'Owner Private Co' })).json
    const mine = (await as(member, 'POST', '/api/customers', { company: 'Member Co' })).json

    const r = await agentCall(member, [
      { id: 'a', name: 'update_customer', arguments: { customerId: ownersCustomer.id, stage: 'won' } },
      { id: 'b', name: 'update_customer', arguments: { customerId: mine.id, stage: 'contacted' } },
    ])
    const a = r.find((x) => x.toolCallId === 'a')
    const b = r.find((x) => x.toolCallId === 'b')
    expect(a.ok).toBe(false)
    expect(a.result).toContain('NOT_FOUND')
    expect(b.ok).toBe(true)
    expect((await as(owner, 'GET', `/api/customers/${ownersCustomer.id}`)).json.stage).toBe('lead')

    // 转移负责人给 member2 后，member 不能再改
    const moved = await agentCall(member, [{ id: 'c', name: 'update_customer', arguments: { customerId: mine.id, ownerId: member2.id } }])
    expect(moved[0].ok, moved[0].result).toBe(true)
    const again = await agentCall(member, [{ id: 'd', name: 'add_activity', arguments: { customerId: mine.id, type: 'note', content: 'x' } }])
    expect(again[0].ok).toBe(false)

    // viewer 不能开会话 / 对话（data:write），因此也无法驱动 Agent 写 CRM；工具层的兜底检查见下方 MCP 用例
    expect((await as(viewer, 'POST', '/api/sessions', { agentIds: ['builtin'] })).status).toBe(403)
  })

  it('任务：自己的任务与可见客户的任务可见；别人私有任务 404；viewer 不能建；admin/owner 看全部', async () => {
    const t = await as(member, 'POST', '/api/tasks', { title: 'member 私人提醒' })
    expect(t.status, t.text).toBe(201)
    expect((await as(member2, 'GET', `/api/tasks/${t.json.id}`)).status).toBe(404)
    expect((await as(member2, 'PATCH', `/api/tasks/${t.json.id}`, { status: 'done' })).status).toBe(404)
    expect((await as(member2, 'GET', '/api/tasks')).json.items.find((x: any) => x.id === t.json.id)).toBeUndefined()
    expect((await as(owner, 'GET', '/api/tasks')).json.items.find((x: any) => x.id === t.json.id)).toBeTruthy()
    expect((await as(viewer, 'POST', '/api/tasks', { title: 'x' })).status).toBe(403)
    // 导出 / 备份需要 data:export（owner/admin）
    expect((await as(member, 'GET', '/api/customers/export')).status).toBe(403)
    expect((await as(member, 'POST', '/api/data/backups', {})).status).toBe(403)
    expect((await as(owner, 'GET', '/api/customers/export')).status).toBe(200)
    // 共享（org）客户上的任务：能看到客户的人能看到，但只有负责人/admin 能改
    const shared = (await as(member, 'POST', '/api/customers', { company: 'Shared Org Co', visibility: 'org' })).json
    const st = (await as(member, 'POST', '/api/tasks', { title: '共享客户跟进', customerId: shared.id })).json
    expect((await as(member2, 'GET', `/api/tasks/${st.id}`)).status).toBe(200)
    expect((await as(member2, 'PATCH', `/api/tasks/${st.id}`, { status: 'done' })).status).toBe(403)
    expect((await as(owner, 'PATCH', `/api/tasks/${st.id}`, { status: 'done' })).status).toBe(200)
    // 审计
    const audit = await as(owner, 'GET', '/api/audit?action=task.create')
    expect(audit.status).toBe(200)
    expect(JSON.stringify(audit.json)).toContain(t.json.id)
  })

  it('商机 / 订单 / 收款：随客户可见；只有负责人与 admin 可写；Agent 工具同样受限并记审计', async () => {
    const shared = (await as(member, 'POST', '/api/customers', { company: 'Deal Shared Co', visibility: 'org' })).json
    const privateCo = (await as(member, 'POST', '/api/customers', { company: 'Deal Private Co' })).json
    const deal = (await as(member, 'POST', '/api/deals', { customerId: shared.id, title: 'Shared deal', amount: 1000 })).json
    const hidden = (await as(member, 'POST', '/api/deals', { customerId: privateCo.id, title: 'Hidden deal', amount: 5 })).json
    expect((await as(member2, 'GET', `/api/deals/${deal.id}`)).status).toBe(200)
    expect((await as(member2, 'GET', `/api/deals/${hidden.id}`)).status).toBe(404)
    expect((await as(member2, 'PATCH', `/api/deals/${deal.id}`, { amount: 1 })).status).toBe(403)
    expect((await as(viewer, 'POST', '/api/deals', { customerId: shared.id, title: 'v' })).status).toBe(403)
    expect((await as(member, 'PATCH', `/api/deals/${deal.id}`, { ownerId: member2.id })).status).toBe(403)
    expect((await as(owner, 'PATCH', `/api/deals/${deal.id}`, { ownerId: member2.id })).json.ownerId).toBe(member2.id)

    const quote = (await as(member, 'POST', '/api/quotes', { customerId: shared.id, items: [{ name: 'X', qty: 10, unitPrice: 3 }] })).json
    expect((await as(member2, 'POST', `/api/quotes/${quote.id}/order`, {})).status).toBe(403)
    const r = await agentCall(member, [{ id: 'o', name: 'convert_quote_to_order', arguments: { quoteId: quote.id, dueDate: '2000-01-01' } }])
    expect(r[0].ok, r[0].result).toBe(true)
    const order = JSON.parse(r[0].result).order
    expect(order).toMatchObject({ amount: 30, balance: 30 })
    const r2 = await agentCall(member2, [
      { id: 'p', name: 'record_payment', arguments: { orderId: order.id, amount: 10 } },
      { id: 'q', name: 'list_overdue_receivables', arguments: {} },
    ])
    expect(r2.find((x) => x.toolCallId === 'p').result).toContain('FORBIDDEN')
    expect(JSON.parse(r2.find((x) => x.toolCallId === 'q').result).items.map((o: any) => o.id)).toContain(order.id)
    const r3 = await agentCall(member, [{ id: 'p2', name: 'record_payment', arguments: { orderId: order.id, amount: 10, reference: 'TT-1' } }])
    expect(JSON.parse(r3[0].result).order.balance).toBe(20)
    const audit = JSON.stringify((await as(owner, 'GET', '/api/audit?action=agent.tool')).json)
    expect(audit).toContain('convert_quote_to_order')
    expect(audit).toContain('record_payment')
  })

  it('漏斗统计按可见范围：member2 看不到 member 的私有客户', async () => {
    const m = (await as(member, 'GET', '/api/pipeline/stats')).json.customers.total
    const m2 = (await as(member2, 'GET', '/api/pipeline/stats')).json.customers.total
    const o = (await as(owner, 'GET', '/api/pipeline/stats')).json.customers.total
    expect(o).toBeGreaterThan(m2)
    expect(o).toBeGreaterThanOrEqual(m)
  })

  it('LULUX MCP 以发起者身份执行：viewer 令牌的写工具无权限', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const actor = { id: viewer.id, name: 'viewer', email: 'viewer@acme.com', role: 'viewer' as const, orgId: (await as(viewer, 'GET', '/api/auth/me')).json.org.id, teamIds: [], sessionId: null }
    const issued = luluxMcpTokens.issue({
      actor,
      kernelId: 'claude-code',
      bridge: { sessionId: 'mcp-rbac', agentId: 'kernel-claude-code', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      const call = await server.request('POST', '/gateway/mcp', {
        token: issued.token,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_customer', arguments: { company: 'MCP Viewer Co' } } },
      })
      expect(call.json.result.isError).toBe(true)
      expect(call.json.result.content[0].text).toContain('没有权限')
      const list = await server.request('POST', '/gateway/mcp', {
        token: issued.token,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_customers', arguments: { query: 'Owner Private' } } },
      })
      expect(JSON.parse(list.json.result.content[0].text).total).toBe(0)
    } finally {
      issued.revoke()
    }
  })
})
