import type Router from '@koa/router'
import { z } from 'zod'
import { parse } from '../validation.js'
import { MEMORY_SECTIONS, memoryService, memoryWriteInput } from '../services/memory/memory-service.js'

/**
 * 长期记忆（docs/API-CONTRACT.md §6.12）：全部接口只读写“当前账号”自己的记忆，没有按别人 id 访问的入口。
 * 写操作只需 data:read（个人数据，只读角色也能管理自己的记忆），见 middleware/policy.ts。
 */
export function memoryRoutes(router: Router): void {
  router.get('/api/memory', (ctx) => {
    ctx.body = memoryService.state()
  })
  router.patch('/api/memory/settings', (ctx) => {
    memoryService.setPrefs(ctx.request.body)
    ctx.body = memoryService.state()
  })
  router.post('/api/memory/entries', (ctx) => {
    const input = parse(memoryWriteInput, ctx.request.body)
    const { entry, duplicate } = memoryService.add({ ...input, source: 'user' })
    ctx.status = duplicate ? 200 : 201
    ctx.body = { entry, duplicate }
  })
  router.patch('/api/memory/entries/:id', (ctx) => {
    const { content } = parse(z.object({ content: z.string().max(4000) }), ctx.request.body)
    ctx.body = { entry: memoryService.update(ctx.params.id, content) }
  })
  router.delete('/api/memory/entries/:id', (ctx) => {
    memoryService.delete(ctx.params.id)
    ctx.status = 204
  })
  router.delete('/api/memory', (ctx) => {
    const section = parse(z.object({ section: z.enum(MEMORY_SECTIONS).optional() }), ctx.query)
    ctx.body = { removed: memoryService.clear(section.section) }
  })
}
