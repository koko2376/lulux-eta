import type Router from '@koa/router'
import { trashService } from '../services/trash-service.js'

export function trashRoutes(router: Router): void {
  router.get('/api/trash', (ctx) => {
    ctx.body = trashService.list(ctx.query)
  })
  router.post('/api/trash/:entity/:id/restore', (ctx) => {
    ctx.body = trashService.restore(ctx.params.entity, ctx.params.id)
  })
  router.delete('/api/trash/:entity/:id', (ctx) => {
    trashService.purge(ctx.params.entity, ctx.params.id)
    ctx.status = 204
  })
}
