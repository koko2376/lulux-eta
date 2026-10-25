import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 字段级加密：AES-256-GCM。
 * 主密钥来源：
 *  - 桌面端：主进程用 Electron safeStorage 保护的随机主密钥，经 LULUX_MASTER_KEY（64 位 hex）下发；
 *  - 浏览器开发态：`<dataDir>/master.key`（0600），首次启动生成。
 *  - 桌面端主密钥暂时解不开（LULUX_MASTER_KEY_LOCKED=1，系统安全存储拒绝 / 尚未解锁）：
 *    绝不生成新的明文 master.key 顶替；已有的 master.key 只用于解密旧数据，新的密钥一律拒绝保存（locked）。
 * 两把密钥都存在时都可用于解密；新数据用主密钥（primary）加密。
 * 密文格式：`enc:v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>`，keyId 是密钥 SHA-256 的前 8 位 hex。
 */

const PREFIX = 'enc:v1:'

interface KeyEntry {
  id: string
  key: Buffer
}

export interface Keyring {
  primary: KeyEntry
  keys: Map<string, Buffer>
  source: 'env' | 'file'
  /** 主密钥暂时不可用：只能解密已有的、用其余密钥加密的数据，不能加密新数据 */
  locked?: boolean
}

/** 主密钥暂时不可用时保存密钥的提示 */
export const MASTER_KEY_LOCKED_MESSAGE =
  '系统安全存储暂时无法解锁，现在不能保存新的密钥。请解锁系统钥匙串或密钥环后重新打开 LULUX ETA，已保存的数据不受影响'

export class SecretUnavailableError extends Error {
  constructor(message = '密钥无法用当前主密钥解密，请在设置中重新填写') {
    super(message)
    this.name = 'SecretUnavailableError'
  }
}

/** 主密钥暂时不可用（只读运行）时拒绝加密新数据 */
export class MasterKeyLockedError extends SecretUnavailableError {
  constructor() {
    super(MASTER_KEY_LOCKED_MESSAGE)
    this.name = 'MasterKeyLockedError'
  }
}

function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

function parseHexKey(raw: string, label: string): Buffer {
  const value = raw.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 64 位十六进制（32 字节）`)
  }
  return Buffer.from(value, 'hex')
}

function readOrCreateFileKey(home: string, create: boolean): Buffer | null {
  const file = join(home, 'master.key')
  if (existsSync(file)) {
    return parseHexKey(readFileSync(file, 'utf8'), file)
  }
  if (!create) return null
  mkdirSync(home, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 忽略
  }
  return key
}

export function loadKeyring(home: string): Keyring {
  const envRaw = process.env.LULUX_MASTER_KEY
  const lockedFlag = process.env.LULUX_MASTER_KEY_LOCKED === '1'
  delete process.env.LULUX_MASTER_KEY
  delete process.env.LULUX_MASTER_KEY_LOCKED

  const keys = new Map<string, Buffer>()
  if (envRaw && envRaw.trim()) {
    const key = parseHexKey(envRaw, 'LULUX_MASTER_KEY')
    const primary = { id: keyIdOf(key), key }
    keys.set(primary.id, key)
    // 旧的文件密钥仍可用于解密开发态写入的数据
    const fileKey = readOrCreateFileKey(home, false)
    if (fileKey) keys.set(keyIdOf(fileKey), fileKey)
    return { primary, keys, source: 'env' }
  }

  if (lockedFlag) {
    // 只读：已有的文件密钥照常用于解密；占位的 primary 不登记到 keys，也永远不会用来加密
    const fileKey = readOrCreateFileKey(home, false)
    if (fileKey) keys.set(keyIdOf(fileKey), fileKey)
    const placeholder = randomBytes(32)
    return { primary: { id: keyIdOf(placeholder), key: placeholder }, keys, source: 'env', locked: true }
  }

  const key = readOrCreateFileKey(home, true)!
  const primary = { id: keyIdOf(key), key }
  keys.set(primary.id, key)
  return { primary, keys, source: 'file' }
}

let active: Keyring | null = null

export function initKeyring(home: string): Keyring {
  active = loadKeyring(home)
  return active
}

export function setKeyringForTests(keyring: Keyring): void {
  active = keyring
}

function keyring(): Keyring {
  if (!active) throw new Error('主密钥尚未初始化')
  return active
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function encryptSecret(plain: string, ring: Keyring = keyring()): string {
  if (!plain) return ''
  if (ring.locked) throw new MasterKeyLockedError()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ring.primary.key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${ring.primary.id}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/** 明文（旧数据）原样返回；密文解密失败抛 SecretUnavailableError */
export function decryptSecret(stored: string, ring: Keyring = keyring()): string {
  if (!stored) return ''
  if (!isEncrypted(stored)) return stored
  const [keyId, ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':')
  const key = keyId ? ring.keys.get(keyId) : undefined
  if (!key || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new SecretUnavailableError()
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new SecretUnavailableError()
  }
}

/** 界面展示用：`sk-…abcd` */
export function previewSecret(plain: string): string {
  if (!plain) return ''
  if (plain.length <= 8) return '••••'
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`
}
