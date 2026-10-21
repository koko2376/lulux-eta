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
}

export class SecretUnavailableError extends Error {
  constructor(message = '密钥无法用当前主密钥解密，请在设置中重新填写') {
    super(message)
    this.name = 'SecretUnavailableError'
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
  delete process.env.LULUX_MASTER_KEY

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
