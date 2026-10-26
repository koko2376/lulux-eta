import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 删除客户不级联业务记录（名下有订单 / 收款 / 报价 / 商机时 409），
 * 转移负责人连带转移商机、订单、未完成任务（界面接口、内置 Agent、LULUX MCP 一致）
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string }
let owner: Who
let alice: Who
let bob: Who
let carol: Who

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
async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}
async function customer(who: Who, company: string): Promise<string> {
  const res = await as(who, 'POST', '/api/customers', { company, contacts: [{ name: 'Buyer' }] })
  expect(res.status, res.text).toBe(201)
  return res.json.id
}
async function quote(who: Who, customerId: string) {
  const res = await as(who, 'POST', '/api/quotes', { customerId, currency: 'USD', items: [{ name: 'Valve DN50', qty: 100, unitPrice: 10 }] })
  expect(res.status, res.text).toBe(201)
  return res.json
}
async function deal(who: Who, customerId: string) {
  const res = await as(who, 'POST', '/api/deals', { customerId, title: '年框', amount: 1000 })
  expect(res.status, res.text).toBe(201)
  return res.json
}
/** 报价 → 订单 → 收款一笔 */
async function orderWithPayment(who: Who, customerId: string) {
  const q = await quote(who, customerId)
  const order = await as(who, 'POST', `/api/quotes/${q.id}/order`, { depositAmount: 300 })
  expect(order.status, order.text).toBe(201)
  const pay = await as(who, 'POST', `/api/orders/${order.json.id}/payments`, { amount: 300 })
  expect(pay.status, pay.text).toBe(201)
  return { quote: q, order: order.json, payment: pay.json.payment }
}
async function task(who: Who, customerId: string | null, title: string) {
  const res = await as(who, 'POST', '/api/tasks', { title, ...(customerId ? { customerId } : {}) })
  expect(res.status, res.text).toBe(201)
  return res.json
}
async function exists(path: string): Promise<boolean> {
  return (await as(owner, 'GET', path)).status === 200
}
async function dbOf() {
  return (await import('../src/db.js')).db
}
async function ownerOf(table: string, id: string): Promise<string> {
  const db = await dbOf()
  return (db.prepare(`SELECT owner_id FROM ${table} WHERE id = ?`).get(id) as { owner_id: string }).owner_id
}
async function auditSummary(entityId: string): Promise<string> {
  const db = await dbOf()
  const row = db
    .prepare("SELECT summary FROM audit_log WHERE action = 'customer.transfer' AND entity_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(entityId) as { summary: string } | undefined
  return row?.summary ?? ''
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@acme.com')
  bob = await invite('member', 'bob@acme.com')
  carol = await invite('member', 'carol@acme.com')
  await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, toolApproval: 'auto', llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('删除客户：有业务记录时拒绝，不再级联物理删除', () => {
  it('名下有报价 → 409，报价仍在', async () => {
    const cid = await customer(alice, 'Quote Only Co')
    const q = await quote(alice, cid)
    const res = await as(alice, 'DELETE', `/api/customers/${cid}`)
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CUSTOMER_HAS_RECORDS')
    expect(res.json.error.message).toBe('该客户名下有 1 个报价，不能删除。请先转移或处理这些记录。')
    expect(await exists(`/api/customers/${cid}`)).toBe(true)
    expect(await exists(`/api/quotes/${q.id}`)).toBe(true)
  })

  it('名下有商机 → 409', async () => {
    const cid = await customer(alice, 'Deal Only Co')
    const d = await deal(alice, cid)
    const res = await as(alice, 'DELETE', `/api/customers/${cid}`)
    expect(res.status).toBe(409)
    expect(res.json.error.message).toBe('该客户名下有 1 个商机，不能删除。请先转移或处理这些记录。')
    expect(await exists(`/api/deals/${d.id}`)).toBe(true)
  })

  it('名下有订单与收款 → 409，消息列出各类数量；订单、收款、任务都没被删', async () => {
    const cid = await customer(alice, 'Order Co')
    const { order, payment } = await orderWithPayment(alice, cid)
    await quote(alice, cid)
    const t = await task(alice, cid, '催尾款')
    const res = await as(owner, 'DELETE', `/api/customers/${cid}`)
    expect(res.status).toBe(409)
    expect(res.json.error.message).toBe('该客户名下有 1 个订单、1 条收款、2 个报价，不能删除。请先转移或处理这些记录。')
    const db = await dbOf()
    expect(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE id = ?').get(payment.id)).toEqual({ n: 1 })
    expect(await exists(`/api/orders/${order.id}`)).toBe(true)
    expect(await exists(`/api/tasks/${t.id}`)).toBe(true)
    expect(await exists(`/api/customers/${cid}`)).toBe(true)
  })

  it('没有业务记录 → 204，客户与任务一起移入回收站（联系人、跟进保留，可恢复）', async () => {
    const cid = await customer(alice, 'Clean Co')
    await as(alice, 'POST', `/api/customers/${cid}/activities`, { type: 'note', content: 'n' })
    const t = await task(alice, cid, '寄样')
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(204)
    expect(await exists(`/api/customers/${cid}`)).toBe(false)
    expect(await exists(`/api/tasks/${t.id}`)).toBe(false)
    const db = await dbOf()
    const c = db.prepare('SELECT deleted_at, deleted_by FROM customers WHERE id = ?').get(cid) as { deleted_at: number; deleted_by: string }
    expect(c.deleted_by).toBe(alice.id)
    expect(db.prepare('SELECT deleted_at AS at FROM tasks WHERE id = ?').get(t.id)).toEqual({ at: c.deleted_at })
    expect(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?').get(cid)).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE customer_id = ?').get(cid)).toEqual({ n: 1 })
  })

  it('处理掉业务记录后可以删除', async () => {
    const cid = await customer(alice, 'Later Clean Co')
    const q = await quote(alice, cid)
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(409)
    expect((await as(alice, 'DELETE', `/api/quotes/${q.id}`)).status).toBe(204)
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(204)
  })

  it('内置 Agent 的 delete_customer 同样被拒绝，返回原因', async () => {
    const cid = await customer(alice, 'Agent Blocked Co')
    await deal(alice, cid)
    const session = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(session.status, session.text).toBe(201)
    await fetch(`${mockBase}/__mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses: [{ toolCalls: [{ id: 'd', name: 'delete_customer', arguments: { customerId: cid } }] }, { text: 'ok' }] }),
    })
    const res = await as(alice, 'POST', '/api/chat', { sessionId: session.json.session.id, content: 'go' })
    const result = parseSse(res.text)
      .filter((e) => e.event === 'tool_result')
      .map((e) => e.data)
      .find((x) => x.toolCallId === 'd')
    expect(result, res.text).toBeTruthy()
    expect(result.ok).toBe(false)
    expect(result.result).toContain('该客户名下有 1 个商机，不能删除')
    expect(await exists(`/api/customers/${cid}`)).toBe(true)
  })

  it('命令行内核经 LULUX MCP 的 delete_customer 同样被拒绝', async () => {
    const cid = await customer(alice, 'MCP Blocked Co')
    await quote(alice, cid)
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { actorForUserId } = await import('../src/services/auth-service.js')
    const session = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })
    expect(session.status, session.text).toBe(201)
    const issued = luluxMcpTokens.issue({
      actor: actorForUserId(alice.id),
      kernelId: 'claude-code',
      bridge: {
        sessionId: session.json.session.id,
        agentId: 'kernel-claude-code',
        signal: new AbortController().signal,
        send: () => undefined,
        trace: () => undefined,
      },
    })
    try {
      const res = await server.request('POST', '/gateway/mcp', {
        token: issued.token,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_customer', arguments: { customerId: cid } } },
      })
      expect(res.json.result.isError, res.text).toBe(true)
      expect(res.json.result.content[0].text).toContain('该客户名下有 1 个报价，不能删除')
      expect(await exists(`/api/customers/${cid}`)).toBe(true)
    } finally {
      issued.revoke()
    }
  })
})

describe('转移负责人：连带转移商机、订单、未完成任务', () => {
  it('POST /api/customers/:id/assign：全部相关记录归新负责人，新负责人能改；已完成任务保留原负责人；审计写数量', async () => {
    const cid = await customer(alice, 'Transfer One Co')
    const d = await deal(alice, cid)
    const { quote: q, order } = await orderWithPayment(alice, cid)
    const open = await task(alice, cid, '跟进样品')
    const done = await task(alice, cid, '首次电话')
    expect((await as(alice, 'PATCH', `/api/tasks/${done.id}`, { status: 'done' })).status).toBe(200)
    // 转移前 Bob 看不到也改不了
    expect([403, 404]).toContain((await as(bob, 'PATCH', `/api/deals/${d.id}`, { notes: 'x' })).status)

    const moved = await as(alice, 'POST', `/api/customers/${cid}/assign`, { ownerId: bob.id })
    expect(moved.status, moved.text).toBe(200)
    expect(await ownerOf('quotes', q.id)).toBe(bob.id)
    expect(await ownerOf('deals', d.id)).toBe(bob.id)
    expect(await ownerOf('orders', order.id)).toBe(bob.id)
    expect(await ownerOf('tasks', open.id)).toBe(bob.id)
    expect(await ownerOf('tasks', done.id)).toBe(alice.id)

    const dealPatch = await as(bob, 'PATCH', `/api/deals/${d.id}`, { notes: 'bob 接手' })
    expect(dealPatch.status, dealPatch.text).toBe(200)
    const orderPatch = await as(bob, 'PATCH', `/api/orders/${order.id}`, { notes: 'bob 接手' })
    expect(orderPatch.status, orderPatch.text).toBe(200)
    const pay = await as(bob, 'POST', `/api/orders/${order.id}/payments`, { amount: 100 })
    expect(pay.status, pay.text).toBe(201)
    const taskPatch = await as(bob, 'PATCH', `/api/tasks/${open.id}`, { status: 'done' })
    expect(taskPatch.status, taskPatch.text).toBe(200)
    // 已完成任务通过客户仍可见
    expect((await as(bob, 'GET', `/api/tasks/${done.id}`)).status).toBe(200)
    // 原负责人不再能改
    expect([403, 404]).toContain((await as(alice, 'PATCH', `/api/deals/${d.id}`, { notes: 'x' })).status)

    expect(await auditSummary(cid)).toContain('连带 1 个报价、1 个商机、1 个订单、1 个未完成任务')
  })

  it('POST /api/customers/transfer（离职交接）：客户相关记录与原负责人名下的其它记录一起转给接收人', async () => {
    const cid = await customer(alice, 'Handover Co')
    const d = await deal(alice, cid)
    const { order } = await orderWithPayment(alice, cid)
    const t = await task(alice, cid, '交接任务')
    const personal = await task(alice, null, '个人待办')
    // Alice 在 Bob 客户上建的商机（Bob 客户对全组织可见）
    const bobCustomer = (await as(bob, 'POST', '/api/customers', { company: 'Bob Shared Co', visibility: 'org' })).json.id
    const aliceDealOnBob = await deal(alice, bobCustomer)

    const res = await as(owner, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: carol.id })
    expect(res.status, res.text).toBe(200)
    expect(res.json.moved).toBeGreaterThanOrEqual(1)
    for (const [table, id] of [
      ['deals', d.id],
      ['orders', order.id],
      ['tasks', t.id],
      ['tasks', personal.id],
      ['deals', aliceDealOnBob.id],
    ] as const) {
      expect(await ownerOf(table, id), `${table} ${id}`).toBe(carol.id)
    }
    expect(await ownerOf('customers', bobCustomer)).toBe(bob.id)
    expect((await as(carol, 'PATCH', `/api/deals/${d.id}`, { notes: 'carol' })).status).toBe(200)
    expect((await as(carol, 'PATCH', `/api/orders/${order.id}`, { notes: 'carol' })).status).toBe(200)
    expect((await as(carol, 'PATCH', `/api/tasks/${t.id}`, { title: '交接任务（carol）' })).status).toBe(200)
    expect(await auditSummary(alice.id)).toMatch(/连带 \d+ 个报价、\d+ 个商机、\d+ 个订单、\d+ 个未完成任务/)
  })
})
