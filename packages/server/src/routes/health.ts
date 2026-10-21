import type Router from '@koa/router'
import { APP_VERSION, config, MIN_CLIENT_VERSION } from '../config.js'

export function healthRoutes(router: Router): void {
  // 需要 token；只返回 ok，不暴露版本与数据目录
  router.get('/api/health', (ctx) => {
    ctx.body = { ok: true }
  })

  // 公开：客户端（桌面端连团队服务器）据此判断版本是否兼容。只给版本号，不含部署细节
  router.get('/api/version', (ctx) => {
    ctx.body = { version: APP_VERSION, minClientVersion: MIN_CLIENT_VERSION, mode: config.mode }
  })
}
