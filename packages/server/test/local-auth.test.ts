import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 本机账户（desktop 模式，契约 §3.1）：用户名 + 密码，会话头 X-Lulux-Session，固定 API token 仍然必需 */

let server: TestServer
let resetBackoff: () => void

beforeAll(async () => {
  server = await startTestServer()
  const mod = await import('../src/services/local-auth-service.js')
  resetBackoff = () => mod.localAuthService.resetForTests()
})

afterAll(async () => {
  await server.close()
})

const session = (token: string) => ({ headers: { 'X-Lulux-Session': token } })

describe('本机账户', () => {
  let token = ''
  let legacySessionId = ''

  it('升级后没有账户：一切照旧，status 显示未创建', async () => {
    const status = await server.request('GET', '/api/auth/local/status')
    expect(status.status).toBe(200)
    expect(status.json).toEqual({ hasAccount: false, signedIn: false, username: null })
    expect((await server.request('GET', '/api/sessions')).status).toBe(200)
    expect((await server.request('GET', '/api/customers')).status).toBe(200)
    const me = await server.request('GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.json.local).toEqual({ hasAccount: false })
  })

  it('早期测试版留下的数据（还没有账户时建的会话 / 客户）：创建账户后仍在，属于新账户', async () => {
    const created = await server.request('POST', '/api/sessions', { body: { title: '升级前的会话' } })
    expect(created.status).toBeLessThan(300)
    legacySessionId = created.json.session?.id ?? created.json.id
    expect(legacySessionId).toBeTruthy()
    const customer = await server.request('POST', '/api/customers', { body: { company: 'Legacy Data GmbH', country: 'Germany' } })
    expect(customer.status).toBeLessThan(300)
  })

  it('本机账户接口同样要求 API token 与本机 Host', async () => {
    expect((await server.request('GET', '/api/auth/local/status', { token: null })).status).toBe(401)
    expect(
      (await server.request('POST', '/api/auth/local/login', { token: null, body: { username: 'ab', password: 'x' } })).status,
    ).toBe(401)
    expect((await server.request('GET', '/api/auth/local/status', { host: `evil.example:${server.port}` })).status).toBe(403)
  })

  it('用户名 / 密码校验', async () => {
    const short = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'a', password: 'longenough1' } })
    expect(short.status).toBe(400)
    expect(short.json.error.code).toBe('USERNAME_INVALID')
    const long = await server.request('POST', '/api/auth/local/accounts', {
      body: { username: 'a'.repeat(33), password: 'longenough1' },
    })
    expect(long.json.error.code).toBe('USERNAME_INVALID')
    const space = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'a b', password: 'longenough1' } })
    expect(space.json.error.code).toBe('USERNAME_INVALID')
    const weak = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'koko', password: 'short' } })
    expect(weak.status).toBe(400)
    expect(weak.json.error.code).toBe('WEAK_PASSWORD')
    const same = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'kokokoko', password: 'KOKOKOKO' } })
    expect(same.json.error.code).toBe('WEAK_PASSWORD')
    // 校验失败不会建出账户
    expect((await server.request('GET', '/api/auth/local/status')).json.hasAccount).toBe(false)
  })

  it('首次创建：返回会话，密码只存 scrypt 哈希', async () => {
    const res = await server.request('POST', '/api/auth/local/accounts', {
      body: { username: 'Koko', password: 'correct horse', remember: true },
    })
    expect(res.status).toBe(201)
    expect(res.json.token).toMatch(/^lls_[0-9a-f]{64}$/)
    expect(res.json.persistent).toBe(true)
    expect(res.json.account).toMatchObject({ username: 'Koko' })
    token = res.json.token

    const { db } = await import('../src/db.js')
    const row = db.prepare('SELECT password_hash FROM local_accounts').get() as { password_hash: string }
    expect(row.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(row.password_hash).not.toContain('correct horse')
    const sess = db.prepare('SELECT token_hash FROM local_sessions').get() as { token_hash: string }
    expect(sess.token_hash).not.toBe(token)
  })

  it('有账户后：受保护接口没有会话 → 401 LOCAL_LOGIN_REQUIRED；带会话 → 200', async () => {
    const before = await server.request('GET', '/api/sessions')
    expect(before.status).toBe(401)
    expect(before.json.error.code).toBe('LOCAL_LOGIN_REQUIRED')
    expect((await server.request('GET', '/api/auth/me')).status).toBe(401)
    expect((await server.request('GET', '/api/sessions', session('lls_' + '0'.repeat(64)))).status).toBe(401)
    // 公开：mode / health / 锁状态 / status
    expect((await server.request('GET', '/api/auth/mode')).status).toBe(200)
    expect((await server.request('GET', '/api/health')).status).toBe(200)
    expect((await server.request('GET', '/api/lock')).status).toBe(200)
    // 桌面主进程关窗前查询运行数：不需要本机会话，只给数量；仍要 API token
    expect((await server.request('GET', '/api/chat/runs/count')).json).toEqual({ count: 0 })
    expect((await server.request('GET', '/api/chat/runs/count', { token: null })).status).toBe(401)
    expect((await server.request('GET', '/api/chat/runs')).status).toBe(401)
    expect((await server.request('GET', '/api/auth/local/status')).json).toEqual({ hasAccount: true, signedIn: false, username: null })

    const listed = await server.request('GET', '/api/sessions', session(token))
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.json)).toContain(legacySessionId)
    const customers = await server.request('GET', '/api/customers', session(token))
    expect(JSON.stringify(customers.json)).toContain('Legacy Data GmbH')
    const me = await server.request('GET', '/api/auth/me', session(token))
    expect(me.json.user).toMatchObject({ id: 'local', name: 'Koko', role: 'owner' })
    expect(me.json.local).toMatchObject({ hasAccount: true, username: 'Koko', expiresAt: expect.any(Number) })
    expect((await server.request('GET', '/api/auth/local/status', session(token))).json).toEqual({
      hasAccount: true,
      signedIn: true,
      username: 'Koko',
    })
    // 会话不能替代 API token
    expect((await server.request('GET', '/api/sessions', { token: null, ...session(token) })).status).toBe(401)
  })

  it('已有账户：未登录不能再建；同名（不区分大小写）409；已登录可以再建', async () => {
    const anon = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'other', password: 'password123' } })
    expect(anon.status).toBe(403)
    expect(anon.json.error.code).toBe('LOCAL_ACCOUNT_EXISTS')
    const dup = await server.request('POST', '/api/auth/local/accounts', {
      ...session(token),
      body: { username: 'KOKO', password: 'password123' },
    })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe('USERNAME_TAKEN')
    const second = await server.request('POST', '/api/auth/local/accounts', {
      ...session(token),
      body: { username: '小王', password: 'password123', remember: false },
    })
    expect(second.status).toBe(201)
    expect(second.json.persistent).toBe(false)
  })

  it('登录：成功（用户名不区分大小写）/ 失败统一提示', async () => {
    resetBackoff()
    const ok = await server.request('POST', '/api/auth/local/login', { body: { username: 'koko', password: 'correct horse' } })
    expect(ok.status).toBe(200)
    expect(ok.json.account.username).toBe('Koko')
    expect((await server.request('GET', '/api/customers', session(ok.json.token))).status).toBe(200)

    const bad = await server.request('POST', '/api/auth/local/login', { body: { username: 'koko', password: 'wrong pass' } })
    expect(bad.status).toBe(401)
    expect(bad.json.error.code).toBe('INVALID_CREDENTIALS')
    const ghost = await server.request('POST', '/api/auth/local/login', { body: { username: 'nobody', password: 'wrong pass' } })
    expect(ghost.status).toBe(401)
    expect(ghost.json.error).toEqual(bad.json.error)
  })

  it('连续失败后退避：正确密码也要等，429 + Retry-After', async () => {
    resetBackoff()
    for (let i = 0; i < 3; i++) {
      const r = await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: `bad-${i}-pass` } })
      expect(r.status).toBe(401)
    }
    const limited = await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })
    expect(limited.status).toBe(429)
    expect(limited.json.error.code).toBe('LOGIN_RATE_LIMITED')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // 别的用户名不受这个用户名的退避影响（全局阈值更高）
    const other = await server.request('POST', '/api/auth/local/login', { body: { username: '小王', password: 'password123' } })
    expect(other.status).toBe(200)
    resetBackoff()
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })).status).toBe(
      200,
    )
  })

  it('改密码：校验当前密码，其他会话失效，当前会话保留', async () => {
    resetBackoff()
    const other = (await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } }))
      .json.token as string
    const wrong = await server.request('POST', '/api/auth/local/password', {
      ...session(token),
      body: { currentPassword: 'nope nope', newPassword: 'new password 1' },
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error.code).toBe('PASSWORD_INCORRECT')
    const ok = await server.request('POST', '/api/auth/local/password', {
      ...session(token),
      body: { currentPassword: 'correct horse', newPassword: 'new password 1' },
    })
    expect(ok.status).toBe(204)
    expect((await server.request('GET', '/api/sessions', session(token))).status).toBe(200)
    expect((await server.request('GET', '/api/sessions', session(other))).status).toBe(401)
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })).status).toBe(401)
    resetBackoff()
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'new password 1' } })).status).toBe(
      200,
    )
  })

  it('登出：会话作废', async () => {
    expect((await server.request('POST', '/api/auth/local/logout', session(token))).status).toBe(204)
    const after = await server.request('GET', '/api/sessions', session(token))
    expect(after.status).toBe(401)
    expect(after.json.error.code).toBe('LOCAL_LOGIN_REQUIRED')
  })

  it('过期会话 → 401 SESSION_EXPIRED', async () => {
    resetBackoff()
    const t = (await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'new password 1' } })).json
      .token as string
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE local_sessions SET expires_at = ? WHERE revoked_at IS NULL').run(Date.now() - 1000)
    const res = await server.request('GET', '/api/sessions', session(t))
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('SESSION_EXPIRED')
  })

  it('有账户时本机锁 PIN 仍可用（登录后）', async () => {
    resetBackoff()
    const t = (await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'new password 1' } })).json
      .token as string
    expect((await server.request('POST', '/api/lock/setup', { body: { pin: '1234' } })).status).toBe(401)
    expect((await server.request('POST', '/api/lock/setup', { ...session(t), body: { pin: '1234' } })).json).toEqual({ enabled: true })
    expect((await server.request('GET', '/api/lock')).json).toEqual({ enabled: true })
    expect((await server.request('POST', '/api/lock/verify', { ...session(t), body: { pin: '1234' } })).json).toEqual({ ok: true })
  })
})
