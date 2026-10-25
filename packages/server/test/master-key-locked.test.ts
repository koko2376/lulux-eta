import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  loadKeyring,
  MasterKeyLockedError,
  SecretUnavailableError,
} from '../src/security/secrets.js'

afterEach(() => {
  delete process.env.LULUX_MASTER_KEY
  delete process.env.LULUX_MASTER_KEY_LOCKED
})

describe('桌面端主密钥暂时解不开（LULUX_MASTER_KEY_LOCKED=1）', () => {
  it('不生成新的明文 master.key；拒绝加密新数据', () => {
    const home = mkdtempSync(join(tmpdir(), 'lulux-locked-'))
    process.env.LULUX_MASTER_KEY_LOCKED = '1'
    const ring = loadKeyring(home)
    expect(ring.locked).toBe(true)
    expect(existsSync(join(home, 'master.key'))).toBe(false)
    expect(() => encryptSecret('sk-new-key-123456', ring)).toThrow(MasterKeyLockedError)
    expect(() => encryptSecret('sk-new-key-123456', ring)).toThrow(SecretUnavailableError)
    expect(process.env.LULUX_MASTER_KEY_LOCKED).toBeUndefined()
  })

  it('已有的文件密钥仍可解密旧数据；用主密钥加密的数据读不出（提示而不是乱码）', () => {
    const home = mkdtempSync(join(tmpdir(), 'lulux-locked-'))
    const fileKey = randomBytes(32).toString('hex')
    writeFileSync(join(home, 'master.key'), fileKey)
    const oldRing = loadKeyring(home)
    const oldCipher = encryptSecret('legacy-secret', oldRing)
    process.env.LULUX_MASTER_KEY = randomBytes(32).toString('hex')
    const envRing = loadKeyring(home)
    const envCipher = encryptSecret('primary-secret', envRing)

    process.env.LULUX_MASTER_KEY_LOCKED = '1'
    const locked = loadKeyring(home)
    expect(decryptSecret(oldCipher, locked)).toBe('legacy-secret')
    expect(() => decryptSecret(envCipher, locked)).toThrow(SecretUnavailableError)
  })
})
