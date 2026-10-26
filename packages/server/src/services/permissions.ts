import { z } from 'zod'
import { config } from '../config.js'
import { currentActor, ROLES, type Actor, type Role } from '../context.js'
import { db } from '../db.js'
import { AppError } from '../errors.js'
import { parse } from '../validation.js'
import { auditService } from './audit-service.js'
import { settingsService } from './settings-service.js'

/**
 * 会话权限级别（契约 §6.11）：
 * - read（仅可查看）：不提供任何写 / 执行类工具，从不弹审批；
 * - ask（需审批）：写 / 执行类工具先弹审批卡片（“本会话始终允许”照常可用）；
 * - full（完全权限）：直接调用工具不再询问——唯一的例外是“组织级”的配置变更
 *   （mcp_add / mcp_update / mcp_remove：改动全组织共享的 MCP 配置、在主机上启动任意命令），
 *   这类操作在 full 下仍逐次确认。其他 approval='always' 的工具（run_skill_script、skill_install、
 *   skill_create、skill_update）在 full 下直接执行。
 *
 * 级别按会话保存（sessions.permission_level，迁移 20）；NULL 表示跟随全局默认
 * defaultPermissionLevel（旧设置 toolApproval：ask → ask，auto → full）。
 * 团队服务器模式下管理员可按角色 / 成员设上限（app_meta permission.caps.<orgId>），服务端一律按上限截断。
 */
export type PermissionLevel = 'read' | 'ask' | 'full'
export const PERMISSION_LEVELS: PermissionLevel[] = ['read', 'ask', 'full']

const RANK: Record<PermissionLevel, number> = { read: 0, ask: 1, full: 2 }

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'read' || value === 'ask' || value === 'full'
}

export function levelRank(level: PermissionLevel): number {
  return RANK[level]
}

/** 取最严格（最低）的级别 */
export function minLevel(...levels: PermissionLevel[]): PermissionLevel {
  return levels.reduce((low, level) => (RANK[level] < RANK[low] ? level : low), 'full' as PermissionLevel)
}

/** 旧设置 toolApproval 的值 → 权限级别 */
export function levelFromToolApproval(value: string | undefined | null): PermissionLevel {
  return value === 'auto' ? 'full' : 'ask'
}

/** 权限级别 → 旧设置 toolApproval（兼容旧客户端读取；read 也记为 ask） */
export function toolApprovalFromLevel(level: PermissionLevel): 'ask' | 'auto' {
  return level === 'full' ? 'auto' : 'ask'
}

/** 新会话的默认级别（设置 defaultPermissionLevel） */
export function defaultPermissionLevel(): PermissionLevel {
  const value = settingsService.get('defaultPermissionLevel')
  return isPermissionLevel(value) ? value : 'ask'
}

/* ── 团队上限（server 模式） ───────────────────────────── */

export interface PermissionCaps {
  /** 按角色的上限；owner 恒为 full（避免把自己锁死），不可修改 */
  roles: Record<Role, PermissionLevel>
  /** 按成员覆盖（userId → 上限）；优先于角色 */
  members: Record<string, PermissionLevel>
}

export const DEFAULT_CAPS: PermissionCaps = {
  roles: { owner: 'full', admin: 'full', member: 'full', viewer: 'read' },
  members: {},
}

function capsKey(orgId: string): string {
  return `permission.caps.${orgId}`
}

function readMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeMeta(key: string, value: string): void {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

function normalizeCaps(raw: unknown): PermissionCaps {
  const caps: PermissionCaps = { roles: { ...DEFAULT_CAPS.roles }, members: {} }
  if (!raw || typeof raw !== 'object') return caps
  const value = raw as { roles?: Record<string, unknown>; members?: Record<string, unknown> }
  for (const role of ROLES) {
    const level = value.roles?.[role]
    if (role !== 'owner' && isPermissionLevel(level)) caps.roles[role] = level
  }
  for (const [userId, level] of Object.entries(value.members ?? {})) {
    if (isPermissionLevel(level)) caps.members[userId] = level
  }
  return caps
}

const levelSchema = z.enum(['read', 'ask', 'full'])

const capsPatch = z
  .object({
    roles: z
      .object({ admin: levelSchema, member: levelSchema, viewer: levelSchema })
      .partial()
      .strict()
      .optional(),
    /** userId → 上限；null 删除覆盖（回到角色上限） */
    members: z.record(z.string().min(1).max(80), z.enum(['read', 'ask', 'full']).nullable()).optional(),
  })
  .strict()

export const permissionCaps = {
  /** desktop 模式没有上限 */
  enabled(): boolean {
    return config.mode === 'server'
  },

  get(orgId: string = currentActor().orgId): PermissionCaps {
    const raw = readMeta(capsKey(orgId))
    if (!raw) return normalizeCaps(null)
    try {
      return normalizeCaps(JSON.parse(raw))
    } catch {
      return normalizeCaps(null)
    }
  },

  update(input: unknown, actor: Actor = currentActor()): PermissionCaps {
    const data = parse(capsPatch, input)
    const caps = permissionCaps.get(actor.orgId)
    for (const [role, level] of Object.entries(data.roles ?? {})) if (level) caps.roles[role as Role] = level
    for (const [userId, level] of Object.entries(data.members ?? {})) {
      if (level === null) delete caps.members[userId]
      else caps.members[userId] = level
    }
    writeMeta(capsKey(actor.orgId), JSON.stringify(caps))
    auditService.record({ action: 'permission.caps', entityType: 'org', entityId: actor.orgId, summary: '修改成员权限上限', meta: { ...data } })
    return caps
  },

  /** 某个操作者的上限：desktop 模式恒为 full；owner 恒为 full */
  capFor(actor: Actor = currentActor()): PermissionLevel {
    if (!permissionCaps.enabled() || actor.role === 'owner') return 'full'
    const caps = permissionCaps.get(actor.orgId)
    return caps.members[actor.id] ?? caps.roles[actor.role] ?? 'full'
  },

  /** 按用户 id 求上限（会话 / 工作流的归属人）；找不到用户时不额外限制 */
  capForUser(userId: string, orgId: string): PermissionLevel {
    if (!permissionCaps.enabled() || userId === 'local') return 'full'
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined
    if (!row) return 'full'
    const role = (ROLES as string[]).includes(row.role) ? (row.role as Role) : 'member'
    if (role === 'owner') return 'full'
    const caps = permissionCaps.get(orgId)
    return caps.members[userId] ?? caps.roles[role] ?? 'full'
  },
}

/** 请求的级别超过上限：403 PERMISSION_LEVEL_EXCEEDED */
export function assertWithinCap(level: PermissionLevel, actor: Actor = currentActor()): void {
  const cap = permissionCaps.capFor(actor)
  if (RANK[level] > RANK[cap]) {
    throw new AppError(403, 'PERMISSION_LEVEL_EXCEEDED', `管理员限制你最高只能使用“${LEVEL_LABEL[cap]}”权限`)
  }
}

export const LEVEL_LABEL: Record<PermissionLevel, string> = { read: '仅可查看', ask: '需审批', full: '完全权限' }

/* ── 会话的有效级别 ───────────────────────────────────── */

/** 会话保存的级别（NULL = 跟随默认）；会话不存在时为 null */
export function storedSessionLevel(sessionId: string): PermissionLevel | null {
  const row = db.prepare('SELECT permission_level FROM sessions WHERE id = ?').get(sessionId) as { permission_level: string | null } | undefined
  return isPermissionLevel(row?.permission_level) ? row.permission_level : null
}

/**
 * 运行时生效的级别 = min(会话级别或默认, 当前操作者上限, 会话归属人上限)。
 * 群聊里同一个级别作用于群里全部 Agent。
 */
export function effectiveSessionLevel(sessionId: string, actor: Actor = currentActor()): PermissionLevel {
  const row = db.prepare('SELECT permission_level, owner_id, org_id FROM sessions WHERE id = ?').get(sessionId) as
    | { permission_level: string | null; owner_id: string; org_id: string }
    | undefined
  const chosen = isPermissionLevel(row?.permission_level) ? row.permission_level : defaultPermissionLevel()
  const owner = row ? permissionCaps.capForUser(row.owner_id, row.org_id) : 'full'
  return minLevel(chosen, permissionCaps.capFor(actor), owner)
}

/* ── 工具闸门 ─────────────────────────────────────────── */

export interface GatedTool {
  risk: 'read' | 'write'
  /** 'never'：从不审批（记忆工具，契约 §6.12） */
  approval?: 'always' | 'never'
  /** 组织级配置变更：full 下也逐次确认 */
  orgLevel?: boolean
  /** 账号个人数据（记忆）：只豁免 RBAC 的 data:write（viewer 也能用）；“仅可查看”级别下照样隐藏，其他级别直接执行 */
  personal?: boolean
  /** 会向外部网络发请求（抓网页、搜索、浏览器导航）：查询串 / 地址里能带出工作区数据，“仅可查看”下不提供 */
  egress?: boolean
}

/**
 * 某级别下一个工具的处理方式：
 * - hidden：不提供给模型；万一被调用直接拒绝（不弹卡片）
 * - auto：直接执行
 * - ask：弹审批卡片（ask 级别下“本会话始终允许”的工具由调用方转成 auto）
 */
export type ToolGate = 'hidden' | 'auto' | 'ask'

export function toolGate(level: PermissionLevel, tool: GatedTool): ToolGate {
  // “仅可查看”用来处理不可信内容：被注入的提示可以先读出客户 / 邮件，再拼进 URL 发出去。
  // 只限制 GET 也挡不住查询串外带，所以这一级直接不提供任何外发网络的工具（更安全的选项）
  if (level === 'read' && tool.egress) return 'hidden'
  if (tool.risk === 'read') return 'auto'
  // “仅可查看”用来处理不可信内容：写工具一律不提供，记忆工具也不例外
  if (level === 'read') return 'hidden'
  // 记忆是账号自己的资料，不是业务数据 / 命令：从不弹卡片（契约 §6.12）
  if (tool.personal || tool.approval === 'never') return 'auto'
  if (level === 'ask') return 'ask'
  return tool.approval === 'always' && tool.orgLevel ? 'ask' : 'auto'
}

/**
 * 非交互运行（工作流节点 / 定时任务 / 由它们发起的群聊）里没有人能审批。approval='always' 的工具
 * （删除业务数据、解散群聊、增删改 MCP Server、安装 / 新建 / 修改技能、运行技能脚本、电脑操作）
 * 属于不可恢复或高风险操作：一律拒绝，不看节点的“允许写”，也不提供给模型。
 */
export function deniedUnattended(tool: GatedTool): boolean {
  return tool.approval === 'always'
}

export const UNATTENDED_REFUSAL =
  '这是不可恢复或高风险的操作（删除 / 解散 / 改动组织配置 / 安装或运行技能等），在没有人值守的运行（工作流、定时任务）里不会自动执行，即使节点打开了“允许写”。请在对话里手动发起，由用户确认。'

export const EGRESS_REFUSAL =
  '当前会话的权限是“仅可查看”，不能访问外部网络（抓取网页 / 搜索 / 浏览器导航），以免把工作区数据带出去。如需访问，请在输入框旁把权限切换为“需审批”或“完全权限”。'

export const READ_ONLY_REFUSAL = '当前会话的权限是“仅可查看”，不能执行写入或命令类工具。如需执行，请在输入框旁把权限切换为“需审批”或“完全权限”。'
