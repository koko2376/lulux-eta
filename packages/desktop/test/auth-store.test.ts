import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStore, sanitizeLoginPrefs, type Cipher } from '../src/auth-store'

/** 假加密器：可逆但不是明文，便于断言磁盘上没有明文 token */
const cipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (encoded) => {
    const text = Buffer.from(encoded, 'base64').toString()
    if (!text.startsWith('enc:')) throw new Error('bad')
    return text.slice(4)
  },
})

const TOKEN = `lls_${'a'.repeat(64)}`
const TOKEN2 = `lls_${'b'.repeat(64)}`

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'lulux-auth-')), 'auth-state.json')
}

describe('AuthStore：记住这台机器（主进程保管，不依赖页面 origin）', () => {
  it('勾选：加密落盘；“重启”（新实例）后仍能读回', () => {
    const file = tempFile()
    const store = new AuthStore(file, cipher())
    expect(store.setLocalSession({ token: TOKEN, username: 'Koko' }, { persist: true })).toEqual({ persisted: true })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(TOKEN)
    const restarted = new AuthStore(file, cipher())
    expect(restarted.getLocalSession()).toEqual({ token: TOKEN, username: 'Koko' })
  })

  it('不勾：只在内存（本次运行），不落盘；重启后没有；并删掉之前记住的会话', () => {
    const file = tempFile()
    const store = new AuthStore(file, cipher())
    store.setLocalSession({ token: TOKEN, username: 'Koko' }, { persist: true })
    expect(store.setLocalSession({ token: TOKEN2, username: 'Koko' }, { persist: false })).toEqual({ persisted: false })
    expect(store.getLocalSession()?.token).toBe(TOKEN2)
    expect(readFileSync(file, 'utf8')).not.toContain('localSession')
    expect(new AuthStore(file, cipher()).getLocalSession()).toBeNull()
  })

  it('清除（登出 / 过期）：内存与磁盘都清掉，登录偏好保留', () => {
    const file = tempFile()
    const store = new AuthStore(file, cipher())
    store.setLoginPrefs({ tab: 'local', local: { username: 'Koko', remember: true } })
    store.setLocalSession({ token: TOKEN, username: 'Koko' }, { persist: true })
    store.setLocalSession(null)
    expect(store.getLocalSession()).toBeNull()
    const restarted = new AuthStore(file, cipher())
    expect(restarted.getLocalSession()).toBeNull()
    expect(restarted.getLoginPrefs()).toEqual({ tab: 'local', local: { username: 'Koko', remember: true } })
  })

  it('没有安全存储：绝不明文落盘，返回 persisted=false', () => {
    const file = tempFile()
    const store = new AuthStore(file, cipher(false))
    expect(store.setLocalSession({ token: TOKEN, username: 'Koko' }, { persist: true })).toEqual({ persisted: false })
    expect(store.getLocalSession()?.token).toBe(TOKEN)
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain(TOKEN)
  })

  it('解密失败（换了系统账户）或文件损坏：当作没有记住', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ localSession: { token: 'not-encrypted', username: 'K', savedAt: 1 } }))
    expect(new AuthStore(file, cipher()).getLocalSession()).toBeNull()
    writeFileSync(file, '{oops')
    expect(new AuthStore(file, cipher()).getLocalSession()).toBeNull()
    expect(new AuthStore(file, cipher()).getLoginPrefs()).toEqual({})
  })

  it('拒绝格式不对的 token', () => {
    const store = new AuthStore(tempFile(), cipher())
    expect(() => store.setLocalSession({ token: 'lxs_x', username: 'K' }, { persist: true })).toThrow()
    expect(() => store.setLocalSession('nope', { persist: true })).toThrow()
  })

  it('上次端口：记下并在重启后读回，非法值忽略', () => {
    const file = tempFile()
    const store = new AuthStore(file, cipher())
    expect(store.getLocalPort()).toBeNull()
    store.setLocalPort(51789)
    expect(new AuthStore(file, cipher()).getLocalPort()).toBe(51789)
    store.setLocalPort(80)
    store.setLocalPort(1.5)
    expect(new AuthStore(file, cipher()).getLocalPort()).toBe(51789)
  })
})

describe('登录偏好校验', () => {
  it('只保留已知字段：不收密码 / token，服务器地址必须是 origin', () => {
    expect(
      sanitizeLoginPrefs({
        tab: 'server',
        password: 'secret',
        local: { username: 'Koko', remember: true, token: TOKEN },
        servers: {
          'https://eta.example.com': { email: 'a@b.co', remember: true, password: 'x' },
          'https://eta.example.com/path': { email: 'bad' },
          'javascript:alert(1)': { email: 'bad' },
        },
        lastServer: 'https://eta.example.com',
      }),
    ).toEqual({
      tab: 'server',
      local: { username: 'Koko', remember: true },
      servers: { 'https://eta.example.com': { email: 'a@b.co', remember: true } },
      lastServer: 'https://eta.example.com',
    })
    expect(sanitizeLoginPrefs(null)).toEqual({})
    expect(sanitizeLoginPrefs([1])).toEqual({})
  })
})
