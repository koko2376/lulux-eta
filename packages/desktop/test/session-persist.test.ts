import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStore, type Cipher } from '../src/auth-store'

/** 可控的假加密器：正常 / 不可用（没有密钥环）/ 解密抛错（钥匙串拒绝访问、换了系统账户） */
function controllableCipher() {
  const state = { mode: 'ok' as 'ok' | 'unavailable' | 'decrypt-throws' }
  const cipher: Cipher = {
    available: () => state.mode !== 'unavailable',
    encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
    decrypt: (encoded) => {
      if (state.mode === 'decrypt-throws') throw new Error('access denied')
      return Buffer.from(encoded, 'base64').toString().slice(4)
    },
  }
  return { state, cipher }
}

const TOKEN = `lls_${'a'.repeat(64)}`
const TOKEN_B = `lls_${'b'.repeat(64)}`
const file = (): string => join(mkdtempSync(join(tmpdir(), 'lulux-persist-')), 'auth-state.json')

/**
 * 页面启动流程（client/src/lib/session.ts initAuth）：拿不到会话时只清内存，
 * 不带 forget（启动时根本没拿到会话，不能删磁盘上记住的会话）。
 */
function pageBoot(store: AuthStore): 'signed-in' | 'login-page' {
  if (store.getLocalSession()) return 'signed-in'
  store.setLocalSession(null)
  return 'login-page'
}

describe('记住这台机器：安全存储暂时失败不删除已落盘的会话', () => {
  for (const failure of ['decrypt-throws', 'unavailable'] as const) {
    it(`启动时 ${failure}：状态为 locked，磁盘会话保留；安全存储恢复后自动登录`, () => {
      const path = file()
      const { state, cipher } = controllableCipher()
      new AuthStore(path, cipher).setLocalSession({ token: TOKEN, username: 'koko' }, { persist: true })

      state.mode = failure
      const locked = new AuthStore(path, cipher)
      expect(locked.getLocalSessionState()).toEqual({ state: 'locked' })
      expect(pageBoot(locked)).toBe('login-page')
      expect(JSON.parse(readFileSync(path, 'utf8')).localSessions.default).toBeTruthy()

      state.mode = 'ok'
      expect(pageBoot(new AuthStore(path, cipher))).toBe('signed-in')
    })
  }

  it('只有 forget=true（主动退出 / 服务端判定失效）才删除磁盘会话，登录偏好保留', () => {
    const path = file()
    const { cipher } = controllableCipher()
    const store = new AuthStore(path, cipher)
    store.setLoginPrefs({ tab: 'local', local: { username: 'koko', remember: true } })
    store.setLocalSession({ token: TOKEN, username: 'koko' }, { persist: true })
    store.setLocalSession(null)
    expect(new AuthStore(path, cipher).getLocalSession()?.token).toBe(TOKEN)
    store.setLocalSession(null, { forget: true })
    const restarted = new AuthStore(path, cipher)
    expect(restarted.getLocalSessionState()).toEqual({ state: 'none' })
    expect(restarted.getLoginPrefs()).toEqual({ tab: 'local', local: { username: 'koko', remember: true } })
  })

  it('两份数据目录共用一个 auth-state.json：各自的会话互不覆盖、互不删除', () => {
    const path = file()
    const { cipher } = controllableCipher()
    new AuthStore(path, cipher, { scope: '/data/installed' }).setLocalSession({ token: TOKEN, username: 'a' }, { persist: true })
    const other = new AuthStore(path, cipher, { scope: '/data/portable' })
    expect(other.getLocalSession()).toBeNull()
    other.setLocalSession({ token: TOKEN_B, username: 'b' }, { persist: true })
    other.setLocalSession(null, { forget: true })
    expect(new AuthStore(path, cipher, { scope: '/data/installed' }).getLocalSession()?.token).toBe(TOKEN)
  })

  it('旧版不分数据目录的会话仍能读出，并在下次保存时迁移', () => {
    const path = file()
    const { cipher } = controllableCipher()
    writeFileSync(path, JSON.stringify({ localSession: { token: cipher.encrypt(TOKEN), username: 'k', savedAt: 1 } }))
    const store = new AuthStore(path, cipher, { scope: '/data/x' })
    expect(store.getLocalSession()?.token).toBe(TOKEN)
    store.setLocalSession({ token: TOKEN, username: 'k' }, { persist: true })
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    expect(disk.localSession).toBeUndefined()
    expect(disk.localSessions['/data/x']).toBeTruthy()
  })
})

describe('auth-state.json 原子写：损坏时另存 .corrupt 并从备份恢复，不清空其他字段', () => {
  it('写到一半被截断：会话与登录偏好从 .bak 恢复，之后写端口不会覆盖掉它们', () => {
    const path = file()
    const { cipher } = controllableCipher()
    const store = new AuthStore(path, cipher)
    store.setLocalSession({ token: TOKEN, username: 'koko' }, { persist: true })
    store.setLoginPrefs({ tab: 'local', local: { username: 'koko', remember: true } })
    store.setLocalPort(31789)
    const full = readFileSync(path, 'utf8')
    writeFileSync(path, full.slice(0, Math.floor(full.length / 2)))

    const restarted = new AuthStore(path, cipher)
    restarted.setLocalPort(31790)
    expect(existsSync(`${path}.corrupt`)).toBe(true)
    const after = new AuthStore(path, cipher)
    expect(after.getLocalSession()?.token).toBe(TOKEN)
    expect(after.getLoginPrefs()).toEqual({ tab: 'local', local: { username: 'koko', remember: true } })
    expect(after.getLocalPort()).toBe(31790)
  })

  it('写入不留临时文件；文件仅本用户可读', () => {
    const path = file()
    const { cipher } = controllableCipher()
    const store = new AuthStore(path, cipher)
    store.setLocalPort(31789)
    store.setLocalPort(31790)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('没有系统安全存储：记住这台机器退回本机文件（0600），不再假装成功', () => {
  it('persisted=true、storage=file；重启后读回；文件仅本用户可读', () => {
    const path = file()
    const { state, cipher } = controllableCipher()
    state.mode = 'unavailable'
    const store = new AuthStore(path, cipher)
    expect(store.storageKind()).toBe('file')
    expect(store.setLocalSession({ token: TOKEN, username: 'koko' }, { persist: true })).toEqual({ persisted: true, storage: 'file' })
    expect(new AuthStore(path, cipher).getLocalSessionState()).toMatchObject({ state: 'ok', storage: 'file' })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('有安全存储时仍然加密落盘（磁盘上没有明文 token）', () => {
    const path = file()
    const { cipher } = controllableCipher()
    expect(new AuthStore(path, cipher).setLocalSession({ token: TOKEN, username: 'k' }, { persist: true })).toEqual({
      persisted: true,
      storage: 'secure',
    })
    expect(readFileSync(path, 'utf8')).not.toContain(TOKEN)
  })
})
