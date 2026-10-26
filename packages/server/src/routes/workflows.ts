import type Router from '@koa/router'
import { sessionService } from '../services/session-service.js'
import { scheduleService } from '../services/schedule/schedule-service.js'
import { scheduler } from '../services/schedule/scheduler.js'
import { workflowRunner } from '../services/workflow/workflow-runner.js'
import { workflowService } from '../services/workflow/workflow-service.js'
import { z } from 'zod'
import { parse } from '../validation.js'

const runInput = z.object({ input: z.string().max(100_000).optional() }).strip()

function limitOf(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 20
}

/** 工作流与定时任务（docs/API-CONTRACT.md「工作流与定时任务」） */
export function workflowRoutes(router: Router): void {
  router.get('/api/workflows', (ctx) => {
    ctx.body = workflowService.list()
  })
  router.post('/api/workflows/import', (ctx) => {
    ctx.status = 201
    ctx.body = workflowService.import(ctx.request.body)
  })
  router.post('/api/workflows', (ctx) => {
    ctx.status = 201
    ctx.body = workflowService.create(ctx.request.body)
  })
  router.get('/api/workflows/:id', (ctx) => {
    ctx.body = workflowService.get(ctx.params.id)
  })
  router.patch('/api/workflows/:id', (ctx) => {
    ctx.body = workflowService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/workflows/:id', (ctx) => {
    workflowService.remove(ctx.params.id, (sessionId) => void sessionService.remove(sessionId))
    scheduleService.disableForWorkflow(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/workflows/:id/duplicate', (ctx) => {
    ctx.status = 201
    ctx.body = workflowService.duplicate(ctx.params.id)
  })
  router.get('/api/workflows/:id/export', (ctx) => {
    const data = workflowService.export(ctx.params.id)
    const name = String(data.name ?? 'workflow').replace(/[\\/:*?"<>|\r\n]+/g, '-').slice(0, 60) || 'workflow'
    ctx.set('Content-Disposition', `attachment; filename="workflow.json"; filename*=UTF-8''${encodeURIComponent(`${name}.json`)}`)
    ctx.type = 'application/json; charset=utf-8'
    ctx.body = data
  })
  router.post('/api/workflows/:id/run', (ctx) => {
    const body = parse(runInput, ctx.request.body)
    ctx.body = workflowRunner.start(ctx.params.id, { input: body.input ?? '', trigger: 'manual' })
  })
  router.get('/api/workflows/:id/runs', (ctx) => {
    ctx.body = workflowRunner.list(ctx.params.id, limitOf(ctx.query.limit))
  })
  router.get('/api/workflow-runs/:runId', (ctx) => {
    ctx.body = workflowRunner.get(ctx.params.runId)
  })
  router.post('/api/workflow-runs/:runId/cancel', async (ctx) => {
    ctx.body = await workflowRunner.cancel(ctx.params.runId)
  })

  router.get('/api/schedules', (ctx) => {
    ctx.body = scheduleService.list()
  })
  router.post('/api/schedules/preview', (ctx) => {
    ctx.body = scheduleService.preview(ctx.request.body)
  })
  router.post('/api/schedules', (ctx) => {
    ctx.status = 201
    ctx.body = scheduleService.create(ctx.request.body)
  })
  router.get('/api/schedules/:id', (ctx) => {
    ctx.body = scheduleService.get(ctx.params.id)
  })
  router.patch('/api/schedules/:id', (ctx) => {
    ctx.body = scheduleService.update(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/schedules/:id', (ctx) => {
    scheduleService.remove(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/schedules/:id/run-now', (ctx) => {
    ctx.body = scheduler.runNow(ctx.params.id)
  })
  router.get('/api/schedules/:id/runs', (ctx) => {
    ctx.body = scheduleService.runs(ctx.params.id, limitOf(ctx.query.limit))
  })
}
