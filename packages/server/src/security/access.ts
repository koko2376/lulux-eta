import { config } from '../config.js'
import { currentActor, type Actor, type Role } from '../context.js'
import { AppError } from '../errors.js'

export type Permission =
  | 'data:read'
  | 'data:write'
  | 'data:export'
  | 'data:import'
  | 'customer:delete'
  | 'customer:import'
  | 'deal:delete'
  | 'quote:delete'
  | 'order:delete'
  | 'task:delete'
  | 'workflow:manage'
  | 'catalog:write'
  | 'settings:write'
  | 'providers:write'
  | 'members:manage'
  | 'audit:read'
  | 'email:send'
  | 'security:manage'

export const ALL_PERMISSIONS: Permission[] = [
  'data:read',
  'data:write',
  'data:export',
  'data:import',
  'customer:delete',
  'customer:import',
  'deal:delete',
  'quote:delete',
  'order:delete',
  'task:delete',
  'workflow:manage',
  'catalog:write',
  'settings:write',
  'providers:write',
  'members:manage',
  'audit:read',
  'email:send',
  'security:manage',
]

/** 契约 5.5 权限矩阵（角色默认值；server 模式下可按账号再授予 / 收回，见 OVERRIDABLE_PERMISSIONS） */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== 'security:manage'),
  member: [
    'data:read',
    'data:write',
    'catalog:write',
    'email:send',
    'customer:delete',
    'customer:import',
    'deal:delete',
    'quote:delete',
    'order:delete',
    'task:delete',
    'workflow:manage',
  ],
  viewer: ['data:read'],
}

/**
 * 可以按账号单独授予 / 收回的权限（业务操作）。组织级权限（设置、模型、成员、审计、服务器安全）
 * 只跟随角色，不能单独授予。分组顺序即成员权限编辑器里的展示顺序。
 */
export const PERMISSION_GROUPS: Array<{ id: string; permissions: Permission[] }> = [
  { id: 'customer', permissions: ['data:write', 'customer:delete'] },
  { id: 'deal', permissions: ['deal:delete'] },
  { id: 'quote_order', permissions: ['quote:delete', 'order:delete'] },
  { id: 'task', permissions: ['task:delete'] },
  { id: 'data', permissions: ['customer:import', 'data:export'] },
  { id: 'email', permissions: ['email:send'] },
  { id: 'workflow', permissions: ['workflow:manage'] },
]

export const OVERRIDABLE_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((group) => group.permissions)

export const PERMISSION_LABELS: Record<Permission, string> = {
  'data:read': '读取数据',
  'data:write': '修改业务数据',
  'data:export': '导出数据',
  'data:import': '导入数据',
  'customer:delete': '删除客户',
  'customer:import': '导入客户',
  'deal:delete': '删除商机',
  'quote:delete': '删除报价单',
  'order:delete': '删除订单或收款记录',
  'task:delete': '删除任务',
  'workflow:manage': '管理工作流与定时任务',
  'catalog:write': '修改产品库',
  'settings:write': '修改组织设置',
  'providers:write': '管理模型与密钥',
  'members:manage': '管理成员',
  'audit:read': '查看审计日志',
  'email:send': '发送邮件',
  'security:manage': '管理服务器安全选项',
}

export function isServerMode(): boolean {
  return config.mode === 'server'
}

export type PermissionEffect = 'grant' | 'deny'
export type PermissionOverrides = Partial<Record<Permission, PermissionEffect>>

/**
 * 按账号的覆盖项来源（由 auth-service 注册，避免本模块直接依赖数据库）。
 * 结果按账号缓存；覆盖项变更时调用 invalidatePermissions()。
 */
let overrideLoader: ((userId: string) => PermissionOverrides) | null = null
const effectiveCache = new Map<string, { role: Role; permissions: Permission[] }>()

export function registerPermissionOverrideLoader(loader: (userId: string) => PermissionOverrides): void {
  overrideLoader = loader
  effectiveCache.clear()
}

export function invalidatePermissions(userId?: string): void {
  if (userId) effectiveCache.delete(userId)
  else effectiveCache.clear()
}

/** 角色默认值 ± 覆盖项。owner 恒为全部权限；不可覆盖的权限只跟随角色。 */
export function effectivePermissions(role: Role, overrides: PermissionOverrides): Permission[] {
  const base = ROLE_PERMISSIONS[role] ?? []
  if (role === 'owner') return [...base]
  const set = new Set(base)
  for (const permission of OVERRIDABLE_PERMISSIONS) {
    const effect = overrides[permission]
    if (effect === 'grant') set.add(permission)
    else if (effect === 'deny') set.delete(permission)
  }
  return ALL_PERMISSIONS.filter((permission) => set.has(permission))
}

export function permissionsOf(actor: Actor): Permission[] {
  const base = ROLE_PERMISSIONS[actor.role] ?? []
  // 本机用户 / 匿名上下文 / 本机模式：只看角色
  if (!isServerMode() || !overrideLoader || !actor.id || actor.id === 'local' || actor.role === 'owner') return base
  const cached = effectiveCache.get(actor.id)
  if (cached && cached.role === actor.role) return cached.permissions
  const permissions = effectivePermissions(actor.role, overrideLoader(actor.id))
  effectiveCache.set(actor.id, { role: actor.role, permissions })
  return permissions
}

export function can(permission: Permission, actor: Actor = currentActor()): boolean {
  return permissionsOf(actor).includes(permission)
}

export function currentRole(): Role {
  return currentActor().role
}

export function permissionDeniedMessage(permission: Permission): string {
  return `没有权限：${PERMISSION_LABELS[permission]}`
}

export function requirePermission(permission: Permission, actor: Actor = currentActor()): void {
  if (!can(permission, actor)) {
    throw new AppError(403, 'FORBIDDEN', permissionDeniedMessage(permission))
  }
}

/** 删除类操作：需要 data:write 与对应的 *:delete */
export function requireDelete(permission: Permission, actor: Actor = currentActor()): void {
  requirePermission('data:write', actor)
  requirePermission(permission, actor)
}

/** 第一个缺少的权限（没有缺少时为 null） */
export function missingPermission(permissions: readonly Permission[], actor: Actor = currentActor()): Permission | null {
  const have = permissionsOf(actor)
  return permissions.find((permission) => !have.includes(permission)) ?? null
}

export function seesAll(actor: Actor = currentActor()): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

export type Visibility = 'private' | 'team' | 'org'
export const VISIBILITIES: Visibility[] = ['private', 'team', 'org']

export interface OwnedRow {
  org_id: string
  owner_id: string
  visibility?: string | null
  team_id?: string | null
  /** 回收站：软删除时间；非空即视为不存在 */
  deleted_at?: number | null
}

/**
 * 行级可见性 SQL 片段（契约 5.6）。`alias` 为表别名；
 * 表没有 visibility 列时传 `shared=false`（只看 owner）。
 */
export function visibilityClause(
  alias: string,
  actor: Actor = currentActor(),
  shared = true,
): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : ''
  if (seesAll(actor)) return { sql: `${prefix}org_id = ?`, params: [actor.orgId] }
  if (!shared) return { sql: `(${prefix}org_id = ? AND ${prefix}owner_id = ?)`, params: [actor.orgId, actor.id] }
  const teamPart =
    actor.teamIds.length > 0
      ? ` OR (${prefix}visibility = 'team' AND ${prefix}team_id IN (${actor.teamIds.map(() => '?').join(',')}))`
      : ''
  return {
    sql: `(${prefix}org_id = ? AND (${prefix}owner_id = ? OR ${prefix}visibility = 'org'${teamPart}))`,
    params: [actor.orgId, actor.id, ...actor.teamIds],
  }
}

/** 同 visibilityClause，并排除回收站里的行（deleted_at 非空） */
export function liveClause(alias: string, actor: Actor = currentActor(), shared = true): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : ''
  const scope = visibilityClause(alias, actor, shared)
  return { sql: `(${scope.sql} AND ${prefix}deleted_at IS NULL)`, params: scope.params }
}

export function canSee(row: OwnedRow, actor: Actor = currentActor()): boolean {
  if (row.deleted_at) return false
  if (row.org_id !== actor.orgId) return false
  if (seesAll(actor)) return true
  if (row.owner_id === actor.id) return true
  if (row.visibility === 'org') return true
  return row.visibility === 'team' && !!row.team_id && actor.teamIds.includes(row.team_id)
}

/** 可写：admin/owner 全部；member 只写自己的；viewer 不可写 */
export function canModify(row: OwnedRow, actor: Actor = currentActor()): boolean {
  if (row.deleted_at) return false
  if (!can('data:write', actor)) return false
  if (row.org_id !== actor.orgId) return false
  return seesAll(actor) || row.owner_id === actor.id
}

export function assertCanModify(row: OwnedRow, what: string, actor: Actor = currentActor()): void {
  requirePermission('data:write', actor)
  if (!canModify(row, actor)) {
    throw new AppError(403, 'FORBIDDEN', `只能修改自己负责的${what}`)
  }
}

/** 新建行的归属；body 里的 visibility / teamId 需校验 */
export function ownershipForNew(
  input: { visibility?: Visibility; teamId?: string | null },
  actor: Actor = currentActor(),
): { orgId: string; ownerId: string; visibility: Visibility; teamId: string | null } {
  const visibility = input.visibility ?? 'private'
  let teamId = input.teamId === undefined ? (actor.teamIds[0] ?? null) : input.teamId
  if (teamId && !seesAll(actor) && !actor.teamIds.includes(teamId)) {
    throw new AppError(400, 'VALIDATION_ERROR', '只能共享给自己所在的团队')
  }
  if (visibility === 'team' && !teamId) {
    throw new AppError(400, 'VALIDATION_ERROR', '共享给团队时必须指定团队（teamId）')
  }
  if (visibility !== 'team' && input.teamId === undefined) teamId = actor.teamIds[0] ?? null
  return { orgId: actor.orgId, ownerId: actor.id, visibility, teamId }
}

/**
 * 仅本人（会话 / 工作流 / 定时任务，契约 §5.6a）：只有负责人自己可见可改，admin/owner 也不例外，
 * 不支持 team / org 共享。
 */
export function ownerOnlyClause(alias: string, actor: Actor = currentActor()): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : ''
  return { sql: `(${prefix}org_id = ? AND ${prefix}owner_id = ?)`, params: [actor.orgId, actor.id] }
}

export function isOwnRow(row: OwnedRow, actor: Actor = currentActor()): boolean {
  return row.org_id === actor.orgId && row.owner_id === actor.id
}

/** 仅本人可写：需要 data:write 且是负责人 */
export function assertOwnRow(row: OwnedRow, what: string, actor: Actor = currentActor()): void {
  requirePermission('data:write', actor)
  if (!isOwnRow(row, actor)) throw new AppError(403, 'FORBIDDEN', `只能修改自己的${what}`)
}
