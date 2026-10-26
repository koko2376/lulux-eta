import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 真实 Hermes Agent / Pi / Grok Build（scoped 模式）经本机网关 + 内置 LULUX MCP 读 CRM。上游是 mock-openai，
 * mock 让模型调用 mcp__lulux__search_customers。内核目录 LULUX_TEST_KERNELS_DIR（默认 ~/.lulux-eta/kernels），
 * 没装对应 CLI 时跳过（CI 无网络不会失败）。
 */
const KERNELS_DIR = process.env.LULUX_TEST_KERNELS_DIR || join(homedir(), '.lulux-eta', 'kernels')
let server: TestServer
let mock: ChildProcess
let mockBase = ''

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
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_KERNELS_DIR: KERNELS_DIR })
  await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-real-key-1234567', model: 'mock-model' },
  })
  await server.request('POST', '/api/customers', { body: { company: 'Real MCP Trading', country: 'SE' } })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

const REAL = [
  { id: 'pi', pkg: ['@earendil-works', 'pi-coding-agent'] },
  { id: 'hermes', pkg: ['hermes-agent'] },
  { id: 'grok', pkg: ['@xai-official', 'grok'] },
]

describe('真实 CLI 经内置 LULUX MCP 读 CRM（未安装则跳过）', () => {
  for (const kernel of REAL) {
    it(`${kernel.id}：模型调用 LULUX MCP 的 search_customers，结果回到对话的工具记录里；不声明 shell / 写文件工具`, async (ctx) => {
      if (!existsSync(join(KERNELS_DIR, kernel.id, 'node_modules', ...kernel.pkg, 'package.json'))) {
        console.warn(`[kernel-mcp-real] 跳过 ${kernel.id}：${KERNELS_DIR} 下未安装`)
        ctx.skip()
        return
      }
      await mockCall('/__mock/reset')
      // Grok Build 自己生成会话标题的旁路请求不算在剧本里
      await mockCall('/__mock/ignore', { systemContains: ['generating the session title'] })
      // Hermes / Pi 把 MCP 工具直接声明为 mcp__lulux__<tool>；Grok Build 1.0 总是按需发现：
      // 声明 search_tool / use_tool，模型用 use_tool { tool_name: 'lulux__<tool>', tool_input } 调用
      const grok = kernel.id === 'grok'
      const toolName = grok ? 'use_tool' : 'mcp__lulux__search_customers'
      const args = grok ? { tool_name: 'lulux__search_customers', tool_input: { query: 'Real MCP' } } : { query: 'Real MCP' }
      await mockCall('/__mock/script', {
        responses: [{ toolCalls: [{ id: 'm1', name: toolName, arguments: args }] }, { text: `DONE-${kernel.id}` }],
      })
      const session = await server.request('POST', '/api/sessions', { body: { agentIds: [`kernel-${kernel.id}`] } })
      const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: '查一下 Real MCP 这个客户' } })
      const events = parseSse(res.text)
      expect(events.find((e) => e.event === 'error')).toBeUndefined()
      const message = events.find((e) => e.event === 'done')!.data.message
      expect(message.content).toContain(`DONE-${kernel.id}`)
      expect(message.runtime).toMatchObject({ kind: 'kernel', kernelId: kernel.id, mode: 'scoped', model: 'mock-model' })
      expect(message.toolTrace.map((t: any) => t.name)).toEqual(['search_customers'])
      expect(message.toolTrace[0].result).toContain('Real MCP Trading')
      const tools = ((await mockCall('/__mock/requests'))[0].tools ?? []).map((t: any) => t.function?.name ?? t.name)
      expect(tools).toContain(toolName)
      expect(tools.some((name: string) => /^(bash|terminal|write|write_file|edit|patch|execute_code|run_terminal_command|search_replace)$/.test(name))).toBe(false)
    }, 300_000)
  }
})
