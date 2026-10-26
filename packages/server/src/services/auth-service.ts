import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { config } from '../config.js'
import { currentActor, currentContext, LOCAL_ACTOR as LOCAL_ACTOR_REF, ROLES, type Actor, type Role } from '../context.js'
import { db } from '../db.js'
import { AppError } from '../errors.js'
import {
  effectivePermissions,
  invalidatePermissions,
  OVERRIDABLE_PERMISSIONS,
  PERMISSION_LABELS,
  permissionsOf,
  registerPermissionOverrideLoader,
  type Permission,
  type PermissionEffect,
  type PermissionOverrides,
} from '../security/access.js'
import {
  dummyPasswordHash,
  hashPassword,
  randomToken,
  sha256Hex,
  validatePasswordStrength,
  verifyPassword,
} from '../security/password.js'
import { tokensEqual } from '../security/api-token.js'
import { newId } from '../utils/id.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { auditService } from './audit-service.js'
import { adminMailboxAccessEnabled, setAdminMailboxAccess } from './email/mailbox-access.js'
import { emitMemberStatus } from './member-events.js'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  disabled: boolean
  /** 管理员设置 / 重置过密码：下次登录必须先修改密码才能使用其它功能 */
  mustChangePassword: boolean
  createdAt: number
  lastLoginAt: number | null
}

export interface Org {
  id: string
  name: string
  createdAt: number
}

export interface Team {
  id: string
  name: string
  memberIds: string[]
  createdAt: number
}

export interface LoginResult {
  token: string
  expiresAt: number
  user: User
  org: Org
}

interface UserRow {
  id: string
  org_id: string
  email: string
  name: string
  role: string
  password_hash: string
  disabled: number
  must_change_password?: number
  created_at: number
  last_login_at: number | null
}

interface SessionRow {
  id: string
  user_id: string
  expires_at: number
  absolute_expires_at: number
  last_used_at: number
  revoked_at: number | null
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    disabled: Number(row.disabled) === 1,
    mustChangePassword: Number(row.must_change_password ?? 0) === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  }
}

/** 成员管理视图：基础资料 + 覆盖项 + 生效权限 */
export interface Member extends User {
  permissionOverrides: PermissionOverrides
  permissions: Permission[]
}

export function loadPermissionOverrides(userId: string): PermissionOverrides {
  const rows = db.prepare('SELECT permission, effect FROM user_permission_overrides WHERE user_id = ?').all(userId) as Array<{
    permission: string
    effect: string
  }>
  const overrides: PermissionOverrides = {}
  for (const row of rows) {
    if ((OVERRIDABLE_PERMISSIONS as string[]).includes(row.permission) && (row.effect === 'grant' || row.effect === 'deny')) {
      overrides[row.permission as Permission] = row.effect
    }
  }
  return overrides
}

registerPermissionOverrideLoader(loadPermissionOverrides)

function toMember(row: UserRow): Member {
  const user = toUser(row)
  const permissionOverrides = user.role === 'owner' ? {} : loadPermissionOverrides(row.id)
  return { ...user, permissionOverrides, permissions: effectivePermissions(user.role, permissionOverrides) }
}

export const emailField = z.string().trim().toLowerCase().email('邮箱格式不正确').max(200)
const nameField = z.string().trim().min(1, '不能为空').max(100)
const passwordField = z.string().max(128)

const setupInput = z.object({
  setupToken: z.string().min(1).max(200),
  email: emailField,
  password: passwordField,
  name: nameField,
  orgName: nameField,
})
const loginInput = z.object({ email: z.string().trim().toLowerCase().max(200), password: passwordField })
const changePasswordInput = z.object({ currentPassword: passwordField, newPassword: passwordField })
const acceptInviteInput = z.object({ code: z.string().min(1).max(200), email: emailField, password: passwordField, name: nameField })

// ── 限流（内存） ─────────────────────────────────────────
const WINDOW_MS = 15 * 60_000
const IP_LIMIT = 10
const EMAIL_LIMIT = 5

interface Bucket {
  count: number
  resetAt: number
}
const failures = new Map<string, Bucket>()

const MAX_BUCKETS = 10_000

/** 过期的计数定期清掉：否则用随机邮箱反复尝试登录会让这张表无限增长（内存 DoS） */
function pruneBuckets(now: number): void {
  if (failures.size < MAX_BUCKETS) return
  for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key)
  // 仍然过多（窗口内的大量不同键）：丢弃最早的一半，IP 维度的计数仍会限流
  if (failures.size >= MAX_BUCKETS) {
    let drop = Math.floor(failures.size / 2)
    for (const key of failures.keys()) {
      if (drop-- <= 0) break
      if (!key.startsWith('ip:')) failures.delete(key)
    }
  }
}

function bucket(key: string): Bucket {
  const now = Date.now()
  pruneBuckets(now)
  let entry = failures.get(key)
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS }
    failures.set(key, entry)
  }
  return entry
}

function assertNotLimited(keys: Array<[string, number]>): void {
  for (const [key, limit] of keys) {
    const entry = bucket(key)
    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000))
      throw Object.assign(new AppError(429, 'LOGIN_RATE_LIMITED', `尝试次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`), {
        retryAfter,
      })
    }
  }
}

function recordFailure(keys: string[]): void {
  for (const key of keys) bucket(key).count += 1
}

export function resetRateLimitsForTests(): void {
  failures.clear()
}

// ── 用户与会话 ───────────────────────────────────────────

function userRowById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
}

function userRowByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined
}

function teamIdsOf(userId: string): string[] {
  return (db.prepare('SELECT team_id FROM team_members WHERE user_id = ? ORDER BY team_id').all(userId) as Array<{ team_id: string }>).map(
    (row) => row.team_id,
  )
}

/** 不按「本机数据」处理的表：账号、组织、团队、邀请与权限本身 */
const ADOPT_SKIP_TABLES = new Set(['users', 'orgs', 'invites', 'teams', 'team_members', 'user_permission_overrides', 'auth_sessions'])

/** 哪些表有哪些归属列（从当前库结构读取，新加的表不会被漏掉） */
export function ownershipColumns(): Array<{ table: string; orgId: boolean; ownerId: boolean; createdBy: boolean }> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as Array<{ name: string }>
  const out: Array<{ table: string; orgId: boolean; ownerId: boolean; createdBy: boolean }> = []
  for (const { name } of tables) {
    if (ADOPT_SKIP_TABLES.has(name)) continue
    const columns = new Set((db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as unknown as Array<{ name: string }>).map((c) => c.name))
    const entry = { table: name, orgId: columns.has('org_id'), ownerId: columns.has('owner_id'), createdBy: columns.has('created_by') && name === 'payments' }
    if (entry.orgId || entry.ownerId || entry.createdBy) out.push(entry)
  }
  return out
}

/**
 * 本机（desktop）模式写下的数据：org_id = 'local'、owner_id = 'local'。
 * 切换到团队服务器初始化 owner 时，全部划给新组织与 owner；只改仍是本机标记的行，已有归属的行不动。
 */
export function adoptLocalData(orgId: string, userId: string): Record<string, number> {
  const moved: Record<string, number> = {}
  for (const entry of ownershipColumns()) {
    const q = `"${entry.table.replace(/"/g, '""')}"`
    let changes = 0
    if (entry.orgId) {
      const ownerPart = entry.ownerId ? `, owner_id = CASE WHEN owner_id = 'local' OR owner_id IS NULL OR owner_id = '' THEN ? ELSE owner_id END` : ''
      const params = entry.ownerId ? [orgId, userId] : [orgId]
      changes += Number(db.prepare(`UPDATE ${q} SET org_id = ?${ownerPart} WHERE org_id = 'local'`).run(...params).changes)
    } else if (entry.ownerId) {
      changes += Number(db.prepare(`UPDATE ${q} SET owner_id = ? WHERE owner_id = 'local'`).run(userId).changes)
    }
    if (entry.createdBy) changes += Number(db.prepare(`UPDATE ${q} SET created_by = ? WHERE created_by = 'local'`).run(userId).changes)
    if (changes > 0) moved[entry.table] = changes
  }
  return moved
}

export function actorFor(row: UserRow, sessionId: string | null): Actor {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    orgId: row.org_id,
    teamIds: teamIdsOf(row.id),
    sessionId,
  }
}

function orgById(id: string): Org | undefined {
  const row = db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as unknown as
    | { id: string; name: string; created_at: number }
    | undefined
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : undefined
}

function createSession(userId: string): { token: string; expiresAt: number; id: string } {
  const token = randomToken('lxs_')
  const now = Date.now()
  const id = newId('ses')
  const absolute = now + config.sessionMaxMs
  const expiresAt = Math.min(now + config.sessionIdleMs, absolute)
  const context = currentContext()
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, expires_at, absolute_expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, sha256Hex(token), now, now, expiresAt, absolute, context.ip, '')
  return { token, expiresAt, id }
}

function loginResult(row: UserRow): LoginResult {
  const session = createSession(row.id)
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id)
  const fresh = userRowById(row.id)!
  return { token: session.token, expiresAt: session.expiresAt, user: toUser(fresh), org: orgById(fresh.org_id)! }
}

export type ResolveResult =
  | { ok: true; actor: Actor; expiresAt: number; mustChangePassword: boolean }
  | { ok: false; code: 'UNAUTHORIZED' | 'SESSION_EXPIRED' | 'USER_DISABLED' }

let setupTokenValue: string | null = null

export function setupTokenFile(): string {
  return join(config.home, 'setup-token')
}

export const authService = {
  userCount(): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n)
  },

  /**
   * 已经初始化过的团队服务器：补迁早期版本 createOwner 漏掉的本机数据（只有一个组织时才做，划给最早的 owner）。
   * 启动时调用，幂等。
   */
  adoptLegacyLocalData(): Record<string, number> {
    if (config.mode !== 'server' || authService.userCount() === 0) return {}
    const orgs = db.prepare('SELECT id FROM orgs').all() as unknown as Array<{ id: string }>
    if (orgs.length !== 1) return {}
    const owner = db.prepare("SELECT id FROM users WHERE org_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(orgs[0]!.id) as unknown as
      | { id: string }
      | undefined
    if (!owner) return {}
    const moved = transaction(() => adoptLocalData(orgs[0]!.id, owner.id))
    if (Object.keys(moved).length > 0) console.log(`[lulux-eta] 已把本机模式遗留数据划给 owner：${JSON.stringify(moved)}`)
    return moved
  },

  setupRequired(): boolean {
    return config.mode === 'server' && authService.userCount() === 0
  },

  /** server 模式首次启动：生成一次性 setup token，打印到日志并写入 <dataDir>/setup-token */
  ensureSetupToken(log = true): string | null {
    if (!authService.setupRequired()) {
      setupTokenValue = null
      if (existsSync(setupTokenFile())) rmSync(setupTokenFile(), { force: true })
      return null
    }
    if (!setupTokenValue) {
      setupTokenValue = randomToken('lxsetup_', 16)
      writeFileSync(setupTokenFile(), setupTokenValue, { mode: 0o600 })
      try {
        chmodSync(setupTokenFile(), 0o600)
      } catch {
        // Windows
      }
      if (log) {
        console.log(`[lulux-eta] ================================================================`)
        console.log(`[lulux-eta] SETUP TOKEN: ${setupTokenValue}`)
        console.log(`[lulux-eta] 用它在网页上创建第一个管理员（owner），或运行 CLI：node dist/cli.js create-owner`)
        console.log(`[lulux-eta] ================================================================`)
      }
    }
    return setupTokenValue
  },

  /** CLI 与 setup 接口共用 */
  async createOwner(input: { email: string; password: string; name: string; orgName: string }): Promise<UserRow> {
    const weak = validatePasswordStrength(input.password, input.email)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak)
    const hash = await hashPassword(input.password)
    return transaction(() => {
      if (authService.userCount() > 0) throw new AppError(409, 'SETUP_ALREADY_DONE', '已经初始化过管理员')
      const now = Date.now()
      const orgId = newId('org')
      const userId = newId('usr')
      db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(orgId, input.orgName, now)
      db.prepare(
        `INSERT INTO users (id, org_id, email, name, role, password_hash, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'owner', ?, 0, ?, ?)`,
      ).run(userId, orgId, input.email, input.name, hash, now, now)
      // 从本机模式迁移来的数据归 owner 所有（所有业务表，按表结构自动枚举）
      adoptLocalData(orgId, userId)
      setupTokenValue = null
      if (existsSync(setupTokenFile())) rmSync(setupTokenFile(), { force: true })
      return userRowById(userId)!
    })
  },

  async setup(input: unknown): Promise<LoginResult> {
    const data = parse(setupInput, input)
    const ip = currentContext().ip
    assertNotLimited([[`ip:${ip}`, IP_LIMIT]])
    if (!authService.setupRequired()) throw new AppError(409, 'SETUP_ALREADY_DONE', '已经初始化过管理员')
    const expected = setupTokenValue ?? authService.ensureSetupToken(false)
    if (!expected || !tokensEqual(expected, data.setupToken.trim())) {
      recordFailure([`ip:${ip}`])
      throw new AppError(403, 'SETUP_TOKEN_INVALID', 'setup token 不正确（见服务启动日志或数据目录下的 setup-token 文件）')
    }
    const row = await authService.createOwner(data)
    const result = loginResult(row)
    auditService.record({ action: 'auth.setup', entityType: 'user', entityId: row.id, summary: `初始化组织「${data.orgName}」与 owner ${row.email}`, actor: actorFor(row, null) })
    return result
  },

  async login(input: unknown): Promise<LoginResult> {
    const data = parse(loginInput, input)
    const ip = currentContext().ip
    if (authService.setupRequired()) throw new AppError(409, 'SETUP_REQUIRED', '服务器尚未初始化，请先创建管理员')
    const keys: Array<[string, number]> = [
      [`ip:${ip}`, IP_LIMIT],
      [`email:${data.email}`, EMAIL_LIMIT],
    ]
    assertNotLimited(keys)
    const row = userRowByEmail(data.email)
    const ok = await verifyPassword(data.password, row?.password_hash ?? (await dummyPasswordHash()))
    if (!row || !ok) {
      recordFailure(keys.map(([key]) => key))
      auditService.record({
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: row?.id ?? null,
        summary: `登录失败：${data.email}`,
        actor: null,
        orgId: row?.org_id ?? (db.prepare('SELECT id FROM orgs LIMIT 1').get() as { id: string } | undefined)?.id ?? 'local',
      })
      throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误')
    }
    if (Number(row.disabled) === 1) throw new AppError(403, 'USER_DISABLED', '账号已停用，请联系管理员')
    const result = loginResult(row)
    auditService.record({ action: 'auth.login', entityType: 'user', entityId: row.id, summary: `${row.email} 登录`, actor: actorFor(row, null) })
    return result
  },

  /** 校验会话 token 并续期 */
  resolve(token: string): ResolveResult {
    if (!token.startsWith('lxs_')) return { ok: false, code: 'UNAUTHORIZED' }
    const session = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(sha256Hex(token)) as unknown as
      | SessionRow
      | undefined
    if (!session || session.revoked_at) return { ok: false, code: 'UNAUTHORIZED' }
    const now = Date.now()
    if (session.expires_at <= now || session.absolute_expires_at <= now) return { ok: false, code: 'SESSION_EXPIRED' }
    const row = userRowById(session.user_id)
    if (!row) return { ok: false, code: 'UNAUTHORIZED' }
    if (Number(row.disabled) === 1) return { ok: false, code: 'USER_DISABLED' }
    let expiresAt = session.expires_at
    // 滑动续期：每分钟最多写一次库
    if (now - session.last_used_at > 60_000) {
      expiresAt = Math.min(now + config.sessionIdleMs, session.absolute_expires_at)
      db.prepare('UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, session.id)
    }
    return { ok: true, actor: actorFor(row, session.id), expiresAt, mustChangePassword: Number(row.must_change_password ?? 0) === 1 }
  },

  refresh(): { expiresAt: number } {
    const actor = currentActor()
    if (!actor.sessionId) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', 'desktop 模式没有会话')
    const session = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(actor.sessionId) as unknown as SessionRow
    const expiresAt = Math.min(Date.now() + config.sessionIdleMs, session.absolute_expires_at)
    db.prepare('UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(Date.now(), expiresAt, session.id)
    return { expiresAt }
  },

  sessionExpiry(sessionId: string | null): number | null {
    if (!sessionId) return null
    const row = db.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').get(sessionId) as { expires_at: number } | undefined
    return row?.expires_at ?? null
  },

  logout(): void {
    const actor = currentActor()
    if (!actor.sessionId) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', 'desktop 模式没有会话')
    db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(Date.now(), actor.sessionId)
    auditService.record({ action: 'auth.logout', entityType: 'user', entityId: actor.id, summary: `${actor.email} 登出` })
  },

  revokeSessions(userId: string, exceptSessionId: string | null = null): number {
    const result = exceptSessionId
      ? db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?').run(Date.now(), userId, exceptSessionId)
      : db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId)
    return Number(result.changes)
  },

  async changePassword(input: unknown): Promise<void> {
    const data = parse(changePasswordInput, input)
    const actor = currentActor()
    const row = userRowById(actor.id)
    if (!row) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', 'desktop 模式没有账号密码')
    if (!(await verifyPassword(data.currentPassword, row.password_hash))) {
      throw new AppError(403, 'PASSWORD_INCORRECT', '当前密码不正确')
    }
    const weak = validatePasswordStrength(data.newPassword, row.email)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak)
    const hash = await hashPassword(data.newPassword)
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hash, Date.now(), row.id)
    authService.revokeSessions(row.id, actor.sessionId)
    auditService.record({ action: 'auth.password_change', entityType: 'user', entityId: row.id, summary: `${row.email} 修改密码` })
  },

  /**
   * 设置新密码并吊销全部会话。requireChange：由管理员代设的密码，成员下次登录后必须先改成只有自己知道的密码；
   * 运维用 CLI 找回自己的密码时不需要。
   */
  async resetPassword(userId: string, newPassword: string, options: { requireChange?: boolean } = {}): Promise<void> {
    const row = userRowById(userId)
    if (!row) throw new AppError(404, 'NOT_FOUND', '成员不存在')
    const weak = validatePasswordStrength(newPassword, row.email)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak)
    const hash = await hashPassword(newPassword)
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?').run(
      hash,
      options.requireChange ? 1 : 0,
      Date.now(),
      row.id,
    )
    authService.revokeSessions(row.id)
    auditService.record({
      action: 'auth.password_reset',
      entityType: 'user',
      entityId: row.id,
      summary: `重置 ${row.email} 的密码${options.requireChange ? '（下次登录须修改）' : ''}`,
      meta: { requireChange: Boolean(options.requireChange) },
    })
  },

  me(): { user: User; org: Org; teams: Team[]; permissions: Permission[]; session: { expiresAt: number } | null } {
    const actor = currentActor()
    const row = userRowById(actor.id)
    if (!row) {
      return {
        user: {
          id: actor.id,
          email: actor.email,
          name: actor.name,
          role: actor.role,
          disabled: false,
          mustChangePassword: false,
          createdAt: 0,
          lastLoginAt: null,
        },
        org: { id: actor.orgId, name: '本机', createdAt: 0 },
        teams: [],
        permissions: permissionsOf(actor),
        session: null,
      }
    }
    const expiresAt = authService.sessionExpiry(actor.sessionId)
    return {
      user: toUser(row),
      org: orgById(row.org_id)!,
      teams: teamService.listTeams(row.org_id).filter((team) => team.memberIds.includes(row.id)),
      permissions: permissionsOf(actor),
      session: expiresAt ? { expiresAt } : null,
    }
  },

  // ── 邀请（公开部分） ───────────────────────────────────
  inviteInfo(code: string): { orgName: string; role: Role; email: string | null; expiresAt: number } {
    const invite = findUsableInvite(code)
    return { orgName: orgById(invite.org_id)?.name ?? '', role: invite.role as Role, email: invite.email, expiresAt: invite.expires_at }
  },

  async acceptInvite(input: unknown): Promise<LoginResult> {
    const data = parse(acceptInviteInput, input)
    const ip = currentContext().ip
    assertNotLimited([[`ip:${ip}`, IP_LIMIT]])
    let invite: InviteRow
    try {
      invite = findUsableInvite(data.code)
    } catch (error) {
      recordFailure([`ip:${ip}`])
      throw error
    }
    if (invite.email && invite.email.toLowerCase() !== data.email) {
      throw new AppError(400, 'INVITE_EMAIL_MISMATCH', '这个邀请只能用指定的邮箱接受')
    }
    const weak = validatePasswordStrength(data.password, data.email)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak)
    const hash = await hashPassword(data.password)
    const row = transaction(() => {
      const fresh = findUsableInvite(data.code)
      if (userRowByEmail(data.email)) throw new AppError(409, 'EMAIL_TAKEN', '该邮箱已注册')
      const now = Date.now()
      const userId = newId('usr')
      db.prepare(
        `INSERT INTO users (id, org_id, email, name, role, password_hash, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(userId, fresh.org_id, data.email, data.name, fresh.role, hash, now, now)
      if (fresh.team_id && db.prepare('SELECT 1 FROM teams WHERE id = ?').get(fresh.team_id)) {
        db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(fresh.team_id, userId)
      }
      db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(fresh.id)
      return userRowById(userId)!
    })
    const result = loginResult(row)
    auditService.record({
      action: 'invite.accept',
      entityType: 'invite',
      entityId: invite.id,
      summary: `${row.email} 接受邀请加入（${row.role}）`,
      actor: actorFor(row, null),
    })
    return result
  },
}

// ── 邀请 / 成员 / 团队 ────────────────────────────────────

interface InviteRow {
  id: string
  org_id: string
  code_hash: string
  role: string
  email: string | null
  team_id: string | null
  max_uses: number
  uses: number
  expires_at: number
  created_by: string
  created_at: number
  revoked_at: number | null
}

export interface Invite {
  id: string
  role: Role
  email: string | null
  teamId: string | null
  maxUses: number
  uses: number
  expiresAt: number
  createdBy: string
  createdAt: number
  revoked: boolean
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    role: row.role as Role,
    email: row.email,
    teamId: row.team_id,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revoked: Boolean(row.revoked_at),
  }
}

function findUsableInvite(code: string): InviteRow {
  const row = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256Hex(code.trim())) as unknown as InviteRow | undefined
  if (!row) throw new AppError(404, 'INVITE_INVALID', '邀请码无效')
  if (row.revoked_at || row.expires_at <= Date.now() || row.uses >= row.max_uses) {
    throw new AppError(410, 'INVITE_EXPIRED', '邀请已过期、已用完或已撤销')
  }
  return row
}

const inviteInput = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  email: emailField.optional().nullable(),
  teamId: z.string().max(80).optional().nullable(),
  expiresInHours: z.number().int().min(1).max(720).default(72),
  maxUses: z.number().int().min(1).max(100).default(1),
})

const memberPatch = z
  .object({
    role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
    disabled: z.boolean().optional(),
    name: nameField.optional(),
    /** 覆盖项全量替换：权限 → grant | deny；不在表里的权限跟随角色默认值 */
    permissionOverrides: z
      .record(z.string().max(40), z.enum(['grant', 'deny']).nullable())
      .optional(),
  })
  .strict()

const createMemberInput = z
  .object({
    email: emailField,
    name: nameField,
    role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
    password: passwordField,
    teamId: z.string().max(80).optional().nullable(),
  })
  .strict()

const teamInput = z.object({ name: nameField, memberIds: z.array(z.string().max(80)).max(1000).optional() }).strict()
const teamPatch = teamInput.partial().strict()

/**
 * 成员停用 / 启用后的联动：停用时暂停他名下的定时任务（owner_paused，不改用户自己设的 enabled）；
 * 邮箱后台同步按负责人状态过滤（email/scheduler.ts）。启用时恢复暂停的任务，
 * 下一次触发时间由定时任务模块监听 member-events 重新计算。
 */
function applyMemberStatus(userId: string, disabled: boolean): { schedules: number; emailAccounts: number } {
  const schedules = Number(
    db.prepare('UPDATE schedules SET owner_paused = ? WHERE owner_id = ? AND owner_paused = ?').run(disabled ? 1 : 0, userId, disabled ? 0 : 1)
      .changes,
  )
  const emailAccounts = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM email_accounts WHERE owner_id = ? AND sync_enabled = 1').get(userId) as { n: number }).n,
  )
  emitMemberStatus(userId, disabled)
  return { schedules, emailAccounts }
}

function ownerCount(orgId: string): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'owner' AND disabled = 0").get(orgId) as { n: number }).n,
  )
}

function requireMember(id: string, actor: Actor): UserRow {
  const row = userRowById(id)
  if (!row || row.org_id !== actor.orgId) throw new AppError(404, 'NOT_FOUND', '成员不存在')
  return row
}

export const teamService = {
  org(actor: Actor = currentActor()): Org {
    return orgById(actor.orgId)!
  },

  renameOrg(name: string, actor: Actor = currentActor()): Org {
    const value = nameField.parse(name)
    db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(value, actor.orgId)
    auditService.record({ action: 'org.update', entityType: 'org', entityId: actor.orgId, summary: `组织改名为「${value}」` })
    return orgById(actor.orgId)!
  },

  members(actor: Actor = currentActor()): Member[] {
    return (db.prepare('SELECT * FROM users WHERE org_id = ? ORDER BY created_at').all(actor.orgId) as unknown as UserRow[]).map(toMember)
  },

  member(id: string, actor: Actor = currentActor()): Member {
    return toMember(requireMember(id, actor))
  },

  /**
   * 设置某个成员的覆盖项（全量替换）。owner 恒为全部权限、不能设置；只有 owner 能设置 admin；
   * 不能改自己；只接受可单独授予的业务权限。
   */
  setPermissionOverrides(id: string, input: Record<string, PermissionEffect | null>, actor: Actor = currentActor()): Member {
    if (actor.role !== 'owner' && actor.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '只有 owner 或管理员可以修改成员权限')
    const row = requireMember(id, actor)
    if (row.role === 'owner') throw new AppError(403, 'CANNOT_MODIFY_OWNER', 'owner 始终拥有全部权限，不能单独设置')
    if (row.id === actor.id) throw new AppError(409, 'CANNOT_MODIFY_SELF', '不能修改自己的权限')
    if (row.role === 'admin' && actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以修改管理员的权限')
    const next: PermissionOverrides = {}
    for (const [key, effect] of Object.entries(input)) {
      if (!(OVERRIDABLE_PERMISSIONS as string[]).includes(key)) {
        throw new AppError(400, 'VALIDATION_ERROR', `不能单独设置的权限：${key}`)
      }
      if (effect === 'grant' || effect === 'deny') next[key as Permission] = effect
    }
    const before = loadPermissionOverrides(row.id)
    const now = Date.now()
    transaction(() => {
      db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(row.id)
      const insert = db.prepare(
        'INSERT INTO user_permission_overrides (user_id, permission, effect, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      for (const [permission, effect] of Object.entries(next)) insert.run(row.id, permission, effect, actor.id, now)
    })
    invalidatePermissions(row.id)
    const changed = OVERRIDABLE_PERMISSIONS.filter((permission) => before[permission] !== next[permission])
    if (changed.length > 0) {
      auditService.record({
        action: 'member.permissions',
        entityType: 'user',
        entityId: row.id,
        summary: `修改成员 ${row.email} 的权限：${changed
          .map((permission) => `${PERMISSION_LABELS[permission]}→${next[permission] === 'grant' ? '允许' : next[permission] === 'deny' ? '禁止' : '默认'}`)
          .join('，')}`,
        meta: { before, after: next },
      })
    }
    return toMember(userRowById(row.id)!)
  },

  userName(id: string): string {
    if (id === 'local') return '本机用户'
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined
    return row?.name ?? '未知用户'
  },

  isOrgMember(id: string, orgId: string): boolean {
    if (id === 'local' && orgId === 'local') return true
    return Boolean(db.prepare('SELECT 1 FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(id, orgId))
  },

  updateMember(id: string, input: unknown, actor: Actor = currentActor()): Member {
    const { permissionOverrides, ...patch } = parse(memberPatch, input)
    const row = requireMember(id, actor)
    if (actor.role !== 'owner' && (row.role === 'owner' || patch.role === 'owner')) {
      throw new AppError(403, 'CANNOT_MODIFY_OWNER', '管理员不能修改 owner 或授予 owner 角色')
    }
    if (row.id === actor.id && (patch.role !== undefined || patch.disabled !== undefined)) {
      throw new AppError(409, 'CANNOT_MODIFY_SELF', '不能修改自己的角色或停用自己')
    }
    const losingOwner = row.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.disabled === true)
    if (losingOwner && ownerCount(actor.orgId) <= 1) throw new AppError(409, 'LAST_OWNER', '至少要保留一个 owner')
    if (permissionOverrides) teamService.setPermissionOverrides(row.id, permissionOverrides, actor)
    if (Object.keys(patch).length === 0) return toMember(userRowById(row.id)!)
    db.prepare('UPDATE users SET role = ?, disabled = ?, name = ?, updated_at = ? WHERE id = ?').run(
      patch.role ?? row.role,
      patch.disabled === undefined ? row.disabled : patch.disabled ? 1 : 0,
      patch.name ?? row.name,
      Date.now(),
      row.id,
    )
    if (patch.role && patch.role !== row.role) invalidatePermissions(row.id)
    if (patch.disabled === true || (patch.role && patch.role !== row.role)) authService.revokeSessions(row.id)
    const statusChanged = patch.disabled !== undefined && patch.disabled !== (Number(row.disabled) === 1)
    const effects = statusChanged ? applyMemberStatus(row.id, patch.disabled!) : null
    auditService.record({
      action: patch.disabled === true ? 'member.disable' : statusChanged ? 'member.enable' : 'member.update',
      entityType: 'user',
      entityId: row.id,
      summary: effects
        ? patch.disabled
          ? `停用成员 ${row.email}（暂停 ${effects.schedules} 个定时任务、${effects.emailAccounts} 个邮箱的后台同步）`
          : `启用成员 ${row.email}（恢复 ${effects.schedules} 个定时任务、${effects.emailAccounts} 个邮箱的后台同步）`
        : `修改成员 ${row.email}`,
      meta: { ...patch, ...(effects ? { schedules: effects.schedules, emailAccounts: effects.emailAccounts } : {}) },
    })
    return toMember(userRowById(row.id)!)
  },

  disableMember(id: string, actor: Actor = currentActor()): void {
    teamService.updateMember(id, { disabled: true }, actor)
  },

  async resetMemberPassword(id: string, newPassword: unknown, actor: Actor = currentActor()): Promise<void> {
    const value = z.object({ newPassword: passwordField }).parse(newPassword).newPassword
    const row = requireMember(id, actor)
    if (row.role === 'owner' && actor.role !== 'owner') {
      throw new AppError(403, 'CANNOT_MODIFY_OWNER', '管理员不能重置 owner 的密码')
    }
    await authService.resetPassword(row.id, value, { requireChange: row.id !== actor.id })
  },

  /**
   * 管理员直接创建成员并设置初始密码（不走邀请链接）。初始密码管理员知道，所以对方首次登录必须先改密。
   */
  async createMember(input: unknown, actor: Actor = currentActor()): Promise<Member> {
    const data = parse(createMemberInput, input)
    if (data.role === 'owner') throw new AppError(400, 'VALIDATION_ERROR', '不能直接创建 owner；先创建为 admin，再转让所有权')
    if (data.role === 'admin' && actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以创建管理员')
    const weak = validatePasswordStrength(data.password, data.email)
    if (weak) throw new AppError(400, 'WEAK_PASSWORD', weak)
    if (data.teamId && !teamService.teamExists(data.teamId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
    const hash = await hashPassword(data.password)
    const row = transaction(() => {
      if (userRowByEmail(data.email)) throw new AppError(409, 'EMAIL_TAKEN', '该邮箱已注册')
      const now = Date.now()
      const userId = newId('usr')
      db.prepare(
        `INSERT INTO users (id, org_id, email, name, role, password_hash, disabled, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      ).run(userId, actor.orgId, data.email, data.name, data.role, hash, now, now)
      if (data.teamId) db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(data.teamId, userId)
      return userRowById(userId)!
    })
    auditService.record({
      action: 'member.create',
      entityType: 'user',
      entityId: row.id,
      summary: `创建成员 ${row.email}（${row.role}，首次登录须修改密码）`,
      meta: { role: row.role, teamId: data.teamId ?? null },
    })
    return toMember(row)
  },

  transferOwnership(userId: string, actor: Actor = currentActor()): { from: User; to: User } {
    if (actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以转让所有权')
    const target = requireMember(userId, actor)
    if (target.id === actor.id) throw new AppError(409, 'CANNOT_MODIFY_SELF', '不能转让给自己')
    if (Number(target.disabled) === 1) throw new AppError(409, 'USER_DISABLED', '对方账号已停用')
    transaction(() => {
      db.prepare("UPDATE users SET role = 'owner', updated_at = ? WHERE id = ?").run(Date.now(), target.id)
      db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").run(Date.now(), actor.id)
    })
    auditService.record({ action: 'ownership.transfer', entityType: 'user', entityId: target.id, summary: `所有权转让给 ${target.email}` })
    return { from: toUser(userRowById(actor.id)!), to: toUser(userRowById(target.id)!) }
  },

  listInvites(actor: Actor = currentActor()): Invite[] {
    return (db.prepare('SELECT * FROM invites WHERE org_id = ? ORDER BY created_at DESC').all(actor.orgId) as unknown as InviteRow[]).map(toInvite)
  },

  createInvite(input: unknown, actor: Actor = currentActor()): { invite: Invite; code: string; url: string } {
    const data = parse(inviteInput, input)
    if (data.role === 'owner') {
      if (actor.role !== 'owner') throw new AppError(403, 'CANNOT_MODIFY_OWNER', '管理员不能邀请 owner')
      throw new AppError(400, 'VALIDATION_ERROR', '不能直接邀请 owner；先邀请为 admin，再转让所有权')
    }
    if (data.teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(data.teamId, actor.orgId)) {
      throw new AppError(404, 'NOT_FOUND', '团队不存在')
    }
    const code = randomToken('lxi_', 16)
    const id = newId('inv')
    const now = Date.now()
    db.prepare(
      `INSERT INTO invites (id, org_id, code_hash, role, email, team_id, max_uses, uses, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, actor.orgId, sha256Hex(code), data.role, data.email ?? null, data.teamId ?? null, data.maxUses, now + data.expiresInHours * 3600_000, actor.id, now)
    auditService.record({ action: 'invite.create', entityType: 'invite', entityId: id, summary: `创建邀请（${data.role}${data.email ? `，${data.email}` : ''}）` })
    const origin = config.publicOrigins[0] ?? ''
    const invite = toInvite(db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as unknown as InviteRow)
    return { invite, code, url: `${origin}/#/join?code=${code}` }
  },

  revokeInvite(id: string, actor: Actor = currentActor()): void {
    const result = db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND org_id = ?').run(Date.now(), id, actor.orgId)
    if (Number(result.changes) === 0) throw new AppError(404, 'NOT_FOUND', '邀请不存在')
    auditService.record({ action: 'invite.revoke', entityType: 'invite', entityId: id, summary: '撤销邀请' })
  },

  listTeams(orgId: string = currentActor().orgId): Team[] {
    const teams = db.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY created_at').all(orgId) as unknown as Array<{
      id: string
      name: string
      created_at: number
    }>
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      createdAt: team.created_at,
      memberIds: (db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(team.id) as Array<{ user_id: string }>).map((r) => r.user_id),
    }))
  },

  teamExists(id: string, orgId: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM teams WHERE id = ? AND org_id = ?').get(id, orgId))
  },

  createTeam(input: unknown, actor: Actor = currentActor()): Team {
    const data = parse(teamInput, input)
    const id = newId('team')
    transaction(() => {
      db.prepare('INSERT INTO teams (id, org_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, actor.orgId, data.name, Date.now())
      teamService.setTeamMembers(id, data.memberIds ?? [], actor)
    })
    auditService.record({ action: 'team.create', entityType: 'team', entityId: id, summary: `创建团队「${data.name}」` })
    return teamService.listTeams(actor.orgId).find((team) => team.id === id)!
  },

  setTeamMembers(teamId: string, memberIds: string[], actor: Actor): void {
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId)
    const insert = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)')
    for (const userId of memberIds) {
      requireMember(userId, actor)
      insert.run(teamId, userId)
    }
  },

  updateTeam(id: string, input: unknown, actor: Actor = currentActor()): Team {
    const data = parse(teamPatch, input)
    if (!teamService.teamExists(id, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
    transaction(() => {
      if (data.name) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(data.name, id)
      if (data.memberIds) teamService.setTeamMembers(id, data.memberIds, actor)
    })
    auditService.record({ action: 'team.update', entityType: 'team', entityId: id, summary: '修改团队', meta: { ...data } })
    return teamService.listTeams(actor.orgId).find((team) => team.id === id)!
  },

  removeTeam(id: string, actor: Actor = currentActor()): void {
    if (!teamService.teamExists(id, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
    transaction(() => {
      for (const table of ['customers', 'sessions', 'email_accounts']) {
        db.prepare(`UPDATE ${table} SET visibility = CASE WHEN visibility = 'team' THEN 'private' ELSE visibility END, team_id = NULL WHERE team_id = ?`).run(id)
      }
      db.prepare('DELETE FROM teams WHERE id = ?').run(id)
    })
    auditService.record({ action: 'team.delete', entityType: 'team', entityId: id, summary: '删除团队' })
  },
}

// ── server 模式安全开关（内核 / MCP） ───────────────────────

export const SECURITY_WARNING =
  '开启后，内核 / MCP 会以服务进程身份在服务器上执行命令，任何能对话的成员都可能借此读取服务器文件与密钥。仅在可信团队、隔离容器中开启。'

function meta(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export interface ServerSecurityState {
  allowKernels: boolean
  allowMcp: boolean
  /** 管理员可查看成员邮箱（默认关闭） */
  adminMailboxAccess: boolean
  warning: string
}

export const serverSecurity = {
  state(): ServerSecurityState {
    if (config.mode !== 'server') return { allowKernels: true, allowMcp: true, adminMailboxAccess: true, warning: '' }
    return {
      allowKernels: meta('server.allowKernels') === '1',
      allowMcp: meta('server.allowMcp') === '1',
      adminMailboxAccess: adminMailboxAccessEnabled(),
      warning: SECURITY_WARNING,
    }
  },
  kernelsAllowed(): boolean {
    return serverSecurity.state().allowKernels
  },
  mcpAllowed(): boolean {
    return serverSecurity.state().allowMcp
  },
  update(input: unknown, actor: Actor = currentActor()): ServerSecurityState {
    if (actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以修改服务器安全选项')
    const data = parse(
      z
        .object({ allowKernels: z.boolean().optional(), allowMcp: z.boolean().optional(), adminMailboxAccess: z.boolean().optional(), confirm: z.string().optional() })
        .strict(),
      input,
    )
    if ((data.allowKernels || data.allowMcp) && data.confirm !== 'I_UNDERSTAND') {
      throw new AppError(400, 'CONFIRM_REQUIRED', `开启前请确认风险（confirm: 'I_UNDERSTAND'）：${SECURITY_WARNING}`)
    }
    if (data.allowKernels !== undefined) setMeta('server.allowKernels', data.allowKernels ? '1' : '0')
    if (data.allowMcp !== undefined) setMeta('server.allowMcp', data.allowMcp ? '1' : '0')
    if (data.adminMailboxAccess !== undefined) {
      const before = adminMailboxAccessEnabled()
      setAdminMailboxAccess(data.adminMailboxAccess)
      if (before !== data.adminMailboxAccess) {
        auditService.record({
          action: 'security.admin_mailbox_access',
          entityType: 'server',
          entityId: null,
          summary: data.adminMailboxAccess ? '开启“管理员可查看成员邮箱”' : '关闭“管理员可查看成员邮箱”',
          meta: { adminMailboxAccess: data.adminMailboxAccess },
        })
      }
    }
    auditService.record({
      action: 'security.update',
      entityType: 'server',
      entityId: null,
      summary: '修改服务器安全选项',
      meta: { allowKernels: data.allowKernels, allowMcp: data.allowMcp, adminMailboxAccess: data.adminMailboxAccess },
    })
    return serverSecurity.state()
  },
}

export { ROLES }

/** 后台任务以数据归属人的身份运行；desktop 模式或找不到用户时用本机用户 */
export function actorForUserId(userId: string): Actor {
  if (userId === 'local') return { ...LOCAL_ACTOR_REF }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined
  if (!row) return { ...LOCAL_ACTOR_REF }
  return actorFor(row, null)
}
