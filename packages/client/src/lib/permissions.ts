/**
 * 会话权限级别（契约 §6.11）：read 仅可查看 / ask 需审批 / full 完全权限。
 * 会话保存的级别为 null 时跟随全局默认；团队服务器模式下管理员设的上限会把级别截断。
 */
export type PermissionLevel = 'read' | 'ask' | 'full'
export const PERMISSION_LEVELS: PermissionLevel[] = ['read', 'ask', 'full']

/** ask 级别下 CLI 内核自带工具的审批方式：card = LULUX 审批卡片；readonly = 只能退回仅可查看 */
export type KernelAskSupport = 'card' | 'readonly'

export interface PermissionInfo {
  levels: PermissionLevel[]
  defaultLevel: PermissionLevel
  /** 当前用户的上限（desktop 恒为 full） */
  cap: PermissionLevel
  capsEnabled: boolean
  kernels: Record<string, { ask: KernelAskSupport }>
}

const RANK: Record<PermissionLevel, number> = { read: 0, ask: 1, full: 2 }

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'read' || value === 'ask' || value === 'full'
}

export function levelAllowed(level: PermissionLevel, cap: PermissionLevel): boolean {
  return RANK[level] <= RANK[cap]
}

export function clampLevel(level: PermissionLevel, cap: PermissionLevel): PermissionLevel {
  return levelAllowed(level, cap) ? level : cap
}

/** 旧设置 toolApproval → 默认级别（旧服务端没有 defaultPermissionLevel 时用） */
export function defaultLevelFromSettings(settings: Record<string, string>): PermissionLevel {
  const value = settings.defaultPermissionLevel
  if (isPermissionLevel(value)) return value
  return settings.toolApproval === 'auto' ? 'full' : 'ask'
}

/** 会话实际生效的级别：保存的级别（或默认）按上限截断 */
export function effectiveLevel(
  stored: PermissionLevel | null | undefined,
  defaultLevel: PermissionLevel,
  cap: PermissionLevel = 'full',
): PermissionLevel {
  return clampLevel(stored ?? defaultLevel, cap)
}

/** 选择器图标 */
export const LEVEL_ICON: Record<PermissionLevel, string> = { read: 'eye', ask: 'hand', full: 'zap' }

/**
 * ask 级别下只能退回仅可查看的 CLI 内核（选择器里给出提示）。
 * agents 是会话成员（kind / kernelId），kernels 来自 GET /api/permissions。
 */
export function readonlyAskKernels(
  agents: Array<{ kind?: string; kernelId?: string | null; name: string }>,
  kernels: PermissionInfo['kernels'] | undefined,
): string[] {
  return agents
    .filter((agent) => agent.kind === 'kernel' && agent.kernelId && kernels?.[agent.kernelId]?.ask === 'readonly')
    .map((agent) => agent.name)
}
