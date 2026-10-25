import type Router from '@koa/router'
import { kernelService } from '../services/kernels/kernel-service.js'

export function kernelRoutes(router: Router): void {
  router.get('/api/kernels', (ctx) => {
    ctx.body = kernelService.list()
  })
  router.post('/api/kernels/:id/install', (ctx) => {
    ctx.status = 202
    ctx.body = kernelService.install(ctx.params.id)
  })
  router.post('/api/kernels/:id/update', (ctx) => {
    ctx.status = 202
    ctx.body = kernelService.update(ctx.params.id)
  })
  router.post('/api/kernels/:id/uninstall', (ctx) => {
    ctx.status = 202
    ctx.body = kernelService.uninstall(ctx.params.id)
  })
  router.get('/api/kernels/:id/log', (ctx) => {
    ctx.body = { lines: kernelService.log(ctx.params.id) }
  })
}
