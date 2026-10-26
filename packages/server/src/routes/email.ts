import type Router from '@koa/router'
import { z } from 'zod'
import { notFound } from '../errors.js'
import { auditService } from '../services/audit-service.js'
import { accountService } from '../services/email/account-service.js'
import { draftService } from '../services/email/draft-service.js'
import { isSyncing, messageService, syncAccount } from '../services/email/message-service.js'
import { oauthService } from '../services/email/oauth.js'
import { EMAIL_PRESETS } from '../services/email/presets.js'
import { renderQuotePdf } from '../services/email/quote-pdf.js'
import { quoteService } from '../services/quote-service.js'
import { quoteTemplateService } from '../services/quote-template-service.js'
import { parse } from '../validation.js'

const syncInput = z.object({ wait: z.boolean().optional(), full: z.boolean().optional() }).strict()
const draftListQuery = z.object({
  accountId: z.string().max(80).optional(),
  status: z.enum(['draft', 'sending', 'sent', 'failed']).optional(),
  customerId: z.string().max(80).optional(),
})

/** 可执行 / 可渲染的类型一律按二进制下载 */
const UNSAFE_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|application\/javascript|text\/javascript)/i

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export function emailRoutes(router: Router): void {
  router.get('/api/email/presets', (ctx) => {
    ctx.body = EMAIL_PRESETS
  })

  // ── 账户 ──
  router.get('/api/email/accounts', (ctx) => {
    ctx.body = accountService.list()
  })
  router.post('/api/email/accounts/test', async (ctx) => {
    ctx.body = await accountService.test(ctx.request.body)
  })
  router.post('/api/email/accounts', async (ctx) => {
    const account = await accountService.create(ctx.request.body)
    ctx.status = 201
    ctx.body = account
  })
  router.patch('/api/email/accounts/:id', async (ctx) => {
    ctx.body = await accountService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/email/accounts/:id', (ctx) => {
    accountService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/email/accounts/:id/test', async (ctx) => {
    ctx.body = await accountService.testSaved(ctx.params.id)
  })
  router.post('/api/email/accounts/:id/sync', async (ctx) => {
    const body = parse(syncInput, ctx.request.body ?? {})
    accountService.requireRow(ctx.params.id)
    if (body.wait) {
      ctx.body = await syncAccount(ctx.params.id, Boolean(body.full))
      return
    }
    const already = isSyncing(ctx.params.id)
    void syncAccount(ctx.params.id, Boolean(body.full)).catch(() => undefined)
    ctx.status = 202
    ctx.body = { accepted: !already }
  })

  // ── OAuth ──
  router.get('/api/email/oauth/config', (ctx) => {
    ctx.body = oauthService.config()
  })
  router.put('/api/email/oauth/config', (ctx) => {
    ctx.body = oauthService.saveConfig(ctx.request.body)
  })
  router.post('/api/email/oauth/start', (ctx) => {
    ctx.body = oauthService.start(ctx.request.body)
  })
  router.get('/api/email/oauth/status/:state', (ctx) => {
    ctx.body = oauthService.status(ctx.params.state)
  })

  // ── 邮件 ──
  router.get('/api/email/messages', (ctx) => {
    ctx.body = messageService.list(ctx.query)
  })
  router.get('/api/email/messages/:id', (ctx) => {
    ctx.body = messageService.get(ctx.params.id)
  })
  router.get('/api/email/messages/:id/html', (ctx) => {
    const html = messageService.html(ctx.params.id)
    ctx.type = 'text/html; charset=utf-8'
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.body = html
  })
  router.patch('/api/email/messages/:id', async (ctx) => {
    ctx.body = await messageService.patch(ctx.params.id, ctx.request.body)
  })
  router.post('/api/email/messages/:id/classify', async (ctx) => {
    ctx.body = await messageService.classify(ctx.params.id, ctx.request.body ?? {})
  })
  router.post('/api/email/messages/:id/score', (ctx) => {
    ctx.body = messageService.score(ctx.params.id)
  })
  router.post('/api/email/messages/:id/create-customer', (ctx) => {
    const result = messageService.createCustomer(ctx.params.id, ctx.request.body ?? {})
    auditService.record({ action: 'customer.create', entityType: 'customer', entityId: result.customer.id, summary: `从邮件建客户「${result.customer.company}」` })
    ctx.status = 201
    ctx.body = result
  })
  router.post('/api/email/messages/:id/link', async (ctx) => {
    const { customerId } = parse(z.object({ customerId: z.string().min(1).max(80) }).strict(), ctx.request.body)
    ctx.body = await messageService.link(ctx.params.id, customerId)
  })
  router.get('/api/email/attachments/:id', async (ctx) => {
    const file = await messageService.attachment(ctx.params.id)
    ctx.set('Content-Disposition', contentDisposition(file.filename))
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.type = UNSAFE_TYPES.test(file.contentType) ? 'application/octet-stream' : file.contentType
    ctx.length = file.size
    ctx.body = messageService.openAttachment(file.path)
  })

  // ── 草稿 ──
  router.get('/api/email/drafts', (ctx) => {
    ctx.body = draftService.list(parse(draftListQuery, ctx.query))
  })
  router.post('/api/email/drafts/generate', async (ctx) => {
    ctx.status = 201
    ctx.body = await draftService.generate(ctx.request.body)
  })
  router.post('/api/email/drafts', (ctx) => {
    ctx.status = 201
    ctx.body = draftService.create(ctx.request.body)
  })
  router.get('/api/email/drafts/:id', (ctx) => {
    ctx.body = draftService.get(ctx.params.id)
  })
  router.patch('/api/email/drafts/:id', (ctx) => {
    ctx.body = draftService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/email/drafts/:id', (ctx) => {
    draftService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/email/drafts/:id/attachments', (ctx) => {
    ctx.status = 201
    ctx.body = draftService.addAttachment(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/email/drafts/:id/attachments/:attachmentId', (ctx) => {
    draftService.removeAttachment(ctx.params.id, ctx.params.attachmentId)
    ctx.status = 204
  })
  router.post('/api/email/drafts/:id/send', async (ctx) => {
    const { confirmSendAs } = parse(z.object({ confirmSendAs: z.boolean().optional() }).strict(), ctx.request.body ?? {})
    ctx.body = await draftService.send(ctx.params.id, { confirmSendAs })
  })

  // ── 报价 PDF（浏览器态） ──
  router.get('/api/quotes/:id/pdf', async (ctx) => {
    const quote = quoteService.require(ctx.params.id)
    const templateId = typeof ctx.query.templateId === 'string' ? ctx.query.templateId : ''
    const template = templateId ? quoteTemplateService.get(templateId) : quoteTemplateService.getDefault()
    if (templateId && !template) throw notFound('报价模板')
    const { buffer, font } = await renderQuotePdf(quote, template)
    ctx.type = 'application/pdf'
    ctx.set('Content-Disposition', contentDisposition(`${quote.number}.pdf`))
    ctx.set('X-Lulux-Pdf-Font', font)
    ctx.body = buffer
  })

}

const CALLBACK_CSP = "default-src 'none'; style-src 'unsafe-inline'"

function callbackPage(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LULUX ETA 邮箱授权</title>
<style>body{font-family:-apple-system,Segoe UI,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f6f7;color:#1f1f22}
.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;text-align:center}h1{font-size:20px}</style>
</head><body><div class="card"><h1>${ok ? '✅ 授权完成' : '⚠️ 授权未完成'}</h1><p>${esc}</p></div></body></html>`
}

export function oauthCallbackRoutes(router: Router): void {
  router.get('/oauth/callback', async (ctx) => {
    const result = await oauthService.callback(ctx.query)
    ctx.status = result.ok ? 200 : 400
    ctx.type = 'text/html; charset=utf-8'
    ctx.set('Content-Security-Policy', CALLBACK_CSP)
    ctx.set('Referrer-Policy', 'no-referrer')
    ctx.set('Cache-Control', 'no-store')
    ctx.body = callbackPage(result.ok, result.message)
  })
}
