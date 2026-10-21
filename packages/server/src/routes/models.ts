import type Router from '@koa/router'
import { modelCatalog } from '../services/models/catalog.js'

/**
 * 模型选择器（契约 §6.13）：GET /api/models?kernel=builtin|<kernelId>[&providerId=]
 * 返回该内核可选的模型（按 Provider / CLI 分组）、默认模型与推理强度支持。
 * 输入框的模型选择器与工作流节点的模型下拉共用这个接口。
 */
export function modelRoutes(router: Router): void {
  router.get('/api/models', (ctx) => {
    const kernel = typeof ctx.query.kernel === 'string' ? ctx.query.kernel.trim() : 'builtin'
    const providerId = typeof ctx.query.providerId === 'string' ? ctx.query.providerId.trim() || null : null
    ctx.body = modelCatalog(kernel || 'builtin', providerId)
  })
}
