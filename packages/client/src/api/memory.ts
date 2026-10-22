/**
 * 长期记忆（docs/API-CONTRACT.md §6.12）：每个账号自己的「用户画像」与「记忆」。
 * 所有接口只读写当前登录账号的记忆。
 */
import { request } from './http'

export type MemorySection = 'profile' | 'notes'
export type MemorySource = 'user' | 'agent' | 'auto' | 'import'

export interface MemoryEntry {
  id: string
  section: MemorySection
  content: string
  source: MemorySource
  sourceSessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface MemorySectionState {
  entries: MemoryEntry[]
  used: number
  limit: number
}

export interface MemoryState {
  enabled: boolean
  autoExtract: boolean
  /** 群聊中使用我的记忆（默认关）：多人群聊里也把我的记忆放进系统提示；群聊里始终不提供记忆工具 */
  groupMemory: boolean
  entryMax: number
  profile: MemorySectionState
  notes: MemorySectionState
}

/** 记忆工具名（内置内核与 LULUX MCP 共用）：对话里据此显示“已更新记忆” */
export const MEMORY_TOOL_NAMES = ['memory_add', 'memory_replace', 'memory_remove'] as const

export function isMemoryTool(name: string | null | undefined): boolean {
  return Boolean(name) && (MEMORY_TOOL_NAMES as readonly string[]).includes(name as string)
}

export function getMemory(): Promise<MemoryState> {
  return request<MemoryState>('/api/memory')
}

export function updateMemorySettings(patch: {
  enabled?: boolean
  autoExtract?: boolean
  groupMemory?: boolean
}): Promise<MemoryState> {
  return request<MemoryState>('/api/memory/settings', { method: 'PATCH', body: patch })
}

export function addMemoryEntry(
  section: MemorySection,
  content: string,
): Promise<{ entry: MemoryEntry; duplicate: boolean }> {
  return request('/api/memory/entries', { method: 'POST', body: { section, content } })
}

export function updateMemoryEntry(id: string, content: string): Promise<{ entry: MemoryEntry }> {
  return request(`/api/memory/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body: { content } })
}

export async function deleteMemoryEntry(id: string): Promise<void> {
  await request(`/api/memory/entries/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function clearMemory(section?: MemorySection): Promise<{ removed: number }> {
  return request('/api/memory', { method: 'DELETE', query: { section } })
}
