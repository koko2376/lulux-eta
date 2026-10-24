import { ref } from 'vue'
import type { Permission, TrashEntity } from '../api'
import { t } from '../i18n'
import { auth, can, currentRole } from './session'

/**
 * 回收站的客户端辅助：保留天数（设置 trashRetentionDays，默认 30，0 = 不自动清理）、
 * 删除确认文案、按类型的彻底删除权限。服务端始终是最终裁决。
 */
export const DEFAULT_TRASH_RETENTION_DAYS = 30

/** 当前生效的保留天数；设置加载 / 保存后、回收站列表返回时更新 */
export const trashRetentionDays = ref(DEFAULT_TRASH_RETENTION_DAYS)

export function parseRetentionDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TRASH_RETENTION_DAYS
}

export function syncTrashRetention(settings: Record<string, string> | null | undefined): void {
  if (settings && 'trashRetentionDays' in settings)
    trashRetentionDays.value = parseRetentionDays(settings.trashRetentionDays)
}

/** 「将移入回收站，N 天内可恢复」；不自动清理时说可随时恢复 */
export function trashNotice(days = trashRetentionDays.value): string {
  return days > 0 ? t('trash.notice', { days }) : t('trash.noticeForever')
}

/** 删除确认文案：key 里的 {notice} 换成回收站说明 */
export function trashConfirmMessage(key: string, days = trashRetentionDays.value): string {
  return t(key, { notice: trashNotice(days) })
}

export const TRASH_DELETE_PERMISSION: Record<TrashEntity, Permission> = {
  customer: 'customer:delete',
  quote: 'quote:delete',
  deal: 'deal:delete',
  order: 'order:delete',
  task: 'task:delete',
}

/** 彻底删除：需要对应的 *:delete；团队服务器模式下只有 owner / admin */
export function canPurge(entity: TrashEntity): boolean {
  if (!can(TRASH_DELETE_PERMISSION[entity])) return false
  if (auth.mode !== 'server') return true
  return currentRole.value === 'owner' || currentRole.value === 'admin'
}

/** 恢复：需要 data:write（服务端再校验负责人 / 删除人） */
export function canRestore(): boolean {
  return can('data:write')
}
