import type Router from '@koa/router'
import { z } from 'zod'
import { notFound } from '../errors.js'
import { quoteService, renderQuoteHtml } from '../services/quote-service.js'
import { quoteTemplateService } from '../services/quote-template-service.js'
import { parse } from '../validation.js'

const listQuery = z.object({ customerId: z.string().max(64).optional() })
const htmlQuery = z.object({ templateId: z.string().max(64).optional() })

export function quoteRoutes(router: Router): void {
  router.get('/api/quotes', (ctx) => {
    ctx.body = quoteService.list(parse(listQuery, ctx.query))
  })
  router.post('/api/quotes', (ctx) => {
    ctx.status = 201
    ctx.body = quoteService.create(ctx.request.body)
  })
  router.get('/api/quotes/:id', (ctx) => {
    ctx.body = quoteService.require(ctx.params.id)
  })
  router.patch('/api/quotes/:id', (ctx) => {
    ctx.body = quoteService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/quotes/:id', (ctx) => {
    quoteService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.get('/api/quotes/:id/html', (ctx) => {
    const quote = quoteService.require(ctx.params.id)
    const { templateId } = parse(htmlQuery, ctx.query)
    let template = quoteTemplateService.getDefault()
    if (templateId) {
      template = quoteTemplateService.get(templateId)
      if (!template) throw notFound('报价模板')
    }
    ctx.type = 'text/html; charset=utf-8'
    // 报价单里不允许脚本与外部资源
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    ctx.body = renderQuoteHtml(quote, template)
  })
}
