import type Router from '@koa/router'
import { z } from 'zod'
import { parse } from '../validation.js'
import { sequenceService, type SendStatus } from '../services/email/sequence-service.js'

const sendsQuery = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  sequenceId: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/** 开发信序列：序列 CRUD、联系人、待确认发送、退订名单 */
export function sequenceRoutes(router: Router): void {
  router.get('/api/sequences', (ctx) => {
    ctx.body = sequenceService.list()
  })
  router.post('/api/sequences', (ctx) => {
    ctx.status = 201
    ctx.body = sequenceService.create(ctx.request.body ?? {})
  })
  router.get('/api/sequences/:id', (ctx) => {
    ctx.body = sequenceService.get(ctx.params.id)
  })
  router.patch('/api/sequences/:id', (ctx) => {
    ctx.body = sequenceService.update(ctx.params.id, ctx.request.body ?? {})
  })
  router.delete('/api/sequences/:id', (ctx) => {
    sequenceService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/sequences/:id/preview', (ctx) => {
    ctx.body = sequenceService.preview(ctx.params.id, ctx.request.body ?? {})
  })
  router.get('/api/sequences/:id/enrollments', (ctx) => {
    ctx.body = sequenceService.enrollments(ctx.params.id)
  })
  router.post('/api/sequences/:id/enrollments', (ctx) => {
    ctx.body = sequenceService.enroll(ctx.params.id, ctx.request.body ?? {})
  })
  router.patch('/api/sequence-enrollments/:id', (ctx) => {
    const { status } = parse(z.object({ status: z.enum(['active', 'paused', 'stopped']) }).strict(), ctx.request.body ?? {})
    ctx.body = sequenceService.setEnrollmentStatus(ctx.params.id, status)
  })
  router.get('/api/sequence-sends', (ctx) => {
    const query = parse(sendsQuery, ctx.query)
    ctx.body = sequenceService.sends({ status: query.status as SendStatus | undefined, sequenceId: query.sequenceId, limit: query.limit })
  })
  router.post('/api/sequence-sends/approve', async (ctx) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().trim().min(1).max(80)).min(1).max(200) }).strict(), ctx.request.body ?? {})
    ctx.body = await sequenceService.approve(ids)
  })
  router.post('/api/sequence-sends/:id/skip', (ctx) => {
    ctx.body = sequenceService.skip(ctx.params.id)
  })
  router.get('/api/email-suppressions', (ctx) => {
    ctx.body = sequenceService.suppressions()
  })
  router.post('/api/email-suppressions', (ctx) => {
    ctx.body = sequenceService.addSuppression(ctx.request.body ?? {})
  })
  router.delete('/api/email-suppressions/:email', (ctx) => {
    sequenceService.removeSuppression(ctx.params.email)
    ctx.status = 204
  })
}
