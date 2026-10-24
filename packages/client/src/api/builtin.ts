import { request } from './http'

/* 契约 §6：内置内核（persona Agent 的 agent 循环）配套接口 */

export interface PendingToolRequest {
  requestId: string
  sessionId: string
  agentId: string
  name: string
  server: string
  arguments: string
  risk: 'read' | 'write'
  builtin: boolean
  toolKey: string
  /** 审批卡片类型（skill_script / skill_install / skill_write / mcp_add|update|remove；普通工具为 tool） */
  approvalKind?: string
  detail?: unknown
  /** false 时不提供“本会话始终允许” */
  canRemember?: boolean
  createdAt: number
  expiresAt: number
}

export interface ChatPending {
  running: boolean
  requests: PendingToolRequest[]
  allowedTools: string[]
}

export interface SessionContext {
  customerId: string | null
  quoteId: string | null
}

export function stopChat(sessionId: string): Promise<{ stopped: boolean }> {
  return request('/api/chat/stop', { method: 'POST', body: { sessionId }, silent: true })
}

export function getChatPending(sessionId: string): Promise<ChatPending> {
  return request('/api/chat/pending', { query: { sessionId }, silent: true })
}

export function getSessionContext(sessionId: string): Promise<SessionContext> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/context`, { silent: true })
}

export function putSessionContext(sessionId: string, context: SessionContext): Promise<SessionContext> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/context`, { method: 'PUT', body: context })
}

export function exportSessionMarkdown(
  sessionId: string,
  options: { reasoning?: boolean; tools?: boolean; usage?: boolean } = {},
): Promise<string> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/export`, {
    query: {
      format: 'markdown',
      reasoning: options.reasoning ? 1 : undefined,
      tools: options.tools ? 1 : undefined,
      usage: options.usage ? 1 : undefined,
    },
    text: true,
  })
}

export function messageMarkdown(sessionId: string, messageId: string, full = false): Promise<string> {
  return request(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/markdown`,
    { query: { full: full ? 1 : undefined }, text: true },
  )
}

/* ── 用量（§6.7） ── */

export type UsageGroupBy = 'day' | 'model' | 'provider' | 'session' | 'agent' | 'purpose' | 'member'
export type UsagePurpose = 'chat' | 'continuation' | 'compaction' | 'title' | 'completion' | 'memory'

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCalls: number
  cost: Record<string, number>
  unpricedCalls: number
}

export interface UsageSummary {
  totals: UsageTotals
  groups: Array<UsageTotals & { key: string; label: string }>
}

export interface UsageRecord {
  id: string
  sessionId: string | null
  messageId: string | null
  agentId: string | null
  providerId: string | null
  providerName: string | null
  model: string
  purpose: UsagePurpose
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimated: boolean
  cost: number | null
  currency: string | null
  ownerId: string | null
  createdAt: number
}

export interface UsageFilter {
  from?: number
  to?: number
  sessionId?: string
  providerId?: string
  model?: string
  agentId?: string
  purpose?: string
  scope?: 'all'
}

export function getUsage(filter: UsageFilter, groupBy?: UsageGroupBy): Promise<UsageSummary> {
  return request('/api/usage', {
    query: { ...filter, groupBy, tzOffsetMinutes: -new Date().getTimezoneOffset() },
  })
}

export function getUsageRecords(
  filter: UsageFilter,
  page = 1,
  pageSize = 50,
): Promise<{ items: UsageRecord[]; total: number }> {
  return request('/api/usage/records', { query: { ...filter, page, pageSize } })
}

/** 服务器日志诊断包（zip；只给所有者 / 管理员） */
export function downloadServerLogs(days = 3): Promise<Blob> {
  return request('/api/diagnostics/logs', { query: { days }, blob: true, silent: true })
}

/* ── 联网搜索（§6.6） ── */

export type SearchProviderId = 'none' | 'tavily' | 'brave' | 'searxng' | 'bing'

export interface SearchConfig {
  provider: SearchProviderId
  endpoint: string
  maxResults: number
  hasApiKey: boolean
  apiKeyPreview: string | null
  apiKeyError: string | null
  enabled: boolean
  providers: Array<{
    id: SearchProviderId
    name: string
    needsKey: boolean
    needsEndpoint: boolean
    defaultEndpoint: string
  }>
}

export function getSearchConfig(): Promise<SearchConfig> {
  return request('/api/chat/search-config', { silent: true })
}

export function putSearchConfig(input: {
  provider: SearchProviderId
  endpoint?: string
  apiKey?: string
  maxResults?: number
}): Promise<SearchConfig> {
  return request('/api/chat/search-config', { method: 'PUT', body: input })
}

/* ── 能力与工具 ── */

export interface ModelCapabilities {
  contextWindow: number
  maxOutput: number
  tools: boolean
  vision: boolean
  reasoning: 'none' | 'deepseek' | 'qwen' | 'openai' | 'anthropic'
  streamUsage: boolean
  temperature: boolean
}

export function getCapabilities(params: { providerId?: string; model?: string }): Promise<{
  model: string
  capabilities: ModelCapabilities
  price: Record<string, unknown> | null
}> {
  return request('/api/chat/capabilities', { query: params, silent: true })
}

export function listBuiltinTools(): Promise<{
  tools: Array<{
    name: string
    description: string
    risk: 'read' | 'write'
    group: 'business' | 'core' | 'skills' | 'config' | 'memory'
  }>
}> {
  return request('/api/chat/tools', { silent: true })
}
