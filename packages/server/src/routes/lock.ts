import { isServerMode } from '../security/access.js'
import type Router from '@koa/router'
import { lockService } from '../services/lock-service.js'

export function lockRoutes(router: Router): void {
  router.get('/api/lock', (ctx) => {
    ctx.body = isServerMode() ? { enabled: false } : lockService.status()
  })
  router.post('/api/lock/setup', (ctx) => {
    ctx.body = lockService.setup(ctx.request.body)
  })
  router.post('/api/lock/verify', (ctx) => {
    ctx.body = lockService.verify(ctx.request.body)
  })
  router.post('/api/lock/disable', (ctx) => {
    ctx.body = lockService.disable(ctx.request.body)
  })
}
