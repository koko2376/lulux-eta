import type Router from '@koa/router'
import { customerService } from '../services/customer-service.js'
import { AppError } from '../errors.js'
import { requirePermission } from '../security/access.js'

export function customerRoutes(router: Router): void {
  router.get('/api/customers', (ctx) => {
    ctx.body = customerService.list(ctx.query)
  })
  // 必须在 /api/customers/:id 之前
  router.get('/api/customers/facets', (ctx) => {
    ctx.body = customerService.facets()
  })
  router.get('/api/customers/export', (ctx) => {
    const { csv, count } = customerService.exportCsv(ctx.query)
    ctx.type = 'text/csv; charset=utf-8'
    ctx.set('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`)
    ctx.set('X-Total-Count', String(count))
    ctx.body = csv
  })
  router.post('/api/customers/import', (ctx) => {
    ctx.body = customerService.import(ctx.request.body)
  })
  router.get('/api/customers/transfer/preview', (ctx) => {
    requirePermission('members:manage')
    const fromUserId = typeof ctx.query.fromUserId === 'string' ? ctx.query.fromUserId : ''
    if (!fromUserId) throw new AppError(400, 'VALIDATION_ERROR', '缺少 fromUserId')
    ctx.body = customerService.handoverPreview(fromUserId)
  })
  router.post('/api/customers/transfer', (ctx) => {
    ctx.body = customerService.transferAll(ctx.request.body)
  })
  router.post('/api/customers/:id/assign', (ctx) => {
    ctx.body = customerService.assign(ctx.params.id, ctx.request.body)
  })
  router.post('/api/customers', (ctx) => {
    ctx.status = 201
    ctx.body = customerService.create(ctx.request.body)
  })
  router.get('/api/customers/:id', (ctx) => {
    ctx.body = customerService.require(ctx.params.id)
  })
  router.patch('/api/customers/:id', (ctx) => {
    ctx.body = customerService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/customers/:id', (ctx) => {
    customerService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.get('/api/customers/:id/activities', (ctx) => {
    ctx.body = customerService.activities(ctx.params.id)
  })
  router.post('/api/customers/:id/activities', (ctx) => {
    ctx.status = 201
    ctx.body = customerService.addActivity(ctx.params.id, ctx.request.body)
  })
}
