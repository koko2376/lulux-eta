import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 回归：开发信序列（退订误判、错过时刻补发、潜客越权加入、发送中断的草稿、统计口径） */
let server: TestServer
let db: typeof import('../src/db.js')['db']
let seq: typeof import('../src/services/email/sequence-service.js')
const ACC = 'acc_regress'

beforeAll(async () => {
  server = await startTestServer()
  ;({ db } = await import('../src/db.js'))
  seq = await import('../src/services/email/sequence-service.js')
  const now = Date.now()
  db.prepare(`INSERT INTO email_accounts (id, email, display_name, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, created_at, updated_at)
    VALUES (?, 'sales@me.example.com', 'Me', '127.0.0.1', 1, 'u', '127.0.0.1', 1, 'u', ?, ?)`).run(ACC, now, now)
})
afterAll(async () => server?.close())

let seqNo = 0
function mkSeq(extra: Record<string, unknown> = {}) {
  seqNo += 1
  return server.request('POST', '/api/sequences', {
    body: { name: `S${seqNo}`, accountId: ACC, steps: [{ delayDays: 0, subject: 'Hi', body: 'Hello {{firstName|there}}' }, { delayDays: 3, subject: 'Re', body: 'Again' }], windowStart: 9, windowEnd: 17, skipWeekends: false, ...extra },
  })
}

async function enrollOne(email: string, timezone = 'UTC', extra: Record<string, unknown> = {}) {
  const s = await mkSeq(extra)
  expect(s.status, s.text).toBe(201)
  const e = await server.request('POST', `/api/sequences/${s.json.id}/enrollments`, { body: { contacts: [{ email, name: 'Anna', company: 'Acme', timezone }] } })
  expect(e.status, e.text).toBeLessThan(300)
  expect(e.json.enrolled).toHaveLength(1)
  return { sequenceId: s.json.id as string, enrollmentId: e.json.enrolled[0].id as string }
}

function inbound(from: string, text: string, subject = 'Re: Hi') {
  seq.handleInboundForSequences({ accountId: ACC, date: Date.now() + 1000, fromAddress: from, subject, text, inReplyTo: null, references: [] })
}

function stateOf(email: string) {
  const row = db.prepare('SELECT status, stop_reason FROM sequence_enrollments WHERE email = ?').get(email) as { status: string; stop_reason: string }
  const suppressed = Boolean(db.prepare('SELECT 1 AS ok FROM email_suppressions WHERE email = ?').get(email))
  return { ...row, suppressed }
}

describe('回信只看新写的部分：引用原文里的退订说明不算退订', () => {
  const FOOTER = `> --\n> If you'd rather not receive further emails from us, just reply "unsubscribe".`

  it('正面询价回信（下面引用了我们的退订脚注）→ 记为已回信，不进退订名单', async () => {
    await enrollOne('buyer@acme-gmbh.example.de', 'Europe/Berlin')
    inbound(
      'buyer@acme-gmbh.example.de',
      `Hi, yes we are interested, please send your price list for 500 pcs.\n\nOn Mon, Sales <sales@me.example.com> wrote:\n> Hello Anna\n>\n${FOOTER}`,
    )
    expect(stateOf('buyer@acme-gmbh.example.de')).toMatchObject({ status: 'replied', suppressed: false })
  })

  it('各种引用分隔（中文“写道”、Original Message、发件人头、折行的 On … wrote:）都不会误判', async () => {
    const cases: Array<[string, string]> = [
      ['cn@buyer-a.example.com', '好的，请报 FOB 宁波价。\n\n在 2026年10月20日 周一 10:00，Sales <sales@me.example.com> 写道：\nHello\n--\nIf you\'d rather not receive further emails from us, just reply "unsubscribe".'],
      ['ol@buyer-b.example.com', 'Please quote 2000 pcs.\n\n-----Original Message-----\nFrom: Sales\nSent: Monday\nSubject: Hi\n\nHello\nIf you\'d rather not receive further emails from us, just reply "unsubscribe".'],
      ['hdr@buyer-c.example.com', '请发目录。\n\n发件人: Sales <sales@me.example.com>\n发送时间: 2026年10月20日\n主题: Hi\n\nunsubscribe'],
      ['wrap@buyer-d.example.com', 'Send catalog please.\n\nOn Mon, Oct 20, 2026 at 10:00 AM Sales Team\n<sales@me.example.com> wrote:\n\nHello, reply unsubscribe to stop.'],
    ]
    for (const [email, text] of cases) {
      await enrollOne(email)
      inbound(email, text)
      expect(stateOf(email), email).toMatchObject({ status: 'replied', suppressed: false })
    }
  })

  it('对方在新写的部分明确要求退订 → 仍然退订并进退订名单', async () => {
    await enrollOne('stop@buyer-e.example.com')
    inbound('stop@buyer-e.example.com', `Please unsubscribe me from your list.\n\nOn Mon, Sales <sales@me.example.com> wrote:\n> Hello Anna`)
    expect(stateOf('stop@buyer-e.example.com')).toMatchObject({ status: 'unsubscribed', suppressed: true })
  })

  it('只说“not interested”→ 记为已回信并提示人工确认，不直接拉进退订名单', async () => {
    await enrollOne('meh@buyer-f.example.com')
    inbound('meh@buyer-f.example.com', 'Thanks, not interested at the moment.')
    const state = stateOf('meh@buyer-f.example.com')
    expect(state).toMatchObject({ status: 'replied', suppressed: false })
    expect(state.stop_reason).toContain('人工确认')
  })

  it('freshReplyText：去掉 > 引用、分隔行之后的内容、签名和给定的固定文字', async () => {
    const { freshReplyText } = await import('../src/services/email/reply-text.js')
    expect(freshReplyText('Yes please.\n> quoted unsubscribe\nmore')).toBe('Yes please.\nmore')
    expect(freshReplyText('Yes.\n-- \nJohn\nunsubscribe link')).toBe('Yes.')
    expect(freshReplyText('Yes.\n-- \nJohn Co Ltd', [], { keepSignature: true })).toBe('Yes.\n-- \nJohn Co Ltd')
    expect(freshReplyText('Yes. FOOTER-TEXT here', ['FOOTER-TEXT'])).toBe('Yes.  here')
    // 正文里偶然出现的 “From: …”（后面不是引用头）不截断
    expect(freshReplyText('From: our side we need 500 pcs.\nThanks')).toBe('From: our side we need 500 pcs.\nThanks')
  })
})

describe('错过的发送时刻按对方时区的发送时段重新排期', () => {
  it('关机期间错过：纽约凌晨 3 点 tick 不生成也不发送，改排到当天纽约 9 点的时段', async () => {
    const { enrollmentId } = await enrollOne('x@late.example.com', 'America/New_York')
    const ny3am = Date.UTC(2026, 9, 27, 7, 0) // 2026-10-27（周二）03:00 EDT
    db.prepare('UPDATE sequence_enrollments SET next_send_at = ? WHERE id = ?').run(ny3am - 18 * 3600_000, enrollmentId)
    await seq.tickSequences(ny3am)
    expect(db.prepare('SELECT 1 AS ok FROM sequence_sends WHERE enrollment_id = ?').get(enrollmentId)).toBeUndefined()
    const next = (db.prepare('SELECT next_send_at FROM sequence_enrollments WHERE id = ?').get(enrollmentId) as { next_send_at: number }).next_send_at
    const nine = Date.UTC(2026, 9, 27, 13, 0) // 09:00 EDT
    expect(next).toBeGreaterThanOrEqual(nine)
    expect(next).toBeLessThan(nine + 30 * 60_000)
    // 到了新排的时刻（窗口内）才真正生成
    await seq.tickSequences(next + 1000)
    expect(db.prepare('SELECT 1 AS ok FROM sequence_sends WHERE enrollment_id = ?').get(enrollmentId)).toBeTruthy()
  })

  it('跳过周末的序列：周六错过的时刻挪到周一，不在周末补发', async () => {
    const { enrollmentId } = await enrollOne('weekend@late.example.com', 'Europe/Berlin', { skipWeekends: true })
    const satNoon = Date.UTC(2026, 9, 24, 10, 0) // 2026-10-24（周六）12:00 CEST
    db.prepare('UPDATE sequence_enrollments SET next_send_at = ? WHERE id = ?').run(satNoon - 3 * 86400_000, enrollmentId)
    await seq.tickSequences(satNoon)
    expect(db.prepare('SELECT 1 AS ok FROM sequence_sends WHERE enrollment_id = ?').get(enrollmentId)).toBeUndefined()
    const next = (db.prepare('SELECT next_send_at FROM sequence_enrollments WHERE id = ?').get(enrollmentId) as { next_send_at: number }).next_send_at
    const monday9 = Date.UTC(2026, 9, 26, 8, 0) // 2026-10-26（周一）09:00 CET（10-25 夏令时结束）
    expect(next).toBeGreaterThanOrEqual(monday9)
    expect(next).toBeLessThan(monday9 + 30 * 60_000)
  })

  it('整条序列暂停后恢复：错过的时刻重新排进发送时段，不早于现在', async () => {
    const { sequenceId, enrollmentId } = await enrollOne('resume@late.example.com', 'Asia/Tokyo')
    expect((await server.request('PATCH', `/api/sequences/${sequenceId}`, { body: { status: 'paused' } })).status).toBe(200)
    const stale = Date.now() - 5 * 86400_000
    db.prepare('UPDATE sequence_enrollments SET next_send_at = ? WHERE id = ?').run(stale, enrollmentId)
    const before = Date.now()
    const resumed = await server.request('PATCH', `/api/sequences/${sequenceId}`, { body: { status: 'active' } })
    expect(resumed.status, resumed.text).toBe(200)
    const next = (db.prepare('SELECT next_send_at FROM sequence_enrollments WHERE id = ?').get(enrollmentId) as { next_send_at: number }).next_send_at
    expect(next).toBeGreaterThanOrEqual(before)
    const tokyoHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(next))
    expect(tokyoHour).toBeGreaterThanOrEqual(9)
    expect(tokyoHour).toBeLessThan(17)
  })
})

describe('加入序列校验潜客的可见性与组织', () => {
  it('另一个组织的潜客 id：当成不存在跳过，邮箱不会进 enrollment', async () => {
    const now = Date.now()
    const cols = db.prepare('PRAGMA table_info(prospects)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    const values: Record<string, unknown> = { id: 'prs_other', org_id: 'other-org', owner_id: 'someone', company: 'Secret Buyer', emails: JSON.stringify(['ceo@secret.example.com']), created_at: now, updated_at: now }
    for (const c of cols) if (c.notnull && c.dflt_value === null && !(c.name in values)) values[c.name] = ''
    const keys = Object.keys(values)
    db.prepare(`INSERT INTO prospects (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => values[k] as never))
    const s = await mkSeq()
    const e = await server.request('POST', `/api/sequences/${s.json.id}/enrollments`, { body: { prospectIds: ['prs_other'], force: true } })
    expect(e.status, e.text).toBeLessThan(300)
    expect(e.json.enrolled).toEqual([])
    expect(e.json.skipped).toEqual([{ email: 'prs_other', reason: '潜客不存在' }])
    expect(JSON.stringify(e.json)).not.toContain('secret.example.com')
    expect(db.prepare("SELECT 1 AS ok FROM sequence_enrollments WHERE email = 'ceo@secret.example.com'").get()).toBeUndefined()
  })

  it('自己组织里看得见的潜客照常加入', async () => {
    const p = await server.request('POST', '/api/prospects', { body: { company: 'Visible Buyer', emails: ['buyer@visible.example.com'] } })
    expect(p.status, p.text).toBeLessThan(300)
    const id = p.json.prospect?.id ?? p.json.id
    const s = await mkSeq()
    const e = await server.request('POST', `/api/sequences/${s.json.id}/enrollments`, { body: { prospectIds: [id], force: true } })
    expect(e.status, e.text).toBeLessThan(300)
    expect(e.json.enrolled.map((x: { email: string }) => x.email)).toEqual(['buyer@visible.example.com'])
  })
})

describe('发送中途退出的草稿：启动恢复为可重试', () => {
  it('“发送中”的草稿恢复成失败：可修改、确认重发不再报“正在发送”；发送中的草稿不能删', async () => {
    const { draftService } = await import('../src/services/email/draft-service.js')
    const { enrollmentId } = await enrollOne('crash@buyer.example.com', 'UTC', { windowStart: 0, windowEnd: 24 })
    await seq.tickSequences(Date.now() + 1000)
    const send = db.prepare('SELECT id, draft_id FROM sequence_sends WHERE enrollment_id = ?').get(enrollmentId) as { id: string; draft_id: string }
    expect(send).toBeTruthy()
    // 模拟：deliver 已把两者都置为 sending，SMTP 之前进程被杀
    db.prepare("UPDATE sequence_sends SET status = 'sending' WHERE id = ?").run(send.id)
    db.prepare("UPDATE email_drafts SET status = 'sending' WHERE id = ?").run(send.draft_id)
    // 发送中的草稿不能删除
    const del = await server.request('DELETE', `/api/email/drafts/${send.draft_id}`)
    expect(del.status).toBe(409)
    // 启动恢复：草稿改为失败
    expect(draftService.recoverInterrupted()).toBeGreaterThanOrEqual(1)
    const draft = db.prepare('SELECT status, error FROM email_drafts WHERE id = ?').get(send.draft_id) as { status: string; error: string }
    expect(draft.status).toBe('failed')
    expect(draft.error).toContain('中断')
    // 序列这边的恢复（启动后第一次调度时做的同一件事）
    db.prepare("UPDATE sequence_sends SET status = 'failed', error = '上次发送被中断，请确认对方没收到后再发' WHERE id = ? AND status = 'sending'").run(send.id)
    const edit = await server.request('PATCH', `/api/email/drafts/${send.draft_id}`, { body: { subject: 'x' } })
    expect(edit.status, edit.text).toBe(200)
    const approve = await server.request('POST', '/api/sequence-sends/approve', { body: { ids: [send.id] } })
    expect(approve.status, approve.text).toBeLessThan(300)
    // 测试环境没有 SMTP，会因连接失败而失败；关键是不再卡在“正在发送”
    expect(JSON.stringify(approve.json.failed)).not.toMatch(/正在发送/)
  })
})

describe('统计与重复加入', () => {
  it('自动发送失败时，tick 只计入已生成，不计入已发出', async () => {
    const s = await mkSeq({ windowStart: 0, windowEnd: 24, autoSend: true })
    expect(s.status, s.text).toBe(201)
    expect(s.json.autoSend).toBe(true)
    const e = await server.request('POST', `/api/sequences/${s.json.id}/enrollments`, { body: { contacts: [{ email: 'auto@fail.example.com', timezone: 'UTC' }] } })
    expect(e.json.enrolled).toHaveLength(1)
    const r = await seq.tickSequences(Date.now() + 1000)
    expect(r.queued).toBeGreaterThanOrEqual(1)
    expect(r.sent).toBe(0)
  })

  it('已暂停的联系人不能同时被加入第二个序列', async () => {
    const { enrollmentId } = await enrollOne('paused@twice.example.com')
    expect((await server.request('PATCH', `/api/sequence-enrollments/${enrollmentId}`, { body: { status: 'paused' } })).status).toBeLessThan(300)
    const s2 = await mkSeq()
    const e = await server.request('POST', `/api/sequences/${s2.json.id}/enrollments`, { body: { contacts: [{ email: 'paused@twice.example.com', timezone: 'UTC' }] } })
    expect(e.json.enrolled).toEqual([])
    expect(e.json.skipped[0].reason).toContain('正在序列')
  })
})
