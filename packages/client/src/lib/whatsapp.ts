import { reactive } from 'vue'
import {
  getWhatsAppConversationCounts,
  getWhatsAppMessages,
  getWhatsAppStatus,
  updateWhatsAppConversation,
  listWhatsAppConversations,
  markWhatsAppConversationRead as markConversationRead,
  retryWhatsAppMessage,
  sendWhatsAppMessage,
  type WhatsAppConnection,
  type WhatsAppConversation,
  type WhatsAppConversationCounts,
  type WhatsAppConversationFilter,
  type WhatsAppConversationSort,
  type WhatsAppMessage,
  type WhatsAppStatus,
} from '../api/whatsapp'
import { onServerEvent } from '../stores/events'

export type { WhatsAppConnection }

/**
 * WhatsApp 关联设备的共享状态：绑定页与侧栏状态点读同一份服务端快照。
 * 状态只由 `GET /api/whatsapp/status` 与 `/api/events` 的 `whatsapp.status` 更新，
 * 客户端不推断「已连接」，也不生成占位二维码。
 */
export const whatsappShell = reactive<{
  unread: number
  connection: WhatsAppConnection
  status: WhatsAppStatus | null
  loaded: boolean
  loadError: string
}>({
  unread: 0,
  connection: 'disconnected',
  status: null,
  loaded: false,
  loadError: '',
})

/**
 * 会话与消息的页面状态。所有字段都来自服务端接口/SSE；唯一的本地临时项是发送中的
 * `local-*` 消息，它在服务端返回或 SSE 到达后立即被真实 id 替换。
 */
export const whatsappChats = reactive<{
  /** 列表筛选（服务端过滤）；tag 非空时只看带该标签的未归档会话 */
  filter: WhatsAppConversationFilter
  tag: string | null
  /** 左栏搜索（名称 / 号码 / 关联客户公司名，服务端过滤） */
  q: string
  /** 列表排序：最近消息 / 未读优先 */
  sort: WhatsAppConversationSort
  counts: WhatsAppConversationCounts
  conversations: WhatsAppConversation[]
  total: number
  hasMore: boolean
  conversationsLoaded: boolean
  conversationsLoading: boolean
  conversationsError: string
  activeId: string | null
  messages: WhatsAppMessage[]
  messagesLoaded: boolean
  messagesLoading: boolean
  messagesError: string
  messagesHasMore: boolean
  messagesCursor: string | null
  olderLoading: boolean
}>({
  filter: 'all',
  tag: null,
  q: '',
  sort: 'recent',
  counts: { all: 0, unread: 0, pending: 0, archived: 0, tags: [] },
  conversations: [],
  total: 0,
  hasMore: false,
  conversationsLoaded: false,
  conversationsLoading: false,
  conversationsError: '',
  activeId: null,
  messages: [],
  messagesLoaded: false,
  messagesLoading: false,
  messagesError: '',
  messagesHasMore: false,
  messagesCursor: null,
  olderLoading: false,
})

let started = false
let offStatus: (() => void) | null = null
let refreshSeq = 0
let conversationSeq = 0
let messageSeq = 0
let localSeq = 0
let offChatMessage: (() => void) | null = null
let offChatConversation: (() => void) | null = null
let previousConnection: WhatsAppConnection | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 与服务端同一排序：置顶在前（新置顶在上），其余按最近消息 */
function sortConversations(items: WhatsAppConversation[]): WhatsAppConversation[] {
  return items.sort((a, b) => {
    const pa = a.pinnedAt ?? 0
    const pb = b.pinnedAt ?? 0
    if (Boolean(pa) !== Boolean(pb)) return pa ? -1 : 1
    if (pa !== pb) return pb - pa
    if (whatsappChats.sort === 'unread' && Boolean(a.unreadCount) !== Boolean(b.unreadCount)) return a.unreadCount ? -1 : 1
    return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt)
  })
}

/** 会话是否属于当前筛选（SSE 推来的变化据此决定留在列表还是移出） */
export function matchesWhatsAppFilter(item: WhatsAppConversation): boolean {
  const archived = item.archivedAt != null
  if (whatsappChats.filter === 'archived') return archived
  if (archived) return false
  if (whatsappChats.tag && !(item.tags ?? []).includes(whatsappChats.tag)) return false
  if (whatsappChats.filter === 'unread' && item.unreadCount <= 0) return false
  if (whatsappChats.filter === 'pending' && item.lastMessageDirection !== 'in') return false
  const q = whatsappChats.q.trim().toLowerCase()
  if (q) {
    const digits = q.replace(/\D/g, '')
    const hit =
      item.displayName.toLowerCase().includes(q) ||
      (item.customerName ?? '').toLowerCase().includes(q) ||
      (digits.length >= 3 && item.phone.replace(/\D/g, '').includes(digits))
    if (!hit) return false
  }
  return true
}

let countsTimer: ReturnType<typeof setTimeout> | null = null
/** 左栏计数：合并多次变化，300ms 内只拉一次 */
export function refreshWhatsAppCounts(): void {
  if (countsTimer) clearTimeout(countsTimer)
  countsTimer = setTimeout(() => {
    countsTimer = null
    getWhatsAppConversationCounts(true)
      .then((counts) => {
        whatsappChats.counts = counts
      })
      .catch(() => undefined)
  }, 300)
}

/** 切换筛选并重新拉列表 */
export async function setWhatsAppFilter(filter: WhatsAppConversationFilter, tag: string | null = null): Promise<void> {
  whatsappChats.filter = filter
  whatsappChats.tag = filter === 'archived' ? null : tag
  conversationSeq += 1
  whatsappChats.conversationsLoading = false
  await loadWhatsAppConversations()
}

/** 搜索与排序（服务端过滤 / 排序后重新拉列表） */
export async function setWhatsAppQuery(q: string): Promise<void> {
  if (whatsappChats.q === q) return
  whatsappChats.q = q
  conversationSeq += 1
  whatsappChats.conversationsLoading = false
  await loadWhatsAppConversations()
}
export async function setWhatsAppSort(sort: WhatsAppConversationSort): Promise<void> {
  whatsappChats.sort = sort
  conversationSeq += 1
  whatsappChats.conversationsLoading = false
  await loadWhatsAppConversations()
}

/** 归档 / 置顶 / 标签 / 关联客户，成功后合并到列表并刷新计数 */
export async function patchWhatsAppConversation(
  id: string,
  patch: Parameters<typeof updateWhatsAppConversation>[1],
): Promise<WhatsAppConversation> {
  const updated = await updateWhatsAppConversation(id, patch)
  mergeWhatsAppConversation(updated)
  return updated
}

function syncUnread(): void {
  // 只有“全部会话”列表能代表总未读；其他筛选下保留原值
  if (whatsappChats.filter !== 'all' || whatsappChats.tag || whatsappChats.q) return
  whatsappShell.unread = whatsappChats.conversations.reduce(
    (sum, item) => sum + Math.max(0, item.unreadCount),
    0,
  )
}

/** 合并一条会话（SSE 或接口返回值），已存在则原位更新并置顶。 */
export function mergeWhatsAppConversation(conversation: WhatsAppConversation): void {
  if (!conversation?.id) return
  const index = whatsappChats.conversations.findIndex((item) => item.id === conversation.id)
  const keep = matchesWhatsAppFilter(conversation) || conversation.id === whatsappChats.activeId
  // SSE 推来的会话不带公司名，沿用列表里已有的
  if (index >= 0 && conversation.customerName === undefined) {
    conversation = { ...conversation, customerName: whatsappChats.conversations[index]!.customerName }
  }
  if (index >= 0 && keep) whatsappChats.conversations.splice(index, 1, conversation)
  else if (index >= 0) whatsappChats.conversations.splice(index, 1)
  else if (keep) whatsappChats.conversations.push(conversation)
  whatsappChats.conversations = sortConversations(whatsappChats.conversations)
  refreshWhatsAppCounts()
  if (whatsappChats.conversationsLoaded && whatsappChats.total < whatsappChats.conversations.length) {
    whatsappChats.total = whatsappChats.conversations.length
  }
  syncUnread()
}

/** 按时间升序合并一条消息；发送中的本地占位消息按「同会话 + 同方向 + 同正文」替换。 */
export function mergeWhatsAppMessage(message: WhatsAppMessage): void {
  if (!message?.id || message.conversationId !== whatsappChats.activeId) return
  const index = whatsappChats.messages.findIndex((item) => item.id === message.id)
  if (index >= 0) {
    whatsappChats.messages.splice(index, 1, message)
    return
  }
  const localIndex = whatsappChats.messages.findIndex(
    (item) =>
      item.id.startsWith('local-') &&
      item.direction === message.direction &&
      item.body === message.body &&
      item.status === 'sending',
  )
  if (localIndex >= 0) {
    whatsappChats.messages.splice(localIndex, 1, message)
    return
  }
  whatsappChats.messages.push(message)
  whatsappChats.messages = whatsappChats.messages.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )
}

/** 本地更新会话摘要，避免 SSE 未连上时列表仍是旧预览。 */
function touchConversation(message: WhatsAppMessage): void {
  const conversation = whatsappChats.conversations.find((item) => item.id === message.conversationId)
  if (!conversation) return
  mergeWhatsAppConversation({
    ...conversation,
    lastMessageAt: message.createdAt,
    lastMessagePreview: message.body.replace(/\s+/g, ' ').trim().slice(0, 160),
    lastMessageDirection: message.direction,
    updatedAt: message.updatedAt,
  })
}

export function resetWhatsAppChats(): void {
  conversationSeq += 1
  messageSeq += 1
  Object.assign(whatsappChats, {
    filter: 'all',
    tag: null,
    q: '',
    sort: 'recent',
    counts: { all: 0, unread: 0, pending: 0, archived: 0, tags: [] },
    conversations: [],
    total: 0,
    hasMore: false,
    conversationsLoaded: false,
    conversationsLoading: false,
    conversationsError: '',
    activeId: null,
    messages: [],
    messagesLoaded: false,
    messagesLoading: false,
    messagesError: '',
    messagesHasMore: false,
    messagesCursor: null,
    olderLoading: false,
  })
  syncUnread()
}

/** 拉取会话列表。`append` 用于「加载更多」，否则整页替换。 */
export async function loadWhatsAppConversations(
  options: { append?: boolean; silent?: boolean } = {},
): Promise<void> {
  const { append = false, silent = true } = options
  if (whatsappChats.conversationsLoading) return
  const seq = ++conversationSeq
  whatsappChats.conversationsLoading = true
  whatsappChats.conversationsError = ''
  try {
    const page = await listWhatsAppConversations(
      {
        limit: 30,
        offset: append ? whatsappChats.conversations.length : 0,
        filter: whatsappChats.filter,
        tag: whatsappChats.tag ?? undefined,
        q: whatsappChats.q.trim() || undefined,
        sort: whatsappChats.sort,
      },
      silent,
    )
    if (seq !== conversationSeq) return
    if (append) {
      const known = new Set(whatsappChats.conversations.map((item) => item.id))
      whatsappChats.conversations.push(...page.items.filter((item) => !known.has(item.id)))
      whatsappChats.conversations = sortConversations(whatsappChats.conversations)
    } else {
      whatsappChats.conversations = sortConversations([...page.items])
    }
    whatsappChats.total = page.total
    whatsappChats.hasMore = page.hasMore
    whatsappChats.conversationsLoaded = true
    syncUnread()
    refreshWhatsAppCounts()
  } catch (error) {
    if (seq === conversationSeq) whatsappChats.conversationsError = errorMessage(error)
    throw error
  } finally {
    if (seq === conversationSeq) whatsappChats.conversationsLoading = false
  }
}

/** 拉取某个会话的消息；`before` 用于向上翻页。 */
export async function loadWhatsAppMessages(
  conversationId: string,
  options: { before?: string | null; silent?: boolean } = {},
): Promise<void> {
  const { before = null, silent = true } = options
  const seq = ++messageSeq
  const older = Boolean(before)
  if (older) whatsappChats.olderLoading = true
  else {
    whatsappChats.messagesLoading = true
    whatsappChats.messagesLoaded = false
    whatsappChats.messagesError = ''
  }
  try {
    const page = await getWhatsAppMessages(conversationId, { limit: 50, before }, silent)
    if (seq !== messageSeq || whatsappChats.activeId !== conversationId) return
    if (older) {
      const known = new Set(whatsappChats.messages.map((item) => item.id))
      whatsappChats.messages = [...page.items.filter((item) => !known.has(item.id)), ...whatsappChats.messages]
    } else {
      whatsappChats.messages = page.items
    }
    whatsappChats.messagesHasMore = page.hasMore
    whatsappChats.messagesCursor = page.nextCursor
    whatsappChats.messagesLoaded = true
  } catch (error) {
    if (seq === messageSeq) whatsappChats.messagesError = errorMessage(error)
    throw error
  } finally {
    if (seq === messageSeq) {
      whatsappChats.messagesLoading = false
      whatsappChats.olderLoading = false
    }
  }
}

/** 选中会话：清空旧消息、拉历史，成功后把该会话标记为已读。 */
export async function selectWhatsAppConversation(conversationId: string): Promise<void> {
  if (!conversationId) return
  whatsappChats.activeId = conversationId
  messageSeq += 1
  whatsappChats.messages = []
  whatsappChats.messagesLoaded = false
  whatsappChats.messagesError = ''
  whatsappChats.messagesHasMore = false
  whatsappChats.messagesCursor = null
  await loadWhatsAppMessages(conversationId)
  await markWhatsAppChatRead(conversationId).catch(() => undefined)
}

/** 标记已读并同步本地未读数。失败时保留原值，不用乐观假设覆盖服务端。 */
export async function markWhatsAppChatRead(conversationId: string): Promise<void> {
  const conversation = await markConversationRead(conversationId, true)
  mergeWhatsAppConversation(conversation)
}

/** 发送文本：先插入本地 sending 占位，服务端返回后替换为真实消息。 */
export async function sendWhatsAppChatMessage(text: string): Promise<WhatsAppMessage> {
  const conversationId = whatsappChats.activeId
  if (!conversationId) throw new Error('No active WhatsApp conversation')
  const body = text.trim()
  if (!body) throw new Error('Message is empty')
  const now = Date.now()
  const local: WhatsAppMessage = {
    id: `local-${++localSeq}`,
    conversationId,
    direction: 'out',
    type: 'text',
    body,
    status: 'sending',
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  }
  whatsappChats.messages.push(local)
  try {
    const saved = await sendWhatsAppMessage(conversationId, body)
    mergeWhatsAppMessage(saved)
    touchConversation(saved)
    return saved
  } catch (error) {
    const details = (error as { details?: { messageId?: string } }).details
    const index = whatsappChats.messages.findIndex((item) => item.id === local.id)
    if (details?.messageId) {
      const stored: WhatsAppMessage = {
        ...local,
        id: details.messageId,
        status: 'failed',
        failureReason: errorMessage(error),
        updatedAt: Date.now(),
      }
      if (index >= 0) whatsappChats.messages.splice(index, 1, stored)
      else mergeWhatsAppMessage(stored)
      touchConversation(stored)
    } else if (index >= 0) {
      whatsappChats.messages.splice(index, 1)
    }
    throw error
  }
}

/** 重试失败消息：重试的是同一行，不新增消息。 */
export async function retryWhatsAppChatMessage(messageId: string): Promise<WhatsAppMessage> {
  const index = whatsappChats.messages.findIndex((item) => item.id === messageId)
  if (index >= 0) {
    whatsappChats.messages.splice(index, 1, {
      ...whatsappChats.messages[index]!,
      status: 'sending',
      failureReason: null,
      updatedAt: Date.now(),
    })
  }
  try {
    const saved = await retryWhatsAppMessage(messageId)
    mergeWhatsAppMessage(saved)
    touchConversation(saved)
    return saved
  } catch (error) {
    if (index >= 0) {
      whatsappChats.messages.splice(index, 1, {
        ...whatsappChats.messages[index]!,
        status: 'failed',
        failureReason: errorMessage(error),
        updatedAt: Date.now(),
      })
    }
    throw error
  }
}

function onChatMessage(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const message = data as WhatsAppMessage
  if (typeof message.id !== 'string' || typeof message.conversationId !== 'string') return
  mergeWhatsAppMessage(message)
  if (message.direction === 'in' && message.conversationId === whatsappChats.activeId) {
    void markWhatsAppChatRead(message.conversationId).catch(() => undefined)
  }
}

function onChatConversation(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const conversation = data as WhatsAppConversation
  if (typeof conversation.id !== 'string') return
  mergeWhatsAppConversation(conversation)
}

/** 会话页挂载时订阅消息/会话增量；卸载时取消。 */
export function startWhatsAppChatEvents(): void {
  if (offChatMessage) return
  offChatMessage = onServerEvent('whatsapp.message', onChatMessage)
  offChatConversation = onServerEvent('whatsapp.conversation', onChatConversation)
}

export function stopWhatsAppChatEvents(): void {
  offChatMessage?.()
  offChatConversation?.()
  offChatMessage = null
  offChatConversation = null
}

export function setWhatsAppStatus(status: WhatsAppStatus | null): void {
  const connection = status?.connection ?? 'disconnected'
  whatsappShell.status = status
  whatsappShell.connection = connection
  whatsappShell.loaded = true
  whatsappShell.loadError = ''
  const justConnected =
    Boolean(status) && connection === 'connected' && previousConnection !== 'connected'
  previousConnection = status ? connection : null
  if (justConnected && !whatsappChats.conversationsLoaded && !whatsappChats.conversationsLoading) {
    void loadWhatsAppConversations().catch(() => undefined)
  }
}

/** 拉取一次服务端状态；并发触发时只认最后一次。失败时保留上一份状态。 */
export async function refreshWhatsAppStatus(silent = true): Promise<WhatsAppStatus> {
  const seq = ++refreshSeq
  try {
    const status = await getWhatsAppStatus(silent)
    if (seq === refreshSeq) setWhatsAppStatus(status)
    return status
  } catch (error) {
    if (seq === refreshSeq) {
      whatsappShell.loaded = true
      whatsappShell.loadError = error instanceof Error ? error.message : String(error)
    }
    throw error
  }
}

function onFocus(): void {
  void refreshWhatsAppStatus().catch(() => undefined)
}

/**
 * AppLayout 挂载时启动：订阅全局事件并拉一次初始状态。
 * 侧栏在任何页面都能看到真实四态，不必先打开绑定页。
 */
export function startWhatsAppStatus(): void {
  if (started) return
  started = true
  offStatus = onServerEvent('whatsapp.status', (data) => {
    if (data && typeof data === 'object') setWhatsAppStatus(data as WhatsAppStatus)
  })
  void refreshWhatsAppStatus().catch(() => undefined)
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
}

export function stopWhatsAppStatus(): void {
  started = false
  offStatus?.()
  offStatus = null
  if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
}
