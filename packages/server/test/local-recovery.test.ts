import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 本机账户找回密码：一次性恢复码、数据目录重置文件、早期账户补发恢复码、命令行重设 */

let server: TestServer
let service: typeof import('../src/services/local-auth-service.js')
let dbMod: typeof import('../src/db.js')

beforeAll(async () => {
  server = await startTestServer()
  service = await import('../src/services/local-auth-service.js')
  dbMod = await import('../src/db.js')
})

afterAll(async () => {
  await server.close()
})

const session = (token: string) => ({ headers: { 'X-Lulux-Session': token } })
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/

function accountRow(username: string): { recovery_hash: string | null; recovery_prompt: number; recovery_created_at: number | null } {
  return dbMod.db
    .prepare('SELECT recovery_hash, recovery_prompt, recovery_created_at FROM local_accounts WHERE username_norm = ?')
    .get(username.toLowerCase()) as any
}

describe('恢复码生成与归一化', () => {
  it('4 组 × 5 位 Crockford Base32，每次不同', () => {
    const codes = new Set(Array.from({ length: 200 }, () => service.generateRecoveryCode()))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(CODE_RE)
  })

  it('输入归一化：忽略大小写 / 空格 / 连字符，I L → 1，O → 0', () => {
    expect(service.normalizeRecoveryCode(' abcde-fghjk mnpqr-stvwx ')).toBe('ABCDEFGHJKMNPQRSTVWX')
    expect(service.normalizeRecoveryCode('ILO0-1')).toBe('11001')
  })
})

describe('本机账户找回', () => {
  let code = ''
  let token = ''

  it('创建账户：返回一次性恢复码，库里只存 scrypt 哈希', async () => {
    const res = await server.request('POST', '/api/auth/local/accounts', {
      body: { username: 'Koko', password: 'correct horse', remember: true },
    })
    expect(res.status).toBe(201)
    expect(res.json.recoveryCode).toMatch(CODE_RE)
    code = res.json.recoveryCode
    token = res.json.token
    const row = accountRow('koko')
    expect(row.recovery_hash).toMatch(/^scrypt\$/)
    expect(row.recovery_hash).not.toContain(code)
    expect(row.recovery_hash).not.toContain(code.replace(/-/g, ''))
    expect(row.recovery_prompt).toBe(0)
    expect(row.recovery_created_at).toEqual(expect.any(Number))
    // 正常登录不再返回恢复码
    const login = await server.request('POST', '/api/auth/local/login', { body: { username: 'koko', password: 'correct horse' } })
    expect(login.status).toBe(200)
    expect(login.json.recoveryCode).toBeUndefined()
    const me = await server.request('GET', '/api/auth/me', session(token))
    expect(me.json.local).toMatchObject({ hasRecoveryCode: true })
  })

  it('找回接口不需要本机会话，但仍要 API token；只在本机模式', async () => {
    const info = await server.request('GET', '/api/auth/local/recovery')
    expect(info.status).toBe(200)
    expect(info.json).toEqual({ dataDir: server.home, resetFileName: 'RESET-LOCAL-PASSWORD', resetFilePresent: false })
    expect((await server.request('GET', '/api/auth/local/recovery', { token: null })).status).toBe(401)
    expect(
      (await server.request('POST', '/api/auth/local/recover', { token: null, body: { username: 'koko', recoveryCode: code, newPassword: 'x' } }))
        .status,
    ).toBe(401)
  })

  it('错误恢复码：统一提示，连续 3 次后退避（正确的码也要等），不影响登录计数', async () => {
    service.localAuthService.resetForTests()
    const ghost = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'nobody', recoveryCode: code, newPassword: 'brand new pass' },
    })
    expect(ghost.status).toBe(401)
    expect(ghost.json.error.code).toBe('RECOVERY_CODE_INVALID')
    service.localAuthService.resetForTests()
    for (let i = 0; i < 3; i++) {
      const r = await server.request('POST', '/api/auth/local/recover', {
        body: { username: 'Koko', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAA' + i, newPassword: 'brand new pass' },
      })
      expect(r.status).toBe(401)
      expect(r.json.error).toEqual(ghost.json.error)
    }
    const limited = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'Koko', recoveryCode: code, newPassword: 'brand new pass' },
    })
    expect(limited.status).toBe(429)
    expect(limited.json.error.code).toBe('LOGIN_RATE_LIMITED')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // 密码登录不受恢复码失败的用户级计数影响
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })).status).toBe(200)
    // 密码没有被改
    expect((await server.request('GET', '/api/sessions', session(token))).status).toBe(200)
  })

  it('弱密码：不改密码，恢复码不作废', async () => {
    service.localAuthService.resetForTests()
    const weak = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'koko', recoveryCode: code, newPassword: 'short' },
    })
    expect(weak.status).toBe(400)
    expect(weak.json.error.code).toBe('WEAK_PASSWORD')
    expect((await server.request('GET', '/api/sessions', session(token))).status).toBe(200)
  })

  it('用恢复码重设：旧会话全部失效，旧密码 / 旧恢复码作废，发新恢复码并直接登录', async () => {
    service.localAuthService.resetForTests()
    const other = (await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })).json
      .token as string
    const res = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'KOKO', recoveryCode: code.toLowerCase().replace(/-/g, ' '), newPassword: 'brand new pass', remember: false },
    })
    expect(res.status).toBe(200)
    expect(res.json.token).toMatch(/^lls_/)
    expect(res.json.persistent).toBe(false)
    expect(res.json.account.username).toBe('Koko')
    expect(res.json.recoveryCode).toMatch(CODE_RE)
    expect(res.json.recoveryCode).not.toBe(code)
    for (const old of [token, other]) {
      const r = await server.request('GET', '/api/sessions', session(old))
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('LOCAL_LOGIN_REQUIRED')
    }
    expect((await server.request('GET', '/api/sessions', session(res.json.token))).status).toBe(200)
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'correct horse' } })).status).toBe(401)
    service.localAuthService.resetForTests()
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'brand new pass' } })).status).toBe(200)
    const reused = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'Koko', recoveryCode: code, newPassword: 'another pass 1' },
    })
    expect(reused.status).toBe(401)
    code = res.json.recoveryCode
    token = res.json.token
  })

  it('设置里重新生成恢复码：需要当前密码，旧码立即作废', async () => {
    service.localAuthService.resetForTests()
    expect((await server.request('POST', '/api/auth/local/recovery-code', { body: { currentPassword: 'brand new pass' } })).status).toBe(401)
    const wrong = await server.request('POST', '/api/auth/local/recovery-code', { ...session(token), body: { currentPassword: 'nope nope' } })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error.code).toBe('PASSWORD_INCORRECT')
    const ok = await server.request('POST', '/api/auth/local/recovery-code', { ...session(token), body: { currentPassword: 'brand new pass' } })
    expect(ok.status).toBe(200)
    expect(ok.json.recoveryCode).toMatch(CODE_RE)
    expect(ok.json.recoveryCode).not.toBe(code)
    service.localAuthService.resetForTests()
    expect(
      (await server.request('POST', '/api/auth/local/recover', { body: { username: 'Koko', recoveryCode: code, newPassword: 'another pass 1' } }))
        .status,
    ).toBe(401)
    code = ok.json.recoveryCode
  })

  it('重置文件：没有文件时拒绝；有文件时不凭旧密码重设，用后删除文件，旧会话失效', async () => {
    service.localAuthService.resetForTests()
    const missing = await server.request('POST', '/api/auth/local/reset-with-file', {
      body: { username: 'Koko', newPassword: 'file reset pass' },
    })
    expect(missing.status).toBe(403)
    expect(missing.json.error.code).toBe('RESET_FILE_MISSING')

    // 同名目录不算
    const resetPath = join(server.home, 'RESET-LOCAL-PASSWORD')
    mkdirSync(resetPath)
    expect((await server.request('GET', '/api/auth/local/recovery')).json.resetFilePresent).toBe(false)
    const { rmSync } = await import('node:fs')
    rmSync(resetPath, { recursive: true })

    writeFileSync(resetPath, '')
    expect((await server.request('GET', '/api/auth/local/recovery')).json.resetFilePresent).toBe(true)
    const ghost = await server.request('POST', '/api/auth/local/reset-with-file', { body: { username: 'nobody', newPassword: 'file reset pass' } })
    expect(ghost.status).toBe(404)
    expect(ghost.json.error.code).toBe('LOCAL_ACCOUNT_NOT_FOUND')
    const weak = await server.request('POST', '/api/auth/local/reset-with-file', { body: { username: 'Koko', newPassword: 'short' } })
    expect(weak.json.error.code).toBe('WEAK_PASSWORD')
    // 校验失败不消耗文件
    expect(existsSync(resetPath)).toBe(true)

    const res = await server.request('POST', '/api/auth/local/reset-with-file', {
      body: { username: 'koko', newPassword: 'file reset pass', remember: true },
    })
    expect(res.status).toBe(200)
    expect(res.json.recoveryCode).toMatch(CODE_RE)
    expect(res.json.persistent).toBe(true)
    expect(existsSync(resetPath)).toBe(false)
    expect((await server.request('GET', '/api/auth/local/recovery')).json.resetFilePresent).toBe(false)
    expect((await server.request('GET', '/api/sessions', session(token))).status).toBe(401)
    expect((await server.request('GET', '/api/sessions', session(res.json.token))).status).toBe(200)
    // 文件已用掉：不能再来一次
    const again = await server.request('POST', '/api/auth/local/reset-with-file', { body: { username: 'Koko', newPassword: 'second reset 1' } })
    expect(again.status).toBe(403)
    service.localAuthService.resetForTests()
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'file reset pass' } })).status).toBe(200)
    token = res.json.token
  })

  it('早期版本的账户（没有恢复码）：下次登录成功后发一次恢复码，之后不再提示', async () => {
    service.localAuthService.resetForTests()
    dbMod.db.prepare('UPDATE local_accounts SET recovery_hash = NULL, recovery_created_at = NULL, recovery_prompt = 1').run()
    const me = await server.request('GET', '/api/auth/me', session(token))
    expect(me.json.local).toMatchObject({ hasRecoveryCode: false })
    const bad = await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'wrong pass 1' } })
    expect(bad.status).toBe(401)
    expect(accountRow('koko').recovery_prompt).toBe(1)
    const first = await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'file reset pass' } })
    expect(first.status).toBe(200)
    expect(first.json.recoveryCode).toMatch(CODE_RE)
    expect(accountRow('koko')).toMatchObject({ recovery_prompt: 0, recovery_hash: expect.stringMatching(/^scrypt\$/) })
    const second = await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'file reset pass' } })
    expect(second.json.recoveryCode).toBeUndefined()
    // 补发的码可以用
    const recovered = await server.request('POST', '/api/auth/local/recover', {
      body: { username: 'Koko', recoveryCode: first.json.recoveryCode, newPassword: 'legacy recovered 1' },
    })
    expect(recovered.status).toBe(200)
    token = recovered.json.token
  })

  it('命令行重设本机账户：注销全部会话，返回新恢复码', async () => {
    const result = await service.localAuthService.resetPasswordFromCli('koko', 'cli reset pass 1')
    expect(result.username).toBe('Koko')
    expect(result.recoveryCode).toMatch(CODE_RE)
    expect((await server.request('GET', '/api/sessions', session(token))).status).toBe(401)
    service.localAuthService.resetForTests()
    expect((await server.request('POST', '/api/auth/local/login', { body: { username: 'Koko', password: 'cli reset pass 1' } })).status).toBe(200)
    await expect(service.localAuthService.resetPasswordFromCli('nobody', 'cli reset pass 1')).rejects.toMatchObject({
      code: 'LOCAL_ACCOUNT_NOT_FOUND',
    })
    await expect(service.localAuthService.resetPasswordFromCli('koko', 'short')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' })
  })
})

describe('迁移 25：早期本机账户标记为需要补发恢复码', () => {
  it('升级前已有的账户 recovery_prompt = 1，新列存在', async () => {
    const migrations = await import('../src/db/migrations.js')
    const dir = mkdtempSync(join(tmpdir(), 'lulux-mig25-'))
    const db = dbMod.openDatabase(join(dir, 'lulux-eta.db'))
    migrations.runMigrations(db, {}, migrations.MIGRATIONS.filter((m) => m.version < 25))
    db.prepare(
      "INSERT INTO local_accounts (id, username, username_norm, password_hash, created_at, updated_at) VALUES ('lacc_old', 'Old', 'old', 'scrypt$x', 1, 1)",
    ).run()
    const result = migrations.runMigrations(db)
    // 之后的迁移（26 起）也会一并执行，只要求 25 在内
    expect(result.applied[0]).toBe(25)
    expect(db.prepare("SELECT recovery_hash, recovery_prompt FROM local_accounts WHERE id = 'lacc_old'").get()).toEqual({
      recovery_hash: null,
      recovery_prompt: 1,
    })
    db.close()
  })
})
