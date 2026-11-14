import { db } from '../../db.js'
import { newId } from '../../utils/id.js'
import type {
  WhatsAppConversation,
  WhatsAppConversationCounts,
  WhatsAppConversationFilter,
  WhatsAppIncomingMessage,
  WhatsAppMessage,
  WhatsAppMessageDirection,
  WhatsAppMessageStatus,
} from './types.js'

/**
 * WhatsApp 会话/消息存储（迁移 38）。
 *
 * - 所有查询都必须带 `owner_id`：WhatsApp 是本机单账号绑定，只允许绑定者读取自己的会话；
 * - 消息只支持文本，状态机为 `received / sending / sent / failed`；
 * - 入站消息按引擎消息 id 去重，重连同步历史不会重复计数；
 * - `customer_id` 只记录手动关联的客户 id，不写任何 CRM 表；
 * - `draft_text` 是 LULUX 起草的回复，只存不发，由用户在会话页采用或丢弃。
 */

interface ConversationRow {
  id: string
  owner_id: string
  org_id: string
  remote_jid: string
  phone: string
  display_name: string
  customer_id: string | null
  last_message_at: number | null
  last_message_preview: string
  last_message_direction: string | null
  unread_count: number
  archived_at: number | null
  pinned_at: number | null
  tags: string
  draft_text: string | null
  draft_at: number | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  owner_id: string
  direction: string
  type: string
  body: string
  status: string
  failure_reason: string | null
  engine_message_id: string | null
  created_at: number
  updated_at: number
}

function mapConversation(row: ConversationRow): WhatsAppConversation {
  return {
    id: row.id,
    remoteJid: row.remote_jid,
    phone: row.phone,
    displayName: row.display_name,
    customerId: row.customer_id,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageDirection:
      row.last_message_direction === 'in' || row.last_message_direction === 'out'
        ? row.last_message_direction
        : null,
    unreadCount: Number(row.unread_count ?? 0),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    pinnedAt: row.pinned_at == null ? null : Number(row.pinned_at),
    tags: parseTags(row.tags),
    draft: row.draft_text ? { text: row.draft_text, createdAt: Number(row.draft_at ?? row.updated_at) } : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapMessage(row: MessageRow): WhatsAppMessage {
  const direction: WhatsAppMessageDirection = row.direction === 'out' ? 'out' : 'in'
  const status = row.status as WhatsAppMessageStatus
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction,
    type: 'text',
    body: row.body,
    status: ['received', 'sending', 'sent', 'failed'].includes(status) ? status : 'failed',
    failureReason: row.failure_reason,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export interface WhatsAppConversationPage {
  items: WhatsAppConversation[]
  total: number
  hasMore: boolean
}

export interface WhatsAppMessagePage {
  items: WhatsAppMessage[]
  hasMore: boolean
  /** 传给下一次分页请求的游标（当前最旧一条消息的 id） */
  nextCursor: string | null
}

const FILTER_SQL: Record<WhatsAppConversationFilter, string> = {
  all: 'archived_at IS NULL',
  unread: 'archived_at IS NULL AND unread_count > 0',
  pending: "archived_at IS NULL AND last_message_direction = 'in'",
  archived: 'archived_at IS NOT NULL',
}

export function listConversations(
  ownerId: string,
  options: {
    limit?: number
    offset?: number
    filter?: WhatsAppConversationFilter
    tag?: string
    /** 搜索：名称 / 号码 / 手动关联客户的公司名 */
    q?: string
    /** recent = 最近消息；unread = 未读优先 */
    sort?: 'recent' | 'unread'
  } = {},
): WhatsAppConversationPage {
  const limit = clamp(options.limit ?? 30, 1, 100)
  const offset = Math.max(0, options.offset ?? 0)
  let where = `owner_id = ? AND ${FILTER_SQL[options.filter ?? 'all']}`
  const params: Array<string | number> = [ownerId]
  if (options.tag) {
    where += ' AND EXISTS (SELECT 1 FROM json_each(whatsapp_conversations.tags) WHERE value = ?)'
    params.push(options.tag)
  }
  const q = options.q?.trim()
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const digits = q.replace(/\D/g, '')
    where += ` AND (display_name LIKE ? ESCAPE '\\'
      OR customer_id IN (SELECT id FROM customers WHERE company LIKE ? ESCAPE '\\')${digits.length >= 3 ? ' OR phone LIKE ?' : ''})`
    params.push(like, like)
    if (digits.length >= 3) params.push(`%${digits}%`)
  }
  const unreadFirst = options.sort === 'unread' ? '(unread_count = 0), ' : ''
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM whatsapp_conversations WHERE ${where}`)
    .get(...params) as unknown as { n: number }
  const rows = db
    .prepare(
      `SELECT * FROM whatsapp_conversations
       WHERE ${where}
       ORDER BY (pinned_at IS NULL), pinned_at DESC, ${unreadFirst}COALESCE(last_message_at, created_at) DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset) as unknown as ConversationRow[]
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(mapConversation),
    total: Number(totalRow.n ?? 0),
    hasMore,
  }
}

/** 左栏计数：全部 / 未读 / 待回复 / 已归档，以及未归档会话的标签分布 */
export function conversationCounts(ownerId: string): WhatsAppConversationCounts {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN ${FILTER_SQL.all} THEN 1 ELSE 0 END) AS a,
         SUM(CASE WHEN ${FILTER_SQL.unread} THEN 1 ELSE 0 END) AS u,
         SUM(CASE WHEN ${FILTER_SQL.pending} THEN 1 ELSE 0 END) AS p,
         SUM(CASE WHEN ${FILTER_SQL.archived} THEN 1 ELSE 0 END) AS r
       FROM whatsapp_conversations WHERE owner_id = ?`,
    )
    .get(ownerId) as unknown as { a: number | null; u: number | null; p: number | null; r: number | null }
  const tags = db
    .prepare(
      `SELECT j.value AS tag, COUNT(*) AS n
       FROM whatsapp_conversations c, json_each(c.tags) j
       WHERE c.owner_id = ? AND c.archived_at IS NULL
       GROUP BY j.value ORDER BY n DESC, j.value LIMIT 30`,
    )
    .all(ownerId) as unknown as Array<{ tag: string; n: number }>
  return {
    all: Number(row.a ?? 0),
    unread: Number(row.u ?? 0),
    pending: Number(row.p ?? 0),
    archived: Number(row.r ?? 0),
    tags: tags.map((t) => ({ tag: String(t.tag), count: Number(t.n) })),
  }
}

/** 整理会话：归档 / 取消归档、置顶、标签、手动关联客户（只改自己的会话） */
export function updateConversationMeta(
  ownerId: string,
  conversationId: string,
  patch: { archived?: boolean; pinned?: boolean; tags?: string[]; customerId?: string | null },
): WhatsAppConversation | null {
  const current = db
    .prepare('SELECT * FROM whatsapp_conversations WHERE id = ? AND owner_id = ?')
    .get(conversationId, ownerId) as unknown as ConversationRow | undefined
  if (!current) return null
  const now = Date.now()
  const archivedAt = patch.archived === undefined ? current.archived_at : patch.archived ? (current.archived_at ?? now) : null
  const pinnedAt = patch.pinned === undefined ? current.pinned_at : patch.pinned ? (current.pinned_at ?? now) : null
  const tags = patch.tags === undefined ? current.tags : JSON.stringify(normalizeTags(patch.tags))
  const customerId = patch.customerId === undefined ? current.customer_id : patch.customerId
  db.prepare(
    `UPDATE whatsapp_conversations
     SET archived_at = ?, pinned_at = ?, tags = ?, customer_id = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(archivedAt, pinnedAt, tags, customerId, now, conversationId, ownerId)
  return findConversation(ownerId, conversationId)
}

/** LULUX 起草的回复：text 为 null 时清除（用户采用或丢弃后） */
export function setConversationDraft(ownerId: string, conversationId: string, text: string | null): WhatsAppConversation | null {
  const now = Date.now()
  const result = db
    .prepare('UPDATE whatsapp_conversations SET draft_text = ?, draft_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
    .run(text, text === null ? null : now, now, conversationId, ownerId)
  return Number(result.changes) > 0 ? findConversation(ownerId, conversationId) : null
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = String(raw).replace(/\s+/g, ' ').trim().slice(0, 20)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 8) break
  }
  return out
}

function parseTags(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function findConversation(ownerId: string, conversationId: string): WhatsAppConversation | null {
  const row = db
    .prepare('SELECT * FROM whatsapp_conversations WHERE id = ? AND owner_id = ?')
    .get(conversationId, ownerId) as unknown as ConversationRow | undefined
  return row ? mapConversation(row) : null
}

export function findConversationByRemote(
  ownerId: string,
  remoteJid: string,
): WhatsAppConversation | null {
  const row = db
    .prepare('SELECT * FROM whatsapp_conversations WHERE owner_id = ? AND remote_jid = ?')
    .get(ownerId, remoteJid) as unknown as ConversationRow | undefined
  return row ? mapConversation(row) : null
}

export function listMessages(
  ownerId: string,
  conversationId: string,
  options: { limit?: number; before?: string | null } = {},
): WhatsAppMessagePage {
  const limit = clamp(options.limit ?? 50, 1, 100)
  const conversation = findConversation(ownerId, conversationId)
  if (!conversation) return { items: [], hasMore: false, nextCursor: null }
  let rows: MessageRow[]
  if (options.before) {
    const cursor = db
      .prepare('SELECT created_at, id FROM whatsapp_messages WHERE id = ? AND conversation_id = ?')
      .get(options.before, conversationId) as unknown as { created_at: number; id: string } | undefined
    if (!cursor) return { items: [], hasMore: false, nextCursor: null }
    rows = db
      .prepare(
        `SELECT * FROM whatsapp_messages
         WHERE conversation_id = ? AND owner_id = ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, ownerId, cursor.created_at, cursor.created_at, cursor.id, limit + 1) as unknown as MessageRow[]
  } else {
    rows = db
      .prepare(
        `SELECT * FROM whatsapp_messages
         WHERE conversation_id = ? AND owner_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, ownerId, limit + 1) as unknown as MessageRow[]
  }
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).map(mapMessage).reverse()
  return {
    items: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[0]!.id : null,
  }
}

/** 最近一条入站消息正文；用于 `auto` 目标语言判断，没有则返回 null */
export function latestIncomingText(ownerId: string, conversationId: string): string | null {
  const row = db
    .prepare(
      `SELECT body FROM whatsapp_messages
       WHERE conversation_id = ? AND owner_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(conversationId, ownerId) as unknown as { body: string } | undefined
  return row?.body ?? null
}

export function getMessage(ownerId: string, messageId: string): WhatsAppMessage | null {
  const row = db
    .prepare('SELECT * FROM whatsapp_messages WHERE id = ? AND owner_id = ?')
    .get(messageId, ownerId) as unknown as MessageRow | undefined
  return row ? mapMessage(row) : null
}

export function ensureConversation(input: {
  ownerId: string
  orgId: string
  remoteJid: string
  phone: string
  displayName?: string
}): WhatsAppConversation {
  const existing = findConversationByRemote(input.ownerId, input.remoteJid)
  const now = Date.now()
  if (existing) {
    if (input.displayName && input.displayName !== existing.displayName && input.displayName !== input.phone) {
      db.prepare('UPDATE whatsapp_conversations SET display_name = ?, updated_at = ? WHERE id = ?').run(
        input.displayName,
        now,
        existing.id,
      )
      return { ...existing, displayName: input.displayName, updatedAt: now }
    }
    return existing
  }
  const id = newId('wac')
  db.prepare(
    `INSERT INTO whatsapp_conversations
       (id, owner_id, org_id, remote_jid, phone, display_name, customer_id,
        last_message_at, last_message_preview, last_message_direction, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '', NULL, 0, ?, ?)`,
  ).run(id, input.ownerId, input.orgId, input.remoteJid, input.phone, input.displayName ?? '', now, now)
  return findConversation(input.ownerId, id)!
}

export function recordIncomingMessage(
  input: WhatsAppIncomingMessage & { ownerId: string; orgId: string },
): { conversation: WhatsAppConversation; message: WhatsAppMessage; duplicate: boolean } {
  const conversation = ensureConversation({
    ownerId: input.ownerId,
    orgId: input.orgId,
    remoteJid: input.remoteJid,
    phone: input.phone,
    displayName: input.displayName,
  })
  if (input.id) {
    const existing = db
      .prepare(
        'SELECT * FROM whatsapp_messages WHERE conversation_id = ? AND engine_message_id = ? LIMIT 1',
      )
      .get(conversation.id, input.id) as unknown as MessageRow | undefined
    if (existing) {
      return { conversation: findConversation(input.ownerId, conversation.id)!, message: mapMessage(existing), duplicate: true }
    }
  }
  const now = Date.now()
  const createdAt = Number.isFinite(input.timestamp) && input.timestamp > 0 ? input.timestamp : now
  const messageId = newId('wam')
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO whatsapp_messages
         (id, conversation_id, owner_id, direction, type, body, status, failure_reason, engine_message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'in', 'text', ?, 'received', NULL, ?, ?, ?)`,
    ).run(messageId, conversation.id, input.ownerId, input.text, input.id || null, createdAt, now)
    db.prepare(
      `UPDATE whatsapp_conversations
       SET last_message_at = ?, last_message_preview = ?, last_message_direction = 'in',
           unread_count = unread_count + 1, archived_at = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(createdAt, preview(input.text), now, conversation.id, input.ownerId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return {
    conversation: findConversation(input.ownerId, conversation.id)!,
    message: getMessage(input.ownerId, messageId)!,
    duplicate: false,
  }
}

export function recordOutgoingMessage(input: {
  ownerId: string
  conversationId: string
  body: string
}): { conversation: WhatsAppConversation; message: WhatsAppMessage } {
  const conversation = findConversation(input.ownerId, input.conversationId)
  if (!conversation) throw new Error('conversation not found')
  const now = Date.now()
  const messageId = newId('wam')
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO whatsapp_messages
         (id, conversation_id, owner_id, direction, type, body, status, failure_reason, engine_message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'out', 'text', ?, 'sending', NULL, NULL, ?, ?)`,
    ).run(messageId, conversation.id, input.ownerId, input.body, now, now)
    db.prepare(
      `UPDATE whatsapp_conversations
       SET last_message_at = ?, last_message_preview = ?, last_message_direction = 'out', updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(now, preview(input.body), now, conversation.id, input.ownerId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return {
    conversation: findConversation(input.ownerId, conversation.id)!,
    message: getMessage(input.ownerId, messageId)!,
  }
}

export function markMessageSent(
  ownerId: string,
  messageId: string,
  engineMessageId: string | null,
): WhatsAppMessage | null {
  const now = Date.now()
  db.prepare(
    `UPDATE whatsapp_messages
     SET status = 'sent', failure_reason = NULL, engine_message_id = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(engineMessageId, now, messageId, ownerId)
  return getMessage(ownerId, messageId)
}

export function markMessageSending(ownerId: string, messageId: string): WhatsAppMessage | null {
  db.prepare(
    `UPDATE whatsapp_messages SET status = 'sending', failure_reason = NULL, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(Date.now(), messageId, ownerId)
  return getMessage(ownerId, messageId)
}

export function markMessageFailed(
  ownerId: string,
  messageId: string,
  reason: string,
): WhatsAppMessage | null {
  db.prepare(
    `UPDATE whatsapp_messages SET status = 'failed', failure_reason = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(reason, Date.now(), messageId, ownerId)
  return getMessage(ownerId, messageId)
}

export function markConversationRead(
  ownerId: string,
  conversationId: string,
): WhatsAppConversation | null {
  db.prepare(
    'UPDATE whatsapp_conversations SET unread_count = 0, updated_at = ? WHERE id = ? AND owner_id = ?',
  ).run(Date.now(), conversationId, ownerId)
  return findConversation(ownerId, conversationId)
}

/** 创建或复用会话（供「新建会话」使用，不发送消息） */
export function openConversation(input: {
  ownerId: string
  orgId: string
  phone: string
  remoteJid: string
  displayName?: string
}): WhatsAppConversation {
  return ensureConversation(input)
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
