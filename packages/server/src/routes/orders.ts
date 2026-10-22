import type Router from '@koa/router'
import { dealService } from '../services/deal-service.js'
import { orderService } from '../services/order-service.js'

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
}
