/**
 * WhatsApp 关联设备接口（docs/API-CONTRACT.md §12）。
 * 状态、二维码和配对码都由服务端驱动；这里不生成任何占位二维码或假配对码。
 */
import { request } from './http'
import type { Customer } from './index'

export type WhatsAppConnection = 'connected' | 'connecting' | 'disconnected' | 'reauth'
export type WhatsAppPhase =
  | 'unbound'
  | 'waiting_qr'
  | 'waiting_pairing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'reauth'
export type WhatsAppLinkMode = 'qr' | 'pairing'

export interface WhatsAppErrorInfo {
  code: string
  message: string
}

export interface WhatsAppQr {
  dataUrl: string
  issuedAt: number
  expiresAt: number
  refreshCount: number
  warning: boolean
  expired: boolean
}

export interface WhatsAppPairing {
  code: string
  phone: string
  issuedAt: number
  expiresAt: number
  expired: boolean
}

export interface WhatsAppAccountInfo {
  phone: string
  deviceName: string
  platform: string | null
  linkedAt: number
  lastLoginAt: number
  lastActivityAt: number
}

export interface WhatsAppEngineInfo {
  id: string
  installed: boolean
  version: string | null
  dir: string | null
  qrAvailable: boolean
  error: WhatsAppErrorInfo | null
}

export interface WhatsAppRiskInfo {
  accepted: boolean
  acceptedAt: number | null
  expiresAt: number | null
  version: string | null
}

export interface WhatsAppStatus {
  accountId: string
  phase: WhatsAppPhase
  connection: WhatsAppConnection
  mode: WhatsAppLinkMode | null
  engine: WhatsAppEngineInfo
  account: WhatsAppAccountInfo | null
  qr: WhatsAppQr | null
  pairing: WhatsAppPairing | null
  reconnect: { attempt: number; maxAttempts: number; nextAt: number } | null
  error: WhatsAppErrorInfo | null
  risk: WhatsAppRiskInfo
  limits: { linkedDevices: number; phoneOfflineDays: number; deviceIdleDays: number }
  updatedAt: number
}

export type WhatsAppMessageDirection = 'in' | 'out'
export type WhatsAppMessageStatus = 'received' | 'sending' | 'sent' | 'failed'

/** 会话摘要（契约 §12.3）。`customerId` = 手动关联的客户；`draft` = LULUX 起草、尚未发送的回复。 */
export interface WhatsAppConversation {
  id: string
  remoteJid: string
  phone: string
  displayName: string
  customerId: string | null
  lastMessageAt: number | null
  lastMessagePreview: string
  lastMessageDirection: WhatsAppMessageDirection | null
  unreadCount: number
  archivedAt: number | null
  pinnedAt: number | null
  tags: string[]
  /** LULUX 起草、尚未发送的回复（只存草稿，发送仍由人确认） */
  draft?: { text: string; createdAt: number } | null
  /** 列表接口附带：手动关联或按号码匹配到的客户公司名（SSE 推来的会话没有这个字段） */
  customerName?: string | null
  createdAt: number
  updatedAt: number
}

/** 会话列表筛选：all 不含已归档；pending = 最后一条是对方发来的 */
export type WhatsAppConversationFilter = 'all' | 'unread' | 'pending' | 'archived'

export interface WhatsAppConversationCounts {
  all: number
  unread: number
  pending: number
  archived: number
  tags: Array<{ tag: string; count: number }>
}

export interface WhatsAppConversationProfile {
  match: 'manual' | 'phone' | null
  customer: Customer | null
  contactId: string | null
  deals: Array<{ id: string; title: string; amount: number; currency: string; stage: string; expectedClose: string; updatedAt: number }>
}

export interface WhatsAppMessage {
  id: string
  conversationId: string
  direction: WhatsAppMessageDirection
  type: 'text'
  body: string
  status: WhatsAppMessageStatus
  failureReason: string | null
  createdAt: number
  updatedAt: number
}

export interface WhatsAppConversationPage {
  items: WhatsAppConversation[]
  total: number
  hasMore: boolean
}

export interface WhatsAppMessagePage {
  items: WhatsAppMessage[]
  hasMore: boolean
  nextCursor: string | null
}

export type WhatsAppTranslatorKind = 'local' | 'cloud' | 'llm'

export interface WhatsAppTranslation {
  provider: string
  kind: WhatsAppTranslatorKind
  text: string
  sourceLang: string
  targetLang: string
  /** 用户请求的目标语言；选择 auto 时与 targetLang 不同 */
  requestedTarget: string
}

/**
 * 目标语言顺序与服务端 `TRANSLATOR_TARGET_LANGUAGES` 一致。
 * `en` 是默认项；`auto` 必须由用户显式选择，不能当成默认值。
 */
export const WHATSAPP_TRANSLATOR_TARGETS = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'ru',
  'es',
  'pt',
  'fr',
  'de',
  'ar',
  'th',
  'vi',
  'id',
  'auto',
] as const

export type WhatsAppTranslatorTarget = (typeof WHATSAPP_TRANSLATOR_TARGETS)[number]

export const getWhatsAppStatus = (silent = true): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/status', { silent })

export const acceptWhatsAppRisk = (): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/risk-acceptance', { method: 'POST', body: {} })

export const startWhatsAppLink = (mode: WhatsAppLinkMode, phone?: string): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/link/start', { method: 'POST', body: { mode, phone } })

export const requestWhatsAppPairingCode = (phone: string): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/link/pairing-code', { method: 'POST', body: { phone } })

export const refreshWhatsAppQr = (): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/link/refresh-qr', { method: 'POST', body: {} })

export const stopWhatsAppLink = (): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/link/stop', { method: 'POST', body: {} })

export const logoutWhatsApp = (): Promise<WhatsAppStatus> =>
  request('/api/whatsapp/logout', { method: 'POST', body: { confirm: true } })

// ---------------------------------------------------------------- 会话与消息（§12.3）

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export const listWhatsAppConversations = (
  params: {
    limit?: number
    offset?: number
    filter?: WhatsAppConversationFilter
    tag?: string
    q?: string
    sort?: WhatsAppConversationSort
  } = {},
  silent = true,
): Promise<WhatsAppConversationPage> =>
  request(withQuery('/api/whatsapp/conversations', params), { silent })

export type WhatsAppConversationSort = 'recent' | 'unread'

/** 快捷回复：每个人自己的常用回复片段 */
export interface WhatsAppQuickReply {
  id: string
  title: string
  body: string
  position: number
  createdAt: number
  updatedAt: number
}

export const listWhatsAppQuickReplies = (silent = true): Promise<{ items: WhatsAppQuickReply[] }> =>
  request('/api/whatsapp/quick-replies', { silent })

export const createWhatsAppQuickReply = (input: { title: string; body: string }): Promise<WhatsAppQuickReply> =>
  request('/api/whatsapp/quick-replies', { method: 'POST', body: input })

export const deleteWhatsAppQuickReply = (id: string): Promise<void> =>
  request(`/api/whatsapp/quick-replies/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const getWhatsAppConversationCounts = (silent = true): Promise<WhatsAppConversationCounts> =>
  request('/api/whatsapp/conversations/counts', { silent })

export const updateWhatsAppConversation = (
  conversationId: string,
  patch: { archived?: boolean; pinned?: boolean; tags?: string[]; customerId?: string | null; draft?: null },
): Promise<WhatsAppConversation> =>
  request(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}`, { method: 'PATCH', body: patch })

export const getWhatsAppConversationProfile = (
  conversationId: string,
  silent = true,
): Promise<WhatsAppConversationProfile> =>
  request(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}/profile`, { silent })

export const createWhatsAppConversation = (
  phone: string,
  displayName?: string,
): Promise<WhatsAppConversation> =>
  request('/api/whatsapp/conversations', {
    method: 'POST',
    body: displayName ? { phone, displayName } : { phone },
  })

export const getWhatsAppMessages = (
  conversationId: string,
  params: { limit?: number; before?: string | null } = {},
  silent = true,
): Promise<WhatsAppMessagePage> =>
  request(
    withQuery(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`, {
      limit: params.limit,
      before: params.before ?? undefined,
    }),
    { silent },
  )

export const sendWhatsAppMessage = (
  conversationId: string,
  text: string,
): Promise<WhatsAppMessage> =>
  request(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { text },
  })

export const retryWhatsAppMessage = (messageId: string): Promise<WhatsAppMessage> =>
  request(`/api/whatsapp/messages/${encodeURIComponent(messageId)}/retry`, {
    method: 'POST',
    body: {},
  })

export const markWhatsAppConversationRead = (
  conversationId: string,
  silent = true,
): Promise<WhatsAppConversation> =>
  request(`/api/whatsapp/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: 'POST',
    body: {},
    silent,
  })

export const translateWhatsAppText = (
  input: {
    text: string
    targetLang?: string
    sourceLang?: string
    conversationId?: string
  },
  silent = true,
): Promise<WhatsAppTranslation> =>
  request('/api/whatsapp/translate', { method: 'POST', body: input, silent })

// ------------------------------------------------ 出口代理（单个，作用于本机关联的 WhatsApp 账号）

export type WhatsAppProxyProtocol = 'socks5' | 'http' | 'https'

export interface WhatsAppProxy {
  protocol: WhatsAppProxyProtocol
  host: string
  port: number
  username: string
  hasPassword: boolean
  updatedAt: string
}

export interface WhatsAppProxyInput {
  protocol: WhatsAppProxyProtocol
  host: string
  port: number
  username?: string
  /** 不传 = 保留原密码；空字符串 = 清除 */
  password?: string
}

export interface WhatsAppProxyTest {
  ok: boolean
  ip?: string
  country?: string
  city?: string
  latencyMs?: number
  error?: string
}

export const getWhatsAppProxy = (): Promise<{ proxy: WhatsAppProxy | null }> =>
  request('/api/whatsapp/proxy', { silent: true })

export const saveWhatsAppProxy = (input: WhatsAppProxyInput): Promise<{ proxy: WhatsAppProxy | null; reconnected: boolean }> =>
  request('/api/whatsapp/proxy', { method: 'PUT', body: input })

export const clearWhatsAppProxy = (): Promise<{ proxy: null; reconnected: boolean }> =>
  request('/api/whatsapp/proxy', { method: 'DELETE' })

export const testWhatsAppProxy = (proxy?: WhatsAppProxyInput): Promise<WhatsAppProxyTest> =>
  request('/api/whatsapp/proxy/test', { method: 'POST', body: proxy ? { proxy } : {} })
