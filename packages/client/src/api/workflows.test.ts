import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { schedulesApi, toAutomationEvent, workflowCounts, workflowsApi } from './workflows'

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const queue = [...responses]
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = queue.shift() ?? { status: 200, body: {} }
    const status = r.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
const call = (fn: ReturnType<typeof mockFetch>, i = 0) => {
  const [url, init] = fn.mock.calls[i]
  return { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

afterEach(() => vi.unstubAllGlobals())

describe('workflowsApi（契约：工作流 REST）', () => {
  it('列表接受数组或 { workflows }，计数优先用 nodeCount / edgeCount', async () => {
    const fn = mockFetch([
      { body: [{ id: 'w1', name: 'A', nodes: [], edges: [], nodeCount: 3, edgeCount: 2 }] },
      { body: { workflows: [{ id: 'w2', name: 'B', nodes: [{}], edges: [] }] } },
    ])
    const a = await workflowsApi.list()
    expect(call(fn).url).toBe('/api/workflows')
    expect(workflowCounts(a[0])).toEqual({ nodes: 3, edges: 2 })
    const b = await workflowsApi.list()
    expect(b[0].id).toBe('w2')
    expect(workflowCounts(b[0])).toEqual({ nodes: 1, edges: 0 })
  })

  it('PATCH 带 nodes / edges / viewport；CYCLE_DETECTED 抛出 ApiError（silent 不弹 toast）', async () => {
    const fn = mockFetch([
      { body: { id: 'w1', name: 'A' } },
      { status: 400, body: { error: { code: 'CYCLE_DETECTED', message: 'cycle' } } },
    ])
    const nodes = [
      {
        id: 'n1',
        name: '节点 1',
        kernelId: 'builtin',
        prompt: '',
        joinStrategy: 'all' as const,
        allowWrite: false,
        position: { x: 0, y: 0 },
      },
    ]
    await workflowsApi.update('w1', { nodes, edges: [], viewport: { x: 1, y: 2, zoom: 1 } })
    expect(call(fn)).toMatchObject({ url: '/api/workflows/w1', method: 'PATCH' })
    expect(call(fn).body).toEqual({ nodes, edges: [], viewport: { x: 1, y: 2, zoom: 1 } })
    const err = await workflowsApi.update('w1', { edges: [] }, true).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('CYCLE_DETECTED')
  })

  it('运行 / 运行记录 / 取消 / 导入 / 复制 / 删除 用契约路径', async () => {
    const fn = mockFetch([
      { body: { id: 'r1', status: 'queued', nodes: [] } },
      { body: { id: 'r2', status: 'queued', nodes: [] } },
      { body: [{ id: 'r1' }] },
      { body: { run: { id: 'r1', status: 'running' } } },
      { body: { id: 'r1', status: 'cancelled' } },
      { body: { id: 'w9', name: 'imported' } },
      { body: { id: 'w3' } },
      { status: 204 },
      { body: { name: 'x', nodes: [] } },
    ])
    expect((await workflowsApi.run('w1', '本周询盘')).id).toBe('r1')
    expect(call(fn, 0)).toEqual({ url: '/api/workflows/w1/run', method: 'POST', body: { input: '本周询盘' } })
    await workflowsApi.run('w1')
    expect(call(fn, 1).body).toEqual({})
    await workflowsApi.runs('w1', 20)
    expect(call(fn, 2).url).toBe('/api/workflows/w1/runs?limit=20')
    expect((await workflowsApi.getRun('r1')).status).toBe('running')
    expect(call(fn, 3).url).toBe('/api/workflow-runs/r1')
    await workflowsApi.cancelRun('r1')
    expect(call(fn, 4)).toMatchObject({ url: '/api/workflow-runs/r1/cancel', method: 'POST' })
    await workflowsApi.importJson({ name: 'x' })
    expect(call(fn, 5)).toEqual({ url: '/api/workflows/import', method: 'POST', body: { json: { name: 'x' } } })
    await workflowsApi.duplicate('w1')
    expect(call(fn, 6)).toMatchObject({ url: '/api/workflows/w1/duplicate', method: 'POST' })
    await workflowsApi.remove('w1')
    expect(call(fn, 7)).toMatchObject({ url: '/api/workflows/w1', method: 'DELETE' })
    await workflowsApi.exportJson('w1')
    expect(call(fn, 8)).toMatchObject({ url: '/api/workflows/w1/export' })
  })
})

describe('schedulesApi（契约：定时任务 REST）', () => {
  it('预览 POST {spec, timezone} → next[]；立即运行 / 运行记录 / PATCH', async () => {
    const fn = mockFetch([
      { body: { next: [1, 2, 3, 4, 5] } },
      { body: { id: 'sr1', status: 'running' } },
      { body: { runs: [{ id: 'sr1' }] } },
      { body: { id: 's1', enabled: false } },
    ])
    const next = await schedulesApi.preview({ type: 'daily', time: '09:00' }, 'Asia/Shanghai')
    expect(next).toEqual([1, 2, 3, 4, 5])
    expect(call(fn, 0)).toEqual({
      url: '/api/schedules/preview',
      method: 'POST',
      body: { spec: { type: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai' },
    })
    await schedulesApi.runNow('s1')
    expect(call(fn, 1)).toMatchObject({ url: '/api/schedules/s1/run-now', method: 'POST' })
    expect(await schedulesApi.runs('s1', 20)).toEqual([{ id: 'sr1' }])
    expect(call(fn, 2).url).toBe('/api/schedules/s1/runs?limit=20')
    await schedulesApi.update('s1', { enabled: false })
    expect(call(fn, 3)).toEqual({ url: '/api/schedules/s1', method: 'PATCH', body: { enabled: false } })
  })
})

describe('toAutomationEvent', () => {
  it('认 SSE event 名或 data.type；字段不全时忽略', () => {
    expect(
      toAutomationEvent({ event: 'workflow.run', data: { runId: 'r', workflowId: 'w', status: 'running' } }),
    ).toEqual({ type: 'workflow.run', runId: 'r', workflowId: 'w', status: 'running' })
    expect(
      toAutomationEvent({
        event: 'message',
        data: { type: 'workflow.node', runId: 'r', nodeId: 'n', status: 'running', delta: 'hi' },
      }),
    ).toMatchObject({ type: 'workflow.node', nodeId: 'n', delta: 'hi' })
    expect(toAutomationEvent({ event: 'schedule.run', data: { scheduleId: 's', status: 'failed' } })).toMatchObject({
      type: 'schedule.run',
      scheduleId: 's',
    })
    expect(toAutomationEvent({ event: 'workflow.node', data: { runId: 'r', status: 'running' } })).toBeNull()
    expect(toAutomationEvent({ event: 'session.title', data: { sessionId: 's' } })).toBeNull()
    expect(toAutomationEvent({ event: 'workflow.run', data: null })).toBeNull()
  })
})
