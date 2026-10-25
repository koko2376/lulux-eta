import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 内置内核工具循环回归（审计 2026-10-24 #8 #9）：
 * 调过工具后模型回空要重试一次、仍空给可读错误；当前轮的大工具结果按模型窗口截短。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as any).port
      probe.close(() => resolve(port))
    })
  })
}
const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const script = (...responses: unknown[]) =>
  fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })
const requests = async (): Promise<any[]> => (await (await fetch(`${mockBase}/__mock/requests`)).json()) as any[]

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((resolve) => mock.stdout!.once('data', () => resolve()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await api('PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, toolLoading: 'all', skillAutoPreload: false })
}, 30_000)
afterAll(async () => {
  mock?.kill()
  await server.close()
})

describe('调过工具后模型回空', () => {
  it('重试一次并要求根据工具结果作答', async () => {
    const sessionId = (await api('POST', '/api/sessions', { agentIds: ['builtin'] })).json.session.id
    await script({ toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] }, { text: '', finish: 'stop' }, { text: '现在是上午十点。' })
    const res = await api('POST', '/api/chat', { sessionId, content: '几点了' })
    const events = parseSse(res.text)
    expect(events.some((event) => event.event === 'error')).toBe(false)
    expect(events.some((event) => event.event === 'retry' && event.data.code === 'EMPTY_REPLY')).toBe(true)
    const done = events.find((event) => event.event === 'done')!
    expect(done.data.message.content).toBe('现在是上午十点。')
    expect(done.data.message.toolTrace).toHaveLength(1)
  })

  it('重试后仍为空：给出 EMPTY_REPLY 错误，消息记为出错而不是空的正常回答', async () => {
    const sessionId = (await api('POST', '/api/sessions', { agentIds: ['builtin'] })).json.session.id
    await script({ toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] }, { text: '', finish: 'stop' }, { text: '', finish: 'stop' })
    const res = await api('POST', '/api/chat', { sessionId, content: '几点了' })
    const events = parseSse(res.text)
    const error = events.find((event) => event.event === 'error')
    expect(error?.data.code).toBe('EMPTY_REPLY')
    expect(error?.data.message).toContain('没有给出回答')
    expect(events.some((event) => event.event === 'done' && !event.data.aborted)).toBe(false)
    const messages = (await api('GET', `/api/sessions/${sessionId}`)).json.messages
    const reply = messages.find((message: any) => message.role === 'assistant')
    // 工具已经执行：轨迹保留，但消息标记为出错
    expect(reply.finishReason).toBe('error')
    expect(reply.toolTrace).toHaveLength(1)
  })
})

describe('当前轮工具结果按模型窗口截短', () => {
  it('唯一的大结果超出预算时被截短，并提示可以分页读取', async () => {
    const { shrinkToolResults } = await import('../src/services/chat/compaction.js')
    const { estimateTurns } = await import('../src/services/llm/tokens.js')
    const big = '中'.repeat(60_000)
    const turns: any[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: '读一下文件' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'workspace_read', arguments: '{}' }] },
      { role: 'tool', content: big, toolCallId: 'c', toolName: 'workspace_read' },
    ]
    const budget = 25_000
    expect(shrinkToolResults(turns, budget, 0, 2)).toBe(1)
    expect(estimateTurns(turns)).toBeLessThanOrEqual(budget)
    expect(turns[3].content).toContain('分页读取')
    expect(turns[3].content.startsWith('中'.repeat(100))).toBe(true)
    // 配对不变
    expect(turns[3].toolCallId).toBe('c')
  })

  it('同一轮有大有小：先截最长的，短结果保持完整', async () => {
    const { shrinkToolResults } = await import('../src/services/chat/compaction.js')
    const small = '小结果'.repeat(50)
    const turns: any[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'y', arguments: '{}' }] },
      { role: 'tool', content: '大'.repeat(50_000), toolCallId: 'a', toolName: 'x' },
      { role: 'tool', content: small, toolCallId: 'b', toolName: 'y' },
    ]
    shrinkToolResults(turns, 20_000, 0, 1)
    expect(turns[3].content).toBe(small)
    expect(turns[2].content.length).toBeLessThan(50_000)
  })

  it('端到端：小窗口模型读到大结果时，下一次上游请求不超预算', async () => {
    await api('PATCH', '/api/settings', { modelCapabilities: '{"mock-model":{"contextWindow":16000}}' })
    try {
      const sessionId = (await api('POST', '/api/sessions', { agentIds: ['builtin'] })).json.session.id
      const big = '数'.repeat(40_000)
      const { sessionWorkspace } = await import('../src/services/tools/workspace.js')
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const dir = sessionWorkspace(sessionId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'big.txt'), big)
      const before = (await requests()).length
      await script({ toolCalls: [{ id: 'r1', name: 'workspace_read', arguments: { path: 'big.txt' } }] }, { text: '读完了' })
      const res = await api('POST', '/api/chat', { sessionId, content: '读 big.txt' })
      const events = parseSse(res.text)
      expect(events.find((event) => event.event === 'done')?.data.message.content).toBe('读完了')
      const sent = (await requests()).slice(before)
      const last = sent.at(-1)
      const toolTurn = last.messages.find((message: any) => message.role === 'tool')
      expect(toolTurn.content.length).toBeLessThan(16_000)
      expect(toolTurn.content).toContain('已截短')
    } finally {
      await api('PATCH', '/api/settings', { modelCapabilities: '' })
    }
  })
})
