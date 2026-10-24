import type Router from '@koa/router'
import { pipelineService, taskService } from '../services/task-service.js'

/** CRM 任务 / 跟进提醒与销售漏斗统计（docs/API-CONTRACT.md §10） */
export function taskRoutes(router: Router): void {
  router.get('/api/tasks', (ctx) => {
    ctx.body = taskService.list(ctx.query)
  })
  router.post('/api/tasks', (ctx) => {
    ctx.status = 201
    ctx.body = taskService.create(ctx.request.body)
  })
  router.get('/api/tasks/:id', (ctx) => {
    ctx.body = taskService.require(ctx.params.id)
  })
  router.patch('/api/tasks/:id', (ctx) => {
    ctx.body = taskService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/tasks/:id', (ctx) => {
    taskService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.get('/api/pipeline/stats', (ctx) => {
    ctx.body = pipelineService.stats(ctx.query)
  })
}
