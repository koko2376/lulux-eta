import { readFileSync, statSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 远程“记住这台服务器”：没有安全存储时退回本机文件；安全存储暂时解不开时不删除 */
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  return {
    dir: '' as string,
    mkdir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'lulux-conn-')) as string,
    path,
    backend: 'basic_text',
    available: true,
    decryptThrows: false,
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => h.backend,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      if (h.decryptThrows) throw new Error('access denied')
      return b.toString().slice(4)
    },
  },
}))

const URL_A = 'https://team.example.com'
const TOKEN = `lxs_${'a'.repeat(64)}`

beforeEach(() => {
  h.dir = h.mkdir()
  h.decryptThrows = false
  h.available = true
  vi.resetModules()
})

describe('团队服务器会话落盘', () => {
  it('没有安全存储：以本机文件保存（0600）并如实返回 storage=file；重启后仍在', async () => {
    // Linux 上 basic_text 后端、其他平台上加密不可用，都算“没有安全存储”
    h.backend = 'basic_text'
    h.available = process.platform === 'linux'
    const { connectionStore } = await import('../src/connection')
    connectionStore.useRemote(URL_A)
    expect(connectionStore.storageKind()).toBe('file')
    expect(connectionStore.setSession(URL_A, { token: TOKEN, user: null })).toEqual({ persisted: true, storage: 'file' })
    const path = h.path.join(h.dir, 'connection.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions[URL_A].protection).toBe('file')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    vi.resetModules()
    const fresh = (await import('../src/connection')).connectionStore
    expect(fresh.session(URL_A)?.token).toBe(TOKEN)
  })

  it('有安全存储：加密保存；之后解不开时这次没有会话，但磁盘上的保留，恢复后读回', async () => {
    h.backend = 'os_keyring'
    const { connectionStore } = await import('../src/connection')
    expect(connectionStore.setSession(URL_A, { token: TOKEN, user: null })).toEqual({ persisted: true, storage: 'secure' })
    const path = h.path.join(h.dir, 'connection.json')
    expect(readFileSync(path, 'utf8')).not.toContain(TOKEN)
    vi.resetModules()
    h.decryptThrows = true
    const locked = (await import('../src/connection')).connectionStore
    expect(locked.session(URL_A)).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions[URL_A]).toBeTruthy()
    h.decryptThrows = false
    expect(locked.session(URL_A)?.token).toBe(TOKEN)
  })
})
