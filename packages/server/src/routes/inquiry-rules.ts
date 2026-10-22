import type Router from '@koa/router'
import { inquiryRuleService } from '../services/inquiry-rule-service.js'
import { quoteTemplateService } from '../services/quote-template-service.js'

export function inquiryRuleRoutes(router: Router): void {
  router.get('/api/inquiry-rules', (ctx) => {
    ctx.body = inquiryRuleService.list()
  })
  router.post('/api/inquiry-rules/test', (ctx) => {
    ctx.body = inquiryRuleService.test(ctx.request.body)
  })
  router.post('/api/inquiry-rules', (ctx) => {
    ctx.status = 201
    ctx.body = inquiryRuleService.create(ctx.request.body)
  })
  router.patch('/api/inquiry-rules/:id', (ctx) => {
    ctx.body = inquiryRuleService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/inquiry-rules/:id', (ctx) => {
    inquiryRuleService.remove(ctx.params.id)
    ctx.status = 204
  })
}

export function quoteTemplateRoutes(router: Router): void {
  router.get('/api/quote-templates', (ctx) => {
    ctx.body = quoteTemplateService.list()
  })
  router.post('/api/quote-templates', (ctx) => {
    ctx.status = 201
    ctx.body = quoteTemplateService.create(ctx.request.body)
  })
  router.patch('/api/quote-templates/:id', (ctx) => {
    ctx.body = quoteTemplateService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/quote-templates/:id', (ctx) => {
    quoteTemplateService.remove(ctx.params.id)
    ctx.status = 204
  })
}
