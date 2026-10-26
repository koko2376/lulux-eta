import { config } from '../../config.js'
import { currentActor, type Actor } from '../../context.js'
import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { canSee, seesAll, type OwnedRow } from '../../security/access.js'
import { auditService } from '../audit-service.js'

/**
 * 管理员查看成员邮箱（组织设置“管理员可查看成员邮箱”）。
 *
 * - own：自己的邮箱；shared：成员按共享规则本来就能看（团队 / 全组织共享）；
 * - admin：只因为是 owner/admin 才看得到的成员私有邮箱。设置关闭时不能读内容、不能用它发信，
 *   但仍可管理账户（停用、删除、交接）；设置开启时可以读 / 发，每次都写审计，成员邮箱里显示提示。
 * - desktop 模式只有本机用户，不涉及。
 */

export type MailboxAccess = 'own' | 'shared' | 'admin' | 'none'

const META_KEY = 'server.adminMailboxAccess'

export function adminMailboxAccessEnabled(): boolean {
  if (config.mode !== 'server') return true
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
  return row?.value === '1'
}

export function setAdminMailboxAccess(enabled: boolean): void {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, enabled ? '1' : '0')
}

/** 当前用户对某个邮箱账户内容的访问方式（不看设置开关） */
export function mailboxAccess(row: OwnedRow & { visibility?: string | null }, actor: Actor = currentActor()): MailboxAccess {
  if (row.org_id !== actor.orgId) return 'none'
  if (row.owner_id === actor.id) return 'own'
  // 按成员身份（不带管理员特权）能不能看到
  const asMember: Actor = { ...actor, role: 'member' }
  if (canSee(row, asMember)) return 'shared'
  return seesAll(actor) ? 'admin' : 'none'
}

/** 是否可以读写这个账户的邮件内容 */
export function canReadMailbox(row: OwnedRow, actor: Actor = currentActor()): boolean {
  const access = mailboxAccess(row, actor)
  if (access === 'own' || access === 'shared') return true
  return access === 'admin' && adminMailboxAccessEnabled()
}

export function mailboxPrivateError(): AppError {
  return new AppError(403, 'MAILBOX_PRIVATE', '组织未开启“管理员可查看成员邮箱”，不能查看或使用该成员的邮件内容')
}

export type AdminMailboxAction = 'list' | 'read' | 'attachment' | 'draft' | 'send'

const ACTION_LABELS: Record<AdminMailboxAction, string> = {
  list: '查看邮件列表',
  read: '阅读邮件',
  attachment: '下载附件',
  draft: '起草邮件',
  send: '代发邮件',
}

/** 同一人对同一账户的同一动作（同一对象）短时间内只记一次，避免列表刷新刷屏 */
const DEDUPE_MS = 60_000
const recent = new Map<string, number>()

export function auditAdminMailbox(
  account: { id: string; email: string; owner_id: string },
  action: AdminMailboxAction,
  entity: { type?: string; id?: string | null; summary?: string } = {},
  actor: Actor = currentActor(),
): void {
  const key = `${actor.id}|${account.id}|${action}|${entity.id ?? ''}`
  const now = Date.now()
  if (action !== 'send') {
    const last = recent.get(key)
    if (last !== undefined && now - last < DEDUPE_MS) return
    recent.set(key, now)
    if (recent.size > 5000) {
      for (const [k, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(k)
    }
  }
  auditService.record({
    action: `email.admin.${action}`,
    entityType: entity.type ?? 'email_account',
    entityId: entity.id ?? account.id,
    summary: `${ACTION_LABELS[action]}：成员邮箱 ${account.email}${entity.summary ? ` · ${entity.summary}` : ''}`.slice(0, 500),
    meta: { accountId: account.id, accountEmail: account.email, mailboxOwnerId: account.owner_id, action },
    actor,
  })
}

/** 仅供测试 */
export function resetMailboxAuditDedupe(): void {
  recent.clear()
}

/**
 * 读 / 用某个账户的内容前调用：设置关闭时拒绝管理员；开启时按动作写审计。
 * 返回访问方式，方便调用方决定是否还要别的确认。
 */
export function requireMailboxContent(
  account: OwnedRow & { id: string; email: string },
  action: AdminMailboxAction,
  entity: { type?: string; id?: string | null; summary?: string } = {},
  actor: Actor = currentActor(),
): MailboxAccess {
  const access = mailboxAccess(account, actor)
  if (access === 'none') throw mailboxPrivateError()
  if (access === 'admin') {
    if (!adminMailboxAccessEnabled()) throw mailboxPrivateError()
    if (config.mode === 'server') auditAdminMailbox(account, action, entity, actor)
  }
  return access
}
