import { db } from '../db.js'
import { currentActor } from '../context.js'
import type { Permission } from '../security/access.js'
import { auditService } from './audit-service.js'

/**
 * 回收站（软删除）的底层操作：各业务服务的 remove() 调用 mark() 打上 deleted_at / deleted_by，
 * 再用 audit() 记一条带删除前快照的审计。不依赖业务服务，避免循环引用。
 */
export const TRASH_TABLES = {
  customer: 'customers',
  quote: 'quotes',
  deal: 'deals',
  order: 'orders',
  task: 'tasks',
  prospect: 'prospects',
} as const
export type TrashEntity = keyof typeof TRASH_TABLES
export const TRASH_ENTITIES = Object.keys(TRASH_TABLES) as TrashEntity[]

/** 潜客复用客户的删除权限（不单列 prospect:delete，避免权限清单与默认角色大改） */
export const TRASH_DELETE_PERMISSION: Record<TrashEntity, Permission> = {
  customer: 'customer:delete',
  quote: 'quote:delete',
  deal: 'deal:delete',
  order: 'order:delete',
  task: 'task:delete',
  prospect: 'customer:delete',
}

export const TRASH_LABELS: Record<TrashEntity, string> = {
  customer: '客户',
  quote: '报价单',
  deal: '商机',
  order: '订单',
  task: '任务',
  prospect: '潜客',
}

export const trash = {
  /** 标记删除；返回删除时间，行不存在或已在回收站时返回 null */
  mark(entity: TrashEntity, id: string, at = Date.now()): number | null {
    const result = db
      .prepare(`UPDATE ${TRASH_TABLES[entity]} SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(at, currentActor().id || null, id)
    return Number(result.changes) > 0 ? at : null
  },

  /** 删除审计：action 为 `<entity>.delete`，meta.snapshot 为删除前的完整记录 */
  audit(entity: TrashEntity, id: string, summary: string, snapshot: unknown): void {
    auditService.record({
      action: `${entity}.delete`,
      entityType: entity,
      entityId: id,
      summary,
      meta: { trashed: true, snapshot },
    })
  },
}
