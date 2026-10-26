import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/** 系统安全存储：可切换“解密抛错 / 不可用” */
const h = vi.hoisted(() => ({ available: true, decryptThrows: false }))
const storage = {
  isEncryptionAvailable: () => h.available,
  getSelectedStorageBackend: () => 'os_keyring',
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    if (h.decryptThrows) throw new Error('access denied')
    return b.toString().slice(4)
  },
}
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() }, safeStorage: storage }))

describe('主密钥解不开时不静默生成新的明文主密钥', () => {
  it('master.key.safe 存在但解不开：返回 locked，原文件不动，也不生成 master.key', async () => {
    const { loadMasterKey } = await import('../src/server')
    const home = mkdtempSync(join(tmpdir(), 'lulux-mk-'))
    h.available = true
    h.decryptThrows = false
    const first = loadMasterKey(home, storage)
    expect(first.key).toMatch(/^[0-9a-f]{64}$/)
    const before = readFileSync(join(home, 'master.key.safe'))

    h.decryptThrows = true
    expect(loadMasterKey(home, storage)).toEqual({ key: null, locked: true })
    h.decryptThrows = false
    h.available = false
    expect(loadMasterKey(home, storage)).toEqual({ key: null, locked: true })
    expect(readFileSync(join(home, 'master.key.safe'))).toEqual(before)
    expect(existsSync(join(home, 'master.key'))).toBe(false)

    h.available = true
    expect(loadMasterKey(home, storage)).toEqual({ key: first.key, locked: false })
  })

  it('从没用过安全存储、系统也没有：不算 locked（服务端照旧使用文件密钥）', async () => {
    const { loadMasterKey } = await import('../src/server')
    const home = mkdtempSync(join(tmpdir(), 'lulux-mk-'))
    h.available = false
    expect(loadMasterKey(home, storage)).toEqual({ key: null, locked: false })
    writeFileSync(join(home, 'unrelated'), '')
  })
})
