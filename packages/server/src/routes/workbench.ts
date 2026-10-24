import type Router from '@koa/router'
import { workbenchService } from '../services/workbench-service.js'

export function workbenchRoutes(router: Router): void {
  router.get('/api/workbench/summary', (ctx) => {
    ctx.body = workbenchService.summary(ctx.query)
  })
}
