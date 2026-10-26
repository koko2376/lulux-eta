import type Router from '@koa/router'
import { prospectService } from '../services/prospect-service.js'
import { prospectImportService } from '../services/prospect-import.js'

/**
 * 潜客接口。权限 / 可见性与客户一致：读要 data:read（policy 的默认 data:write 规则不覆盖 GET），
 * 写要 data:write，删除要 customer:delete，均在服务层校验（与 customers 路由同样的分工）。
 */
export function prospectRoutes(router: Router): void {
  router.get('/api/prospects', (ctx) => {
    ctx.body = prospectService.list(ctx.query)
  })
  router.get('/api/prospects/counts', (ctx) => {
    ctx.body = prospectService.counts()
  })
  // 表格导入（客户端解析 CSV / Excel 后按列映射提交）；必须在 /api/prospects/:id 之前
  router.post('/api/prospects/import', (ctx) => {
    ctx.body = prospectImportService.import(ctx.request.body)
  })
  // 必须在 /api/prospects/:id 之前
  router.post('/api/prospects/upsert', (ctx) => {
    ctx.body = prospectService.upsert(ctx.request.body)
  })
  router.post('/api/prospects', (ctx) => {
    ctx.status = 201
    ctx.body = prospectService.create(ctx.request.body)
  })
  router.get('/api/prospects/:id', (ctx) => {
    ctx.body = prospectService.require(ctx.params.id)
  })
  router.patch('/api/prospects/:id', (ctx) => {
    ctx.body = prospectService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/prospects/:id', (ctx) => {
    prospectService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/prospects/:id/status', (ctx) => {
    const body = (ctx.request.body ?? {}) as { status?: unknown }
    ctx.body = prospectService.setStatus(ctx.params.id, body.status)
  })
  router.post('/api/prospects/:id/convert', (ctx) => {
    ctx.body = prospectService.convertToCustomer(ctx.params.id, ctx.request.body)
  })
}
