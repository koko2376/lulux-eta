import type Router from '@koa/router'
import { agentService } from '../services/agent-service.js'

export function agentRoutes(router: Router): void {
  // 已有接口保持 `{ agents }` 包装
  router.get('/api/agents', (ctx) => {
    ctx.body = { agents: agentService.list() }
  })
}
