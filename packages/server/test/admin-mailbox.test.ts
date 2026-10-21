import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * “管理员可查看成员邮箱”（server 模式，默认关闭）：
 * 关闭时管理员看得到账户（可管理 / 删除），看不到内容、不能代发；开启时可读可发，
 * 成员邮箱带提示，管理员每次读 / 发都写审计，代发需要显式确认。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
type Who = { token: string; id: string }
let server: TestServer
let smtp: SMTPServer
let smtpPort = 0
const received: Array<{ from: string; to: string[] }> = []
let owner: Who
let admin: Who
let alice: Who
let bob: Who
let accountId = ''
let messageId = ''

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

async function invite(role: string, email: string, name: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  smtp = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, callback) {
      callback(null, { user: auth.username })
    },
    onData(stream, session, callback) {
      stream.on('data', () => undefined)
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address) })
        callback()
      })
    },
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => resolve()))
  smtpPort = (smtp.server.address() as AddressInfo).port

  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  admin = await invite('admin', 'admin@acme.com', 'Ada Admin')
  alice = await invite('member', 'alice@acme.com', 'Alice')
  bob = await invite('member', 'bob@acme.com', 'Bob')

  // 直接写库：alice 的私有邮箱 + 一封邮件（不依赖 IMAP）
  const { db } = await import('../src/db.js')
  const { encryptSecret } = await import('../src/security/secrets.js')
  const org = (db.prepare('SELECT org_id FROM users WHERE id = ?').get(alice.id) as { org_id: string }).org_id
  accountId = 'acc_alice'
  const now = Date.now()
  db.prepare(
    `INSERT INTO email_accounts (id, org_id, owner_id, visibility, team_id, name, email, display_name, auth_type, imap_host, imap_port, imap_secure, imap_user,
       smtp_host, smtp_port, smtp_secure, smtp_user, secret, sync_enabled, sync_days, append_to_sent, signature, inbox_path, state, created_at, updated_at)
     VALUES (?, ?, ?, 'private', NULL, 'Alice', 'alice@mail.test', 'Alice', 'password', '127.0.0.1', 1, 0, 'alice@mail.test',
       '127.0.0.1', ?, 0, 'alice@mail.test', ?, 0, 30, 0, '', 'INBOX', 'idle', ?, ?)`,
  ).run(accountId, org, alice.id, smtpPort, encryptSecret('pw'), now, now)
  messageId = 'msg_alice_1'
  db.prepare(
    `INSERT INTO email_messages (id, account_id, folder, folder_path, from_name, from_address, subject, date, snippet, text_body, created_at)
     VALUES (?, ?, 'inbox', 'INBOX', 'Hans', 'hans@acme-valves.de', '私人询盘', ?, 'hi', '报价请求正文', ?)`,
  ).run(messageId, accountId, now, now)
}, 60_000)

afterAll(async () => {
  await server?.close()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
})

const adminAudits = async () =>
  ((await as(owner, 'GET', '/api/audit?action=email.admin.')).json.items as Array<{ action: string; userId: string; meta: Record<string, unknown> }>)

describe('关闭（默认）', () => {
  it('server 模式默认关闭；成员邮箱不显示提示', async () => {
    expect((await as(owner, 'GET', '/api/team/security')).json.adminMailboxAccess).toBe(false)
    const mine = (await as(alice, 'GET', '/api/email/accounts')).json
    expect(mine).toEqual([expect.objectContaining({ id: accountId, adminCanRead: false, contentAccess: 'own' })])
  })

  it('管理员看得到账户但看不到内容，不能起草 / 代发；别的成员完全看不到', async () => {
    const accounts = (await as(admin, 'GET', '/api/email/accounts')).json
    expect(accounts.find((a: any) => a.id === accountId)).toMatchObject({ contentAccess: 'restricted' })
    const list = await as(admin, 'GET', '/api/email/messages')
    expect(list.json.items.map((m: any) => m.id)).not.toContain(messageId)
    expect((await as(admin, 'GET', `/api/email/messages?accountId=${accountId}`)).json.error.code).toBe('MAILBOX_PRIVATE')
    expect((await as(admin, 'GET', `/api/email/messages/${messageId}`)).json.error.code).toBe('MAILBOX_PRIVATE')
    expect((await as(admin, 'GET', `/api/email/messages/${messageId}/html`)).status).toBe(403)
    const draft = await as(admin, 'POST', '/api/email/drafts', { accountId, to: [{ address: 'x@y.test' }], subject: 's', text: 't' })
    expect(draft.json.error.code).toBe('MAILBOX_PRIVATE')
    expect((await as(bob, 'GET', `/api/email/messages/${messageId}`)).status).toBe(404)
    expect((await as(owner, 'GET', `/api/email/messages/${messageId}`)).json.error.code).toBe('MAILBOX_PRIVATE')
    // 成员自己照常可读
    expect((await as(alice, 'GET', `/api/email/messages/${messageId}`)).json.subject).toBe('私人询盘')
    expect(await adminAudits()).toEqual([])
  })

  it('只有 owner 能修改；admin 不行', async () => {
    expect((await as(admin, 'PATCH', '/api/team/security', { adminMailboxAccess: true })).status).toBe(403)
  })
})

describe('开启', () => {
  it('owner 开启后写审计；成员邮箱显示“管理员可查看”', async () => {
    const res = await as(owner, 'PATCH', '/api/team/security', { adminMailboxAccess: true })
    expect(res.status, res.text).toBe(200)
    expect(res.json.adminMailboxAccess).toBe(true)
    const toggles = (await as(owner, 'GET', '/api/audit?action=security.admin_mailbox_access')).json.items
    expect(toggles).toHaveLength(1)
    expect((await as(alice, 'GET', '/api/email/accounts')).json[0]).toMatchObject({ adminCanRead: true, contentAccess: 'own' })
  })

  it('管理员读成员邮件：每次都记审计（谁、哪个账户、什么动作）；成员自己读不记', async () => {
    const accounts = (await as(admin, 'GET', '/api/email/accounts')).json
    expect(accounts.find((a: any) => a.id === accountId)).toMatchObject({ contentAccess: 'admin' })
    const list = await as(admin, 'GET', `/api/email/messages?accountId=${accountId}`)
    expect(list.json.items.map((m: any) => m.id)).toEqual([messageId])
    const read = await as(admin, 'GET', `/api/email/messages/${messageId}`)
    expect(read.json.subject).toBe('私人询盘')
    await as(alice, 'GET', `/api/email/messages/${messageId}`)
    const audits = await adminAudits()
    const actions = audits.map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['email.admin.list', 'email.admin.read']))
    for (const entry of audits) {
      expect(entry.userId).toBe(admin.id)
      expect(entry.meta).toMatchObject({ accountId, accountEmail: 'alice@mail.test', mailboxOwnerId: alice.id })
    }
  })

  it('代发需要显式确认，确认后发出并记审计', async () => {
    const draft = await as(admin, 'POST', '/api/email/drafts', { accountId, to: [{ address: 'buyer@client.test' }], subject: '代发测试', text: '正文' })
    expect(draft.status, draft.text).toBe(201)
    const unconfirmed = await as(admin, 'POST', `/api/email/drafts/${draft.json.id}/send`)
    expect(unconfirmed.status).toBe(409)
    expect(unconfirmed.json.error.code).toBe('CONFIRM_SEND_AS')
    expect(received).toHaveLength(0)
    const sent = await as(admin, 'POST', `/api/email/drafts/${draft.json.id}/send`, { confirmSendAs: true })
    expect(sent.status, sent.text).toBe(200)
    expect(received).toEqual([{ from: 'alice@mail.test', to: ['buyer@client.test'] }])
    const sendAudit = (await adminAudits()).filter((a) => a.action === 'email.admin.send')
    expect(sendAudit).toHaveLength(1)
    expect(sendAudit[0]).toMatchObject({ userId: admin.id, meta: { accountId, mailboxOwnerId: alice.id } })
  })

  it('成员用自己的邮箱发信不需要确认', async () => {
    const draft = await as(alice, 'POST', '/api/email/drafts', { accountId, to: [{ address: 'b@client.test' }], subject: '自己发', text: '正文' })
    expect((await as(alice, 'POST', `/api/email/drafts/${draft.json.id}/send`)).status).toBe(200)
  })

  it('再关闭：管理员又看不到内容，但仍可删除（交接 / 停用）账户', async () => {
    await as(owner, 'PATCH', '/api/team/security', { adminMailboxAccess: false })
    expect((await as(admin, 'GET', `/api/email/messages/${messageId}`)).json.error.code).toBe('MAILBOX_PRIVATE')
    expect((await as(admin, 'GET', '/api/email/drafts')).json.map((d: any) => d.accountId)).not.toContain(accountId)
    expect((await as(admin, 'DELETE', `/api/email/accounts/${accountId}`)).status).toBe(204)
  })
})
