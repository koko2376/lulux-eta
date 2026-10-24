import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 询盘打分接入：人工标询盘 / 重新判定 / 重新打分写库，列表按分排序与等级筛选，Agent 工具与 MCP。 */

type Registry = typeof import('../src/services/tools/registry.js')
let server: TestServer
let registry: Registry
let db: typeof import('../src/db.js')['db']
const ids: Record<string, string> = {}

const ctx = () => ({ sessionId: 'inquiry-tools-test', agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })
async function callTool(name: string, args: Record<string, unknown>) {
  const tool = registry.findTool(name)
  expect(tool, `${name} 未注册`).toBeTruthy()
  const outcome = await registry.runTool(tool!, args, ctx())
  return { ...outcome, json: outcome.ok ? JSON.parse(outcome.text) : null }
}

function insertMail(key: string, from: string, subject: string, body: string, extra: { replyTo?: string; attachment?: string; folder?: string } = {}) {
  const id = `msg_${key}`
  db.prepare(
    `INSERT INTO email_messages (id, account_id, folder, uid, message_id, thread_key, from_name, from_address, reply_to_json, subject, date, snippet, text_body, created_at)
     VALUES (?, 'acc_test', ?, NULL, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, extra.folder ?? 'inbox', `<${key}@test>`, key, from, JSON.stringify(extra.replyTo ? [{ name: '', address: extra.replyTo }] : []), subject, Date.now() - Object.keys(ids).length * 1000, body.slice(0, 100), body, Date.now())
  if (extra.attachment) {
    db.prepare(`INSERT INTO email_attachments (id, message_id, filename, content_type, size, inline, position) VALUES (?, ?, ?, 'text/html', 10, 0, 0)`).run(`att_${key}`, id, extra.attachment)
  }
  ids[key] = id
}

beforeAll(async () => {
  server = await startTestServer()
  registry = await import('../src/services/tools/registry.js')
  ;({ db } = await import('../src/db.js'))
  db.prepare(
    `INSERT INTO email_accounts (id, email, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, sync_enabled, created_at, updated_at)
     VALUES ('acc_test', 'sales@lulux-demo.example.com', 'imap.example.com', 993, 'u', 'smtp.example.com', 465, 'u', 0, ?, ?)`,
  ).run(Date.now(), Date.now())
  insertMail('good', 'j.miller@northwind-pumps.co.uk', 'RFQ gate valves DN50', 'We need 2000 pcs gate valves DN50 PN16, CIF Felixstowe, target price USD 9.5. Regards, Northwind Pumps Ltd, Tel: +44 20 7946 0958, www.northwind-pumps.co.uk')
  insertMail('sample', 'buyer2026@gmail.com', 'samples', 'Hello, send me free samples please.')
  insertMail('phish', 'po@buyer-corp.com', 'Purchase order', 'Click here to view the purchase order online.', { attachment: 'PO_2231.html' })
  insertMail('sent', 'sales@lulux-demo.example.com', 'Re: RFQ', 'Thanks', { folder: 'sent' })
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('询盘打分接入', () => {
  it('人工标成询盘 → 自动打分写库；详情带理由', async () => {
    for (const key of ['good', 'sample', 'phish']) {
      const res = await server.request('PATCH', `/api/email/messages/${ids[key]}`, { body: { verdict: 'inquiry' } })
      expect(res.status, res.text).toBe(200)
      expect(res.json.inquiryGrade).toMatch(/^[ABCD]$/)
    }
    const good = (await server.request('GET', `/api/email/messages/${ids.good}`)).json
    expect(good.inquiryGrade).toBe('A')
    expect(good.inquiry.reasons.length).toBeGreaterThan(3)
    const phish = (await server.request('GET', `/api/email/messages/${ids.phish}`)).json
    expect(phish.inquiryGrade).toBe('D')
    expect(phish.inquiry.flags).toContain('phishing')
  })

  it('列表：按分排序、等级筛选', async () => {
    const sorted = await server.request('GET', '/api/email/messages?folder=inbox&verdict=inquiry&sort=score')
    expect(sorted.json.items.map((m: { id: string }) => m.id)).toEqual([ids.good, ids.sample, ids.phish])
    const ab = await server.request('GET', '/api/email/messages?grade=AB')
    expect(ab.json.items.map((m: { id: string }) => m.id)).toEqual([ids.good])
    const d = await server.request('GET', '/api/email/messages?grade=D')
    expect(d.json.items.map((m: { id: string }) => m.id)).toContain(ids.phish)
  })

  it('重新打分接口；发件箱不能打分', async () => {
    db.prepare('UPDATE email_messages SET inquiry_score = NULL, inquiry_grade = NULL WHERE id = ?').run(ids.good)
    const res = await server.request('POST', `/api/email/messages/${ids.good}/score`)
    expect(res.status, res.text).toBe(200)
    expect(res.json.inquiryGrade).toBe('A')
    const sent = await server.request('POST', `/api/email/messages/${ids.sent}/score`)
    expect(sent.status).toBe(400)
  })

  it('score_inquiry 工具：按 messageId（不写库）或直接给正文', async () => {
    db.prepare('UPDATE email_messages SET inquiry_score = NULL, inquiry_grade = NULL WHERE id = ?').run(ids.sample)
    const byId = await callTool('score_inquiry', { messageId: ids.sample })
    expect(byId.ok, byId.text).toBe(true)
    expect(byId.json.flags).toEqual(expect.arrayContaining(['free_mail', 'sample_hunter']))
    expect(byId.json.followUps.length).toBeGreaterThan(0)
    expect(byId.json.hint).toContain('create_email_draft')
    const row = db.prepare('SELECT inquiry_score FROM email_messages WHERE id = ?').get(ids.sample) as { inquiry_score: number | null }
    expect(row.inquiry_score).toBeNull()
    const raw = await callTool('score_inquiry', { from: 'compras@ferreteria-sol.es', body: 'Hola, necesitamos 800 piezas de válvulas, precio FOB. Saludos' })
    expect(raw.ok, raw.text).toBe(true)
    expect(raw.json.language).toBe('es')
    expect(raw.json.languageName).toBe('西班牙语')
    expect((await callTool('score_inquiry', { subject: 'x' })).ok).toBe(false)
    expect((await callTool('score_inquiry', { messageId: ids.good, body: 'x', from: 'a@b.c' })).ok).toBe(false)
  })

  it('list_inquiries：按分从高到低，默认不含 D 级', async () => {
    const res = await callTool('list_inquiries', {})
    expect(res.ok, res.text).toBe(true)
    expect(res.json.items[0]).toMatchObject({ id: ids.good, grade: 'A' })
    // 本机时区的墙上时间（带偏移），不给 UTC ISO，免得模型误判“今天”
    expect(res.json.items[0].receivedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/)
    expect(res.json.now).toMatch(/UTC/)
    expect(res.json.items.some((m: { id: string }) => m.id === ids.phish)).toBe(false)
    const d = await callTool('list_inquiries', { grade: 'D' })
    expect(d.json.items.map((m: { id: string }) => m.id)).toContain(ids.phish)
  })

  it('升级前的老询盘（已判询盘但没分）：按等级筛 / 按分排序时自动补打', async () => {
    insertMail('legacy', 'buyer@legacy-import.example.com', 'RFQ', 'Please quote 1000 pcs DN32 ball valves FOB Ningbo. Legacy Import Ltd, Tel: +1 555 010 2233, www.legacy-import.example.com')
    db.prepare("UPDATE email_messages SET verdict = 'inquiry' WHERE id = ?").run(ids.legacy)
    const res = await callTool('list_inquiries', { grade: 'AB' })
    expect(res.json.items.map((m: { id: string }) => m.id)).toContain(ids.legacy)
  })

  it('search_emails 带上询盘分；MCP 暴露 score_inquiry / list_inquiries', async () => {
    const res = await callTool('search_emails', { verdict: 'inquiry' })
    expect(res.json.items.find((m: { id: string }) => m.id === ids.good).inquiryGrade).toBe('A')
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-pi'], permissionLevel: 'full' } })
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      let id = 0
      const rpc = async (method: string, params: Record<string, unknown> = {}) =>
        (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      const names = ((await rpc('tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['score_inquiry', 'list_inquiries']))
      const called = await rpc('tools/call', { name: 'list_inquiries', arguments: { grade: 'A' } })
      expect(JSON.parse(called.result.content[0].text).items[0].id).toBe(ids.good)
    } finally {
      issued.revoke()
    }
  })
})
