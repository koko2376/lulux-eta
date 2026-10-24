import type { Actor } from '../../context.js'
import { db } from '../../db.js'
import { isNonInteractive } from '../tool-approval.js'
import { memoryService } from './memory-service.js'

/**
 * 记忆在某个会话里能不能用：
 * - 多人群聊（≥2 个真人：群主 + 群成员 + 曾经发过言的人）：不提供 memory_* 工具（别人可以借提示注入写 / 删 / 套取你的记忆）；
 *   默认也不注入记忆快照，除非发言人在设置里打开了“群聊中使用我的记忆”；不做自动提取。
 * - 自动化会话（非交互运行：工作流 / 定时任务；或持久化来源 origin ≠ chat、工作流隐藏会话）：不提供 memory_* 工具、不自动提取。
 *   这两种运行正是处理不可信内容（网页、邮件、第三方 MCP）的地方，不能留下长期生效的写入。
 * 用户自己在设置页 / REST 管理记忆不受这里限制。
 */

export type SessionOrigin = 'chat' | 'schedule' | 'workflow'

interface SessionRow {
  owner_id: string
  origin: string | null
  workflow_run_id: string | null
}

function sessionRow(sessionId: string): SessionRow | undefined {
  return db.prepare('SELECT owner_id, origin, workflow_run_id FROM sessions WHERE id = ?').get(sessionId) as unknown as SessionRow | undefined
}

/** 会话里的真人：群主 + session_participants + 发过用户消息的人（已退群的也算，他留下的消息还在上下文里） */
export function sessionHumans(sessionId: string): string[] {
  const row = sessionRow(sessionId)
  if (!row) return []
  const ids = new Set<string>([row.owner_id])
  for (const item of db.prepare('SELECT user_id FROM session_participants WHERE session_id = ?').all(sessionId) as unknown as Array<{
    user_id: string
  }>)
    ids.add(item.user_id)
  for (const item of db
    .prepare("SELECT DISTINCT sender_user_id FROM messages WHERE session_id = ? AND role = 'user' AND sender_user_id IS NOT NULL")
    .all(sessionId) as unknown as Array<{ sender_user_id: string }>)
    ids.add(item.sender_user_id)
  return [...ids].filter(Boolean)
}

export function isMultiHumanSession(sessionId: string): boolean {
  return sessionHumans(sessionId).length >= 2
}

export function sessionOrigin(sessionId: string): SessionOrigin {
  const row = sessionRow(sessionId)
  if (row?.workflow_run_id) return 'workflow'
  return row?.origin === 'schedule' || row?.origin === 'workflow' ? row.origin : 'chat'
}

export function setSessionOrigin(sessionId: string, origin: SessionOrigin): void {
  db.prepare('UPDATE sessions SET origin = ? WHERE id = ?').run(origin, sessionId)
}

/** 工作流 / 定时任务：当前正在非交互运行，或会话本身就是自动化产生的 */
export function isAutomatedSession(sessionId: string): boolean {
  return isNonInteractive(sessionId) || sessionOrigin(sessionId) !== 'chat'
}

export const MEMORY_TOOLS_GROUP_REFUSAL = '多人群聊里不能使用记忆工具（群里其他人的消息可能诱导修改你的记忆）。如需记住什么，请在单聊里说，或到“设置 → 记忆”里添加。'
export const MEMORY_TOOLS_AUTOMATION_REFUSAL = '工作流 / 定时任务等非交互运行里不能修改长期记忆。'

/** memory_* 工具在这个会话里被禁用的原因；null = 不禁用（权限级别另由 toolGate 判断） */
export function memoryToolsBlocked(sessionId: string): string | null {
  if (isAutomatedSession(sessionId)) return MEMORY_TOOLS_AUTOMATION_REFUSAL
  if (isMultiHumanSession(sessionId)) return MEMORY_TOOLS_GROUP_REFUSAL
  return null
}

/**
 * 系统提示里用的记忆快照：多人群聊里只有发言人打开了“群聊中使用我的记忆”才注入。
 * group=true 时调用方在提示里补一句“只用于理解当前发言人，不要在群里复述原文”。
 */
export function sessionMemorySnapshot(sessionId: string, actor?: Actor): { snapshot: string; group: boolean } {
  if (isMultiHumanSession(sessionId)) {
    if (!memoryService.prefs(actor).groupMemory) return { snapshot: '', group: true }
    return { snapshot: memoryService.snapshot(sessionId, actor), group: true }
  }
  return { snapshot: memoryService.snapshot(sessionId, actor), group: false }
}
