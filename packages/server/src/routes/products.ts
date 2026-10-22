import type Router from '@koa/router'
import { productService } from '../services/product-service.js'

export function productRoutes(router: Router): void {
  router.get('/api/products', (ctx) => {
    ctx.body = productService.list()
  })
  router.post('/api/products', (ctx) => {
    ctx.status = 201
    ctx.body = productService.create(ctx.request.body)
  })
  router.post('/api/products/import', (ctx) => {
    ctx.body = productService.import(ctx.request.body)
  })
  router.patch('/api/products/:id', (ctx) => {
    ctx.body = productService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/products/:id', (ctx) => {
    productService.remove(ctx.params.id)
    ctx.status = 204
  })
}
