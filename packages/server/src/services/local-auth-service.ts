import { randomBytes } from 'node:crypto'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { config } from '../config.js'
import { currentActor, LOCAL_ACTOR, type Actor } from '../context.js'
import { db } from '../db.js'
import { AppError } from '../errors.js'
import { dummyPasswordHash, hashPassword, randomToken, sha256Hex, validatePasswordStrength, verifyPassword } from '../security/password.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'
import { auditService } from './audit-service.js'
import { eventBus } from './events.js'

/**
 * 本机账户（desktop 模式，契约 §3.1）。
 *
 * - 用户名 + 密码，存在本机库 local_accounts；用户名不区分大小写唯一，2–32 个字符（字母 / 数字 / 中文 / . _ -）。
 * - 密码 scrypt（每用户随机盐，timingSafeEqual 比较），与团队服务器同一套哈希格式。
 * - 登录得到会话 token（只存 sha256），请求头 `X-Lulux-Session` 携带；
 *   固定 API token（Authorization）仍然必需 —— 本机账户是在它之上的一层，不替代 Host / Origin / token 校验。
 * - 还没有任何本机账户时一切照旧（不锁人）；有了账户之后，除少数公开接口外都要求会话。
 * - 所有本机账户都是同一个本机用户（actor id 'local'、owner），共享这台电脑上的数据。
 * - 找回：创建账户时发一次性恢复码（只存哈希，只显示一次），忘记密码时用恢复码设新密码；
 *   恢复码也丢了时，在数据目录放一个 RESET-LOCAL-PASSWORD 空文件即可不凭旧密码重设（用后删除）。
 *   数据本身不用密码加密，能写数据目录的人本来就能读到数据，所以这个兜底不降低安全性。
 */

export const LOCAL_SESSION_HEADER = 'x-lulux-session'

const IDLE_PERSISTENT_MS = 30 * 24 * 60 * 60_000
const ABSOLUTE_PERSISTENT_MS = 90 * 24 * 60 * 60_000
const IDLE_SESSION_MS = 12 * 60 * 60_000
const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60_000
/** last_used_at 至多每分钟写一次，避免每个请求都写库 */
const TOUCH_INTERVAL_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * 「记住本机」会话的滑动续期：每次使用都把空闲期限（30 天）和绝对期限（90 天）从当前时间往后推，
 * 天天用的人不会在某个固定日子被登出。最长寿命由 LULUX_REMEMBER_MAX_DAYS 设定（从登录时算起），
 * 不设或为 0 表示不设上限 —— 只要 30 天内用过一次就一直有效。
 */
function rememberMaxMs(): number {
  const days = Number(process.env.LULUX_REMEMBER_MAX_DAYS ?? '0')
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : 0
}

function persistentAbsolute(createdAt: number, now: number): number {
  const cap = rememberMaxMs()
  return cap > 0 ? createdAt + cap : now + ABSOLUTE_PERSISTENT_MS
}

/**
 * 可信的当前时间：系统时钟与本机库里记下的「见过的最晚时间」取较大者。
 * 系统时钟被回拨（主板电池没电回到旧日期、手动改过日期）期间时间不倒退，这期间登录 / 续期写下的时间也就不会偏早，
 * 时钟校正回来后，会话不会被当成「已经很久没用」而立即失效。
 */
const CLOCK_KEY = 'local_auth.clock_high_water'
let clockHighWater: number | null = null

function trustedNow(): number {
  if (clockHighWater === null) {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CLOCK_KEY) as unknown as { value: string } | undefined
    const stored = Number(row?.value ?? 0)
    clockHighWater = Number.isFinite(stored) ? stored : 0
  }
  return Math.max(Date.now(), clockHighWater)
}

function recordClock(now: number): void {
  if (clockHighWater !== null && now <= clockHighWater) return
  clockHighWater = now
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CLOCK_KEY, String(now))
}

const USERNAME_RE = /^[\p{L}\p{N}._-]+$/u

export function normalizeUsername(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase()
}

function validateUsername(raw: string): string {
  const name = raw.trim().normalize('NFKC')
  const length = [...name].length
  if (length < 2 || length > 32) throw new AppError(400, 'USERNAME_INVALID', '用户名需要 2–32 个字符')
  if (!USERNAME_RE.test(name)) throw new AppError(400, 'USERNAME_INVALID', '用户名只能包含字母、数字、中文和 . _ -')
  return name
}

const createInput = z
  .object({
    username: z.string().max(64),
    password: z.string().max(256),
    remember: z.boolean().optional(),
  })
  .strict()
const loginInput = createInput
const recoverInput = z
  .object({
    username: z.string().max(64),
    recoveryCode: z.string().max(64),
    newPassword: z.string().max(256),
    remember: z.boolean().optional(),
  })
  .strict()
const fileResetInput = z
  .object({
    username: z.string().max(64),
    newPassword: z.string().max(256),
    remember: z.boolean().optional(),
  })
  .strict()
const regenerateInput = z.object({ currentPassword: z.string().max(256) }).strict()
const passwordInput = z
  .object({
    currentPassword: z.string().max(256),
    newPassword: z.string().max(256),
  })
  .strict()

interface AccountRow {
  id: string
  username: string
  username_norm: string
  password_hash: string
  created_at: number
  updated_at: number
  last_login_at: number | null
  recovery_hash: string | null
  recovery_created_at: number | null
  recovery_prompt: number
}

interface SessionRow {
  id: string
  account_id: string
  token_hash: string
  persistent: number
  created_at: number
  last_used_at: number
  expires_at: number
  absolute_expires_at: number
  revoked_at: number | null
}

export interface LocalAccount {
  id: string
  username: string
  createdAt: number
  lastLoginAt: number | null
}

export interface LocalLoginResult {
  token: string
  expiresAt: number
  persistent: boolean
  account: LocalAccount
  /** 新发的恢复码（明文只在这一次响应里出现）：创建账户、用恢复码 / 重置文件找回、早期账户首次登录 */
  recoveryCode?: string
}

export type LocalResolveResult =
  | { ok: true; actor: Actor; account: LocalAccount; expiresAt: number }
  | { ok: false; code: 'UNAUTHORIZED' | 'SESSION_EXPIRED' }

function toAccount(row: AccountRow): LocalAccount {
  return { id: row.id, username: row.username, createdAt: row.created_at, lastLoginAt: row.last_login_at }
}

function accountById(id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM local_accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined
}

function accountByName(username: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM local_accounts WHERE username_norm = ?').get(normalizeUsername(username)) as unknown as
    | AccountRow
    | undefined
}

function actorOf(account: AccountRow, sessionId: string): Actor {
  return { ...LOCAL_ACTOR, name: account.username, sessionId }
}

/* ── 失败退避（内存）：每个用户名连续失败 3 次后指数退避；全局 10 次后同样退避 ── */
interface Backoff {
  failures: number
  until: number
  last: number
}
const backoffs = new Map<string, Backoff>()
const DECAY_MS = 15 * 60_000
const BASE_DELAY_MS = 2_000
const MAX_DELAY_MS = 5 * 60_000
const USER_THRESHOLD = 3
const GLOBAL_THRESHOLD = 10

function backoffKeys(username: string): Array<[string, number]> {
  return [
    [`u:${normalizeUsername(username)}`, USER_THRESHOLD],
    ['*', GLOBAL_THRESHOLD],
  ]
}

function assertNoBackoff(keys: Array<[string, number]>): void {
  const now = Date.now()
  for (const [key] of keys) {
    const entry = backoffs.get(key)
    if (!entry) continue
    if (now - entry.last > DECAY_MS) {
      backoffs.delete(key)
      continue
    }
    if (entry.until > now) {
      const retryAfter = Math.max(1, Math.ceil((entry.until - now) / 1000))
      throw Object.assign(new AppError(429, 'LOGIN_RATE_LIMITED', `尝试次数过多，请 ${retryAfter} 秒后再试`), { retryAfter })
    }
  }
}

function recordFailure(keys: Array<[string, number]>): void {
  const now = Date.now()
  for (const [key, threshold] of keys) {
    const entry = backoffs.get(key) ?? { failures: 0, until: 0, last: now }
    entry.failures += 1
    entry.last = now
    if (entry.failures >= threshold) {
      entry.until = now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (entry.failures - threshold))
    }
    backoffs.set(key, entry)
  }
}

function clearFailures(username: string): void {
  backoffs.delete(`u:${normalizeUsername(username)}`)
  backoffs.delete(`r:${normalizeUsername(username)}`)
}

/* ── 恢复码：20 位 Crockford Base32（约 100 位随机），分 4 组显示；只存 scrypt 哈希 ── */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_GROUPS = 4
const RECOVERY_GROUP_LENGTH = 5
export const RESET_FILE_NAME = 'RESET-LOCAL-PASSWORD'

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH)
  // 256 是 32 的整数倍，取低 5 位没有偏差
  const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte & 31]!)
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += RECOVERY_GROUP_LENGTH) groups.push(chars.slice(i, i + RECOVERY_GROUP_LENGTH).join(''))
  return groups.join('-')
}

/** 用户输入的恢复码：忽略大小写、空格和连字符；易混字符按 Crockford 规则归一（I/L → 1，O → 0） */
export function normalizeRecoveryCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}

function resetFilePath(): string {
  return join(config.home, RESET_FILE_NAME)
}

function resetFilePresent(): boolean {
  try {
    const file = resetFilePath()
    return existsSync(file) && statSync(file).isFile()
  } catch {
    return false
  }
}

async function issueRecoveryCode(accountId: string): Promise<string> {
  const code = generateRecoveryCode()
  const hash = await hashPassword(normalizeRecoveryCode(code))
  db.prepare('UPDATE local_accounts SET recovery_hash = ?, recovery_created_at = ?, recovery_prompt = 0 WHERE id = ?').run(
    hash,
    Date.now(),
    accountId,
  )
  return code
}

/** 注销这个账户的全部会话（可保留一个），并断开对应的实时连接 */
function revokeSessions(accountId: string, keepSessionId: string | null = null): void {
  const rows = db
    .prepare('SELECT id FROM local_sessions WHERE account_id = ? AND revoked_at IS NULL')
    .all(accountId) as unknown as Array<{ id: string }>
  const now = Date.now()
  const update = db.prepare('UPDATE local_sessions SET revoked_at = ? WHERE id = ?')
  for (const row of rows) {
    if (row.id === keepSessionId) continue
    update.run(now, row.id)
    eventBus.revokeSession(row.id)
  }
}

async function setPassword(account: AccountRow, newPassword: string): Promise<void> {
  assertStrongPassword(newPassword, account.username)
  db.prepare('UPDATE local_accounts SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    await hashPassword(newPassword),
    Date.now(),
    account.id,
  )
}

function assertStrongPassword(password: string, username: string): void {
  const weak = validatePasswordStrength(password, username)
  if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak.replace('邮箱', '用户名'))
}

/** 恢复码失败单独计数（不和登录失败叠加，忘记密码的人通常已经输错过几次），全局阈值共用 */
function recoveryBackoffKeys(username: string): Array<[string, number]> {
  return [
    [`r:${normalizeUsername(username)}`, USER_THRESHOLD],
    ['*', GLOBAL_THRESHOLD],
  ]
}

function createSession(account: AccountRow, persistent: boolean): LocalLoginResult {
  const now = trustedNow()
  recordClock(now)
  const token = randomToken('lls_')
  const absolute = persistent ? persistentAbsolute(now, now) : now + ABSOLUTE_SESSION_MS
  const expiresAt = Math.min(absolute, now + (persistent ? IDLE_PERSISTENT_MS : IDLE_SESSION_MS))
  db.prepare(
    `INSERT INTO local_sessions (id, account_id, token_hash, persistent, created_at, last_used_at, expires_at, absolute_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('lses'), account.id, sha256Hex(token), persistent ? 1 : 0, now, now, expiresAt, absolute)
  db.prepare('UPDATE local_accounts SET last_login_at = ? WHERE id = ?').run(now, account.id)
  return { token, expiresAt, persistent, account: toAccount({ ...account, last_login_at: now }) }
}

/** 当前请求是否带着有效的本机会话（中间件已解析进 actor） */
function signedInAccount(): AccountRow | undefined {
  const actor = currentActor()
  if (!actor.sessionId) return undefined
  const session = db
    .prepare('SELECT * FROM local_sessions WHERE id = ? AND revoked_at IS NULL')
    .get(actor.sessionId) as unknown as SessionRow | undefined
  return session ? accountById(session.account_id) : undefined
}

export const localAuthService = {
  hasAccounts(): boolean {
    return db.prepare('SELECT 1 AS x FROM local_accounts LIMIT 1').get() !== undefined
  },

  status(): { hasAccount: boolean; signedIn: boolean; username: string | null } {
    const account = signedInAccount()
    return { hasAccount: this.hasAccounts(), signedIn: Boolean(account), username: account?.username ?? null }
  },

  /** 创建本机账户：没有任何账户时任何人可建（首次使用），否则只有已登录的本机用户可以再建 */
  async create(input: unknown): Promise<LocalLoginResult> {
    const data = parse(createInput, input)
    if (this.hasAccounts() && !signedInAccount()) {
      throw new AppError(403, 'LOCAL_ACCOUNT_EXISTS', '这台电脑已经有本机账户，请先登录')
    }
    const username = validateUsername(data.username)
    const weak = validatePasswordStrength(data.password, username)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak.replace('邮箱', '用户名'))
    if (accountByName(username)) throw new AppError(409, 'USERNAME_TAKEN', '这个用户名已经存在')
    const hash = await hashPassword(data.password)
    const now = Date.now()
    const id = newId('lacc')
    try {
      db.prepare(
        'INSERT INTO local_accounts (id, username, username_norm, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, username, normalizeUsername(username), hash, now, now)
    } catch (error) {
      // 并发创建同名：UNIQUE 约束
      if (String((error as Error).message).includes('UNIQUE')) throw new AppError(409, 'USERNAME_TAKEN', '这个用户名已经存在')
      throw error
    }
    const recoveryCode = await issueRecoveryCode(id)
    const row = accountById(id)!
    auditService.record({ action: 'auth.local_account_created', entityType: 'local_account', entityId: id, summary: `创建本机账户 ${username}` })
    return { ...createSession(row, data.remember !== false), recoveryCode }
  },

  async login(input: unknown): Promise<LocalLoginResult> {
    const data = parse(loginInput, input)
    const keys = backoffKeys(data.username)
    assertNoBackoff(keys)
    const row = data.username.trim() ? accountByName(data.username) : undefined
    const ok = await verifyPassword(data.password, row?.password_hash ?? (await dummyPasswordHash()))
    if (!row || !ok) {
      recordFailure(keys)
      auditService.record({
        action: 'auth.local_login_failed',
        entityType: 'local_account',
        entityId: row?.id ?? null,
        summary: `本机登录失败：${data.username.trim().slice(0, 64)}`,
      })
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误')
    }
    clearFailures(data.username)
    const result: LocalLoginResult = createSession(row, data.remember !== false)
    auditService.record({ action: 'auth.local_login', entityType: 'local_account', entityId: row.id, summary: `${row.username} 登录本机` })
    // 早期版本建的账户没有恢复码：这次登录发一个，界面提示保存（只提示这一次）
    if (row.recovery_prompt || !row.recovery_hash) {
      result.recoveryCode = await issueRecoveryCode(row.id)
      auditService.record({ action: 'auth.local_recovery_code_issued', entityType: 'local_account', entityId: row.id, summary: `${row.username} 获得恢复码` })
    }
    return result
  },

  /** 登录页“忘记密码？”需要的信息：数据目录（放重置文件用）和重置文件是否已就位 */
  recoveryInfo(): { dataDir: string; resetFileName: string; resetFilePresent: boolean } {
    return { dataDir: config.home, resetFileName: RESET_FILE_NAME, resetFilePresent: resetFilePresent() }
  },

  /** 用恢复码设新密码：注销这个账户的全部旧会话，发一个新恢复码（旧的作废），并直接登录 */
  async recover(input: unknown): Promise<LocalLoginResult> {
    const data = parse(recoverInput, input)
    const keys = recoveryBackoffKeys(data.username)
    assertNoBackoff(keys)
    const row = data.username.trim() ? accountByName(data.username) : undefined
    const code = normalizeRecoveryCode(data.recoveryCode)
    const ok = code.length > 0 && (await verifyPassword(code, row?.recovery_hash ?? (await dummyPasswordHash())))
    if (!row || !row.recovery_hash || !ok) {
      recordFailure(keys)
      auditService.record({
        action: 'auth.local_recovery_failed',
        entityType: 'local_account',
        entityId: row?.id ?? null,
        summary: `本机恢复码不正确：${data.username.trim().slice(0, 64)}`,
      })
      throw new AppError(401, 'RECOVERY_CODE_INVALID', '用户名或恢复码不正确')
    }
    await setPassword(row, data.newPassword)
    revokeSessions(row.id)
    const recoveryCode = await issueRecoveryCode(row.id)
    clearFailures(row.username)
    auditService.record({ action: 'auth.local_password_recovered', entityType: 'local_account', entityId: row.id, summary: `${row.username} 用恢复码重设了本机密码` })
    return { ...createSession(accountById(row.id)!, data.remember !== false), recoveryCode }
  },

  /** 恢复码也丢了：数据目录里有 RESET-LOCAL-PASSWORD 文件时，不凭旧密码设新密码；文件用后即删 */
  async resetWithFile(input: unknown): Promise<LocalLoginResult> {
    const data = parse(fileResetInput, input)
    if (!resetFilePresent()) {
      throw new AppError(403, 'RESET_FILE_MISSING', `数据目录里没有 ${RESET_FILE_NAME} 文件`)
    }
    const row = data.username.trim() ? accountByName(data.username) : undefined
    if (!row) throw new AppError(404, 'LOCAL_ACCOUNT_NOT_FOUND', '没有这个本机账户')
    assertStrongPassword(data.newPassword, row.username)
    // 先删文件再改密码：删不掉就不改，避免文件一直留着、谁都能重设
    try {
      unlinkSync(resetFilePath())
    } catch {
      throw new AppError(500, 'RESET_FILE_LOCKED', `无法删除 ${RESET_FILE_NAME} 文件，请手动删除后重试`)
    }
    await setPassword(row, data.newPassword)
    revokeSessions(row.id)
    const recoveryCode = await issueRecoveryCode(row.id)
    clearFailures(row.username)
    auditService.record({ action: 'auth.local_password_reset_file', entityType: 'local_account', entityId: row.id, summary: `${row.username} 用重置文件重设了本机密码` })
    return { ...createSession(accountById(row.id)!, data.remember !== false), recoveryCode }
  },

  /** 设置 → 账户：凭当前密码重新生成恢复码（旧的立即作废） */
  async regenerateRecoveryCode(input: unknown): Promise<{ recoveryCode: string }> {
    const data = parse(regenerateInput, input)
    const account = signedInAccount()
    if (!account) throw new AppError(401, 'LOCAL_LOGIN_REQUIRED', '请先登录本机账户')
    const keys = backoffKeys(account.username)
    assertNoBackoff(keys)
    if (!(await verifyPassword(data.currentPassword, account.password_hash))) {
      recordFailure(keys)
      throw new AppError(400, 'PASSWORD_INCORRECT', '当前密码不正确')
    }
    clearFailures(account.username)
    const recoveryCode = await issueRecoveryCode(account.id)
    auditService.record({ action: 'auth.local_recovery_code_issued', entityType: 'local_account', entityId: account.id, summary: `${account.username} 重新生成了恢复码` })
    return { recoveryCode }
  },

  /** 命令行重设（lulux-cli reset-password --username）：注销全部会话，返回新恢复码 */
  async resetPasswordFromCli(username: string, newPassword: string): Promise<{ username: string; recoveryCode: string }> {
    const row = accountByName(username)
    if (!row) throw new AppError(404, 'LOCAL_ACCOUNT_NOT_FOUND', '没有这个本机账户')
    await setPassword(row, newPassword)
    revokeSessions(row.id)
    const recoveryCode = await issueRecoveryCode(row.id)
    auditService.record({ action: 'auth.local_password_reset_cli', entityType: 'local_account', entityId: row.id, summary: `${row.username} 的本机密码由命令行重设` })
    return { username: row.username, recoveryCode }
  },

  resolve(token: string): LocalResolveResult {
    const session = db.prepare('SELECT * FROM local_sessions WHERE token_hash = ?').get(sha256Hex(token)) as unknown as
      | SessionRow
      | undefined
    if (!session || session.revoked_at) return { ok: false, code: 'UNAUTHORIZED' }
    const now = trustedNow()
    if (session.expires_at <= now || session.absolute_expires_at <= now) return { ok: false, code: 'SESSION_EXPIRED' }
    const account = accountById(session.account_id)
    if (!account) return { ok: false, code: 'UNAUTHORIZED' }
    let expiresAt = session.expires_at
    if (now - session.last_used_at > TOUCH_INTERVAL_MS) {
      // 记住本机：绝对期限也随使用顺延（受 LULUX_REMEMBER_MAX_DAYS 上限约束）；普通会话的绝对期限不变
      const absolute = session.persistent
        ? Math.max(session.absolute_expires_at, persistentAbsolute(session.created_at, now))
        : session.absolute_expires_at
      expiresAt = Math.min(absolute, now + (session.persistent ? IDLE_PERSISTENT_MS : IDLE_SESSION_MS))
      db.prepare('UPDATE local_sessions SET last_used_at = ?, expires_at = ?, absolute_expires_at = ? WHERE id = ?').run(now, expiresAt, absolute, session.id)
      recordClock(now)
    }
    return { ok: true, actor: actorOf(account, session.id), account: toAccount(account), expiresAt }
  },

  /** 当前会话信息（/api/auth/me 用） */
  current(): { username: string; expiresAt: number; hasRecoveryCode: boolean } | null {
    const actor = currentActor()
    if (!actor.sessionId) return null
    const session = db.prepare('SELECT * FROM local_sessions WHERE id = ? AND revoked_at IS NULL').get(actor.sessionId) as unknown as
      | SessionRow
      | undefined
    const account = session ? accountById(session.account_id) : undefined
    return account && session
      ? { username: account.username, expiresAt: session.expires_at, hasRecoveryCode: Boolean(account.recovery_hash) }
      : null
  },

  logout(): void {
    const actor = currentActor()
    if (!actor.sessionId) return
    db.prepare('UPDATE local_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), actor.sessionId)
  },

  /** 改密码：校验当前密码，成功后注销这个账户的其他会话（当前会话保留） */
  async changePassword(input: unknown): Promise<void> {
    const data = parse(passwordInput, input)
    const account = signedInAccount()
    if (!account) throw new AppError(401, 'LOCAL_LOGIN_REQUIRED', '请先登录本机账户')
    const keys = backoffKeys(account.username)
    assertNoBackoff(keys)
    if (!(await verifyPassword(data.currentPassword, account.password_hash))) {
      recordFailure(keys)
      throw new AppError(400, 'PASSWORD_INCORRECT', '当前密码不正确')
    }
    await setPassword(account, data.newPassword)
    revokeSessions(account.id, currentActor().sessionId ?? null)
    clearFailures(account.username)
    auditService.record({ action: 'auth.local_password_changed', entityType: 'local_account', entityId: account.id, summary: `${account.username} 修改了本机密码` })
  },

  resetForTests(): void {
    backoffs.clear()
  },
}
