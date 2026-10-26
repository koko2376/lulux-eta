import type Router from '@koa/router'
import { z } from 'zod'
import { requirePermission } from '../security/access.js'
import { parse } from '../validation.js'
import { sanctionsService } from '../services/sanctions/sanctions-service.js'

const refreshInput = z.object({
  list: z.enum(['ofac', 'eu', 'un', 'all']).default('all'),
})

const screenInput = z.object({
  name: z.string().trim().min(1).max(500),
  country: z.string().trim().max(10).optional(),
  threshold: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export function sanctionsRoutes(router: Router): void {
  router.get('/api/sanctions/status', (ctx) => {
    ctx.body = { lists: sanctionsService.status() }
  })

  router.post('/api/sanctions/refresh', async (ctx) => {
    requirePermission('settings:write')
    const body = parse(refreshInput, ctx.request.body ?? {})
    const result = await sanctionsService.refresh(body.list)
    ctx.body = { ...result, lists: sanctionsService.status() }
  })

  router.post('/api/sanctions/import', (ctx) => {
    requirePermission('settings:write')
    const body = parse(z.object({ csv: z.string().max(20_000_000) }).strict(), ctx.request.body)
    const result = sanctionsService.importCustom(body.csv)
    ctx.body = result
  })

  router.post('/api/sanctions/screen', (ctx) => {
    const body = parse(screenInput, ctx.request.body)
    const result = sanctionsService.screen(body.name, {
      country: body.country,
      threshold: body.threshold,
      limit: body.limit,
    })
    ctx.body = result
  })
}
