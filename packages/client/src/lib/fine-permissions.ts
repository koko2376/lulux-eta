import type { Permission, PermissionEffect, PermissionOverrides, Role } from '../api'

/**
 * 按账号的细粒度权限（团队服务器）：角色默认值 ± 管理员设置的覆盖项。
 * 与服务端 security/access.ts 的 ROLE_PERMISSIONS / PERMISSION_GROUPS 保持一致；
 * 服务端始终是最终裁决（403），这里只用于编辑器展示与按钮状态。
 */
export type PermissionGroupId = 'customer' | 'deal' | 'quote_order' | 'task' | 'data' | 'email' | 'workflow'

export const PERMISSION_GROUPS: Array<{ id: PermissionGroupId; permissions: Permission[] }> = [
  { id: 'customer', permissions: ['data:write', 'customer:delete'] },
  { id: 'deal', permissions: ['deal:delete'] },
  { id: 'quote_order', permissions: ['quote:delete', 'order:delete'] },
  { id: 'task', permissions: ['task:delete'] },
  { id: 'data', permissions: ['customer:import', 'data:export'] },
  { id: 'email', permissions: ['email:send'] },
  { id: 'workflow', permissions: ['workflow:manage'] },
]

export const OVERRIDABLE_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.permissions)

const MEMBER_DEFAULTS: Permission[] = [
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
]

/** 只列出可覆盖的业务权限的角色默认值（owner / admin 全部有） */
export function roleDefault(role: Role, permission: Permission): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (role === 'member') return MEMBER_DEFAULTS.includes(permission)
  return permission === 'data:read'
}

/** 某权限在覆盖项作用下是否生效（owner 恒为全部） */
export function effectiveAllowed(
  role: Role,
  overrides: PermissionOverrides | undefined,
  permission: Permission,
): boolean {
  if (role === 'owner') return true
  const effect = overrides?.[permission]
  if (effect === 'grant') return true
  if (effect === 'deny') return false
  return roleDefault(role, permission)
}

/** 勾选 / 取消后新的覆盖项：与角色默认值相同就去掉覆盖项，不同就记 grant / deny */
export function toggleOverride(
  role: Role,
  overrides: PermissionOverrides | undefined,
  permission: Permission,
  allowed: boolean,
): PermissionOverrides {
  const next: PermissionOverrides = { ...(overrides ?? {}) }
  if (allowed === roleDefault(role, permission)) delete next[permission]
  else next[permission] = (allowed ? 'grant' : 'deny') as PermissionEffect
  return next
}

/** 删除类权限对应的 *:delete；删除操作同时需要 data:write */
export type DeletePermission = 'customer:delete' | 'deal:delete' | 'quote:delete' | 'order:delete' | 'task:delete'
