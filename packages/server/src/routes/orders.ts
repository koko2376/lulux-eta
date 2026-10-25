import type Router from '@koa/router'
import { dealService } from '../services/deal-service.js'
import { orderService } from '../services/order-service.js'
import { DOC_KINDS, shippingDocsService, type DocKind } from '../services/trade/shipping-docs.js'
import { suggestHs } from '../services/trade/hs-suggest.js'
import { AppError } from '../errors.js'

function attachment(filename: string): string {
  return `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** 商机、订单、收款（docs/API-CONTRACT.md §10.7 / §10.8） */
export function orderRoutes(router: Router): void {
  router.get('/api/deals', (ctx) => {
    ctx.body = dealService.list(ctx.query)
  })
  router.post('/api/deals', (ctx) => {
    ctx.status = 201
    ctx.body = dealService.create(ctx.request.body)
  })
  router.get('/api/deals/:id', (ctx) => {
    ctx.body = dealService.require(ctx.params.id)
  })
  router.patch('/api/deals/:id', (ctx) => {
    ctx.body = dealService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/deals/:id', (ctx) => {
    dealService.remove(ctx.params.id)
    ctx.status = 204
  })

  router.post('/api/quotes/:id/order', (ctx) => {
    ctx.status = 201
    ctx.body = orderService.fromQuote(ctx.params.id, ctx.request.body ?? {})
  })
  router.get('/api/orders', (ctx) => {
    ctx.body = orderService.list(ctx.query)
  })
  router.get('/api/receivables', (ctx) => {
    const overdue = ctx.query.overdue === '1' || ctx.query.overdue === 'true'
    ctx.body = { ...orderService.list({ receivable: overdue ? 'overdue' : 'open', limit: ctx.query.limit }), summary: orderService.receivableSummary() }
  })
  router.get('/api/orders/:id', (ctx) => {
    ctx.body = orderService.require(ctx.params.id)
  })
  router.patch('/api/orders/:id', (ctx) => {
    ctx.body = orderService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/orders/:id', (ctx) => {
    orderService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.get('/api/orders/:id/payments', (ctx) => {
    orderService.require(ctx.params.id, false)
    ctx.body = orderService.payments(ctx.params.id)
  })
  router.post('/api/orders/:id/payments', (ctx) => {
    ctx.status = 201
    ctx.body = orderService.recordPayment(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/orders/:id/payments/:pid', (ctx) => {
    orderService.removePayment(ctx.params.id, ctx.params.pid)
    ctx.status = 204
  })

  /* ── 出货单证 ── */
  router.get('/api/orders/:id/docs', (ctx) => {
    ctx.body = shippingDocsService.get(ctx.params.id)
  })
  router.patch('/api/orders/:id/docs', (ctx) => {
    ctx.body = shippingDocsService.update(ctx.params.id, ctx.request.body ?? {})
  })
  router.get('/api/orders/:id/docs/:kind', async (ctx) => {
    const kind = ctx.params.kind.replace(/\.pdf$/, '') as DocKind
    if (!DOC_KINDS.includes(kind)) throw new AppError(400, 'BAD_ARGS', '单证类型只能是 ci / pl / co')
    const { buffer, font, filename } = await shippingDocsService.render(ctx.params.id, kind)
    ctx.type = 'application/pdf'
    ctx.set('Content-Disposition', attachment(filename))
    ctx.set('X-Lulux-Pdf-Font', font)
    ctx.body = buffer
  })
  router.get('/api/hs/suggest', async (ctx) => {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim().slice(0, 200) : ''
    if (!q) throw new AppError(400, 'BAD_ARGS', '请输入品名')
    ctx.body = await suggestHs(q)
  })
}
