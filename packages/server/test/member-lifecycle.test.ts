import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 成员生命周期：管理员设置 / 重置的密码须先修改；离职交接（邮箱账户、工作流、定时任务）；
 * 停用账号暂停邮箱同步与定时任务、启用后恢复；公开的版本接口。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
type Who = { token: string; id: string; email: string }
let owner: Who
let admin: Who
let alice: Who
let carol: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

async function dbOf() {
  return (await import('../src/db.js')).db
}

async function login(email: string, password = PASSWORD): Promise<Who> {
  const res = await as(null, 'POST', '/api/auth/login', { email, password })
  expect(res.status, res.text).toBe(200)
  return { token: res.json.token, id: res.json.user.id, email }
}

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, email }
}

let accountSeq = 0
async function emailAccount(ownerId: string, orgId: string): Promise<string> {
  const db = await dbOf()
  const id = `eac_test_${++accountSeq}`
  const now = Date.now()
  db.prepare(
    `INSERT INTO email_accounts (id, org_id, owner_id, email, imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user, sync_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'imap.example.com', 993, 'u', 'smtp.example.com', 465, 'u', 1, ?, ?)`,
  ).run(id, orgId, ownerId, `box${accountSeq}@example.com`, now, now)
  db.prepare(
    `INSERT INTO email_drafts (id, account_id, owner_id, subject, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(`edr_${id}`, id, ownerId, now, now)
  return id
}

async function orgId(): Promise<string> {
  return (await as(owner, 'GET', '/api/team/org')).json.id
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  expect(ok.status, ok.text).toBe(201)
  owner = { token: ok.json.token, id: ok.json.user.id, email: 'owner@acme.com' }
  admin = await invite('admin', 'admin@acme.com')
  alice = await invite('member', 'alice@acme.com')
  carol = await invite('member', 'carol@acme.com')
})
afterAll(() => server.close())

describe('GET /api/version', () => {
  it('不需要登录，返回服务端版本与最低客户端版本', async () => {
    const res = await as(null, 'GET', '/api/version')
    expect(res.status).toBe(200)
    expect(res.json.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(res.json.minClientVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(res.json.mode).toBe('server')
    expect(res.text).not.toContain(server.home)
  })
})

describe('管理员设置的密码：下次登录必须先修改', () => {
  it('直接创建成员：首次登录 mustChangePassword；其它接口 403 PASSWORD_CHANGE_REQUIRED，改密后放行', async () => {
    expect((await as(alice, 'POST', '/api/team/members', { email: 'x@acme.com', name: 'X', password: 'initial pass 1' })).status).toBe(403)
    expect((await as(admin, 'POST', '/api/team/members', { email: 'y@acme.com', name: 'Y', role: 'admin', password: 'initial pass 1' })).json.error.code).toBe('FORBIDDEN')
    expect((await as(admin, 'POST', '/api/team/members', { email: 'z@acme.com', name: 'Z', password: 'short' })).json.error.code).toBe('WEAK_PASSWORD')
    const created = await as(admin, 'POST', '/api/team/members', { email: 'dave@acme.com', name: 'Dave', password: 'initial pass 1' })
    expect(created.status, created.text).toBe(201)
    expect(created.json).toMatchObject({ email: 'dave@acme.com', role: 'member', mustChangePassword: true })
    expect((await as(admin, 'POST', '/api/team/members', { email: 'dave@acme.com', name: 'Dave', password: 'initial pass 1' })).json.error.code).toBe('EMAIL_TAKEN')

    const res = await as(null, 'POST', '/api/auth/login', { email: 'dave@acme.com', password: 'initial pass 1' })
    expect(res.status).toBe(200)
    expect(res.json.user.mustChangePassword).toBe(true)
    const dave: Who = { token: res.json.token, id: res.json.user.id, email: 'dave@acme.com' }

    const blocked = await as(dave, 'GET', '/api/customers')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect((await as(dave, 'POST', '/api/customers', { company: 'Nope' })).json.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect((await as(dave, 'GET', '/api/settings')).status).toBe(403)
    const me = await as(dave, 'GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.json.user.mustChangePassword).toBe(true)
    expect((await as(dave, 'GET', '/api/version')).status).toBe(200)

    expect((await as(dave, 'POST', '/api/auth/password', { currentPassword: 'initial pass 1', newPassword: 'dave own secret' })).status).toBe(204)
    expect((await as(dave, 'GET', '/api/auth/me')).json.user.mustChangePassword).toBe(false)
    expect((await as(dave, 'GET', '/api/customers')).status).toBe(200)
    const audit = await as(admin, 'GET', '/api/audit?action=member.create')
    expect(audit.json.items.some((e: { summary: string }) => e.summary.includes('dave@acme.com'))).toBe(true)
  })

  it('管理员重置密码后对方须改密；登出仍可用；CLI 以外的重置都会标记', async () => {
    expect((await as(admin, 'POST', `/api/team/members/${carol.id}/reset-password`, { newPassword: 'temp by admin 1' })).status).toBe(204)
    const res = await as(null, 'POST', '/api/auth/login', { email: 'carol@acme.com', password: 'temp by admin 1' })
    expect(res.json.user.mustChangePassword).toBe(true)
    const temp: Who = { token: res.json.token, id: res.json.user.id, email: 'carol@acme.com' }
    expect((await as(temp, 'GET', '/api/sessions')).json.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect((await as(temp, 'POST', '/api/auth/logout')).status).toBe(204)

    const again = await login('carol@acme.com', 'temp by admin 1')
    expect((await as(again, 'POST', '/api/auth/password', { currentPassword: 'temp by admin 1', newPassword: PASSWORD })).status).toBe(204)
    expect((await as(again, 'GET', '/api/sessions')).status).toBe(200)
    carol = again

    const reset = await as(admin, 'GET', `/api/audit?action=auth.password_reset`)
    expect(reset.json.items[0].summary).toContain('下次登录须修改')
  })
})

describe('离职交接：邮箱账户、工作流、定时任务', () => {
  it('预览返回各类数量；交接后归接收人，定时任务以接收人身份运行，审计逐类记录', async () => {
    const org = await orgId()
    const cust = await as(alice, 'POST', '/api/customers', { company: 'Leaver Co' })
    expect(cust.status, cust.text).toBe(201)
    const box = await emailAccount(alice.id, org)
    const wf = await as(alice, 'POST', '/api/workflows', {
      name: '每日跟进',
      nodes: [{ id: 'a', name: 'A', kernelId: 'builtin', prompt: '跟进', joinStrategy: 'all', position: { x: 0, y: 0 } }],
      edges: [],
    })
    expect(wf.status, wf.text).toBe(201)
    const session = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    const wfSchedule = await as(alice, 'POST', '/api/schedules', {
      name: '跑工作流',
      target: { type: 'workflow', workflowId: wf.json.id },
      spec: { type: 'daily', time: '09:00' },
    })
    expect(wfSchedule.status, wfSchedule.text).toBe(201)
    const appendSchedule = await as(alice, 'POST', '/api/schedules', {
      name: '追加到会话',
      target: { type: 'prompt', kernelId: 'builtin', prompt: '总结', sessionMode: 'append', sessionId: session.json.session.id },
      spec: { type: 'daily', time: '18:00' },
    })
    expect(appendSchedule.status, appendSchedule.text).toBe(201)

    expect((await as(alice, 'GET', `/api/customers/transfer/preview?fromUserId=${alice.id}`)).status).toBe(403)
    const preview = await as(admin, 'GET', `/api/customers/transfer/preview?fromUserId=${alice.id}`)
    expect(preview.status, preview.text).toBe(200)
    expect(preview.json).toMatchObject({ customers: 1, emailAccounts: 1, workflows: 1, schedules: 2 })

    // 只转定时任务不转工作流：有依赖工作流的任务时拒绝
    const bad = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: carol.id, workflows: false })
    expect(bad.status).toBe(400)
    expect((await as(admin, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: alice.id })).status).toBe(400)

    const res = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: carol.id, emailAccounts: 'transfer' })
    expect(res.status, res.text).toBe(200)
    expect(res.json).toMatchObject({ moved: 1, emailAccounts: { mode: 'transfer', count: 1 }, workflows: 1, schedules: 2 })

    const db = await dbOf()
    const ownerOf = (table: string, id: string) => (db.prepare(`SELECT owner_id FROM ${table} WHERE id = ?`).get(id) as { owner_id: string }).owner_id
    expect(ownerOf('email_accounts', box)).toBe(carol.id)
    expect(ownerOf('email_drafts', `edr_${box}`)).toBe(carol.id)
    expect(ownerOf('workflows', wf.json.id)).toBe(carol.id)
    expect(ownerOf('schedules', wfSchedule.json.id)).toBe(carol.id)
    // 接收人看得到、也能改
    const list = (await as(carol, 'GET', '/api/schedules')).json as Array<{ id: string; target: { sessionMode?: string; sessionId?: string | null } }>
    expect(list.map((s) => s.id)).toEqual(expect.arrayContaining([wfSchedule.json.id, appendSchedule.json.id]))
    // 原负责人的私人会话接收人写不了：改为每次新建会话
    expect(list.find((s) => s.id === appendSchedule.json.id)!.target).toMatchObject({ sessionMode: 'new', sessionId: null })
    expect((await as(carol, 'PATCH', `/api/workflows/${wf.json.id}`, { name: '每日跟进（carol）' })).status).toBe(200)
    expect((await as(alice, 'GET', `/api/schedules/${wfSchedule.json.id}`)).status).toBe(404)

    const { actorForUserId } = await import('../src/services/auth-service.js')
    expect(actorForUserId(ownerOf('schedules', wfSchedule.json.id)).id).toBe(carol.id)

    const audit = (await as(admin, 'GET', '/api/audit?pageSize=50')).json.items.map((e: { action: string }) => e.action)
    for (const action of ['customer.transfer', 'email_account.transfer', 'workflow.transfer', 'schedule.transfer']) expect(audit).toContain(action)
  })

  it('邮箱选“停用”：账户仍归原负责人，后台同步关闭；“不处理”则原样保留', async () => {
    const org = await orgId()
    const leaver = await invite('member', 'erin@acme.com')
    const box = await emailAccount(leaver.id, org)
    const res = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: leaver.id, toUserId: carol.id, emailAccounts: 'disable' })
    expect(res.status, res.text).toBe(200)
    expect(res.json.emailAccounts).toEqual({ mode: 'disable', count: 1 })
    const db = await dbOf()
    expect(db.prepare('SELECT owner_id, sync_enabled FROM email_accounts WHERE id = ?').get(box)).toEqual({ owner_id: leaver.id, sync_enabled: 0 })
    const audit = await as(admin, 'GET', '/api/audit?action=email_account.disable_sync')
    expect(audit.json.items.length).toBeGreaterThan(0)

    const kept = await emailAccount(leaver.id, org)
    const keep = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: leaver.id, toUserId: carol.id, emailAccounts: 'keep' })
    expect(keep.json.emailAccounts).toEqual({ mode: 'keep', count: 0 })
    expect(db.prepare('SELECT owner_id, sync_enabled FROM email_accounts WHERE id = ?').get(kept)).toEqual({ owner_id: leaver.id, sync_enabled: 1 })
  })
})

describe('停用账号：暂停邮箱同步与定时任务；启用后恢复', () => {
  it('停用后邮箱不在后台同步队列、定时任务不触发；启用后恢复并从现在起重新计算下次触发', async () => {
    const org = await orgId()
    const frank = await invite('member', 'frank@acme.com')
    const box = await emailAccount(frank.id, org)
    const sched = await as(frank, 'POST', '/api/schedules', {
      name: '每小时',
      target: { type: 'prompt', kernelId: 'builtin', prompt: 'hi', sessionMode: 'new' },
      spec: { type: 'interval', minutes: 60 },
    })
    expect(sched.status, sched.text).toBe(201)
    const db = await dbOf()
    const { emailScheduler } = await import('../src/services/email/scheduler.js')
    const { scheduler } = await import('../src/services/schedule/scheduler.js')
    expect(emailScheduler.dueAccounts().map((a) => a.id)).toContain(box)

    expect((await as(admin, 'PATCH', `/api/team/members/${frank.id}`, { disabled: true })).status).toBe(200)
    expect(emailScheduler.dueAccounts().map((a) => a.id)).not.toContain(box)
    const paused = db.prepare('SELECT enabled, owner_paused FROM schedules WHERE id = ?').get(sched.json.id) as { enabled: number; owner_paused: number }
    expect(paused).toEqual({ enabled: 1, owner_paused: 1 })
    const ownerView = (await as(admin, 'GET', `/api/audit?action=member.disable`)).json.items[0]
    expect(ownerView.summary).toContain('暂停 1 个定时任务')

    // 到期也不触发、不记失败
    const past = Date.now() - 5 * 60_000
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(past, sched.json.id)
    scheduler.tick()
    expect((db.prepare('SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?').get(sched.json.id) as { n: number }).n).toBe(0)

    expect((await as(admin, 'PATCH', `/api/team/members/${frank.id}`, { disabled: false })).status).toBe(200)
    expect(emailScheduler.dueAccounts().map((a) => a.id)).toContain(box)
    const resumed = db.prepare('SELECT enabled, owner_paused, next_run_at FROM schedules WHERE id = ?').get(sched.json.id) as {
      enabled: number
      owner_paused: number
      next_run_at: number
    }
    expect(resumed.enabled).toBe(1)
    expect(resumed.owner_paused).toBe(0)
    // 停用期间错过的不补跑
    expect(resumed.next_run_at).toBeGreaterThan(Date.now())
    const enableAudit = (await as(admin, 'GET', `/api/audit?action=member.enable`)).json.items[0]
    expect(enableAudit.summary).toContain('恢复 1 个定时任务')
    const listed = (await login('frank@acme.com').then((f) => as(f, 'GET', `/api/schedules/${sched.json.id}`))).json
    expect(listed.ownerPaused).toBe(false)
  })

  it('停用后再交接：定时任务转给接收人后不再暂停', async () => {
    const leaver = await invite('member', 'gina@acme.com')
    const sched = await as(leaver, 'POST', '/api/schedules', {
      name: '交接后继续跑',
      target: { type: 'prompt', kernelId: 'builtin', prompt: 'hi', sessionMode: 'new' },
      spec: { type: 'interval', minutes: 30 },
    })
    expect(sched.status, sched.text).toBe(201)
    expect((await as(admin, 'PATCH', `/api/team/members/${leaver.id}`, { disabled: true })).status).toBe(200)
    const db = await dbOf()
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 3 * 3_600_000, sched.json.id)
    const res = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: leaver.id, toUserId: carol.id })
    expect(res.status, res.text).toBe(200)
    const row = db.prepare('SELECT owner_id, owner_paused, next_run_at FROM schedules WHERE id = ?').get(sched.json.id) as {
      owner_id: string
      owner_paused: number
      next_run_at: number
    }
    expect(row.owner_id).toBe(carol.id)
    expect(row.owner_paused).toBe(0)
    expect(row.next_run_at).toBeGreaterThan(Date.now())
  })
})

describe('迁移 27', () => {
  it('新增 users.must_change_password 与 schedules.owner_paused', async () => {
    const migrations = await import('../src/db/migrations.js')
    expect(migrations.MIGRATIONS.some((m) => m.version === 27 && m.name === 'member_lifecycle')).toBe(true)
    const db = await dbOf()
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols('users')).toContain('must_change_password')
    expect(cols('schedules')).toContain('owner_paused')
  })
})
