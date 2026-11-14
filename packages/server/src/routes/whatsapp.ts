import type Router from '@koa/router'
import { z } from 'zod'
import { currentActor } from '../context.js'
import { AppError } from '../errors.js'
import { whatsappService, contactPhoneDigits } from '../services/whatsapp/service.js'
import type { WhatsAppConversation } from '../services/whatsapp/types.js'
import { customerService, type Customer } from '../services/customer-service.js'
import { dealService } from '../services/deal-service.js'
import { db } from '../db.js'
import { parse, patchShape } from '../validation.js'
import { createQuickReply, deleteQuickReply, listQuickReplies, updateQuickReply } from '../services/whatsapp/quick-replies.js'

const startSchema = z.object({
  mode: z.enum(['qr', 'pairing']),
  phone: z.string().trim().max(32).optional(),
})

const pairingSchema = z.object({
  phone: z.string().trim().max(32),
})

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  filter: z.enum(['all', 'unread', 'pending', 'archived']).optional(),
  tag: z.string().trim().min(1).max(20).optional(),
  q: z.string().trim().max(60).optional(),
  sort: z.enum(['recent', 'unread']).optional(),
})

const quickReplySchema = z
  .object({
    title: z.string().trim().min(1).max(30),
    body: z.string().trim().min(1).max(2000),
  })
  .strict()

const conversationPatchSchema = z
  .object({
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(20)).max(8).optional(),
    customerId: z.string().trim().min(1).max(80).nullable().optional(),
    /** 只允许清除：LULUX 起草的回复被采用或丢弃 */
    draft: z.null().optional(),
  })
  .strict()

const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().trim().max(64).optional(),
})

const conversationCreateSchema = z.object({
  phone: z.string().trim().min(1).max(32),
  displayName: z.string().trim().max(80).optional(),
})

const sendMessageSchema = z.object({
  text: z.string().max(5_000),
})

const proxySchema = z.object({
  protocol: z.enum(['socks5', 'http', 'https']),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
})

const proxyTestSchema = z.object({ proxy: proxySchema.optional() })

const translateSchema = z.object({
  text: z.string().max(5_000),
  targetLang: z.string().trim().max(16).optional(),
  sourceLang: z.string().trim().max(16).optional(),
  conversationId: z.string().trim().max(64).optional(),
})

/**
 * 关联设备绑定接口（契约 §12）。
 *
 * 状态与二维码/配对码都从 `GET /api/whatsapp/status` 与 `/api/events` 的
 * `whatsapp.*` 事件获得；配对码只在内存与当前响应/事件里，不落盘。
 */
export function whatsappRoutes(router: Router): void {
  router.get('/api/whatsapp/status', (ctx) => {
    ctx.body = whatsappService.status(currentActor())
  })

  router.post('/api/whatsapp/risk-acceptance', (ctx) => {
    ctx.body = whatsappService.acceptRisk(currentActor())
  })

  router.post('/api/whatsapp/link/start', async (ctx) => {
    const input = parse(startSchema, ctx.request.body)
    if (input.mode === 'pairing' && !input.phone) {
      throw new AppError(400, 'PAIRING_INVALID_PHONE', '请填写带国家码的手机号，例如 +8613800138000')
    }
    ctx.body = await whatsappService.start(currentActor(), input)
  })

  router.post('/api/whatsapp/link/pairing-code', async (ctx) => {
    const input = parse(pairingSchema, ctx.request.body)
    ctx.body = await whatsappService.requestPairingCode(currentActor(), input.phone)
  })

  router.post('/api/whatsapp/link/refresh-qr', async (ctx) => {
    ctx.body = await whatsappService.refreshQr(currentActor())
  })

  router.post('/api/whatsapp/link/stop', async (ctx) => {
    ctx.body = await whatsappService.stop(currentActor())
  })

  router.post('/api/whatsapp/logout', async (ctx) => {
    const body = ctx.request.body as { confirm?: unknown } | undefined
    if (body?.confirm !== true) {
      throw new AppError(
        400,
        'CONFIRMATION_REQUIRED',
        '解绑会立即删除本机凭据并在手机上退出这台设备，请二次确认后重试',
      )
    }
    ctx.body = await whatsappService.logout(currentActor())
  })

  // ------------------------------------------------------------ 会话与消息（§12.3）

  router.get('/api/whatsapp/conversations', (ctx) => {
    const query = parse(listQuerySchema, ctx.query)
    const page = whatsappService.listConversations(currentActor(), { ...query, q: query.q || undefined })
    // 列表上显示对方公司：手动关联的客户优先，否则按号码匹配（看不到的客户不显示）
    ctx.body = { ...page, items: page.items.map((item) => ({ ...item, customerName: matchCustomer(item).customer?.company ?? null })) }
  })

  // 快捷回复：每个人自己的常用回复片段
  router.get('/api/whatsapp/quick-replies', (ctx) => {
    const actor = currentActor()
    ctx.body = { items: listQuickReplies(actor.id) }
  })
  router.post('/api/whatsapp/quick-replies', (ctx) => {
    const actor = currentActor()
    const input = parse(quickReplySchema, ctx.request.body)
    ctx.status = 201
    ctx.body = createQuickReply(actor.id, actor.orgId, input)
  })
  router.patch('/api/whatsapp/quick-replies/:id', (ctx) => {
    const input = parse(z.object(patchShape(quickReplySchema.shape)).strict(), ctx.request.body)
    ctx.body = updateQuickReply(currentActor().id, ctx.params.id, input)
  })
  router.delete('/api/whatsapp/quick-replies/:id', (ctx) => {
    deleteQuickReply(currentActor().id, ctx.params.id)
    ctx.status = 204
  })

  // 必须在 /api/whatsapp/conversations/:id 之前
  router.get('/api/whatsapp/conversations/counts', (ctx) => {
    ctx.body = whatsappService.conversationCounts(currentActor())
  })

  router.patch('/api/whatsapp/conversations/:id', (ctx) => {
    const patch = parse(conversationPatchSchema, ctx.request.body)
    // 手动关联客户：必须是当前用户能看到的客户
    if (patch.customerId) customerService.require(patch.customerId)
    const { draft, ...meta } = patch
    const actor = currentActor()
    let updated = whatsappService.updateConversation(actor, ctx.params.id, meta)
    if (draft === null) updated = whatsappService.setDraft(actor, ctx.params.id, null)
    ctx.body = updated
  })

  // 右侧客户档案：手动关联的客户优先，否则按号码匹配联系人；看不到的客户不返回
  router.get('/api/whatsapp/conversations/:id/profile', (ctx) => {
    const conversation = whatsappService.conversationForProfile(currentActor(), ctx.params.id)
    ctx.body = conversationProfile(conversation)
  })

  router.post('/api/whatsapp/conversations', (ctx) => {
    const input = parse(conversationCreateSchema, ctx.request.body)
    ctx.status = 201
    ctx.body = whatsappService.openConversation(currentActor(), input)
  })

  // 出口代理：本机模式设本机账号的；团队服务器由绑定者或老板 / 管理员设
  router.get('/api/whatsapp/proxy', (ctx) => {
    ctx.body = whatsappService.getProxy(currentActor())
  })
  router.put('/api/whatsapp/proxy', async (ctx) => {
    ctx.body = await whatsappService.setProxy(currentActor(), parse(proxySchema, ctx.request.body))
  })
  router.delete('/api/whatsapp/proxy', async (ctx) => {
    ctx.body = await whatsappService.setProxy(currentActor(), null)
  })
  router.post('/api/whatsapp/proxy/test', async (ctx) => {
    ctx.body = await whatsappService.testProxy(currentActor(), parse(proxyTestSchema, ctx.request.body ?? {}).proxy)
  })

  router.get('/api/whatsapp/conversations/:id/messages', (ctx) => {
    const query = parse(messageListQuerySchema, ctx.query)
    ctx.body = whatsappService.conversationMessages(currentActor(), ctx.params.id, query)
  })

  router.post('/api/whatsapp/conversations/:id/messages', async (ctx) => {
    const input = parse(sendMessageSchema, ctx.request.body)
    ctx.status = 201
    ctx.body = await whatsappService.sendMessage(currentActor(), ctx.params.id, input.text)
  })

  router.post('/api/whatsapp/conversations/:id/read', (ctx) => {
    ctx.body = whatsappService.markRead(currentActor(), ctx.params.id)
  })

  router.post('/api/whatsapp/messages/:id/retry', async (ctx) => {
    ctx.body = await whatsappService.retryMessage(currentActor(), ctx.params.id)
  })

  router.post('/api/whatsapp/translate', async (ctx) => {
    const input = parse(translateSchema, ctx.request.body)
    ctx.body = await whatsappService.translateInput(currentActor(), input)
  })
}

export interface WhatsAppConversationProfile {
  /** manual = 手动关联；phone = 号码与联系人一致；null = 没找到 */
  match: 'manual' | 'phone' | null
  customer: Customer | null
  contactId: string | null
  deals: Array<{ id: string; title: string; amount: number; currency: string; stage: string; expectedClose: string; updatedAt: number }>
}

function visibleCustomer(id: string): Customer | null {
  try {
    return customerService.require(id)
  } catch (error) {
    if (error instanceof AppError && (error.status === 404 || error.status === 403)) return null
    throw error
  }
}

/** SQL 里去掉号码常见分隔符，便于用末几位粗筛 */
function digitsOnly(column: 'phone' | 'whatsapp'): string {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')`
}

function conversationProfile(conversation: WhatsAppConversation): WhatsAppConversationProfile {
  const { customer, match, digits } = matchCustomer(conversation)
  if (!customer) return { match: null, customer: null, contactId: null, deals: [] }
  const contact = digits
    ? (customer.contacts.find((c) => contactPhoneDigits(c.whatsapp) === digits || contactPhoneDigits(c.phone) === digits) ?? null)
    : null
  const deals = dealService
    .list({ customerId: customer.id, limit: 3 })
    .items.map((d) => ({ id: d.id, title: d.title, amount: d.amount, currency: d.currency, stage: d.stage, expectedClose: d.expectedClose, updatedAt: d.updatedAt }))
  return { match, customer, contactId: contact?.id ?? null, deals }
}

function matchCustomer(conversation: WhatsAppConversation): {
  customer: Customer | null
  match: WhatsAppConversationProfile['match']
  digits: string
} {
  let customer: Customer | null = null
  let match: WhatsAppConversationProfile['match'] = null
  if (conversation.customerId) {
    customer = visibleCustomer(conversation.customerId)
    if (customer) match = 'manual'
  }
  const digits = contactPhoneDigits(conversation.phone.startsWith('+') ? conversation.phone : `+${conversation.phone}`)
  if (!customer && digits) {
    // 先用号码末 7 位粗筛，再按完整 E.164 数字精确比对
    const rows = db
      .prepare(
        `SELECT customer_id, phone, whatsapp FROM contacts
         WHERE ${digitsOnly('phone')} LIKE ? OR ${digitsOnly('whatsapp')} LIKE ? LIMIT 50`,
      )
      .all(`%${digits.slice(-7)}%`, `%${digits.slice(-7)}%`) as unknown as Array<{ customer_id: string; phone: string; whatsapp: string }>
    for (const row of rows) {
      if (contactPhoneDigits(row.whatsapp) !== digits && contactPhoneDigits(row.phone) !== digits) continue
      customer = visibleCustomer(row.customer_id)
      if (customer) {
        match = 'phone'
        break
      }
    }
  }
  return { customer, match: customer ? match : null, digits: digits ?? '' }
}
