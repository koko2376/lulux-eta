import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 开发信序列：真 IMAP（hoodiecrow）+ 真 SMTP（smtp-server）。
 * 排期窗口、模板变量、待确认 → 确认发送、跳过、回信（含同公司）/ 退订 / 退信自动停发、自动发送每日上限、
 * 在邮箱里直接发草稿也能同步回序列、Agent 工具不能开自动发送、MCP 暴露。
 */

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap') as (options: unknown) => {
  listen(port: number, host: string, cb: () => void): void
  close(cb?: () => void): void
  server?: { address(): AddressInfo }
}

const USER = 'sales@lulux-demo.example.com'
const PASS = 'pass-1'
let server: TestServer
let imap: ReturnType<typeof hoodiecrow>
let imapPort = 0
let smtp: SMTPServer
let smtpPort = 0
const received: Array<{ to: string[]; raw: Buffer }> = []
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n')

type Seq = typeof import('../src/services/email/sequence-service.js')
let seq: Seq
let db: typeof import('../src/db.js')['db']
let registry: typeof import('../src/services/tools/registry.js')
let accountId = ''
let sequenceId = ''

const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const ctx = () => ({ sessionId: 'seq-test', agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })
async function callTool(name: string, args: Record<string, unknown>) {
  const tool = registry.findTool(name)
  expect(tool, `${name} 未注册`).toBeTruthy()
  const outcome = await registry.runTool(tool!, args, ctx())
  return { ...outcome, json: outcome.ok ? JSON.parse(outcome.text) : null }
}

async function appendInbox(raw: string): Promise<void> {
  const client = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: { user: USER, pass: PASS }, logger: false })
  await client.connect()
  await client.append('INBOX', crlf(raw))
  await client.logout()
}

async function sync(): Promise<void> {
  const res = await api('POST', `/api/email/accounts/${accountId}/sync`, { wait: true })
  expect(res.status, res.text).toBeLessThan(300)
}

const enrollments = async (id = sequenceId) => (await api('GET', `/api/sequences/${id}/enrollments`)).json as Array<{ id: string; email: string; status: string; currentStep: number; nextSendAt: number | null; stopReason: string; timezone: string }>
const byEmail = async (email: string, id = sequenceId) => (await enrollments(id)).find((e) => e.email === email)!
const pending = async () => (await api('GET', '/api/sequence-sends?status=pending')).json as Array<{ id: string; email: string; draftId: string; subject: string; preview: string; stepIndex: number }>

beforeAll(async () => {
  imap = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UNSELECT', 'ENABLE', 'CONDSTORE', 'XOAUTH2', 'SPECIAL-USE', 'LITERALPLUS', 'UIDPLUS', 'MOVE'],
    users: { [USER]: { password: PASS } },
    storage: { INBOX: { messages: [] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } } },
  })
  await new Promise<void>((resolve) => imap.listen(0, '127.0.0.1', () => ((imapPort = (imap.server ?? (imap as unknown as { address(): AddressInfo })).address().port), resolve())))
  smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _s, cb) {
      return auth.username === USER && auth.password === PASS ? cb(null, { user: USER }) : cb(new Error('bad auth'))
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks) })
        cb()
      })
    },
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => ((smtpPort = (smtp.server.address() as AddressInfo).port), resolve())))
  server = await startTestServer({ LULUX_PDF_FONT: '' })
  seq = await import('../src/services/email/sequence-service.js')
  registry = await import('../src/services/tools/registry.js')
  ;({ db } = await import('../src/db.js'))
  const res = await api('POST', '/api/email/accounts', {
    email: USER,
    displayName: 'Koko Chen',
    imap: { host: '127.0.0.1', port: imapPort, secure: false },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
    password: PASS,
    syncDays: 30,
  })
  expect(res.status, res.text).toBe(201)
  accountId = res.json.id
  await sync()
}, 60_000)

afterAll(async () => {
  await server?.close()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
  await new Promise<void>((resolve) => imap.close(() => resolve()))
})

describe('排期与模板（纯函数）', () => {
  it('窗口内原样返回；窗口前挪到当天开头；窗口后 / 周末挪到下一个工作日', () => {
    const zone = 'Europe/Berlin'
    // 2026-10-21 周三 10:00 柏林（UTC+2）
    const wedTen = Date.UTC(2026, 9, 21, 8, 0)
    expect(seq.nextWindowSlot(wedTen, zone, 9, 17, true, 'k')).toBe(wedTen)
    const wedSix = Date.UTC(2026, 9, 21, 4, 0)
    const slot = seq.nextWindowSlot(wedSix, zone, 9, 17, true, 'k')
    expect(new Date(slot).getUTCHours()).toBe(7) // 09:xx 柏林
    expect(slot).toBeGreaterThan(wedSix)
    // 周五 18:00 柏林 → 下周一 09:xx（10-25 起冬令时 UTC+1，即 08:xx UTC）
    const friEve = Date.UTC(2026, 9, 23, 16, 0)
    const monday = seq.nextWindowSlot(friEve, zone, 9, 17, true, 'k')
    expect(new Date(monday).getUTCDay()).toBe(1)
    expect(new Date(monday).getUTCHours()).toBe(8)
    // 不跳过周末 → 周六 09:xx
    expect(new Date(seq.nextWindowSlot(friEve, zone, 9, 17, false, 'k')).getUTCDay()).toBe(6)
    // 冬令时后（10-25 起 UTC+1）：周一 09:xx = 08:xx UTC
    const sunNight = Date.UTC(2026, 9, 25, 20, 0)
    expect(new Date(seq.nextWindowSlot(sunNight, zone, 9, 17, true, 'k')).getUTCHours()).toBe(8)
  })

  it('模板变量与缺省值', () => {
    expect(seq.renderTemplate('Hi {{firstName|there}}, {{company}} / {{ country }} — {{senderName}}', { firstName: '', company: 'Nordic Tools AB', country: 'SE', senderName: 'Koko' })).toBe(
      'Hi there, Nordic Tools AB / SE — Koko',
    )
    expect(seq.renderTemplate('{{unknown}} {{name}}', { name: 'Anna' })).toBe('{{unknown}} Anna')
  })
})

describe('序列主流程', () => {
  it('新建序列：校验步骤与时段', async () => {
    expect((await api('POST', '/api/sequences', { name: 'x', steps: [] })).status).toBe(400)
    expect((await api('POST', '/api/sequences', { name: 'x', steps: [{ delayDays: 0, subject: 's', body: 'b' }], windowStart: 17, windowEnd: 9 })).status).toBe(400)
    const res = await api('POST', '/api/sequences', {
      name: '北欧工具商',
      accountId,
      windowStart: 0,
      windowEnd: 24,
      skipWeekends: false,
      steps: [
        { delayDays: 0, subject: 'Ball valves for {{company}}', body: 'Hi {{firstName|there}},\n\nWe make brass ball valves DN15–DN50.\n\nBest,\n{{senderName}}' },
        { delayDays: 3, subject: 'Re: Ball valves for {{company}}', body: 'Hi {{firstName|there}}, just following up.' },
      ],
    })
    expect(res.status, res.text).toBe(201)
    sequenceId = res.json.id
    expect(res.json).toMatchObject({ accountEmail: USER, autoSend: false, includeOptout: true, dailyLimit: 50 })
  })

  it('加入联系人：按国家推断时区；退订 / 重复 / 时区错误跳过并说明', async () => {
    await api('POST', '/api/email-suppressions', { email: 'nope@blocked.example.com', reason: '测试' })
    const res = await api('POST', `/api/sequences/${sequenceId}/enrollments`, {
      contacts: [
        { email: 'Anna@Nordic-Tools.example.com', name: 'Anna Berg', company: 'Nordic Tools AB', country: 'SE' },
        { email: 'lars@nordic-tools.example.com', name: 'Lars Holm', company: 'Nordic Tools AB', country: 'Sweden' },
        { email: 'bob.trader@gmail.com', name: 'Bob', country: 'US' },
        { email: 'nope@blocked.example.com' },
        { email: 'anna@nordic-tools.example.com' },
        { email: 'x@tz.example.com', timezone: 'Mars/Base' },
      ],
    })
    expect(res.status, res.text).toBe(200)
    expect(res.json.enrolled.map((e: { email: string }) => e.email)).toEqual(['anna@nordic-tools.example.com', 'lars@nordic-tools.example.com', 'bob.trader@gmail.com'])
    expect(res.json.enrolled[0].timezone).toBe('Europe/Stockholm')
    expect(res.json.enrolled[1].timezone).toBe('Europe/Stockholm')
    expect(res.json.enrolled[2].timezone).toBe('America/New_York')
    const reasons = Object.fromEntries(res.json.skipped.map((s: { email: string; reason: string }) => [s.email, s.reason]))
    expect(reasons['nope@blocked.example.com']).toContain('退订')
    expect(reasons['x@tz.example.com']).toContain('时区')
    const again = await api('POST', `/api/sequences/${sequenceId}/enrollments`, { contacts: [{ email: 'anna@nordic-tools.example.com' }] })
    expect(again.json.skipped[0].reason).toContain('已经在这个序列里')
  })

  it('到点 → 生成草稿进待确认（不发送），正文渲染变量并带退订说明', async () => {
    const result = await seq.tickSequences(Date.now() + 1000)
    expect(result.queued).toBe(3)
    expect(received).toHaveLength(0)
    const queue = await pending()
    expect(queue).toHaveLength(3)
    const anna = queue.find((q) => q.email === 'anna@nordic-tools.example.com')!
    expect(anna.subject).toBe('Ball valves for Nordic Tools AB')
    expect(anna.preview).toContain('Hi Anna,')
    const draft = (await api('GET', `/api/email/drafts/${anna.draftId}`)).json
    expect(draft.text).toContain('Koko Chen')
    expect(draft.text).toContain('unsubscribe')
    expect(draft.source).toBe('sequence')
    // 联系人没有公司名：模板里的 {{company}} 留空并给出提醒
    const bob = (await api('GET', '/api/sequence-sends?status=pending')).json.find((q: { email: string }) => q.email === 'bob.trader@gmail.com')
    expect(bob.missingVars).toEqual(['company'])
    expect(anna.subject).toBe('Ball valves for Nordic Tools AB')
    // 已有待确认的不会重复生成
    expect((await seq.tickSequences(Date.now() + 1000)).queued).toBe(0)
  })

  it('确认发送：真的发出，联系人推进到第 2 步（3 天后）', async () => {
    const anna = (await pending()).find((q) => q.email === 'anna@nordic-tools.example.com')!
    const res = await api('POST', '/api/sequence-sends/approve', { ids: [anna.id] })
    expect(res.status, res.text).toBe(200)
    expect(res.json.sent).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(received[0]!.to).toEqual(['anna@nordic-tools.example.com'])
    const parsed = await simpleParser(received[0]!.raw)
    expect(parsed.subject).toBe('Ball valves for Nordic Tools AB')
    const e = await byEmail('anna@nordic-tools.example.com')
    expect(e).toMatchObject({ status: 'active', currentStep: 1 })
    expect(e.nextSendAt! - Date.now()).toBeGreaterThan(2.9 * 86400_000)
    // 已发的再确认一次：不会重发
    const twice = await api('POST', '/api/sequence-sends/approve', { ids: [anna.id] })
    expect(twice.json.failed[0].error).toContain('已经发出')
    expect(received).toHaveLength(1)
  })

  it('并发确认同一封（双击 / 重试）：只发一次', async () => {
    await api('POST', `/api/sequences/${sequenceId}/enrollments`, { contacts: [{ email: 'race@race.example.com', name: 'Rae', company: 'Race Co' }] })
    await seq.tickSequences(Date.now() + 1000)
    const item = (await pending()).find((q) => q.email === 'race@race.example.com')!
    const before = received.length
    const [a, b] = await Promise.all([
      api('POST', '/api/sequence-sends/approve', { ids: [item.id] }),
      api('POST', '/api/sequence-sends/approve', { ids: [item.id] }),
    ])
    expect(a.json.sent.length + b.json.sent.length).toBe(1)
    expect(received.length).toBe(before + 1)
    await api('PATCH', `/api/sequence-enrollments/${(await byEmail('race@race.example.com')).id}`, { status: 'stopped' })
  })

  it('跳过：删除草稿，进入下一步', async () => {
    const bob = (await pending()).find((q) => q.email === 'bob.trader@gmail.com')!
    const res = await api('POST', `/api/sequence-sends/${bob.id}/skip`)
    expect(res.status, res.text).toBe(200)
    expect((await api('GET', `/api/email/drafts/${bob.draftId}`)).status).toBe(404)
    expect(await byEmail('bob.trader@gmail.com')).toMatchObject({ status: 'active', currentStep: 1 })
  })

  it('对方回信（In-Reply-To）→ 停发；同公司的同事也停发，其待确认草稿作废', async () => {
    const lars = (await pending()).find((q) => q.email === 'lars@nordic-tools.example.com')!
    const sentId = (await simpleParser(received[0]!.raw)).messageId!
    await appendInbox(`From: Anna Berg <anna@nordic-tools.example.com>
To: ${USER}
Subject: Re: Ball valves for Nordic Tools AB
Message-ID: <reply-1@nordic-tools.example.com>
In-Reply-To: ${sentId}
Date: ${new Date(Date.now() + 60_000).toUTCString()}
Content-Type: text/plain; charset=utf-8

Thanks, please send your catalogue.
`)
    await sync()
    expect(await byEmail('anna@nordic-tools.example.com')).toMatchObject({ status: 'replied', nextSendAt: null })
    const larsRow = await byEmail('lars@nordic-tools.example.com')
    expect(larsRow.status).toBe('replied')
    expect(larsRow.stopReason).toContain('同公司')
    expect((await api('GET', `/api/email/drafts/${lars.draftId}`)).status).toBe(404)
    expect((await pending()).some((q) => q.email.endsWith('nordic-tools.example.com'))).toBe(false)
  })

  it('回复退订 → 停发并加入退订名单；以后加入任何序列都会被跳过', async () => {
    await appendInbox(`From: Bob <bob.trader@gmail.com>
To: ${USER}
Subject: Re: Ball valves
Message-ID: <unsub-1@gmail.com>
Date: ${new Date(Date.now() + 60_000).toUTCString()}
Content-Type: text/plain; charset=utf-8

Please unsubscribe me.
`)
    await sync()
    expect(await byEmail('bob.trader@gmail.com')).toMatchObject({ status: 'unsubscribed' })
    const list = (await api('GET', '/api/email-suppressions')).json as Array<{ email: string }>
    expect(list.map((x) => x.email)).toContain('bob.trader@gmail.com')
    const other = await api('POST', '/api/sequences', { name: '另一套', accountId, steps: [{ delayDays: 0, subject: 's', body: 'b' }] })
    const res = await api('POST', `/api/sequences/${other.json.id}/enrollments`, { contacts: [{ email: 'bob.trader@gmail.com' }] })
    expect(res.json.skipped[0].reason).toContain('退订')
    await api('DELETE', `/api/sequences/${other.json.id}`)
  })

  it('退信（MAILER-DAEMON）→ 标记退信并加入退订名单', async () => {
    await api('POST', `/api/sequences/${sequenceId}/enrollments`, { contacts: [{ email: 'ghost@nowhere.example.com', country: 'DE' }] })
    await appendInbox(`From: Mail Delivery System <MAILER-DAEMON@mx.example.net>
To: ${USER}
Subject: Undelivered Mail Returned to Sender
Message-ID: <bounce-1@mx.example.net>
Date: ${new Date(Date.now() + 60_000).toUTCString()}
Content-Type: text/plain; charset=utf-8

<ghost@nowhere.example.com>: host mx.nowhere.example.com said: 550 5.1.1 User unknown
`)
    await sync()
    expect(await byEmail('ghost@nowhere.example.com')).toMatchObject({ status: 'bounced' })
  })

  it('在邮箱里直接发出待确认草稿：序列同步为已发并推进', async () => {
    await api('POST', `/api/sequences/${sequenceId}/enrollments`, { contacts: [{ email: 'mia@hansa-import.example.com', name: 'Mia Krause', country: 'DE' }] })
    await seq.tickSequences(Date.now() + 1000)
    const mia = (await pending()).find((q) => q.email === 'mia@hansa-import.example.com')!
    const before = received.length
    const sent = await api('POST', `/api/email/drafts/${mia.draftId}/send`, {})
    expect(sent.status, sent.text).toBe(200)
    expect(received.length).toBe(before + 1)
    await seq.tickSequences(Date.now() + 1000)
    expect(await byEmail('mia@hansa-import.example.com')).toMatchObject({ status: 'active', currentStep: 1 })
    expect((await pending()).some((q) => q.email === 'mia@hansa-import.example.com')).toBe(false)
  })

  it('暂停 / 恢复 / 停止联系人', async () => {
    const mia = await byEmail('mia@hansa-import.example.com')
    expect((await api('PATCH', `/api/sequence-enrollments/${mia.id}`, { status: 'paused' })).json.status).toBe('paused')
    expect((await seq.tickSequences(Date.now() + 10 * 86400_000)).queued).toBe(0)
    expect((await api('PATCH', `/api/sequence-enrollments/${mia.id}`, { status: 'active' })).json.status).toBe('active')
    expect((await api('PATCH', `/api/sequence-enrollments/${mia.id}`, { status: 'stopped' })).json.status).toBe('stopped')
    expect((await api('PATCH', `/api/sequence-enrollments/${mia.id}`, { status: 'active' })).status).toBe(409)
  })
})

describe('自动发送（用户在界面开启的批量确认）', () => {
  it('到点直接发，受每日上限', async () => {
    const res = await api('POST', '/api/sequences', { name: '自动', accountId, autoSend: true, dailyLimit: 1, windowStart: 0, windowEnd: 24, skipWeekends: false, steps: [{ delayDays: 0, subject: 'Hello {{company}}', body: 'Hi' }] })
    expect(res.json.autoSend).toBe(true)
    await api('POST', `/api/sequences/${res.json.id}/enrollments`, { contacts: [{ email: 'a1@auto.example.com', company: 'A1' }, { email: 'a2@auto2.example.com', company: 'A2' }] })
    const before = received.length
    const tick = await seq.tickSequences(Date.now() + 1000)
    expect(tick.sent).toBe(1)
    expect(received.length).toBe(before + 1)
    const rows = await enrollments(res.json.id)
    expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1)
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1)
    // 上限用完：下一轮不再发
    expect((await seq.tickSequences(Date.now() + 2000)).sent).toBe(0)
    expect(received.length).toBe(before + 1)
  })
})

describe('Agent 工具 / MCP', () => {
  it('sequence_create 不能开自动发送；sequence_update 开自动发送被拒', async () => {
    const bad = await callTool('sequence_create', { name: 't', steps: [{ delayDays: 0, subject: 's', body: 'b' }], autoSend: true })
    expect(bad.ok).toBe(false)
    const ok = await callTool('sequence_create', { name: '工具建的', accountId, steps: [{ delayDays: 0, subject: 'Hi {{company}}', body: 'Hello' }] })
    expect(ok.ok, ok.text).toBe(true)
    expect(ok.json.sequence.autoSend).toBe(false)
    expect(seq.sequenceService.update.length).toBeGreaterThan(0)
    const upd = await callTool('sequence_update', { sequenceId: ok.json.sequence.id, autoSend: true })
    expect(upd.ok).toBe(false)
  })

  it('sequence_enroll / sequence_queue / sequence_approve / email_unsubscribe', async () => {
    const created = await callTool('sequence_create', { name: '工具流程', accountId, windowStart: 0, windowEnd: 24, skipWeekends: false, steps: [{ delayDays: 0, subject: 'Hi {{company}}', body: 'Hello {{firstName|there}}' }] })
    const id = created.json.sequence.id
    const enrolled = await callTool('sequence_enroll', { sequenceId: id, contacts: [{ email: 'tom@tools-flow.example.com', name: 'Tom Lee', company: 'Flow Ltd', country: 'GB' }] })
    expect(enrolled.ok, enrolled.text).toBe(true)
    expect(enrolled.json.enrolled[0].timezone).toBe('Europe/London')
    await seq.tickSequences(Date.now() + 1000)
    const queue = await callTool('sequence_queue', { sequenceId: id })
    expect(queue.json.items[0]).toMatchObject({ to: 'tom@tools-flow.example.com', subject: 'Hi Flow Ltd' })
    const before = received.length
    const approved = await callTool('sequence_approve', { sendIds: [queue.json.items[0].id] })
    expect(approved.ok, approved.text).toBe(true)
    expect(approved.json.sent).toHaveLength(1)
    expect(received.length).toBe(before + 1)
    const unsub = await callTool('email_unsubscribe', { email: 'tom@tools-flow.example.com', reason: '客户要求' })
    expect(unsub.ok, unsub.text).toBe(true)
    const detail = await callTool('sequence_get', { sequenceId: id })
    expect(detail.json.enrollments[0].status).toBe('completed')
  })

  it('MCP 暴露 sequence_* 工具', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await api('POST', '/api/sessions', { agentIds: ['kernel-pi'], permissionLevel: 'full' })
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    try {
      const rpc = async (method: string, params: Record<string, unknown> = {}) =>
        (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: 1, method, params } })).json
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
      const names = ((await rpc('tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['sequence_create', 'sequence_enroll', 'sequence_queue', 'sequence_approve', 'email_unsubscribe']))
      const listed = await rpc('tools/call', { name: 'sequence_list', arguments: {} })
      expect(JSON.parse(listed.result.content[0].text).sequences.length).toBeGreaterThan(0)
    } finally {
      issued.revoke()
    }
  })

  it('删除序列：待确认草稿一并删除', async () => {
    const res = await api('POST', '/api/sequences', { name: '要删的', accountId, windowStart: 0, windowEnd: 24, skipWeekends: false, steps: [{ delayDays: 0, subject: 's', body: 'b' }] })
    await api('POST', `/api/sequences/${res.json.id}/enrollments`, { contacts: [{ email: 'del@remove.example.com' }] })
    await seq.tickSequences(Date.now() + 1000)
    const item = (await pending()).find((q) => q.email === 'del@remove.example.com')!
    expect((await api('DELETE', `/api/sequences/${res.json.id}`)).status).toBe(204)
    expect((await api('GET', `/api/email/drafts/${item.draftId}`)).status).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ?').get(res.json.id)).toEqual({ n: 0 })
  })
})
