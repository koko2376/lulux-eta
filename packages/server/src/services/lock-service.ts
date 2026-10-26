import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from '../db.js'
import { AppError } from '../errors.js'
import { parse } from '../validation.js'

/**
 * 本机锁：可选的 PIN 解锁界面（替换旧的假登录）。
 * 只存 scrypt 哈希；真正的接口保护仍是 API token。
 */
const META_KEY = 'lockHash'
const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
const MAX_FAILURES = 5
const LOCKOUT_MS = 30_000

export const pinInput = z.object({
  pin: z.string().regex(/^\d{4,12}$/, 'PIN 必须是 4–12 位数字'),
})

let failures = 0
let lockedUntil = 0

function readHash(): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) as unknown as { value: string } | undefined
  return row?.value ?? null
}

function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyHash(pin: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function checkPin(pin: string): boolean {
  const now = Date.now()
  if (now < lockedUntil) {
    throw new AppError(429, 'LOCK_RATE_LIMITED', `尝试次数过多，请 ${Math.ceil((lockedUntil - now) / 1000)} 秒后再试`)
  }
  const stored = readHash()
  if (!stored) return false
  const ok = verifyHash(pin, stored)
  if (ok) {
    failures = 0
  } else {
    failures += 1
    if (failures >= MAX_FAILURES) {
      failures = 0
      lockedUntil = now + LOCKOUT_MS
    }
  }
  return ok
}

export const lockService = {
  status(): { enabled: boolean } {
    return { enabled: readHash() !== null }
  },

  setup(input: unknown): { enabled: boolean } {
    const { pin } = parse(pinInput, input)
    if (readHash()) throw new AppError(409, 'LOCK_ALREADY_ENABLED', '本机锁已启用，请先停用后再重新设置')
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(META_KEY, hashPin(pin))
    return { enabled: true }
  },

  verify(input: unknown): { ok: boolean } {
    const { pin } = parse(pinInput, input)
    if (!readHash()) return { ok: true }
    return { ok: checkPin(pin) }
  },

  disable(input: unknown): { enabled: boolean } {
    const { pin } = parse(pinInput, input)
    if (!readHash()) return { enabled: false }
    if (!checkPin(pin)) throw new AppError(403, 'LOCK_PIN_INVALID', 'PIN 不正确')
    db.prepare('DELETE FROM app_meta WHERE key = ?').run(META_KEY)
    return { enabled: false }
  },

  resetForTests(): void {
    failures = 0
    lockedUntil = 0
  },
}
