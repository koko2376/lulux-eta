import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/** 回收站：客户 / 报价 / 商机 / 订单 / 任务软删除、恢复、彻底删除、自动清理；界面 / Agent / MCP 一致 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string }
let owner: Who
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
async function db() {
  return (await import('../src/db.js')).db
}
async function trashOf(who: Who, query = '') {
  const res = await as(who, 'GET', `/api/trash${query}`)
  expect(res.status, res.text).toBe(200)
  return res.json as { items: Array<{ entity: string; id: string; title: string; cascadedTasks?: number; purgeAt: number | null }>; total: number; retentionDays: number }
}
async function lastAudit(action: string, entityId: string) {
  const row = (await db()).prepare('SELECT meta FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY rowid DESC LIMIT 1').get(action, entityId) as
    | { meta: string }
    | undefined
  return row ? JSON.parse(row.meta) : null
}
async function agentCall(who: Who, toolCalls: unknown[]) {
  const session = await as(who, 'POST', '/api/sessions', { agentIds: ['builtin'] })
  await fetch(`${mockBase}/__mock/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ toolCalls }, { text: 'ok' }] }),
  })
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
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@acme.com')
  bob = await invite('member', 'bob@acme.com')
  await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, toolApproval: 'auto', llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('软删除：列表 / 详情 / 统计不再出现，审计带快照', () => {
  it('报价、商机、订单、任务、客户', async () => {
    const cid = await customer(alice, 'Trash Flow Co')
    const q = await quote(alice, cid)
    const q2 = await quote(alice, cid)
    const order = (await as(alice, 'POST', `/api/quotes/${q2.id}/order`, { depositAmount: 100 })).json
    await as(alice, 'POST', `/api/orders/${order.id}/payments`, { amount: 100 })
    const deal = (await as(alice, 'POST', '/api/deals', { customerId: cid, title: '年框', amount: 1000 })).json
    const task = (await as(alice, 'POST', '/api/tasks', { title: '寄样', customerId: cid })).json

    expect((await as(alice, 'DELETE', `/api/quotes/${q.id}`)).status).toBe(204)
    expect((await as(alice, 'GET', `/api/quotes/${q.id}`)).status).toBe(404)
    expect((await as(alice, 'GET', '/api/quotes')).json.some((x: { id: string }) => x.id === q.id)).toBe(false)
    const audit = await lastAudit('quote.delete', q.id)
    expect(audit.trashed).toBe(true)
    expect(audit.snapshot.number).toBe(q.number)
    expect(audit.snapshot.items[0].name).toBe('Valve DN50')

    expect((await as(alice, 'DELETE', `/api/orders/${order.id}`)).status).toBe(204)
    expect((await as(alice, 'GET', `/api/orders/${order.id}`)).status).toBe(404)
    expect((await as(alice, 'GET', '/api/orders?status=all')).json.items.some((x: { id: string }) => x.id === order.id)).toBe(false)
    expect((await lastAudit('order.delete', order.id)).snapshot.payments).toHaveLength(1)
    // 回收站里的订单仍占着报价的“一单一报价”，给出明确原因
    const again = await as(alice, 'POST', `/api/quotes/${q2.id}/order`, {})
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('ORDER_IN_TRASH')

    expect((await as(alice, 'DELETE', `/api/deals/${deal.id}`)).status).toBe(204)
    expect((await as(alice, 'GET', `/api/deals/${deal.id}`)).status).toBe(404)
    expect((await lastAudit('deal.delete', deal.id)).snapshot.title).toBe('年框')

    // 名下还有未删除的报价时客户仍不能删
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).json.error.code).toBe('CUSTOMER_HAS_RECORDS')
    expect((await as(alice, 'DELETE', `/api/quotes/${q2.id}`)).status).toBe(204)
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(204)
    expect((await as(alice, 'GET', `/api/tasks/${task.id}`)).status).toBe(404)
    expect((await as(alice, 'GET', '/api/customers?query=Trash%20Flow')).json.total).toBe(0)
    const snap = (await lastAudit('customer.delete', cid)).snapshot
    expect(snap.company).toBe('Trash Flow Co')
    expect(snap.contacts[0].name).toBe('Buyer')
    expect(snap.tasks[0].title).toBe('寄样')

    const bin = await trashOf(alice)
    const mine = bin.items.filter((i) => [q.id, q2.id, order.id, deal.id, cid, task.id].includes(i.id))
    expect(mine.map((i) => i.entity).sort()).toEqual(['customer', 'deal', 'order', 'quote', 'quote'])
    expect(mine.find((i) => i.entity === 'customer')!.cascadedTasks).toBe(1)
    expect(bin.retentionDays).toBe(30)
    expect(mine[0]!.purgeAt).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  })

  it('查重与导入查重忽略回收站里的客户', async () => {
    const cid = await customer(alice, 'Ghost Buyer Ltd')
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(204)
    expect((await as(bob, 'POST', '/api/customers', { company: 'Ghost Buyer' })).status).toBe(201)
  })
})

describe('恢复与彻底删除', () => {
  it('恢复：所属客户在回收站时先恢复客户；客户连同任务一起恢复', async () => {
    const cid = await customer(alice, 'Restore Me Co')
    const q = await quote(alice, cid)
    const t = (await as(alice, 'POST', '/api/tasks', { title: '电话回访', customerId: cid })).json
    await as(alice, 'DELETE', `/api/quotes/${q.id}`)
    await as(alice, 'DELETE', `/api/customers/${cid}`)
    const blocked = await as(alice, 'POST', `/api/trash/quote/${q.id}/restore`)
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('CUSTOMER_IN_TRASH')
    // 别人看不到也恢复不了
    expect((await trashOf(bob)).items.some((i) => i.id === cid)).toBe(false)
    expect((await as(bob, 'POST', `/api/trash/customer/${cid}/restore`)).status).toBe(404)
    const restored = await as(alice, 'POST', `/api/trash/customer/${cid}/restore`)
    expect(restored.status, restored.text).toBe(200)
    expect(restored.json.restored).toBe(2)
    expect((await as(alice, 'GET', `/api/customers/${cid}`)).status).toBe(200)
    expect((await as(alice, 'GET', `/api/tasks/${t.id}`)).status).toBe(200)
    expect((await as(alice, 'POST', `/api/trash/quote/${q.id}/restore`)).status).toBe(200)
    expect((await as(alice, 'GET', `/api/quotes/${q.id}`)).json.number).toBe(q.number)
    expect(await lastAudit('quote.restore', q.id)).not.toBeNull()
  })

  it('彻底删除：团队服务器里成员不行，管理员可以；客户名下还有回收站记录时先清那些', async () => {
    const cid = await customer(alice, 'Purge Me Co')
    const q = await quote(alice, cid)
    await as(alice, 'DELETE', `/api/quotes/${q.id}`)
    await as(alice, 'DELETE', `/api/customers/${cid}`)
    const denied = await as(alice, 'DELETE', `/api/trash/customer/${cid}`)
    expect(denied.status).toBe(403)
    const blocked = await as(owner, 'DELETE', `/api/trash/customer/${cid}`)
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('CUSTOMER_HAS_RECORDS')
    expect((await as(owner, 'DELETE', `/api/trash/quote/${q.id}`)).status).toBe(204)
    expect((await as(owner, 'DELETE', `/api/trash/customer/${cid}`)).status).toBe(204)
    const d = await db()
    expect(d.prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(cid)).toEqual({ n: 0 })
    expect(d.prepare('SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?').get(cid)).toEqual({ n: 0 })
    expect(await lastAudit('customer.purge', cid)).not.toBeNull()
    expect((await trashOf(owner)).items.some((i) => i.id === q.id || i.id === cid)).toBe(false)
  })

  it('彻底删除需要对应的 *:delete 权限：管理员被收回 task:delete 后不能彻底删除任务，但仍能恢复', async () => {
    const admin = await invite('admin', 'admin@acme.com')
    const cid = await customer(admin, 'Perm Purge Co')
    const t = (await as(admin, 'POST', '/api/tasks', { title: 'x', customerId: cid })).json
    expect((await as(admin, 'DELETE', `/api/tasks/${t.id}`)).status).toBe(204)
    expect((await as(owner, 'PUT', `/api/team/members/${admin.id}/permissions`, { overrides: { 'task:delete': 'deny' } })).status).toBe(200)
    expect((await as(admin, 'DELETE', `/api/trash/task/${t.id}`)).status).toBe(403)
    expect((await as(admin, 'DELETE', `/api/trash/widget/${t.id}`)).status).toBe(400)
    expect((await as(admin, 'POST', `/api/trash/task/${t.id}/restore`)).status).toBe(200)
    await as(owner, 'DELETE', `/api/tasks/${t.id}`)
    expect((await as(owner, 'DELETE', `/api/trash/task/${t.id}`)).status).toBe(204)
  })

  it('自动清理超过保留天数的记录；保留天数可配置，0 不清理', async () => {
    const cid = await customer(alice, 'Old Trash Co')
    const t = (await as(alice, 'POST', '/api/tasks', { title: 'old', customerId: cid })).json
    await as(alice, 'DELETE', `/api/tasks/${t.id}`)
    await as(alice, 'DELETE', `/api/customers/${cid}`)
    const d = await db()
    const old = Date.now() - 31 * 86_400_000
    d.prepare('UPDATE customers SET deleted_at = ? WHERE id = ?').run(old, cid)
    d.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(old, t.id)
    const { trashService } = await import('../src/services/trash-service.js')
    expect((await as(owner, 'PATCH', '/api/settings', { trashRetentionDays: 0 })).status).toBe(200)
    expect(trashService.autoPurge()).toBe(0)
    expect((await as(owner, 'PATCH', '/api/settings', { trashRetentionDays: 60 })).status).toBe(200)
    expect(trashService.autoPurge()).toBe(0)
    expect((await as(owner, 'PATCH', '/api/settings', { trashRetentionDays: 30 })).status).toBe(200)
    expect(trashService.autoPurge()).toBeGreaterThanOrEqual(2)
    expect(d.prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(cid)).toEqual({ n: 0 })
    expect(d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(t.id)).toEqual({ n: 0 })
    const purge = d.prepare("SELECT summary, user_id FROM audit_log WHERE action = 'customer.purge' AND entity_id = ?").get(cid) as { summary: string; user_id: string | null }
    expect(purge.summary).toContain('自动彻底删除')
    expect(purge.user_id).toBeNull()
  })
})

describe('Agent 与 LULUX MCP 走同一套软删除', () => {
  it('内置 Agent delete_task / delete_quote 进回收站', async () => {
    const cid = await customer(alice, 'Agent Trash Co')
    const q = await quote(alice, cid)
    const t = (await as(alice, 'POST', '/api/tasks', { title: 'agent task', customerId: cid })).json
    const r = await agentCall(alice, [
      { id: 'a', name: 'delete_task', arguments: { taskId: t.id } },
      { id: 'b', name: 'delete_quote', arguments: { quoteId: q.id } },
    ])
    expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true)
    expect(JSON.parse(r[0].result).trashed).toBe(true)
    // 搜索同时匹配标题与所属客户
    const bin = await trashOf(alice, '?query=agent')
    expect(bin.items.map((i) => i.id).sort()).toEqual([t.id, q.id].sort())
    expect((await trashOf(alice, '?entity=quote')).items.some((i) => i.id === q.id)).toBe(true)
    expect((await lastAudit('task.delete', t.id)).snapshot.title).toBe('agent task')
  })

  it('list_trash / restore_from_trash：按权限列出与恢复；恢复客户时报告疑似重复但照常恢复', async () => {
    const cid = await customer(alice, 'Dup Restore Co')
    expect((await as(alice, 'DELETE', `/api/customers/${cid}`)).status).toBe(204)
    // 删除期间别人新建了同名客户（回收站里的不参与查重）
    expect((await as(bob, 'POST', '/api/customers', { company: 'Dup Restore Co.' })).status).toBe(201)

    const listed = await agentCall(alice, [{ id: 'l', name: 'list_trash', arguments: { entity: 'customer', query: 'dup restore' } }])
    expect(listed[0].ok, JSON.stringify(listed)).toBe(true)
    const items = JSON.parse(listed[0].result).items as Array<{ id: string; entity: string; deletedBy: string }>
    expect(items.map((i) => i.id)).toEqual([cid])
    expect(items[0]!.deletedBy).toBe('alice')
    // bob 看不到 alice 的回收站记录，也恢复不了
    const bobList = await agentCall(bob, [{ id: 'l', name: 'list_trash', arguments: { query: 'dup restore' } }])
    expect(JSON.parse(bobList[0].result).items).toEqual([])
    const bobRestore = await agentCall(bob, [{ id: 'r', name: 'restore_from_trash', arguments: { entity: 'customer', id: cid } }])
    expect(bobRestore[0].ok).toBe(false)
    expect((await trashOf(alice, '?entity=customer')).items.some((i) => i.id === cid)).toBe(true)

    const restored = await agentCall(alice, [{ id: 'r', name: 'restore_from_trash', arguments: { entity: 'customer', id: cid } }])
    expect(restored[0].ok, JSON.stringify(restored)).toBe(true)
    const result = JSON.parse(restored[0].result)
    expect(result).toMatchObject({ restored: true, entity: 'customer', id: cid })
    expect(result.duplicates).toEqual([{ company: 'Dup Restore Co.', owner: 'bob', matchedBy: ['company'] }])
    expect((await as(alice, 'GET', `/api/customers/${cid}`)).status).toBe(200)
  })

  it('HTTP 恢复客户同样返回疑似重复；没有重复时不带 duplicates', async () => {
    const cid = await customer(alice, 'Http Dup Co')
    await as(alice, 'DELETE', `/api/customers/${cid}`)
    const res = await as(alice, 'POST', `/api/trash/customer/${cid}/restore`)
    expect(res.json.duplicates).toBeUndefined()
    await as(alice, 'DELETE', `/api/customers/${cid}`)
    const other = (await as(alice, 'POST', '/api/customers', { company: 'HTTP DUP CO' })).json
    const again = await as(alice, 'POST', `/api/trash/customer/${cid}/restore`)
    expect(again.status).toBe(200)
    expect(again.json.duplicates).toEqual([expect.objectContaining({ id: other.id, company: 'HTTP DUP CO', matchedBy: ['company'] })])
  })

  it('LULUX MCP 的 delete_customer 进回收站', async () => {
    const cid = await customer(alice, 'MCP Trash Co')
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { actorForUserId } = await import('../src/services/auth-service.js')
    const session = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'full' })
    const issued = luluxMcpTokens.issue({
      actor: actorForUserId(alice.id),
      kernelId: 'claude-code',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-claude-code', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      const res = await server.request('POST', '/gateway/mcp', {
        token: issued.token,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_customer', arguments: { customerId: cid } } },
      })
      expect(res.json.result.isError, res.text).toBe(false)
    } finally {
      issued.revoke()
    }
    expect((await trashOf(alice, '?entity=customer')).items.some((i) => i.id === cid)).toBe(true)
    expect((await db()).prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(cid)).toEqual({ n: 1 })
  })
})
