import type { Visibility } from './team'
import type { PermissionInfo, PermissionLevel } from '../lib/permissions'
import type { EffortLevel, ModelCatalog } from '../lib/models'
import { ApiError, apiUrl, authHeaders, localizeErrorMessage, parseErrorBody, reportApiError, request, unwrapList, unwrapOne } from './http'
import { labelled, t } from '../i18n'

export {
  ApiError,
  onApiError,
  onUnauthorized,
  onPasswordChangeRequired,
  request,
  buildUrl,
  parseErrorBody,
  apiUrl,
  setTransport,
  transport,
} from './http'
export * from './email'
export * from './team'
export * from './crm'
export * from './memory'
export * from './prospects'

/* ───────────────────────── 类型（docs/API-CONTRACT.md） ───────────────────────── */

export type ProviderKind = 'openai' | 'anthropic'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  /** 当前默认模型 */
  model: string
  /** 可用模型列表，默认模型一定在其中 */
  models: string[]
  createdAt: number
  hasApiKey: boolean
  /** 形如 "sk-…abcd"，服务端永不返回明文 */
  apiKeyPreview?: string | null
  /** 主密钥变化导致密钥无法解密时的中文提示；正常为 null */
  apiKeyError?: string | null
  /** 每个模型的思考强度：manual 手动设置（null = 自动检测）/ detected 上游元数据 / auto 自动检测结果 / effective 实际生效 */
  modelReasoning?: Record<string, ModelReasoning>
}

/** 思考强度类型：openai / anthropic / qwen 可分档；toggle 只能开关；fixed 始终思考；none 不支持 */
export type ReasoningChoice = 'openai' | 'anthropic' | 'qwen' | 'toggle' | 'fixed' | 'none'

export interface ModelReasoning {
  manual: ReasoningChoice | null
  detected: ReasoningChoice | null
  auto: ReasoningChoice
  effective: ReasoningChoice
}

export interface ProviderInput {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  model: string
  models: string[]
}

export interface Agent {
  id: string
  name: string
  description: string
  avatar: string
  accent: string
  /** builtin = LULUX 内核；kernel = 命令行内核（旧服务端曾返回 persona，按 builtin 对待） */
  kind?: 'builtin' | 'kernel' | 'persona'
  kernelId?: string | null
  available?: boolean
  unavailableReason?: string | null
}

export type SessionKind = 'single' | 'group'

/** 群聊里的真人（契约 §6.10）：owner 群主 / admin 群管理员 / member 普通成员 */
export type ParticipantRole = 'owner' | 'admin' | 'member'

export interface SessionParticipant {
  userId: string
  name: string
  role: ParticipantRole
  joinedAt: number
}

/** 可邀请进群的同事（GET /api/sessions/colleagues） */
export interface Colleague {
  id: string
  name: string
  email: string
}

/** 群成员资料：名字始终是内核原名，role 是贴在名字旁的群头衔 */
export interface MemberProfile {
  role: string
  instructions: string
  model: string | null
}

/** 新建 / 修改群成员的输入（agentId 为内核 id 时由服务端分配实例序号） */
export interface MemberInput {
  agentId: string
  role?: string | null
  instructions?: string | null
  model?: string | null
}

export interface Session {
  id: string
  title: string
  /** 单聊（恰好一个内核）/ 群聊（只能新建）。旧服务端没有该字段：按成员数推断 */
  kind?: SessionKind
  groupName: string | null
  providerId: string | null
  /** 成员 id；群聊里同一内核可多次进群，第 2 个起带序号（kernel-claude-code#2） */
  agentIds: string[]
  /** 群成员资料：群头衔 / 职责 / 模型（旧服务端没有该字段） */
  memberProfiles?: Record<string, MemberProfile>
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
  /** 群聊主管：'builtin'（默认）/ 成员 Agent id / 'none'（旧服务端没有该字段，按 builtin） */
  supervisorId?: string
  /** 会话权限级别（契约 §6.11）；null / 缺省 = 跟随全局默认 */
  permissionLevel?: PermissionLevel | null
  /** 会话模型（契约 §6.13）：Provider 的模型或 global CLI 内核的模型；null / 缺省 = 默认 */
  model?: string | null
  /** 会话推理强度；null / 缺省 = 默认（内置内核跟随全局设置，CLI 内核用 CLI 自己的默认） */
  reasoningEffort?: EffortLevel | null
  /** 工作流节点的隐藏会话：所属运行 id。服务端不在列表里返回，只能从运行记录只读查看 */
  workflowRunId?: string | null
  /** 群聊的真人成员（群主在第一个）；单聊为空。多于一人即多人群聊（旧服务端没有该字段） */
  participants?: SessionParticipant[]
  /** 当前用户在本会话里的角色（旧服务端没有，按 owner） */
  myRole?: ParticipantRole
  ownerId?: string
  /** 服务端是否有进行中的运行（契约 §6.9；旧服务端没有该字段） */
  running?: boolean
  activeRunId?: string | null
}

/** 会话运行（契约 §6.9） */
export interface SessionRun {
  id: string
  sessionId: string
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  source: string
  startedAt: number
  endedAt: number | null
  lastSeq: number
}

export interface ToolTraceEntry {
  id: string
  name: string
  server: string
  arguments: string
  ok: boolean
  approved: boolean
  result: string
  durationMs: number
  createdAt: number
}

export type Runtime =
  | { kind: 'provider'; providerName: string; model: string }
  | {
      kind: 'kernel'
      kernelId: string
      version: string | null
      /** 契约 §6：内核网关（旧消息没有这些字段） */
      mode?: KernelMode | null
      providerName?: string | null
      model?: string | null
      label?: string | null
    }

/** 契约 §6.4：本条回复所有上游调用（工具轮次、续写）的合计 */
export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimated: boolean
  calls: number
  cost: number | null
  currency: string | null
}

/** streaming：运行中逐步落库的草稿；interrupted：服务关闭 / 崩溃时中断（契约 §6.9） */
export type FinishReason = 'stop' | 'length' | 'tool_limit' | 'aborted' | 'error' | 'interrupted' | 'streaming'

/** tool_limit：轮数到上限（max_turns）或重复调用被拦截（loop_guard）；旧服务端只给 maxToolRounds */
export interface ToolLimitEvent {
  agentId: string
  maxToolRounds: number
  maxTurns?: number
  used?: number
  reason?: 'max_turns' | 'loop_guard'
  tool?: string
  repeats?: number
}

/** 用户消息的图片附件：文件在会话工作区，消息只存引用（契约：图片输入） */
export interface MessageAttachment {
  kind: 'image'
  path: string
  name: string
  mime: string
  size: number
  width: number | null
  height: number | null
}

/** 发送时的附件引用（先上传到会话工作区） */
export interface AttachmentRef {
  path: string
  name?: string
}

export interface Message {
  id: string
  sessionId: string
  role: 'system' | 'user' | 'assistant'
  content: string
  senderAgentId: string | null
  toolTrace: ToolTraceEntry[]
  createdAt: number
  runtime?: Runtime | null
  /** 契约 §6.4（旧消息没有） */
  reasoning?: string
  usage?: MessageUsage | null
  finishReason?: FinishReason | null
  /** 群聊主管的规划 / 汇总消息 */
  supervisorRole?: 'plan' | 'summary'
  /** 用户消息的图片（旧消息没有） */
  attachments?: MessageAttachment[]
  /** 用户消息的发言人账号与名字（多人群聊显示；旧消息没有） */
  senderUserId?: string | null
  senderName?: string | null
}

export type McpServerStatus = 'stopped' | 'connecting' | 'connected' | 'error'

export interface McpServer {
  id: string
  name: string
  /** stdio = 本机命令；http = 远程 Streamable HTTP（url + headers，接口只返回 headerKeys） */
  transport?: 'stdio' | 'http'
  url?: string
  headerKeys?: string[]
  createdBy?: 'user' | 'agent'
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /** 命令是否已经过原生确认；未确认的记录不会自动启动 */
  approved?: boolean
  createdAt: number
  state?: { status: McpServerStatus; error: string; tools: string[] }
}

export interface McpServerInput {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  /** 远程 HTTP：与 command 二选一 */
  url?: string
  /** 只在新增或要替换时传；不传则保留原有请求头 */
  headers?: Record<string, string>
}

export interface SettingSchema {
  key: string
  type: 'string' | 'boolean' | 'number' | 'enum'
  default: unknown
  enum?: string[]
}

export type KernelStatus = 'idle' | 'installing' | 'uninstalling' | 'error'
/** 契约 §6.1：scoped = 经 LULUX 网关使用已配置的 Provider；global = CLI 自己的登录 */
export type KernelMode = 'scoped' | 'global'

export interface Kernel {
  id: string
  name: string
  vendor: string
  npmPackage: string
  description: string
  /** 内核管理页的一行说明（旧服务端没有） */
  tagline?: string
  /** 内核头像（/agents/*.png）；null 表示用客户端内置的 svg 标志 */
  avatar?: string | null
  sizeHint: string
  installed: boolean
  version: string | null
  latestVersion: string | null
  status: KernelStatus
  progress: number | null
  error: string | null
  requiresLogin: boolean
  loginHint: string
  /** 契约 §6.1（builtin 为 null；旧服务端没有） */
  mode?: KernelMode | null
  modeSettingKey?: string | null
  scopedProvider?: { id: string; name: string; model: string } | null
}

export const STAGES = ['lead', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const
export type Stage = (typeof STAGES)[number]

export interface Contact {
  id: string
  name: string
  title: string
  email: string
  phone: string
  whatsapp: string
  isPrimary: boolean
}

export interface Customer {
  id: string
  company: string
  country: string
  website: string
  stage: Stage
  tags: string[]
  source: string
  notes: string
  contacts: Contact[]
  createdAt: number | string
  updatedAt: number | string
  /** 契约 §5.6：负责人与可见性（desktop 模式 ownerId='local'） */
  ownerId?: string
  ownerName?: string
  visibility?: Visibility
  teamId?: string | null
}

export type CustomerInput = Omit<Customer, 'id' | 'createdAt' | 'updatedAt' | 'contacts'> & {
  contacts: Array<Omit<Contact, 'id'> & { id?: string }>
}

export type ActivityType = 'note' | 'email' | 'call' | 'quote'

export interface Activity {
  id: string
  customerId?: string
  type: ActivityType
  content: string
  createdAt: number | string
  actorId?: string | null
  actorName?: string | null
}

export type ImportField =
  | 'company'
  | 'country'
  | 'website'
  | 'stage'
  | 'tags'
  | 'source'
  | 'notes'
  | 'contactName'
  | 'contactTitle'
  | 'contactEmail'
  | 'contactPhone'
  | 'contactWhatsapp'

export interface ImportRequest {
  rows: Record<string, string>[]
  mapping: Partial<Record<ImportField, string>>
  dedupeBy: 'email' | 'company' | 'website'
  onDuplicate: 'skip' | 'merge'
}

export interface ImportResult {
  created: number
  merged: number
  skipped: number
  errors: { row: number; message: string }[]
}

export interface Product {
  id: string
  sku: string
  name: string
  spec: string
  unit: string
  price: number
  currency: string
  moq: number
  hsCode: string
  /** 分类（可空） */
  category: string
  createdAt?: number
  updatedAt?: number
}

export type ProductInput = Omit<Product, 'id' | 'createdAt' | 'updatedAt'>

export interface ProductImportResult {
  created: number
  updated: number
  skipped: number
  errors: Array<{ row: number; message: string }>
}

export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const
export const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'AUD', 'CAD', 'HKD'] as const
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export interface QuoteItem {
  productId: string | null
  name: string
  spec: string
  qty: number
  unit: string
  unitPrice: number
}

export interface Quote {
  id: string
  number: string
  customerId: string
  currency: string
  incoterm: string
  port: string
  validUntil: string
  paymentTerms: string
  leadTime: string
  items: QuoteItem[]
  notes: string
  status: QuoteStatus
  subtotal: number
  createdAt: number | string
  updatedAt: number | string
}

export type QuoteInput = Omit<Quote, 'id' | 'number' | 'subtotal' | 'createdAt' | 'updatedAt'> & {
  number?: string
}

export interface InquiryCondition {
  field: 'subject' | 'body' | 'from' | 'domain'
  op: 'contains' | 'not_contains' | 'regex'
  value: string
}

export interface InquiryRule {
  id: string
  name: string
  enabled: boolean
  conditions: InquiryCondition[]
  action: 'inquiry' | 'spam' | 'review'
  priority: number
}

export interface QuoteTemplate {
  id: string
  name: string
  isDefault: boolean
  company: { name: string; address: string; phone: string; email: string; logoDataUrl: string }
  defaultIncoterm: string
  defaultCurrency: string
  defaultPaymentTerms: string
  footer: string
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number | string
  preview?: string
}

export interface WorkbenchSummary {
  customers: { total: number; byStage: Partial<Record<Stage, number>> }
  quotes: {
    total: number
    draft: number
    sent: number
    accepted: number
    amountByCurrency: Record<string, number>
  }
  recentActivities: Activity[]
  recentSessions: SessionSummary[]
  /** 新服务端才有（range / tz 查询参数）；旧服务端没有这一块 */
  overview?: WorkbenchOverview
}

export type WorkbenchRange = 'today' | '7d' | '30d'
export interface WorkbenchMailCounts {
  total: number
  inquiry: number
  customerReply: number
  other: number
}
export interface WorkbenchOverview {
  range: WorkbenchRange
  from: number
  to: number
  days: number
  mail: {
    accounts: Array<{ id: string; email: string; state: string; lastSyncAt: number | null }>
    current: WorkbenchMailCounts
    previous: WorkbenchMailCounts
    daily: Array<{ date: string; total: number; inquiry: number }>
    inquiryCountries: number
    inquiryNewCustomers: number
    unreadInquiries: number
  }
  newCustomers: { current: number; previous: number; week: number }
  stale: { count: number; items: Array<{ id: string; company: string; stage: Stage; lastTouchAt: number }> }
  followUps: {
    due: number
    overdue: number
    done: number
    openTotal: number
    items: Array<{
      id: string
      title: string
      dueAt: number | null
      overdue: boolean
      priority: string
      customerId: string | null
      company: string | null
      country: string | null
      stage: Stage | null
    }>
  }
}

/** 客户列表行（新服务端附带）：最近跟进时间与下次跟进任务 */
export interface CustomerFollowUp {
  lastTouchAt?: number | null
  nextTask?: { id: string; title: string; dueAt: number | null; overdue: boolean } | null
}
export interface CustomerFacets {
  total: number
  newThisMonth: number
  countries: Array<{ value: string; count: number }>
  owners: Array<{ id: string; name: string; count: number }>
  tags: Array<{ value: string; count: number }>
}

export interface Paged<T> {
  items: T[]
  total: number
}

export interface DataSummary {
  sessions: number
  messages: number
  providers: number
  mcpServers: number
  databaseBytes: number
}

export interface NetworkTestResult {
  ok: boolean
  status: number
}

/* ───────────────────────── 基础 / 设置 ───────────────────────── */

export function getHealth(): Promise<{ ok: boolean }> {
  return request('/api/health', { silent: true })
}

export async function listSettings(): Promise<Record<string, string>> {
  const res = await request<unknown>('/api/settings')
  return unwrapOne<Record<string, string>>(res, 'settings') ?? {}
}

export async function updateSettings(patch: Record<string, string>): Promise<Record<string, string>> {
  const res = await request<unknown>('/api/settings', { method: 'PATCH', body: patch })
  return unwrapOne<Record<string, string>>(res, 'settings') ?? {}
}

export async function getSettingsSchema(): Promise<SettingSchema[]> {
  return unwrapList<SettingSchema>(await request('/api/settings/schema', { silent: true }), 'schema')
}

/* ───────────────────────── Agents / Providers / Sessions ───────────────────────── */

export async function listAgents(): Promise<Agent[]> {
  return unwrapList<Agent>(await request('/api/agents'), 'agents')
}

export async function listProviders(): Promise<Provider[]> {
  return unwrapList<Provider>(await request('/api/providers'), 'providers')
}

export async function createProvider(input: ProviderInput): Promise<Provider> {
  return unwrapOne<Provider>(await request('/api/providers', { method: 'POST', body: input }), 'provider')
}

export async function updateProvider(id: string, input: Partial<ProviderInput>): Promise<Provider> {
  return unwrapOne<Provider>(
    await request(`/api/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'provider',
  )
}

/** 按模型设置思考强度；'auto' = 恢复自动检测 */
export async function setModelReasoning(
  id: string,
  model: string,
  reasoning: ReasoningChoice | 'auto',
): Promise<Provider> {
  return unwrapOne<Provider>(
    await request(`/api/providers/${encodeURIComponent(id)}/model-caps`, { method: 'PUT', body: { model, reasoning } }),
    'provider',
  )
}

export async function discoverProviderModels(
  id: string,
  options: { silent?: boolean } = {},
): Promise<{ provider: Provider; models: string[] }> {
  const res = await request<{ provider?: Provider; models?: string[] }>(
    `/api/providers/${encodeURIComponent(id)}/discover-models`,
    { method: 'POST', silent: options.silent },
  )
  return { provider: res.provider as Provider, models: res.models ?? res.provider?.models ?? [] }
}

export function deleteProvider(id: string): Promise<void> {
  return request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function listSessions(): Promise<Session[]> {
  return unwrapList<Session>(await request('/api/sessions'), 'sessions')
}

export async function createSession(
  input: {
    title?: string
    providerId?: string
    agentIds?: string[]
    /** 群聊成员（带群头衔；同一内核可多次出现）。给了就忽略 agentIds */
    members?: MemberInput[]
    /** 'group' 新建群聊（总是新会话、空历史）；单聊传 'single' */
    kind?: SessionKind
    groupName?: string | null
    supervisorId?: string
    /** 群聊：一起邀请的同事（团队服务器模式） */
    userIds?: string[]
    /** 会话权限级别；省略 = 跟随全局默认 */
    permissionLevel?: PermissionLevel | null
    model?: string
    reasoningEffort?: EffortLevel
  } = {},
): Promise<Session> {
  return unwrapOne<Session>(await request('/api/sessions', { method: 'POST', body: input }), 'session')
}

export function getSession(id: string): Promise<{ session: Session; messages: Message[]; run?: SessionRun | null }> {
  return request(`/api/sessions/${encodeURIComponent(id)}`)
}

/** 显式取消会话运行（契约 §6.9）；关窗 / 刷新 / 切会话都不会停止运行，只有这里会 */
export function cancelRun(sessionId: string): Promise<{ stopped: boolean; runId: string | null }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', silent: true })
}

/** Agent 操作内置浏览器时用户接管：pause 暂停 / resume 继续 / stop 本次运行内不再操作（docs/browser-use.md） */
export type BrowserControlAction = 'pause' | 'resume' | 'stop'

export function browserControl(sessionId: string, action: BrowserControlAction): Promise<unknown> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/browser/control`, {
    method: 'POST',
    body: { action },
    silent: true,
  })
}

/** 电脑操作（docs/computer-use.md，实验性）：本会话开关与状态 */
export type ComputerState = 'running' | 'paused' | 'stopped'
export interface ComputerSessionStatus {
  enabled: boolean
  state: ComputerState
  /** 设置里已打开且桌面端本地模式可用 */
  available: boolean
}

export function computerStatus(sessionId: string): Promise<ComputerSessionStatus> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/computer`, { silent: true })
}

export function setComputerEnabled(sessionId: string, enabled: boolean): Promise<{ enabled: boolean; state: ComputerState }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/computer`, { method: 'POST', body: { enabled }, silent: true })
}

export function computerControl(sessionId: string, action: BrowserControlAction): Promise<{ state: ComputerState }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/computer/control`, {
    method: 'POST',
    body: { action },
    silent: true,
  })
}

export async function patchSession(
  id: string,
  patch: Partial<{
    title: string
    groupName: string | null
    agentIds: string[]
    /** 群聊：整体替换成员（含群头衔）；与 agentIds 二选一 */
    members: MemberInput[]
    supervisorId: string | null
    permissionLevel: PermissionLevel | null
    providerId: string | null
    model: string | null
    reasoningEffort: EffortLevel | null
  }>,
): Promise<Session> {
  return unwrapOne<Session>(
    await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    'session',
  )
}

/** 权限选择器需要的信息（契约 §6.11）；旧服务端没有该接口时返回 null */
export async function getPermissions(): Promise<PermissionInfo | null> {
  try {
    return await request<PermissionInfo>('/api/permissions', { silent: true })
  } catch {
    return null
  }
}

export interface PermissionCaps {
  roles: Record<'owner' | 'admin' | 'member' | 'viewer', PermissionLevel>
  members: Record<string, PermissionLevel>
}

/** 团队上限（server 模式，members:manage） */
export function getPermissionCaps(): Promise<PermissionCaps> {
  return request<PermissionCaps>('/api/team/permission-caps')
}

export function updatePermissionCaps(patch: {
  roles?: Partial<Record<'admin' | 'member' | 'viewer', PermissionLevel>>
  members?: Record<string, PermissionLevel | null>
}): Promise<PermissionCaps> {
  return request<PermissionCaps>('/api/team/permission-caps', { method: 'PATCH', body: patch })
}

export function deleteSession(id: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/* ── 多人群聊：真人成员（契约 §6.10） ── */

export async function listColleagues(): Promise<Colleague[]> {
  return unwrapList<Colleague>(await request('/api/sessions/colleagues', { silent: true }), 'users')
}

export async function addParticipants(
  id: string,
  userIds: string[],
  role?: 'admin' | 'member',
): Promise<{ added: string[]; session: Session }> {
  return request(`/api/sessions/${encodeURIComponent(id)}/participants`, {
    method: 'POST',
    body: role ? { userIds, role } : { userIds },
  })
}

export async function setParticipantRole(id: string, userId: string, role: 'admin' | 'member'): Promise<Session> {
  return unwrapOne<Session>(
    await request(`/api/sessions/${encodeURIComponent(id)}/participants/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { role },
    }),
    'session',
  )
}

/** 移出成员；userId 传 'me' 即退出群聊 */
export function removeParticipant(id: string, userId: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(id)}/participants/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}

/* ───────────────────────── MCP / 网络 ───────────────────────── */

export async function listMcpServers(): Promise<McpServer[]> {
  return unwrapList<McpServer>(await request('/api/mcp/servers'), 'servers')
}

export async function createMcpServer(input: McpServerInput): Promise<McpServer> {
  return unwrapOne<McpServer>(await request('/api/mcp/servers', { method: 'POST', body: input }), 'server')
}

export async function updateMcpServer(id: string, patch: Partial<McpServerInput>): Promise<McpServer> {
  return unwrapOne<McpServer>(
    await request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    'server',
  )
}

export function deleteMcpServer(id: string): Promise<void> {
  return request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function refreshMcpServer(
  id: string,
): Promise<{ state: { status: McpServerStatus; error: string; tools: string[] } }> {
  return request(`/api/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
}

export function testProxy(proxyUrl?: string): Promise<NetworkTestResult> {
  return request('/api/proxy/test', { method: 'POST', body: { proxyUrl }, silent: true })
}

export function testWebhook(url?: string): Promise<NetworkTestResult> {
  return request('/api/webhook/test', { method: 'POST', body: { url }, silent: true })
}

/** 回传一次工具调用的批准结果；remember='session' = 本会话内同名工具不再询问（契约 §6.2） */
export function decideTool(requestId: string, approved: boolean, remember?: 'session'): Promise<{ ok: boolean }> {
  return request('/api/chat/tool-decision', {
    method: 'POST',
    body: remember ? { requestId, approved, remember } : { requestId, approved },
  })
}

/* ───────────────────────── 内核 ───────────────────────── */

export async function listKernels(options: { silent?: boolean } = {}): Promise<Kernel[]> {
  return unwrapList<Kernel>(await request('/api/kernels', { silent: options.silent }), 'kernels')
}

export async function kernelAction(id: string, action: 'install' | 'update' | 'uninstall'): Promise<Kernel> {
  return unwrapOne<Kernel>(
    await request(`/api/kernels/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    'kernel',
  )
}

export async function kernelLog(id: string): Promise<string[]> {
  const res = await request<{ lines?: string[] }>(`/api/kernels/${encodeURIComponent(id)}/log`)
  return res.lines ?? []
}

/* ───────────────────────── 客户 ───────────────────────── */

/** 导出客户 CSV（服务端按同样的筛选条件导出全部页；带 BOM，Excel 直接打开不乱码） */
export function exportCustomersCsv(params: { query?: string; stage?: string; tag?: string }): Promise<Blob> {
  return request('/api/customers/export', { query: params, blob: true, silent: true })
}

export function listCustomers(params: {
  query?: string
  stage?: string
  tag?: string
  country?: string
  ownerId?: string
  visibility?: string
  page?: number
  pageSize?: number
}): Promise<Paged<Customer & CustomerFollowUp>> {
  return request<Paged<Customer & CustomerFollowUp>>('/api/customers', { query: params }).then((res) => ({
    items: res?.items ?? [],
    total: res?.total ?? 0,
  }))
}

/** 服务端 pageSize 上限 200：分页取全部（报价单的客户下拉等） */
export async function listAllCustomers(params: { query?: string } = {}): Promise<Customer[]> {
  const all: Customer[] = []
  for (let page = 1; page <= 50; page++) {
    const res = await listCustomers({ ...params, page, pageSize: 200 })
    all.push(...res.items)
    if (all.length >= res.total || res.items.length === 0) break
  }
  return all
}

export async function getCustomer(id: string): Promise<Customer> {
  return unwrapOne<Customer>(await request(`/api/customers/${encodeURIComponent(id)}`, { silent: true }), 'customer')
}

/** 查重命中的已有客户：只有公司名与负责人；当前用户看得见时附 id */
export type DuplicateReason = 'company' | 'email' | 'emailDomain' | 'phone' | 'website'
export interface CustomerDuplicate {
  id?: string
  company: string
  ownerName: string
  matchedBy: DuplicateReason[]
}

/** 409 CUSTOMER_DUPLICATE 时取出命中列表，其它错误返回 null */
export function customerDuplicatesOf(error: unknown): CustomerDuplicate[] | null {
  if (!(error instanceof ApiError) || error.code !== 'CUSTOMER_DUPLICATE') return null
  const list = (error.details as { duplicates?: unknown } | undefined)?.duplicates
  return Array.isArray(list) ? (list as CustomerDuplicate[]) : []
}

/**
 * 新建客户。服务端先在全组织查重，命中时 409 CUSTOMER_DUPLICATE（不弹全局提示，由表单展示），
 * 用户确认后传 force=true 仍然创建。
 */
export async function createCustomer(input: CustomerInput, opts: { force?: boolean } = {}): Promise<Customer> {
  const body = opts.force ? { ...input, force: true } : input
  try {
    return unwrapOne<Customer>(await request('/api/customers', { method: 'POST', body, silent: true }), 'customer')
  } catch (error) {
    if (!customerDuplicatesOf(error) && error instanceof ApiError) reportApiError(error)
    throw error
  }
}

export async function updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer> {
  return unwrapOne<Customer>(
    await request(`/api/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'customer',
  )
}

/** 名下有订单 / 收款 / 报价 / 商机时服务端返回 409 CUSTOMER_HAS_RECORDS，消息里列出各类数量 */
export function deleteCustomer(id: string, opts: { silent?: boolean } = {}): Promise<void> {
  return request(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE', silent: opts.silent })
}

export function importCustomers(body: ImportRequest): Promise<ImportResult> {
  return request('/api/customers/import', { method: 'POST', body })
}

export async function listQuotesForCustomer(customerId: string): Promise<Quote[]> {
  return unwrapList<Quote>(await request('/api/quotes', { query: { customerId } }), 'quotes')
}

export async function listActivities(customerId: string): Promise<Activity[]> {
  return unwrapList<Activity>(
    await request(`/api/customers/${encodeURIComponent(customerId)}/activities`),
    'activities',
  )
}

export async function addActivity(
  customerId: string,
  input: { type: ActivityType; content: string },
): Promise<Activity> {
  return unwrapOne<Activity>(
    await request(`/api/customers/${encodeURIComponent(customerId)}/activities`, { method: 'POST', body: input }),
    'activity',
  )
}

/* ───────────────────────── 产品 / 报价 ───────────────────────── */

export async function listProducts(): Promise<Product[]> {
  return unwrapList<Product>(await request('/api/products'), 'products')
}

export async function createProduct(input: Partial<ProductInput> & { name: string }): Promise<Product> {
  return unwrapOne<Product>(await request('/api/products', { method: 'POST', body: input }), 'product')
}

export async function updateProduct(id: string, input: Partial<ProductInput>): Promise<Product> {
  return unwrapOne<Product>(
    await request(`/api/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'product',
  )
}

export function deleteProduct(id: string): Promise<void> {
  return request(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** CSV 行批量导入：按 SKU 匹配已有产品时更新（onDuplicate=skip 则跳过） */
export function importProducts(
  rows: Array<Record<string, string>>,
  onDuplicate: 'update' | 'skip' = 'update',
): Promise<ProductImportResult> {
  return request('/api/products/import', { method: 'POST', body: { rows, onDuplicate } })
}

export async function listQuotes(): Promise<Quote[]> {
  return unwrapList<Quote>(await request('/api/quotes'), 'quotes')
}

export async function getQuote(id: string): Promise<Quote> {
  return unwrapOne<Quote>(await request(`/api/quotes/${encodeURIComponent(id)}`), 'quote')
}

export async function createQuote(input: QuoteInput): Promise<Quote> {
  return unwrapOne<Quote>(await request('/api/quotes', { method: 'POST', body: input }), 'quote')
}

export async function updateQuote(id: string, input: Partial<QuoteInput>): Promise<Quote> {
  return unwrapOne<Quote>(
    await request(`/api/quotes/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'quote',
  )
}

export function deleteQuote(id: string): Promise<void> {
  return request(`/api/quotes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function quoteHtml(id: string): Promise<string> {
  return request(`/api/quotes/${encodeURIComponent(id)}/html`, { text: true })
}

/* ───────────────────────── 规则 / 模板 ───────────────────────── */

export async function listInquiryRules(): Promise<InquiryRule[]> {
  return unwrapList<InquiryRule>(await request('/api/inquiry-rules'), 'rules')
}

export async function createInquiryRule(input: Omit<InquiryRule, 'id'>): Promise<InquiryRule> {
  return unwrapOne<InquiryRule>(await request('/api/inquiry-rules', { method: 'POST', body: input }), 'rule')
}

export async function updateInquiryRule(id: string, input: Partial<Omit<InquiryRule, 'id'>>): Promise<InquiryRule> {
  return unwrapOne<InquiryRule>(
    await request(`/api/inquiry-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'rule',
  )
}

export function deleteInquiryRule(id: string): Promise<void> {
  return request(`/api/inquiry-rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testInquiryRules(input: {
  subject: string
  body: string
  from: string
}): Promise<{ verdict: string; matchedRuleId: string | null }> {
  return request('/api/inquiry-rules/test', { method: 'POST', body: input })
}

export async function listQuoteTemplates(): Promise<QuoteTemplate[]> {
  return unwrapList<QuoteTemplate>(await request('/api/quote-templates'), 'templates')
}

export async function createQuoteTemplate(input: Omit<QuoteTemplate, 'id'>): Promise<QuoteTemplate> {
  return unwrapOne<QuoteTemplate>(await request('/api/quote-templates', { method: 'POST', body: input }), 'template')
}

export async function updateQuoteTemplate(
  id: string,
  input: Partial<Omit<QuoteTemplate, 'id'>>,
): Promise<QuoteTemplate> {
  return unwrapOne<QuoteTemplate>(
    await request(`/api/quote-templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }),
    'template',
  )
}

export function deleteQuoteTemplate(id: string): Promise<void> {
  return request(`/api/quote-templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/* ───────────────────────── 工作台 / 数据 / 本机锁 ───────────────────────── */

export function getWorkbenchSummary(params: { range?: WorkbenchRange; tz?: number } = {}): Promise<WorkbenchSummary> {
  return request('/api/workbench/summary', { silent: true, query: params })
}

export function getCustomerFacets(): Promise<CustomerFacets> {
  return request('/api/customers/facets', { silent: true })
}

export function getDataSummary(): Promise<DataSummary> {
  return request('/api/data/summary')
}

export function exportData(): Promise<Record<string, unknown>> {
  return request('/api/data/export')
}

export function importData(payload: unknown): Promise<{ imported: Record<string, number> }> {
  return request('/api/data/import', { method: 'POST', body: payload })
}

export function clearAllSessions(): Promise<{ removed: number }> {
  return request('/api/data/sessions', { method: 'DELETE' })
}

export function getLock(): Promise<{ enabled: boolean }> {
  return request('/api/lock', { silent: true })
}

export function setupLock(pin: string): Promise<unknown> {
  return request('/api/lock/setup', { method: 'POST', body: { pin } })
}

export function verifyLock(pin: string): Promise<{ ok: boolean }> {
  return request('/api/lock/verify', { method: 'POST', body: { pin }, silent: true })
}

export function disableLock(pin: string): Promise<unknown> {
  return request('/api/lock/disable', { method: 'POST', body: { pin }, silent: true })
}

/* ───────────────────────── 对话流 ───────────────────────── */

export interface StreamAgent {
  agentId: string
  name: string
  avatar: string
  index: number
  total: number
  runtime?: Runtime | null
  /** 群聊：plan = 主管规划，summary = 主管汇总，member = 成员发言 */
  role?: 'plan' | 'member' | 'summary'
}

export interface StreamStart {
  sessionId: string
  group: boolean
  provider?: { id: string; name: string; model: string } | null
  members: Array<{ id: string; name: string; avatar: string }>
  /** 契约 §6.3 */
  mode?: 'send' | 'regenerate' | 'edit'
  speakers?: string[]
  speakMode?: 'targeted' | 'mentioned' | 'all' | 'supervised'
  /** 本轮的主管（无主管为 null） */
  supervisorId?: string | null
}

/** 主管派发：成员按顺序回答 */
export interface StreamDispatch {
  supervisorId: string
  members: string[]
  instructions: string
}

/** 发言前提示：成员不可用被跳过 / 选中的主管不可用 */
export interface StreamNotice {
  kind: 'unavailable' | 'supervisor_unavailable'
  agentId: string
  name: string
  reason: string
}

export interface StreamRetry {
  agentId: string
  attempt: number
  maxRetries: number
  delayMs: number
  code: string
  status: number | null
  message: string
}

export interface StreamArtifact {
  agentId: string
  artifact: {
    id: string
    title: string
    language: string
    filename: string
    path: string
    size: number
    /** 脚本生成的二进制文件（docx/xlsx/pptx/pdf…）：不在消息正文里，用 downloadUrl 下载 */
    binary?: boolean
    mime?: string
    downloadUrl?: string
  }
}

export type StreamCompaction =
  | {
      agentId: string
      kind: 'summary'
      ok: boolean
      summarizedMessages: number
      tokensBefore: number
      tokensAfter: number
      budget: number
    }
  | { agentId: string; kind: 'tool_results'; shrunk: number }
  /** 上下文超预算：先省略较早消息里的图片 */
  | { agentId: string; kind: 'images'; droppedImages: number }

/** 本轮模型不支持看图：图片以文件路径的文字形式送达 */
export interface StreamVision {
  agentId?: string
  supported: boolean
  model: string
  images: number
}

export interface StreamErrorInfo {
  agentId?: string
  name?: string
  code?: string
  message: string
  retryable?: boolean
  status?: number | null
  partialMessageId?: string | null
}

/** 模型请求调用某个 MCP 工具 */
export interface StreamToolRequest {
  /** 契约 §4.9：LULUX 内置业务工具 */
  builtin?: boolean
  risk?: 'read' | 'write'
  requestId: string
  agentId: string
  name: string
  server: string
  arguments: string
  /** 设置为自动批准时无需界面确认 */
  auto: boolean
  toolCallId?: string
  /** 审批卡片类型：tool | skill_script | skill_install | skill_write | mcp_add | mcp_update | mcp_remove */
  approvalKind?: string
  /** 卡片详情（各类型结构见 lib/approval.ts） */
  detail?: unknown
  /** false 时不显示“本会话始终允许” */
  canRemember?: boolean
  toolKey?: string
}

export interface StreamToolResult {
  requestId: string
  agentId: string
  name: string
  server: string
  ok: boolean
  approved: boolean
  result: string
  durationMs: number
}

export interface StreamHandlers {
  onStart?: (info: StreamStart) => void
  onAgent?: (agent: StreamAgent) => void
  onDelta: (text: string) => void
  onReasoning?: (data: { agentId: string; text: string }) => void
  onToolRequest?: (request: StreamToolRequest) => void
  onToolResult?: (result: StreamToolResult) => void
  onRetry?: (data: StreamRetry) => void
  onDowngrade?: (data: {
    agentId: string
    what: 'tools' | 'stream_usage' | 'vision'
    model: string
    message: string
  }) => void
  onVision?: (data: StreamVision) => void
  onContinuation?: (data: {
    agentId: string
    reason: 'length' | 'interrupted' | 'reasoning_only'
    attempt: number
  }) => void
  onToolLimit?: (data: ToolLimitEvent) => void
  onArtifact?: (data: StreamArtifact) => void
  onCompaction?: (data: StreamCompaction) => void
  onStopped?: (data: { sessionId: string; reason: string }) => void
  /** 用户消息命中技能关键词，服务端预加载了技能正文 */
  onSkillPreload?: (data: { agentId: string; skills: string[] }) => void
  onDispatch?: (data: StreamDispatch) => void
  onNotice?: (data: StreamNotice) => void
  onDone: (message: Message, aborted: boolean) => void
  onError: (message: string, info?: StreamErrorInfo) => void
  /** 每个带 id（运行事件 seq）的事件之前调用，断线后用它续接 */
  onSeq?: (seq: number) => void
  /** 重新接上时：缓存事件回放完毕，之后都是实时事件 */
  onReplayed?: (data: { lastSeq: number }) => void
}

/** 解析一个 SSE 块，返回事件名与 JSON 载荷 */
export function parseSseBlock(block: string): { event: string; data: unknown; id?: number } | null {
  let event = 'message'
  let id: number | undefined
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    else if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim())
      if (Number.isFinite(n)) id = n
    }
  }
  if (dataLines.length === 0) return null
  try {
    const data = JSON.parse(dataLines.join('\n'))
    return id === undefined ? { event, data } : { event, data, id }
  } catch {
    return null
  }
}

/** 对话流请求体：/api/chat、/api/chat/regenerate、/api/chat/edit 共用同一套 SSE（契约 §6.2 / §6.3） */
export type ChatStreamRequest =
  | {
      kind: 'send'
      sessionId: string
      content: string
      targetAgentIds?: string[]
      context?: { customerId?: string | null; quoteId?: string | null }
      attachments?: AttachmentRef[]
    }
  | { kind: 'regenerate'; sessionId: string; messageId?: string; targetAgentIds?: string[] }
  | {
      kind: 'edit'
      sessionId: string
      messageId: string
      content: string
      targetAgentIds?: string[]
      attachments?: AttachmentRef[]
    }

const STREAM_PATH: Record<ChatStreamRequest['kind'], string> = {
  send: '/api/chat',
  regenerate: '/api/chat/regenerate',
  edit: '/api/chat/edit',
}

/** 把一个 SSE 事件分发给对应的回调 */
export function dispatchStreamEvent(event: string, data: unknown, handlers: StreamHandlers): void {
  const d = data as Record<string, unknown>
  switch (event) {
    case 'start':
      return handlers.onStart?.(data as StreamStart)
    case 'agent':
      return handlers.onAgent?.(data as StreamAgent)
    case 'delta':
      return handlers.onDelta(String(d.text ?? ''))
    case 'reasoning':
      return handlers.onReasoning?.(data as { agentId: string; text: string })
    case 'tool_request':
      return handlers.onToolRequest?.(data as StreamToolRequest)
    case 'tool_result':
      return handlers.onToolResult?.(data as StreamToolResult)
    case 'retry':
      return handlers.onRetry?.(data as StreamRetry)
    case 'downgrade':
      return handlers.onDowngrade?.(data as Parameters<NonNullable<StreamHandlers['onDowngrade']>>[0])
    case 'continuation':
      return handlers.onContinuation?.(data as Parameters<NonNullable<StreamHandlers['onContinuation']>>[0])
    case 'tool_limit':
      return handlers.onToolLimit?.(data as ToolLimitEvent)
    case 'artifact':
      return handlers.onArtifact?.(data as StreamArtifact)
    case 'compaction':
      return handlers.onCompaction?.(data as StreamCompaction)
    case 'vision':
      return handlers.onVision?.(data as StreamVision)
    case 'stopped':
      return handlers.onStopped?.(data as { sessionId: string; reason: string })
    case 'skill_preload':
      return handlers.onSkillPreload?.(data as { agentId: string; skills: string[] })
    case 'dispatch':
      return handlers.onDispatch?.(data as StreamDispatch)
    case 'notice':
      return handlers.onNotice?.(data as StreamNotice)
    case 'done':
      return handlers.onDone(d.message as Message, d.aborted === true)
    case 'replayed':
      return handlers.onReplayed?.(data as { lastSeq: number })
    case 'error': {
      const payload = data as StreamErrorInfo & { error?: { message?: string } }
      const raw = payload.error?.message || payload.message
      const message = raw ? localizeErrorMessage(payload.code ?? '', raw) : t('apiIndex.kry5b6h')
      return handlers.onError(
        payload.name && !message.includes(payload.name) ? labelled(payload.name, message) : message,
        {
          ...payload,
          message,
        },
      )
    }
  }
}

export function streamChat(
  sessionId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamChatRequest({ kind: 'send', sessionId, content }, handlers, signal)
}

export async function streamChatRequest(
  req: ChatStreamRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { kind, ...body } = req
  let response: Response
  try {
    response = await fetch(apiUrl(STREAM_PATH[kind]), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError('NETWORK', t('apiIndex.k1mpayr0'), 0)
  }

  if (!response.ok) {
    throw parseErrorBody(response.status, await response.text().catch(() => ''), response.statusText)
  }
  if (!response.body) throw new ApiError('BAD_RESPONSE', t('apiIndex.k7itsuq'), response.status)

  await readSseStream(response.body, handlers)
}

/** 读一个 SSE 响应体并分发事件（POST 对话流与重新接上的流共用） */
async function readSseStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (block: string): void => {
    const parsed = parseSseBlock(block)
    if (!parsed) return
    if (parsed.id !== undefined) handlers.onSeq?.(parsed.id)
    dispatchStreamEvent(parsed.event, parsed.data, handlers)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        dispatch(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim()) dispatch(buffer)
  } finally {
    reader.releaseLock()
  }
}

/**
 * 重新接上会话运行（契约 §6.9）：GET /api/sessions/:id/stream?after=<seq>，
 * 先回放 seq > after 的缓存事件（结束时发 replayed），再推实时事件，运行结束时流关闭。
 */
export async function attachRunStream(
  sessionId: string,
  after: number,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(
      apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${Math.max(0, after)}`),
      {
        headers: { Accept: 'text/event-stream', ...authHeaders() },
        signal,
      },
    )
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError('NETWORK', t('apiIndex.k1mpayr0'), 0)
  }
  if (!response.ok) {
    throw parseErrorBody(response.status, await response.text().catch(() => ''), response.statusText)
  }
  if (!response.body) return
  await readSseStream(response.body, handlers)
}

export * from './builtin'

/** 模型选择器（契约 §6.13）：某内核可选的模型、默认模型与推理强度支持；旧服务端没有该接口时返回 null */
export async function getModels(kernel: string, providerId?: string | null): Promise<ModelCatalog | null> {
  const query = new URLSearchParams({ kernel })
  if (providerId) query.set('providerId', providerId)
  try {
    return await request<ModelCatalog>(`/api/models?${query.toString()}`, { silent: true })
  } catch {
    return null
  }
}
export * from './pricing'
export * from './sequences'
export * from './docs'
