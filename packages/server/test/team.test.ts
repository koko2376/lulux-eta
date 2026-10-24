import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

const ORIGIN = 'https://lulux.example.com'
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
})
afterAll(() => server.close())

type Who = { token: string; id: string; email: string }
const as = (who: Who | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  server.request(method, path, { body, token: who ? who.token : null, headers })

const PASSWORD = 'correct horse battery'
let owner: Who
let admin: Who
let alice: Who // member, team A
let bob: Who // member, team A
let carol: Who // member, no team
let victor: Who // viewer, team A
let teamA = ''

async function login(email: string, password = PASSWORD): Promise<Who> {
  const res = await as(null, 'POST', '/api/auth/login', { email, password })
  expect(res.status, res.text).toBe(200)
  return { token: res.json.token, id: res.json.user.id, email }
}

async function invite(role: string, email: string, extra: Record<string, unknown> = {}): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role, ...extra })
  expect(created.status, created.text).toBe(201)
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, email }
}

describe('server 模式：初始化与登录', () => {
  it('mode 公开；未初始化时业务接口 401、登录 409', async () => {
    const mode = await as(null, 'GET', '/api/auth/mode')
    expect(mode.status).toBe(200)
    expect(mode.json).toMatchObject({ mode: 'server', setupRequired: true, publicOrigin: ORIGIN })
    expect((await as(null, 'GET', '/api/customers')).status).toBe(401)
    // desktop 模式的固定 token 在 server 模式无效
    expect((await server.request('GET', '/api/customers')).status).toBe(401)
    const loginRes = await as(null, 'POST', '/api/auth/login', { email: 'x@y.com', password: 'whatever1' })
    expect(loginRes.json.error.code).toBe('SETUP_REQUIRED')
  })

  it('setup token 错误 403；正确则创建 owner 并返回会话', async () => {
    const bad = await as(null, 'POST', '/api/auth/setup', { setupToken: 'nope', email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
    expect(bad.status).toBe(403)
    expect(bad.json.error.code).toBe('SETUP_TOKEN_INVALID')
    const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
    const weak = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: 'short', name: 'Owner', orgName: 'Acme' })
    expect(weak.json.error.code).toBe('WEAK_PASSWORD')
    const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'Owner@Acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.json.token).toMatch(/^lxs_[0-9a-f]{64}$/)
    expect(ok.json.user).toMatchObject({ email: 'owner@acme.com', role: 'owner' })
    owner = { token: ok.json.token, id: ok.json.user.id, email: 'owner@acme.com' }
    const again = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'b@acme.com', password: PASSWORD, name: 'B', orgName: 'X' })
    expect(again.json.error.code).toBe('SETUP_ALREADY_DONE')
    expect((await as(null, 'GET', '/api/auth/mode')).json.setupRequired).toBe(false)
  })

  it('me 返回角色与全部权限', async () => {
    const me = await as(owner, 'GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({ mode: 'server', user: { role: 'owner' }, org: { name: 'Acme' } })
    expect(me.json.permissions).toContain('security:manage')
    expect(me.json.session.expiresAt).toBeGreaterThan(Date.now())
  })

  it('登录：错误密码 401；同一邮箱失败 5 次后 429 + Retry-After', async () => {
    const { resetRateLimitsForTests } = await import('../src/services/auth-service.js')
    resetRateLimitsForTests()
    for (let i = 0; i < 5; i += 1) {
      const res = await as(null, 'POST', '/api/auth/login', { email: 'owner@acme.com', password: 'wrong-password' })
      expect(res.status).toBe(401)
      expect(res.json.error.code).toBe('INVALID_CREDENTIALS')
    }
    const limited = await as(null, 'POST', '/api/auth/login', { email: 'owner@acme.com', password: PASSWORD })
    expect(limited.status).toBe(429)
    expect(limited.json.error.code).toBe('LOGIN_RATE_LIMITED')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    resetRateLimitsForTests()
    await login('owner@acme.com')
  })
})

describe('server 模式：Host / Origin / CORS', () => {
  it('Host 只接受 LULUX_PUBLIC_ORIGIN 与本机回环', async () => {
    expect((await server.request('GET', '/api/auth/mode', { host: 'evil.example.com' })).status).toBe(403)
    expect((await server.request('GET', '/api/auth/mode', { host: 'lulux.example.com' })).status).toBe(200)
    expect((await server.request('GET', '/', { host: 'evil.example.com' })).status).toBe(403)
  })

  it('Origin 白名单 + 精确 CORS 回显，不发 credentials', async () => {
    const evil = await as(owner, 'GET', '/api/auth/me', undefined, { Origin: 'https://evil.example.com' })
    expect(evil.status).toBe(403)
    expect(evil.json.error.code).toBe('ORIGIN_NOT_ALLOWED')
    const good = await as(owner, 'GET', '/api/auth/me', undefined, { Origin: ORIGIN })
    expect(good.status).toBe(200)
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(good.headers['access-control-allow-credentials']).toBeUndefined()
    const desktop = await as(owner, 'GET', '/api/auth/me', undefined, { Origin: 'http://127.0.0.1:61234' })
    expect(desktop.status).toBe(200)
    expect(desktop.headers['access-control-allow-origin']).toBe('http://127.0.0.1:61234')
    const preflight = await server.request('OPTIONS', '/api/customers', { token: null, headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization')
    // 跨源（团队服务器 + 桌面端）也能读到并传入请求 ID，便于报错时对照日志
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Request-Id')
    expect(desktop.headers['access-control-expose-headers']).toContain('X-Request-Id')
    expect(desktop.headers['x-request-id']).toBeTruthy()
  })
})

describe('邀请与成员', () => {
  it('邀请信息公开可查；接受后加入并登录；邮箱不符 / 用完 / 撤销', async () => {
    const team = await as(owner, 'POST', '/api/team/teams', { name: '一组' })
    expect(team.status).toBe(201)
    teamA = team.json.id

    const created = await as(owner, 'POST', '/api/team/invites', { role: 'member', email: 'alice@acme.com', teamId: teamA })
    expect(created.json.code).toMatch(/^lxi_/)
    expect(created.json.url).toBe(`${ORIGIN}/#/join?code=${created.json.code}`)
    const info = await as(null, 'GET', `/api/auth/invites/${created.json.code}`)
    expect(info.json).toMatchObject({ orgName: 'Acme', role: 'member', email: 'alice@acme.com' })
    const mismatch = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email: 'eve@acme.com', password: PASSWORD, name: 'Eve' })
    expect(mismatch.json.error.code).toBe('INVITE_EMAIL_MISMATCH')
    const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email: 'alice@acme.com', password: PASSWORD, name: 'Alice' })
    expect(accepted.status).toBe(201)
    alice = { token: accepted.json.token, id: accepted.json.user.id, email: 'alice@acme.com' }
    const reused = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email: 'alice2@acme.com', password: PASSWORD, name: 'A2' })
    expect(reused.status).toBe(410)
    expect((await as(null, 'GET', '/api/auth/invites/lxi_doesnotexist')).status).toBe(404)

    const revoked = await as(owner, 'POST', '/api/team/invites', { role: 'member' })
    expect((await as(owner, 'DELETE', `/api/team/invites/${revoked.json.invite.id}`)).status).toBe(204)
    expect((await as(null, 'POST', '/api/auth/invites/accept', { code: revoked.json.code, email: 'z@acme.com', password: PASSWORD, name: 'Z' })).status).toBe(410)

    bob = await invite('member', 'bob@acme.com', { teamId: teamA })
    carol = await invite('member', 'carol@acme.com')
    victor = await invite('viewer', 'victor@acme.com', { teamId: teamA })
    admin = await invite('admin', 'admin@acme.com')
    const taken = await as(owner, 'POST', '/api/team/invites', { role: 'member' })
    expect((await as(null, 'POST', '/api/auth/invites/accept', { code: taken.json.code, email: 'bob@acme.com', password: PASSWORD, name: 'B' })).json.error.code).toBe('EMAIL_TAKEN')

    const members = await as(alice, 'GET', '/api/team/members')
    expect(members.json.map((u: { email: string }) => u.email).sort()).toEqual(
      ['admin@acme.com', 'alice@acme.com', 'bob@acme.com', 'carol@acme.com', 'owner@acme.com', 'victor@acme.com'].sort(),
    )
    expect(members.json[0].password_hash).toBeUndefined()
  })

  it('admin 不能邀请/修改/重置 owner；不能改自己；最后一个 owner 不可降级', async () => {
    expect((await as(admin, 'POST', '/api/team/invites', { role: 'owner' })).json.error.code).toBe('CANNOT_MODIFY_OWNER')
    expect((await as(admin, 'PATCH', `/api/team/members/${owner.id}`, { role: 'member' })).json.error.code).toBe('CANNOT_MODIFY_OWNER')
    expect((await as(admin, 'POST', `/api/team/members/${owner.id}/reset-password`, { newPassword: 'another password' })).json.error.code).toBe('CANNOT_MODIFY_OWNER')
    expect((await as(admin, 'PATCH', `/api/team/members/${admin.id}`, { role: 'member' })).json.error.code).toBe('CANNOT_MODIFY_SELF')
    expect((await as(owner, 'PATCH', `/api/team/members/${owner.id}`, { role: 'admin' })).json.error.code).toBe('CANNOT_MODIFY_SELF')
  })
})

describe('RBAC 矩阵', () => {
  const cases: Array<{ name: string; method: string; path: string; body?: unknown; allow: Array<'owner' | 'admin' | 'member' | 'viewer'> }> = [
    { name: '改组织设置', method: 'PATCH', path: '/api/settings', body: { theme: 'light' }, allow: ['owner', 'admin'] },
    { name: '新建 Provider', method: 'POST', path: '/api/providers', body: { name: 'P', kind: 'openai', baseUrl: 'https://api.example.com/v1' }, allow: ['owner', 'admin'] },
    { name: '新建产品', method: 'POST', path: '/api/products', body: { name: 'Valve' }, allow: ['owner', 'admin', 'member'] },
    { name: '新建询盘规则', method: 'POST', path: '/api/inquiry-rules', body: { name: 'r', conditions: [{ field: 'subject', op: 'contains', value: 'x' }], action: 'spam' }, allow: ['owner', 'admin'] },
    { name: '测试询盘规则', method: 'POST', path: '/api/inquiry-rules/test', body: { subject: 'a', body: 'b', from: 'c@d.com' }, allow: ['owner', 'admin', 'member', 'viewer'] },
    { name: '新建客户', method: 'POST', path: '/api/customers', body: { company: 'Matrix Co', force: true }, allow: ['owner', 'admin', 'member'] },
    { name: '新建会话', method: 'POST', path: '/api/sessions', body: {}, allow: ['owner', 'admin', 'member'] },
    { name: '导出数据', method: 'GET', path: '/api/data/export', allow: ['owner', 'admin'] },
    { name: '审计日志', method: 'GET', path: '/api/audit', allow: ['owner', 'admin'] },
    { name: '邀请成员', method: 'POST', path: '/api/team/invites', body: { role: 'viewer' }, allow: ['owner', 'admin'] },
    { name: '建团队', method: 'POST', path: '/api/team/teams', body: { name: 'tmp' }, allow: ['owner', 'admin'] },
    { name: '读客户列表', method: 'GET', path: '/api/customers', allow: ['owner', 'admin', 'member', 'viewer'] },
    { name: '读成员列表', method: 'GET', path: '/api/team/members', allow: ['owner', 'admin', 'member', 'viewer'] },
    { name: '服务器安全开关', method: 'PATCH', path: '/api/team/security', body: { allowMcp: false }, allow: ['owner'] },
  ]
  const who = () => ({ owner, admin, member: carol, viewer: victor })

  for (const testCase of cases) {
    it(testCase.name, async () => {
      for (const [role, user] of Object.entries(who())) {
        const res = await as(user, testCase.method, testCase.path, testCase.body)
        const allowed = testCase.allow.includes(role as 'owner')
        if (allowed) expect(res.status, `${role} ${res.text}`).toBeLessThan(400)
        else {
          expect(res.status, `${role} 应被拒绝：${res.text}`).toBe(403)
          expect(res.json.error.code).toBe('FORBIDDEN')
        }
      }
    })
  }
})

describe('行级可见性', () => {
  let privateId = ''
  let sharedId = ''
  let orgId = ''

  it('member 只看到自己的；private 对他人 404', async () => {
    const created = await as(alice, 'POST', '/api/customers', { company: 'Alice Private GmbH', contacts: [{ email: 'p@private.de' }] })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ ownerId: alice.id, ownerName: 'Alice', visibility: 'private', teamId: teamA })
    privateId = created.json.id
    expect((await as(bob, 'GET', `/api/customers/${privateId}`)).status).toBe(404)
    expect((await as(bob, 'PATCH', `/api/customers/${privateId}`, { notes: 'x' })).status).toBe(404)
    expect((await as(victor, 'GET', `/api/customers/${privateId}`)).status).toBe(404)
    const bobList = await as(bob, 'GET', '/api/customers?pageSize=200')
    expect(bobList.json.items.some((c: { id: string }) => c.id === privateId)).toBe(false)
    expect((await as(admin, 'GET', `/api/customers/${privateId}`)).status).toBe(200)
    expect((await as(owner, 'GET', `/api/customers/${privateId}`)).status).toBe(200)
  })

  it('共享给团队：同组可读不可改，可加跟进；viewer 只读；组外不可见', async () => {
    const created = await as(alice, 'POST', '/api/customers', { company: 'Team Shared Ltd', visibility: 'team', teamId: teamA })
    sharedId = created.json.id
    expect((await as(bob, 'GET', `/api/customers/${sharedId}`)).status).toBe(200)
    const patch = await as(bob, 'PATCH', `/api/customers/${sharedId}`, { notes: 'hijack' })
    expect(patch.status).toBe(403)
    expect((await as(bob, 'DELETE', `/api/customers/${sharedId}`)).status).toBe(403)
    const activity = await as(bob, 'POST', `/api/customers/${sharedId}/activities`, { type: 'note', content: 'Bob 打过电话' })
    expect(activity.status).toBe(201)
    expect(activity.json).toMatchObject({ actorId: bob.id, actorName: 'bob' })
    expect((await as(victor, 'GET', `/api/customers/${sharedId}`)).status).toBe(200)
    expect((await as(victor, 'POST', `/api/customers/${sharedId}/activities`, { type: 'note', content: 'x' })).status).toBe(403)
    expect((await as(carol, 'GET', `/api/customers/${sharedId}`)).status).toBe(404)
    // 不能共享给自己不在的团队
    const other = await as(owner, 'POST', '/api/team/teams', { name: '二组' })
    expect((await as(alice, 'POST', '/api/customers', { company: 'X', visibility: 'team', teamId: other.json.id })).status).toBe(400)
  })

  it('全组织可见；报价随客户可见', async () => {
    const created = await as(alice, 'POST', '/api/customers', { company: 'Org Wide Inc', visibility: 'org' })
    orgId = created.json.id
    expect((await as(carol, 'GET', `/api/customers/${orgId}`)).status).toBe(200)
    const quote = await as(alice, 'POST', '/api/quotes', { customerId: privateId, items: [{ name: 'Valve', qty: 10, unitPrice: 2 }] })
    expect(quote.status, quote.text).toBe(201)
    expect(quote.json.ownerId).toBe(alice.id)
    expect((await as(bob, 'GET', `/api/quotes/${quote.json.id}`)).status).toBe(404)
    expect((await as(bob, 'GET', '/api/quotes')).json.some((q: { id: string }) => q.id === quote.json.id)).toBe(false)
    expect((await as(bob, 'POST', '/api/quotes', { customerId: privateId })).status).toBe(400)
    // 共享客户上同组成员可以建报价，但不能改 Alice 的报价
    const aliceQuote = await as(alice, 'POST', '/api/quotes', { customerId: sharedId, items: [] })
    expect((await as(bob, 'PATCH', `/api/quotes/${aliceQuote.json.id}`, { notes: 'x' })).status).toBe(403)
    expect((await as(bob, 'POST', '/api/quotes', { customerId: sharedId, items: [] })).status).toBe(201)
    const summary = await as(carol, 'GET', '/api/workbench/summary')
    expect(summary.json.customers.total).toBe(2) // 自己在矩阵测试里建的 + 全组织可见的
  })

  it('分配负责人：member 只能转自己的；转移后新负责人可改；批量交接仅管理员', async () => {
    expect((await as(bob, 'POST', `/api/customers/${sharedId}/assign`, { ownerId: bob.id })).status).toBe(403)
    const moved = await as(alice, 'POST', `/api/customers/${privateId}/assign`, { ownerId: bob.id })
    expect(moved.status).toBe(200)
    expect(moved.json).toMatchObject({ ownerId: bob.id, ownerName: 'bob' })
    expect((await as(bob, 'PATCH', `/api/customers/${privateId}`, { notes: 'mine now' })).status).toBe(200)
    expect((await as(alice, 'GET', `/api/customers/${privateId}`)).status).toBe(404)
    // 报价连带转移
    expect((await as(bob, 'GET', `/api/quotes?customerId=${privateId}`)).json[0].ownerId).toBe(bob.id)
    expect((await as(alice, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: carol.id })).status).toBe(403)
    const bulk = await as(admin, 'POST', '/api/customers/transfer', { fromUserId: alice.id, toUserId: carol.id })
    expect(bulk.json.moved).toBe(2)
    expect((await as(carol, 'GET', `/api/customers/${sharedId}`)).status).toBe(200)
  })

  it('会话：只看自己的；他人会话 404；admin 用 scope=all 也看不到（契约 §5.6a）', async () => {
    const mine = await as(carol, 'POST', '/api/sessions', { title: 'carol chat' })
    expect(mine.json.session.ownerId).toBe(carol.id)
    expect((await as(bob, 'GET', `/api/sessions/${mine.json.session.id}`)).status).toBe(404)
    expect((await as(bob, 'GET', '/api/sessions')).json.sessions.some((s: { id: string }) => s.id === mine.json.session.id)).toBe(false)
    expect((await as(admin, 'GET', '/api/sessions')).json.sessions.some((s: { id: string }) => s.id === mine.json.session.id)).toBe(false)
    expect((await as(admin, 'GET', '/api/sessions?scope=all')).json.sessions.some((s: { id: string }) => s.id === mine.json.session.id)).toBe(false)
    expect((await as(admin, 'GET', `/api/sessions/${mine.json.session.id}`)).status).toBe(404)
    expect((await as(bob, 'POST', '/api/chat', { sessionId: mine.json.session.id, content: 'hi' })).status).toBe(404)
  })
})

describe('邮箱的行级可见性与权限', () => {
  const account = { email: 'alice.sales@acme.com', imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port: 1, secure: false }, password: 'x', verify: false }
  let accountId = ''

  it('邮箱账户归属创建者；他人 404；viewer 不能添加', async () => {
    const created = await as(alice, 'POST', '/api/email/accounts', account)
    expect(created.status, created.text).toBe(201)
    accountId = created.json.id
    expect(created.json).toMatchObject({ ownerId: alice.id, visibility: 'private' })
    expect((await as(bob, 'GET', '/api/email/accounts')).json.some((a: { id: string }) => a.id === accountId)).toBe(false)
    expect((await as(bob, 'POST', `/api/email/accounts/${accountId}/sync`, {})).status).toBe(404)
    expect((await as(bob, 'PATCH', `/api/email/accounts/${accountId}`, { name: 'x' })).status).toBe(404)
    expect((await as(admin, 'GET', '/api/email/accounts')).json.some((a: { id: string }) => a.id === accountId)).toBe(true)
    const byViewer = await as(victor, 'POST', '/api/email/accounts', { ...account, email: 'v@acme.com' })
    expect(byViewer.status).toBe(403)
  })

  it('草稿只属于作者；共享邮箱后同组成员可见邮件但看不到别人的草稿；viewer 不能发送', async () => {
    const draft = await as(alice, 'POST', '/api/email/drafts', { accountId, to: ['x@y.com'], subject: 's', text: 't' })
    expect(draft.status, draft.text).toBe(201)
    expect((await as(bob, 'GET', `/api/email/drafts/${draft.json.id}`)).status).toBe(404)
    expect((await as(alice, 'PATCH', `/api/email/accounts/${accountId}`, { visibility: 'team', teamId: teamA })).status).toBe(200)
    expect((await as(bob, 'GET', '/api/email/accounts')).json.some((a: { id: string }) => a.id === accountId)).toBe(true)
    expect((await as(bob, 'GET', '/api/email/drafts')).json.some((d: { id: string }) => d.id === draft.json.id)).toBe(false)
    expect((await as(bob, 'PATCH', `/api/email/accounts/${accountId}`, { name: 'x' })).status).toBe(403)
    expect((await as(victor, 'GET', `/api/email/messages?accountId=${accountId}`)).status).toBe(200)
    const send = await as(victor, 'POST', `/api/email/drafts/${draft.json.id}/send`)
    expect(send.status).toBe(403)
    expect((await as(admin, 'GET', '/api/audit?action=email_account.create')).json.total).toBe(1)
  })
})

describe('会话生命周期', () => {
  it('过期 → 401 SESSION_EXPIRED；登出后 401；refresh 续期', async () => {
    const temp = await login('carol@acme.com')
    const refreshed = await as(temp, 'POST', '/api/auth/refresh')
    expect(refreshed.json.expiresAt).toBeGreaterThan(Date.now())
    const { db } = await import('../src/db.js')
    const { sha256Hex } = await import('../src/security/password.js')
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, sha256Hex(temp.token))
    const expired = await as(temp, 'GET', '/api/auth/me')
    expect(expired.status).toBe(401)
    expect(expired.json.error.code).toBe('SESSION_EXPIRED')

    const other = await login('carol@acme.com')
    expect((await as(other, 'POST', '/api/auth/logout')).status).toBe(204)
    expect((await as(other, 'GET', '/api/auth/me')).json.error.code).toBe('UNAUTHORIZED')
  })

  it('改密：当前密码错 403；成功后其他会话失效、当前会话保留', async () => {
    const a = await login('bob@acme.com')
    const b = await login('bob@acme.com')
    expect((await as(a, 'POST', '/api/auth/password', { currentPassword: 'nope-nope', newPassword: 'brand new pass' })).json.error.code).toBe('PASSWORD_INCORRECT')
    expect((await as(a, 'POST', '/api/auth/password', { currentPassword: PASSWORD, newPassword: 'brand new pass' })).status).toBe(204)
    expect((await as(a, 'GET', '/api/auth/me')).status).toBe(200)
    expect((await as(b, 'GET', '/api/auth/me')).status).toBe(401)
    expect((await as(bob, 'GET', '/api/auth/me')).status).toBe(401)
    bob = await login('bob@acme.com', 'brand new pass')
  })

  it('管理员重置密码 → 对方全部会话失效；停用 → 登录 403、旧会话 403', async () => {
    expect((await as(admin, 'POST', `/api/team/members/${bob.id}/reset-password`, { newPassword: 'reset by admin' })).status).toBe(204)
    expect((await as(bob, 'GET', '/api/auth/me')).status).toBe(401)
    bob = await login('bob@acme.com', 'reset by admin')
    expect((await as(admin, 'DELETE', `/api/team/members/${bob.id}`)).status).toBe(204)
    expect((await as(bob, 'GET', '/api/auth/me')).status).toBe(401)
    const denied = await as(null, 'POST', '/api/auth/login', { email: 'bob@acme.com', password: 'reset by admin' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('USER_DISABLED')
  })
})

describe('审计日志', () => {
  it('记录登录、失败登录、客户增改、转移、导出、成员操作；不含密码', async () => {
    const res = await as(admin, 'GET', '/api/audit?pageSize=200')
    expect(res.status).toBe(200)
    const actions = new Set(res.json.items.map((e: { action: string }) => e.action))
    for (const action of ['auth.setup', 'auth.login', 'auth.login_failed', 'invite.create', 'invite.accept', 'customer.create', 'customer.transfer', 'data.export', 'auth.password_change', 'auth.password_reset', 'member.disable', 'settings.update']) {
      expect(actions, action).toContain(action)
    }
    expect(res.text).not.toContain(PASSWORD)
    expect(res.text).not.toContain('lxs_')
    const prefixed = await as(admin, 'GET', '/api/audit?action=customer.')
    expect(prefixed.json.items.every((e: { action: string }) => e.action.startsWith('customer.'))).toBe(true)
    const byUser = await as(admin, 'GET', `/api/audit?userId=${alice.id}&action=customer.create`)
    expect(byUser.json.total).toBeGreaterThanOrEqual(3)
  })
})

describe('内核 / MCP 默认禁用', () => {
  it('安装内核与添加 MCP → 403 FEATURE_DISABLED；kernel Agent 不可用', async () => {
    const install = await as(owner, 'POST', '/api/kernels/claude-code/install')
    expect(install.status).toBe(403)
    expect(install.json.error.code).toBe('FEATURE_DISABLED')
    const mcp = await as(owner, 'POST', '/api/mcp/servers', { name: 'x', command: 'node', args: ['-v'] })
    expect(mcp.json.error.code).toBe('FEATURE_DISABLED')
    const agents = await as(alice, 'GET', '/api/agents')
    const kernel = agents.json.agents.find((a: { id: string }) => a.id === 'kernel-claude-code')
    expect(kernel).toMatchObject({ available: false, unavailableReason: '服务器已禁用内核' })
    const state = await as(alice, 'GET', '/api/team/security')
    expect(state.json).toMatchObject({ allowKernels: false, allowMcp: false })
    expect(state.json.warning).toContain('执行命令')
  })

  it('只有 owner 能开启，且必须确认；开启后 MCP 仍仅 owner 可改', async () => {
    expect((await as(admin, 'PATCH', '/api/team/security', { allowMcp: true, confirm: 'I_UNDERSTAND' })).status).toBe(403)
    expect((await as(owner, 'PATCH', '/api/team/security', { allowMcp: true })).json.error.code).toBe('CONFIRM_REQUIRED')
    const on = await as(owner, 'PATCH', '/api/team/security', { allowMcp: true, confirm: 'I_UNDERSTAND' })
    expect(on.json.allowMcp).toBe(true)
    const byAdmin = await as(admin, 'POST', '/api/mcp/servers', { name: 'x', command: 'node', args: ['-v'], enabled: false })
    expect(byAdmin.status).toBe(403)
    expect(byAdmin.json.error.code).toBe('FORBIDDEN')
    const byOwner = await as(owner, 'POST', '/api/mcp/servers', { name: 'x', command: 'node', args: ['-v'], enabled: false })
    expect(byOwner.status, byOwner.text).toBe(201)
    await as(owner, 'PATCH', '/api/team/security', { allowMcp: false })
    const audit = await as(owner, 'GET', '/api/audit?action=security.update')
    expect(audit.json.total).toBe(3) // 含 RBAC 矩阵里 owner 的一次
  })

  it('本机锁在 server 模式不可用', async () => {
    expect((await as(owner, 'GET', '/api/lock')).json).toEqual({ enabled: false })
    expect((await as(owner, 'POST', '/api/lock/setup', { pin: '1234' })).json.error.code).toBe('NOT_AVAILABLE_IN_MODE')
  })

  it('转让所有权', async () => {
    expect((await as(admin, 'POST', '/api/team/transfer-ownership', { userId: admin.id })).status).toBe(403)
    const res = await as(owner, 'POST', '/api/team/transfer-ownership', { userId: admin.id })
    expect(res.status).toBe(200)
    expect(res.json.to.role).toBe('owner')
    expect(res.json.from.role).toBe('admin')
  })
})

describe('CLI', () => {
  it('create-owner 在已有用户时拒绝；reset-password 生效', async () => {
    const { spawnSync } = await import('node:child_process')
    const { join: joinPath } = await import('node:path')
    const cli = joinPath(__dirname, '..', 'src', 'cli.ts')
    const env = { ...process.env, LULUX_ETA_HOME: server.home, LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN }
    // 用 node 直接跑 tsx 的 CLI：Windows 上 node_modules/.bin/tsx 是 shell 脚本，spawnSync 无 shell 时起不来
    const tsxCli = joinPath(__dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const created = spawnSync(process.execPath, [tsxCli, cli, 'create-owner', '--email', 'x@acme.com', '--password', PASSWORD, '--name', 'X', '--org', 'Y'], { env, encoding: 'utf8' })
    expect(created.status).toBe(1)
    expect(created.stderr).toContain('SETUP_ALREADY_DONE')
    const reset = spawnSync(process.execPath, [tsxCli, cli, 'reset-password', '--email', 'carol@acme.com', '--password', 'cli reset pass'], { env, encoding: 'utf8' })
    expect(reset.status, reset.stderr).toBe(0)
    await login('carol@acme.com', 'cli reset pass')
  })
})
