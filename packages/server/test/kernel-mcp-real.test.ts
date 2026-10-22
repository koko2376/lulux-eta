import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 真实 Claude Code（scoped 模式）经内置 LULUX MCP 读写 CRM。上游是 mock-openai（经网关转成 Anthropic 协议），
 * mock 让模型调用 mcp__lulux__search_customers → mcp__lulux__update_customer；写操作在 LULUX 界面审批。
 * KERNELS_DIR（LULUX_TEST_KERNELS_DIR，默认 ~/.lulux-eta/kernels）下没有 claude-code 时跳过。
 */
const KERNELS_DIR = process.env.LULUX_TEST_KERNELS_DIR || join(homedir(), '.lulux-eta', 'kernels')
const installed = existsSync(join(KERNELS_DIR, 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'))
let server: TestServer
let mock: ChildProcess
let mockBase = ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
async function mockCall(path: string, body?: unknown): Promise<any> {
  const get = path === '/__mock/requests'
  const res = await fetch(`${mockBase}${path}`, { method: get ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: get ? undefined : JSON.stringify(body ?? {}) })
  return res.json()
}

beforeAll(async () => {
  if (!installed) return
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_KERNELS_DIR: KERNELS_DIR })
  await server.request('POST', '/api/providers', { body: { name: 'MockUp', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-123456', model: 'mock-model-1' } })
  await server.request('PATCH', '/api/settings', { body: { autoTitle: false, toolApproval: 'ask' } })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('真实 Claude Code 经 LULUX MCP 访问 CRM', () => {
  it.skipIf(!installed)('search_customers（自动）+ update_customer（界面批准）', async () => {
    const customer = (await server.request('POST', '/api/customers', { body: { company: 'Real CC Buyer GmbH' } })).json
    await mockCall('/__mock/script', {
      responses: [
        { toolCalls: [{ id: 'm1', name: 'mcp__lulux__search_customers', arguments: { query: 'Real CC' } }] },
        { toolCalls: [{ id: 'm2', name: 'mcp__lulux__update_customer', arguments: { customerId: customer.id, stage: 'negotiating' } }] },
        { text: 'DONE-REAL-CC' },
      ],
    })
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-claude-code'] } })
    const sessionId = session.json.session.id
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '把 Real CC Buyer 改成谈判中' } })
    let req: any = null
    for (let i = 0; i < 1500 && !req; i += 1) {
      await sleep(100)
      req = (await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests[0] ?? null
    }
    expect(req).toMatchObject({ name: 'update_customer', server: 'LULUX', risk: 'write' })
    await server.request('POST', '/api/chat/tool-decision', { body: { requestId: req.requestId, approved: true } })
    const events = parseSse((await pending).text)
    const requests = await mockCall('/__mock/requests')
    const toolNames = (requests[0]?.tools ?? []).map((t: any) => t.function?.name ?? t.name)
    console.info('[kernel-mcp-real] upstream tools:', toolNames.filter((n: string) => n.startsWith('mcp__')).join(', '))
    const done = events.find((e) => e.event === 'done')
    expect(done, JSON.stringify(events.slice(-3))).toBeTruthy()
    expect(done!.data.message.toolTrace.map((t: any) => [t.name, t.ok])).toEqual([
      ['search_customers', true],
      ['update_customer', true],
    ])
    expect((await server.request('GET', `/api/customers/${customer.id}`)).json.stage).toBe('negotiating')
    // Claude Code 2.1.x 把 MCP 工具作为“延迟加载工具”（ToolSearch），不一定出现在首个请求的 tools 里，但上游请求中会出现其名称
    expect(JSON.stringify(requests)).toContain('mcp__lulux__')
  }, 240_000)
})
