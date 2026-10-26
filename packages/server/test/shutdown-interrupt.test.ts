import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 优雅关闭（SIGTERM → shutdownRuns）时，进行中的工作流节点 / 定时任务应记为“服务重启，运行被中断”，
 * 而不是误导性的“没有产生回复”。shutdownRuns 会把整个进程标记为关闭中，所以单独一个测试文件。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
async function script(...responses: unknown[]): Promise<void> {
  await fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })
}
async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timeout')
    await sleep(40)
  }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  expect((await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })).status).toBe(201)
  expect((await api('PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, toolLoading: 'all', skillAutoPreload: false })).status).toBe(200)
}, 30_000)

afterAll(async () => {
  const { resetShutdownStateForTests } = await import('../src/services/chat/run-registry.js')
  resetShutdownStateForTests()
  mock?.kill()
  await server?.close()
})

it('关闭时进行中的工作流节点和定时任务记为“服务重启，运行被中断”', async () => {
  const slow = { text: '慢'.repeat(60), chunkSize: 2, delayMs: 100 }
  await script(slow, slow)
  const wf = await api('POST', '/api/workflows', {
    name: '慢流程',
    nodes: [
      { id: 'a', name: '分析', kernelId: 'builtin', prompt: '分析', joinStrategy: 'all', allowWrite: false, position: { x: 0, y: 0 } },
      { id: 'b', name: '汇总', kernelId: 'builtin', prompt: '汇总', joinStrategy: 'all', allowWrite: false, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b' }],
  })
  expect(wf.status, wf.text).toBe(201)
  const sch = await api('POST', '/api/schedules', {
    name: '慢提醒',
    target: { type: 'prompt', kernelId: 'builtin', prompt: '总结', sessionMode: 'new' },
    spec: { type: 'daily', time: '09:00' },
  })
  expect(sch.status, sch.text).toBe(201)

  const run = (await api('POST', `/api/workflows/${wf.json.id}/run`, { input: 'x' })).json
  const schRun = (await api('POST', `/api/schedules/${sch.json.id}/run-now`)).json
  // 等两边都开始流式输出
  await until(async () => ((await api('GET', `/api/workflow-runs/${run.id}`)).json.status === 'running' ? true : undefined))
  await sleep(600)

  const { isShuttingDown, shutdownRuns, SHUTDOWN_INTERRUPTED_MESSAGE } = await import('../src/services/chat/run-registry.js')
  expect(isShuttingDown()).toBe(false)
  const stopped = await shutdownRuns(3000)
  expect(stopped).toBeGreaterThanOrEqual(2)
  expect(isShuttingDown()).toBe(true)

  const finished = await until(async () => {
    const res = (await api('GET', `/api/workflow-runs/${run.id}`)).json
    return ['failed', 'cancelled', 'succeeded'].includes(res.status) ? res : undefined
  })
  expect(finished.status, JSON.stringify(finished)).toBe('failed')
  expect(finished.error).toBe(SHUTDOWN_INTERRUPTED_MESSAGE)
  expect(finished.error).not.toContain('没有产生回复')
  for (const node of finished.nodes) {
    expect(node.status).toBe('cancelled')
    expect(node.error).toBe(SHUTDOWN_INTERRUPTED_MESSAGE)
  }

  const schFinished = await until(async () => {
    const runs = (await api('GET', `/api/schedules/${sch.json.id}/runs`)).json as any[]
    const found = runs.find((r) => r.id === schRun.id)
    return found && found.status !== 'running' && found.status !== 'queued' ? found : undefined
  })
  expect(schFinished).toMatchObject({ status: 'failed', error: SHUTDOWN_INTERRUPTED_MESSAGE })
  const after = (await api('GET', `/api/schedules/${sch.json.id}`)).json
  expect(after).toMatchObject({ lastStatus: 'failed', lastError: SHUTDOWN_INTERRUPTED_MESSAGE, enabled: true })
})
