import { z } from 'zod'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError, notFound } from '../errors.js'
import { isServerMode, requireDelete, requirePermission, seesAll } from '../security/access.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { auditService } from './audit-service.js'
import { teamService } from './auth-service.js'
import { businessRecordCounts, customerService, type CustomerDuplicate } from './customer-service.js'
import { settingsService } from './settings-service.js'
import { TRASH_DELETE_PERMISSION, TRASH_ENTITIES, TRASH_LABELS, TRASH_TABLES, type TrashEntity } from './trash.js'

/**
 * 回收站：客户、报价、商机、订单、任务删除后先进这里。
 * - 列表：owner/admin 看本组织全部；其他人只看自己负责或自己删除的
 * - 恢复：需要 data:write，且是负责人 / 删除人 / owner / admin；所属客户也在回收站时先恢复客户
 * - 彻底删除：需要对应的 *:delete；团队服务器模式下只有 owner/admin 可以
 * - 超过保留天数（设置 trashRetentionDays，默认 30，0 不清理）自动彻底删除
 */
export interface TrashItem {
  entity: TrashEntity
  id: string
  title: string
  subtitle: string
  customerId: string | null
  ownerId: string
  ownerName: string
  deletedAt: number
  deletedBy: string | null
  deletedByName: string
  /** 自动彻底删除的时间（不自动清理时为 null） */
  purgeAt: number | null
  /** 随客户一起移入回收站的任务数（仅客户） */
  cascadedTasks?: number
}

const listInput = z.object({
  entity: z.enum(TRASH_ENTITIES as [TrashEntity, ...TrashEntity[]]).optional(),
  query: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

const entityParam = z.enum(TRASH_ENTITIES as [TrashEntity, ...TrashEntity[]])

const DAY = 86_400_000

interface TrashRow {
  entity: TrashEntity
  id: string
  title: string
  subtitle: string
  customer_id: string | null
  owner_id: string
  org_id: string
  deleted_at: number
  deleted_by: string | null
}

/** 各表映射成统一的列；任务只列不是随客户一起删除的（那些随客户恢复） */
const UNION = `
  SELECT 'customer' AS entity, c.id, c.company AS title, c.country AS subtitle, c.id AS customer_id, c.owner_id, c.org_id, c.deleted_at, c.deleted_by
    FROM customers c WHERE c.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'quote', q.id, q.number, COALESCE(c.company, ''), q.customer_id, q.owner_id, q.org_id, q.deleted_at, q.deleted_by
    FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id WHERE q.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'deal', d.id, d.title, COALESCE(c.company, ''), d.customer_id, d.owner_id, d.org_id, d.deleted_at, d.deleted_by
    FROM deals d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'order', o.id, o.number, COALESCE(c.company, ''), o.customer_id, o.owner_id, o.org_id, o.deleted_at, o.deleted_by
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'task', t.id, t.title, COALESCE(c.company, ''), t.customer_id, t.owner_id, t.org_id, t.deleted_at, t.deleted_by
    FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.deleted_at IS NOT NULL AND NOT (c.deleted_at IS NOT NULL AND c.deleted_at = t.deleted_at)
  UNION ALL
  SELECT 'prospect', p.id, p.company, p.country, NULL, p.owner_id, p.org_id, p.deleted_at, p.deleted_by
    FROM prospects p WHERE p.deleted_at IS NOT NULL
`

export function retentionDays(): number {
  const value = Number.parseInt(settingsService.get('trashRetentionDays') ?? '30', 10)
  return Number.isFinite(value) && value >= 0 ? value : 30
}

function trashedRow(entity: TrashEntity, id: string): Record<string, unknown> & { org_id: string; owner_id: string; deleted_at: number | null; deleted_by: string | null } {
  const row = db.prepare(`SELECT * FROM ${TRASH_TABLES[entity]} WHERE id = ?`).get(id) as unknown as
    | (Record<string, unknown> & { org_id: string; owner_id: string; deleted_at: number | null; deleted_by: string | null })
    | undefined
  const actor = currentActor()
  if (!row || !row.deleted_at || row.org_id !== actor.orgId) throw notFound(`回收站里的${TRASH_LABELS[entity]}`)
  if (!seesAll(actor) && row.owner_id !== actor.id && row.deleted_by !== actor.id) throw notFound(`回收站里的${TRASH_LABELS[entity]}`)
  return row
}

function customerTrashed(customerId: string | null | undefined): boolean {
  if (!customerId) return false
  const row = db.prepare('SELECT deleted_at FROM customers WHERE id = ?').get(customerId) as unknown as { deleted_at: number | null } | undefined
  return Boolean(row?.deleted_at)
}

function titleOf(entity: TrashEntity, row: Record<string, unknown>): string {
  if (entity === 'customer' || entity === 'prospect') return String(row.company ?? '')
  if (entity === 'quote' || entity === 'order') return String(row.number ?? '')
  return String(row.title ?? '')
}

/** 物理删除一行（外键级联：客户 → 联系人 / 跟进 / 任务；订单 → 收款） */
function hardDelete(entity: TrashEntity, id: string): void {
  db.prepare(`DELETE FROM ${TRASH_TABLES[entity]} WHERE id = ?`).run(id)
}

/** 客户还有回收站里的报价 / 商机 / 订单时不能彻底删除（否则会被外键级联一起抹掉） */
function assertCustomerPurgeable(id: string): void {
  const counts = businessRecordCounts(id, false)
  const parts = [
    counts.orders ? `${counts.orders} 个订单` : '',
    counts.quotes ? `${counts.quotes} 个报价` : '',
    counts.deals ? `${counts.deals} 个商机` : '',
  ].filter(Boolean)
  if (parts.length) {
    throw new AppError(409, 'CUSTOMER_HAS_RECORDS', `该客户名下还有 ${parts.join('、')}（含回收站），请先彻底删除这些记录再删除客户`)
  }
}

/** 自动清理每批取多少行（测试可调小） */
let PURGE_BATCH = 500
export function setPurgeBatchForTest(size: number): void {
  PURGE_BATCH = Math.max(1, Math.floor(size))
}

export const trashService = {
  list(input: unknown): { items: TrashItem[]; total: number; retentionDays: number } {
    const query = parse(listInput, input)
    const actor = currentActor()
    const where = ['u.org_id = ?']
    const params: Array<string | number> = [actor.orgId]
    if (!seesAll(actor)) {
      where.push('(u.owner_id = ? OR u.deleted_by = ?)')
      params.push(actor.id, actor.id)
    }
    if (query.entity) {
      where.push('u.entity = ?')
      params.push(query.entity)
    }
    if (query.query?.trim()) {
      const like = `%${query.query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push("(lower(u.title) LIKE ? ESCAPE '\\' OR lower(u.subtitle) LIKE ? ESCAPE '\\')")
      params.push(like, like)
    }
    const from = `FROM (${UNION}) u WHERE ${where.join(' AND ')}`
    const total = Number((db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as unknown as { n: number }).n)
    const rows = db
      .prepare(`SELECT u.* ${from} ORDER BY u.deleted_at DESC, u.id LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as unknown as TrashRow[]
    const days = retentionDays()
    const items = rows.map((row): TrashItem => {
      const item: TrashItem = {
        entity: row.entity,
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        customerId: row.customer_id,
        ownerId: row.owner_id,
        ownerName: teamService.userName(row.owner_id),
        deletedAt: Number(row.deleted_at),
        deletedBy: row.deleted_by,
        deletedByName: row.deleted_by ? teamService.userName(row.deleted_by) : '',
        purgeAt: days > 0 ? Number(row.deleted_at) + days * DAY : null,
      }
      if (row.entity === 'customer') {
        item.cascadedTasks = Number(
          (
            db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ? AND deleted_at = ?').get(row.id, row.deleted_at) as unknown as {
              n: number
            }
          ).n,
        )
      }
      return item
    })
    return { items, total, retentionDays: days }
  },

  /**
   * 恢复；客户连同随它一起删除的任务一起恢复。
   * 客户恢复后再查一次重（删除期间可能新建了同一家公司），命中时在 duplicates 里返回，不阻止恢复。
   */
  restore(entityRaw: string, id: string): { entity: TrashEntity; id: string; restored: number; duplicates?: CustomerDuplicate[] } {
    const entity = parse(entityParam, entityRaw)
    requirePermission('data:write')
    const row = trashedRow(entity, id)
    const customerId = entity === 'customer' ? null : (row.customer_id as string | null)
    if (customerTrashed(customerId)) {
      throw new AppError(409, 'CUSTOMER_IN_TRASH', `所属客户也在回收站里，请先恢复客户`)
    }
    const restored = transaction(() => {
      let n = Number(db.prepare(`UPDATE ${TRASH_TABLES[entity]} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(id).changes)
      if (entity === 'customer') {
        n += Number(
          db.prepare('UPDATE tasks SET deleted_at = NULL, deleted_by = NULL WHERE customer_id = ? AND deleted_at = ?').run(id, row.deleted_at).changes,
        )
      }
      return n
    })
    auditService.record({
      action: `${entity}.restore`,
      entityType: entity,
      entityId: id,
      summary: `从回收站恢复${TRASH_LABELS[entity]}「${titleOf(entity, row)}」`,
    })
    if (entity !== 'customer') return { entity, id, restored }
    const contacts = db.prepare('SELECT email, phone, whatsapp FROM contacts WHERE customer_id = ?').all(id) as unknown as Array<{
      email: string | null
      phone: string | null
      whatsapp: string | null
    }>
    const duplicates = customerService.findDuplicates(
      {
        company: String(row.company ?? ''),
        website: String(row.website ?? ''),
        contacts: contacts.map((c) => ({ email: c.email ?? '', phone: c.phone ?? '', whatsapp: c.whatsapp ?? '' })),
      },
      id,
    )
    return { entity, id, restored, ...(duplicates.length ? { duplicates } : {}) }
  },

  /** 彻底删除（不可恢复）：对应的 *:delete；团队服务器模式下仅 owner / admin */
  purge(entityRaw: string, id: string): void {
    const entity = parse(entityParam, entityRaw)
    requireDelete(TRASH_DELETE_PERMISSION[entity])
    if (isServerMode() && !seesAll()) throw new AppError(403, 'FORBIDDEN', '只有 owner / admin 可以彻底删除回收站里的记录')
    const row = trashedRow(entity, id)
    transaction(() => {
      if (entity === 'customer') assertCustomerPurgeable(id)
      hardDelete(entity, id)
    })
    auditService.record({
      action: `${entity}.purge`,
      entityType: entity,
      entityId: id,
      summary: `彻底删除回收站里的${TRASH_LABELS[entity]}「${titleOf(entity, row)}」`,
    })
  },

  /**
   * 自动清理超过保留天数的记录（全部组织）。先清子记录（任务、报价、商机、订单）再清客户；
   * 客户名下还有没到期的回收站记录时跳过，等下次。
   */
  autoPurge(now = Date.now()): number {
    const days = retentionDays()
    if (days <= 0) return 0
    const cutoff = now - days * DAY
    let purged = 0
    for (const entity of ['task', 'quote', 'deal', 'order', 'prospect', 'customer'] as TrashEntity[]) {
      // 按 id 游标分批取，循环到取完：被跳过的记录（客户名下还有没到期的记录）不会让后面的永远轮不到
      let cursor = ''
      for (;;) {
        const rows = db
          .prepare(`SELECT * FROM ${TRASH_TABLES[entity]} WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND id > ? ORDER BY id LIMIT ?`)
          .all(cutoff, cursor, PURGE_BATCH) as unknown as Array<Record<string, unknown> & { id: string; org_id: string }>
        if (rows.length === 0) break
        cursor = rows[rows.length - 1]!.id
        for (const row of rows) {
          try {
            transaction(() => {
              if (entity === 'customer') assertCustomerPurgeable(row.id)
              hardDelete(entity, row.id)
            })
          } catch (error) {
            if (error instanceof AppError) continue
            throw error
          }
          purged += 1
          auditService.record({
            action: `${entity}.purge`,
            entityType: entity,
            entityId: row.id,
            summary: `回收站超过 ${days} 天，自动彻底删除${TRASH_LABELS[entity]}「${titleOf(entity, row)}」`,
            actor: null,
            orgId: row.org_id,
          })
        }
        if (rows.length < PURGE_BATCH) break
      }
    }
    return purged
  },
}

let purgeTimer: NodeJS.Timeout | null = null
/** 启动后先清一次，之后每小时一次 */
export const trashPurger = {
  start(): void {
    if (purgeTimer) return
    const run = () => {
      try {
        trashService.autoPurge()
      } catch (error) {
        console.warn('[lulux-eta] trash auto-purge failed:', error instanceof Error ? error.message : String(error))
      }
    }
    run()
    purgeTimer = setInterval(run, 3_600_000)
    purgeTimer.unref()
  },
  stop(): void {
    if (purgeTimer) clearInterval(purgeTimer)
    purgeTimer = null
  },
}
