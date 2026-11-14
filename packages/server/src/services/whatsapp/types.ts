/**
 * WhatsApp 关联设备通道的类型定义。
 * 对外只暴露四态连接（与侧栏状态点同一枚举）；内部阶段更细，用于绑定页分区显示。
 */
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
  /** 二维码图片（data:image/png;base64,... / data:image/svg+xml;base64,...） */
  dataUrl: string
  issuedAt: number
  expiresAt: number
  /** 本次绑定已经换过多少张二维码（连续过期计数，用于 6 次后降级提示） */
  refreshCount: number
  /** 连续 6 次过期：提示检查手机网络 */
  warning: boolean
  expired: boolean
}

export interface WhatsAppPairing {
  /** 8 位配对码，只存在内存与当前界面，不落盘、不写日志 */
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
  /** 二维码渲染库是否随引擎安装（配对码模式不依赖它） */
  qrAvailable: boolean
  error: WhatsAppErrorInfo | null
}

export interface WhatsAppReconnectInfo {
  attempt: number
  maxAttempts: number
  nextAt: number
}

export interface WhatsAppRiskInfo {
  accepted: boolean
  acceptedAt: number | null
  expiresAt: number | null
  version: string | null
}

/** GET /api/whatsapp/status 的响应（契约 §12） */
export interface WhatsAppStatus {
  accountId: string
  phase: WhatsAppPhase
  connection: WhatsAppConnection
  mode: WhatsAppLinkMode | null
  engine: WhatsAppEngineInfo
  account: WhatsAppAccountInfo | null
  qr: WhatsAppQr | null
  pairing: WhatsAppPairing | null
  reconnect: WhatsAppReconnectInfo | null
  error: WhatsAppErrorInfo | null
  risk: WhatsAppRiskInfo
  limits: {
    linkedDevices: 4
    phoneOfflineDays: 14
    deviceIdleDays: 30
  }
  updatedAt: number
}

export interface WhatsAppStartInput {
  mode: WhatsAppLinkMode
  phone?: string
}

/** 引擎事件。真实适配器与测试替身都只通过这组事件驱动状态机。 */
export type WhatsAppEngineEvent =
  | { type: 'connecting' }
  | { type: 'qr'; dataUrl: string }
  | { type: 'pairing'; code: string; phone: string }
  | { type: 'open'; account: WhatsAppAccountInfo }
  | {
      type: 'close'
      statusCode: number | null
      reason: string
      loggedOut: boolean
      replaced: boolean
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'message'; message: WhatsAppIncomingMessage }

/** 会话与消息（契约 §12.3）。 */
export type WhatsAppMessageDirection = 'in' | 'out'
export type WhatsAppMessageStatus = 'received' | 'sending' | 'sent' | 'failed'

export interface WhatsAppConversation {
  id: string
  remoteJid: string
  phone: string
  displayName: string
  /** 手动关联的 CRM 客户（必须是当前用户可见的客户） */
  customerId: string | null
  lastMessageAt: number | null
  lastMessagePreview: string
  lastMessageDirection: WhatsAppMessageDirection | null
  unreadCount: number
  /** 归档时间；归档的会话不在默认列表里 */
  archivedAt: number | null
  /** 置顶时间；置顶的排在最前 */
  pinnedAt: number | null
  /** 会话标签（只属于这个号的会话） */
  tags: string[]
  /** LULUX 起草、尚未发送的回复 */
  draft: { text: string; createdAt: number } | null
  createdAt: number
  updatedAt: number
}

/** 会话列表筛选：all 不含已归档；pending = 最后一条是对方发来的（待回复） */
export type WhatsAppConversationFilter = 'all' | 'unread' | 'pending' | 'archived'

export interface WhatsAppConversationCounts {
  all: number
  unread: number
  pending: number
  archived: number
  tags: Array<{ tag: string; count: number }>
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

export interface WhatsAppIncomingMessage {
  /** 引擎侧消息 id（用于去重） */
  id: string
  remoteJid: string
  phone: string
  displayName: string
  text: string
  timestamp: number
}

export interface WhatsAppOutgoingMessage {
  remoteJid: string
  text: string
}

export interface WhatsAppSendResult {
  id: string
  timestamp: number
}

export type WhatsAppEngineListener = (event: WhatsAppEngineEvent) => void

export interface WhatsAppStartOptions {
  mode: WhatsAppLinkMode
  phone?: string
  /** 引擎写入凭据的目录；目录由凭据层创建，权限 700 */
  credentialsDir: string
  /** 该号的出口代理（WebSocket 与媒体下载都走它）；不传 = 直连 */
  agent?: import('node:http').Agent
}

/**
 * 引擎适配器：M0 可以替换为 whatsapp-web.js 或离线包，业务层不改。
 * `requestPairingCode` 是 Baileys 能力；不支持配对码的引擎必须显式抛
 * `PAIRING_UNSUPPORTED`，不能静默降级成扫码。
 */
export interface WhatsAppEngineAdapter {
  readonly id: string
  start(options: WhatsAppStartOptions): Promise<void>
  stop(): Promise<void>
  logout(): Promise<void>
  requestPairingCode(phone: string): Promise<{ code: string; phone: string }>
  /** 重新建立连接以获取新二维码（真实引擎无独立刷新 API） */
  refreshQr(): Promise<void>
  /** 发送文本消息；引擎不可用必须显式抛错，不能静默丢弃 */
  sendText(message: WhatsAppOutgoingMessage): Promise<WhatsAppSendResult>
  onEvent(listener: WhatsAppEngineListener): () => void
}

export interface WhatsAppEngineFactoryContext {
  engineDir: string | null
  credentialsDir: string
}

export type WhatsAppEngineFactory = (
  context: WhatsAppEngineFactoryContext,
) => WhatsAppEngineAdapter

export const WHATSAPP_QR_TTL_MS = 20_000
export const WHATSAPP_PAIRING_TTL_MS = 240_000
export const WHATSAPP_RISK_TTL_MS = 30 * 86_400_000
export const WHATSAPP_MAX_QR_REFRESHES = 6
export const WHATSAPP_RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 30_000] as const
