import type { WhatsAppContactName, WhatsAppHistoryBatch, WhatsAppIncomingMessage } from './types.js'

/**
 * 引擎原始消息 → 业务消息（纯函数，便于单测）。
 *
 * - 只保留一对一聊天（`@s.whatsapp.net`，以及能映射到号码的 `@lid`）；群聊、广播、频道、状态一律跳过；
 * - 文本取 conversation / extendedText / 媒体说明；其他类型存成英文占位标签（如 `[Image]`），
 *   界面按语言显示（客户端 `whatsappBodyLabel`）；
 * - 时间戳可能是秒级 number、字符串或 Long，统一成毫秒。
 */

/** 占位标签（存库用英文，界面本地化）；客户端用同一组名字识别 */
export const WA_PLACEHOLDER_LABELS = [
  'Image',
  'Video',
  'GIF',
  'Voice message',
  'Audio',
  'Document',
  'Sticker',
  'Location',
  'Live location',
  'Contact card',
  'Poll',
  'Unsupported message',
] as const

/** 秒级 number / 字符串 / Long 统一成毫秒；无效时返回 fallback */
export function timestampOf(value: unknown, fallback = Date.now()): number {
  let raw: number
  if (typeof value === 'object' && value !== null && 'toNumber' in value && typeof (value as { toNumber: unknown }).toNumber === 'function') {
    raw = Number((value as { toNumber: () => number }).toNumber())
  } else if (typeof value === 'object' && value !== null && 'low' in value) {
    const long = value as { low: number; high?: number }
    raw = (long.high ?? 0) * 4_294_967_296 + (long.low >>> 0)
  } else {
    raw = Number(value)
  }
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return raw < 1_000_000_000_000 ? raw * 1000 : raw
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
] as const

/** 拆掉阅后即焚 / 限时 / 带说明文档等外层包装 */
export function unwrapMessage(message: any): any {
  let current = message
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const wrapper = WRAPPERS.map((key) => current[key]?.message).find((inner) => inner && typeof inner === 'object')
    if (!wrapper) break
    current = wrapper
  }
  return current
}

/** 不产生聊天内容的协议类消息（撤回、密钥分发、表情回应、投票更新等） */
const SILENT_KEYS = new Set([
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'protocolMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
  'pinInChatMessage',
  'call',
])

function label(name: (typeof WA_PLACEHOLDER_LABELS)[number], detail?: unknown, caption?: unknown): string {
  const d = typeof detail === 'string' ? detail.replace(/[\]\n]/g, ' ').trim().slice(0, 80) : ''
  const c = typeof caption === 'string' ? caption.trim() : ''
  const head = d ? `[${name}: ${d}]` : `[${name}]`
  return c ? `${head} ${c}` : head
}

/** 消息正文；返回 null 表示这条不是聊天内容（应跳过） */
export function contentOf(raw: any): string | null {
  const message = unwrapMessage(raw)
  if (!message || typeof message !== 'object') return null
  if (typeof message.conversation === 'string' && message.conversation.trim()) return message.conversation
  const extended = message.extendedTextMessage?.text
  if (typeof extended === 'string' && extended.trim()) return extended
  if (message.imageMessage) return label('Image', undefined, message.imageMessage.caption)
  if (message.videoMessage) return label(message.videoMessage.gifPlayback ? 'GIF' : 'Video', undefined, message.videoMessage.caption)
  if (message.ptvMessage) return label('Video', undefined, message.ptvMessage.caption)
  if (message.audioMessage) return label(message.audioMessage.ptt ? 'Voice message' : 'Audio')
  if (message.documentMessage) {
    return label('Document', message.documentMessage.fileName ?? message.documentMessage.title, message.documentMessage.caption)
  }
  if (message.stickerMessage) return label('Sticker')
  if (message.liveLocationMessage) return label('Live location', undefined, message.liveLocationMessage.caption)
  if (message.locationMessage) {
    const loc = message.locationMessage
    return label('Location', [loc.name, loc.address].filter((v) => typeof v === 'string' && v.trim()).join(' · ') || undefined)
  }
  if (message.contactMessage) return label('Contact card', message.contactMessage.displayName)
  if (message.contactsArrayMessage) return label('Contact card', message.contactsArrayMessage.displayName)
  const poll = message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3
  if (poll) return label('Poll', poll.name)
  const reply =
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.templateButtonReplyMessage?.selectedDisplayText
  if (typeof reply === 'string' && reply.trim()) return reply
  const keys = Object.keys(message).filter((key) => message[key] != null && !SILENT_KEYS.has(key))
  return keys.length ? label('Unsupported message') : null
}

export function isUserJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
}

export function phoneOfJid(jid: string): string {
  if (!jid.endsWith('@s.whatsapp.net')) return ''
  const user = jid.split('@')[0]?.split(':')[0] ?? ''
  const digits = user.replace(/\D/g, '')
  return digits ? `+${digits}` : ''
}

/** 去掉设备后缀：`15555550110:12@s.whatsapp.net` → `15555550110@s.whatsapp.net` */
export function normalizeJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@')
  if (!server) return jid
  return `${user.split(':')[0]}@${server}`
}

/** `@lid` → 号码 jid 的映射表（来自会话 / 联系人 / 消息 key 的附带字段） */
export class JidResolver {
  private readonly lidToPn = new Map<string, string>()

  learn(lid: unknown, pn: unknown): void {
    if (typeof lid !== 'string' || typeof pn !== 'string') return
    const l = normalizeJid(lid)
    const p = normalizeJid(pn)
    if (l.endsWith('@lid') && p.endsWith('@s.whatsapp.net')) this.lidToPn.set(l, p)
  }

  resolve(jid: string, alt?: unknown): string {
    const normalized = normalizeJid(jid)
    if (!normalized.endsWith('@lid')) return normalized
    if (typeof alt === 'string' && normalizeJid(alt).endsWith('@s.whatsapp.net')) {
      this.learn(normalized, alt)
      return normalizeJid(alt)
    }
    return this.lidToPn.get(normalized) ?? normalized
  }
}

/** 一条原始消息 → 业务消息；不是一对一聊天内容时返回 null */
export function mapRawMessage(raw: any, resolver: JidResolver, now = Date.now()): WhatsAppIncomingMessage | null {
  const key = raw?.key ?? {}
  const original = String(key.remoteJid ?? '')
  if (!original || !isUserJid(original)) return null
  const remoteJid = resolver.resolve(original, key.remoteJidAlt ?? key.senderPn)
  const text = contentOf(raw?.message)
  if (text === null || !text.trim()) return null
  const phone = phoneOfJid(remoteJid)
  const fromMe = Boolean(key.fromMe)
  return {
    id: String(key.id ?? ''),
    remoteJid,
    phone,
    // 自己发出的消息 pushName 是自己的名字，不能拿来当会话名
    displayName: fromMe ? '' : String(raw?.pushName ?? '').trim() || phone,
    text,
    timestamp: timestampOf(raw?.messageTimestamp, now),
    fromMe,
  }
}

/** 引擎联系人 → 名字（通讯录名 name 优先，其次昵称 notify / verifiedName） */
export function mapContacts(raw: unknown, resolver: JidResolver): WhatsAppContactName[] {
  const out: WhatsAppContactName[] = []
  for (const contact of Array.isArray(raw) ? raw : []) {
    if (!contact || typeof contact !== 'object') continue
    const c = contact as Record<string, unknown>
    resolver.learn(c.lid, c.jid)
    resolver.learn(c.id, c.phoneNumber ?? c.jid)
    const id = typeof c.id === 'string' ? c.id : ''
    if (!id || !isUserJid(id)) continue
    const remoteJid = resolver.resolve(id, c.jid ?? c.phoneNumber)
    const phone = phoneOfJid(remoteJid)
    if (typeof c.name === 'string' && c.name.trim()) {
      out.push({ remoteJid, phone, name: c.name.trim(), source: 'contact' })
      continue
    }
    const push = [c.notify, c.verifiedName].find((v): v is string => typeof v === 'string' && v.trim().length > 0)
    if (push) out.push({ remoteJid, phone, name: push.trim(), source: 'push' })
  }
  return out
}

/** `messaging-history.set` → 一批历史数据（只保留 cutoff 之后的一对一消息） */
export function mapHistorySet(data: any, cutoff: number, resolver: JidResolver, now = Date.now()): WhatsAppHistoryBatch {
  const chats: WhatsAppHistoryBatch['chats'] = []
  for (const chat of Array.isArray(data?.chats) ? data.chats : []) {
    const id = String(chat?.id ?? '')
    resolver.learn(id, chat?.pnJid)
    resolver.learn(chat?.lidJid, id)
    if (!id || !isUserJid(id)) continue
    const remoteJid = resolver.resolve(id, chat?.pnJid)
    chats.push({
      remoteJid,
      phone: phoneOfJid(remoteJid),
      name: typeof chat?.name === 'string' && chat.name.trim() ? chat.name.trim() : undefined,
      unreadCount: Number.isFinite(Number(chat?.unreadCount)) ? Number(chat.unreadCount) : undefined,
      archived: chat?.archived === true ? true : undefined,
    })
  }
  const contacts = mapContacts(data?.contacts, resolver)
  const messages: WhatsAppIncomingMessage[] = []
  for (const raw of Array.isArray(data?.messages) ? data.messages : []) {
    const mapped = mapRawMessage(raw, resolver, now)
    if (!mapped || mapped.timestamp < cutoff) continue
    messages.push(mapped)
  }
  const progress = Number(data?.progress)
  return {
    messages,
    contacts,
    chats,
    isLatest: data?.isLatest === true,
    progress: Number.isFinite(progress) && data?.progress != null ? Math.max(0, Math.min(100, progress)) : null,
  }
}
