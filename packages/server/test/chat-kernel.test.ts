import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

let server: TestServer
let mock: Server
let mockUrl = ''
const requests: Array<{ messages: Array<Record<string, any>>; tools?: unknown[] }> = []

/** 最小 OpenAI 兼容流式服务：用户说“查价格”时发起工具调用，收到工具结果后回答 */
function startMockOpenAI(): Promise<void> {
  mock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      requests.push(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const last = body.messages[body.messages.length - 1]
      if (last.role === 'user' && String(last.content).includes('查价格') && body.tools?.length) {
        send({ choices: [{ delta: { content: '我来查一下。' } }] })
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: body.tools[0].function.name, arguments: '{"sku":"BV-25"}' } }],
              },
            },
          ],
        })
      } else if (last.role === 'tool') {
        send({ choices: [{ delta: { content: `工具返回：${last.content}` } }] })
      } else {
        send({ choices: [{ delta: { content: '你好，' } }] })
        send({ choices: [{ delta: { content: '我是 LULUX。' } }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => {
      mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`
      resolve()
    })
  })
}

const MCP_SCRIPT = `
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  let result = {}
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'price', version: '1' } }
  if (msg.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'price lookup', inputSchema: { type: 'object', properties: { sku: { type: 'string' } } } }] }
  if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'PRICE=42 for ' + msg.params.arguments.sku }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
})`

beforeAll(async () => {
  await startMockOpenAI()
  server = await startTestServer({ ANTHROPIC_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key' })
})

afterAll(async () => {
  const { mcpRuntime } = await import('../src/services/mcp/runtime.js')
  mcpRuntime.closeAll()
  await server.close()
  await new Promise((resolve) => mock.close(resolve))
})

describe('对话编排（mock Provider + MCP 工具）', () => {
  let sessionId = ''

  it('基础对话：SSE 事件带 runtime', async () => {
    const provider = await server.request('POST', '/api/providers', {
      body: { name: 'Mock', kind: 'openai', baseUrl: mockUrl, apiKey: 'sk-mock-key-123456', model: 'mock-1' },
    })
    expect(provider.status).toBe(201)
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })
    sessionId = session.json.session.id

    const res = await server.request('POST', '/api/chat', { body: { sessionId, content: '你好' } })
    expect(res.status).toBe(200)
    const events = parseSse(res.text)
    expect(events.map((e) => e.event)).toEqual(['start', 'agent', 'delta', 'delta', 'done'])
    const runtime = { kind: 'provider', providerName: 'Mock', model: 'mock-1' }
    expect(events[1]!.data.runtime).toEqual(runtime)
    expect(events[4]!.data.message).toMatchObject({ content: '你好，我是 LULUX。', senderAgentId: 'builtin', runtime })
    // 上游收到的是解密后的 Key
    expect(requests[0]!.messages[0]!.role).toBe('system')
  })

  it('工具结果进入下一轮上下文', async () => {
    const { setConfirmChannelForTests } = await import('../src/services/mcp/confirm.js')
    setConfirmChannelForTests({ available: () => true, request: async () => true })
    const mcp = await server.request('POST', '/api/mcp/servers', {
      body: { name: 'price', command: process.execPath, args: ['-e', MCP_SCRIPT] },
    })
    expect(mcp.status).toBe(201)
    // 本用例按“全部工具”断言上游收到的 tools[0]（MCP 工具）；按需加载见 toolsets.test.ts
    await server.request('PATCH', '/api/settings', { body: { toolApproval: 'auto', toolLoading: 'all' } })

    const first = await server.request('POST', '/api/chat', { body: { sessionId, content: '帮我查价格' } })
    const events = parseSse(first.text)
    expect(events.map((e) => e.event)).toContain('tool_request')
    const result = events.find((e) => e.event === 'tool_result')!
    expect(result.data).toMatchObject({ ok: true, name: 'lookup', server: 'price', result: 'PRICE=42 for BV-25' })
    const done = events.find((e) => e.event === 'done')!
    expect(done.data.message.content).toBe('我来查一下。工具返回：PRICE=42 for BV-25')
    expect(done.data.message.toolTrace).toHaveLength(1)

    requests.length = 0
    await server.request('POST', '/api/chat', { body: { sessionId, content: '刚才价格是多少？' } })
    const history = requests[0]!.messages
    const assistantWithCall = history.find((m) => m.role === 'assistant' && m.tool_calls?.length)
    expect(assistantWithCall).toBeDefined()
    expect(assistantWithCall!.tool_calls[0].id).toBe('call_1')
    const toolMessage = history.find((m) => m.role === 'tool')
    expect(toolMessage).toMatchObject({ tool_call_id: 'call_1', content: 'PRICE=42 for BV-25' })
    // 顺序：user → assistant(tool_calls) → tool → assistant(最终回答) → user
    const roles = history.slice(-5).map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
  })

  it('MCP 停用后历史以文本形式保留工具结果', async () => {
    const list = await server.request('GET', '/api/mcp/servers')
    await server.request('PATCH', `/api/mcp/servers/${list.json.servers[0].id}`, { body: { enabled: false } })
    requests.length = 0
    await server.request('POST', '/api/chat', { body: { sessionId, content: '再说一次' } })
    const history = requests[0]!.messages
    expect(history.some((m) => m.role === 'tool')).toBe(false)
    expect(history.some((m) => m.role === 'user' && String(m.content).includes('PRICE=42'))).toBe(true)
  })

  it('无 Provider 时 400 NO_PROVIDER（JSON，不打开 SSE）', async () => {
    const { db } = await import('../src/db.js')
    const saved = db.prepare('SELECT * FROM providers').all()
    db.prepare('DELETE FROM providers').run()
    const res = await server.request('POST', '/api/chat', { body: { sessionId, content: 'x' } })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('NO_PROVIDER')
    for (const row of saved as Array<Record<string, any>>) {
      db.prepare('INSERT INTO providers (id,name,kind,base_url,api_key,model,models,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
        row.id, row.name, row.kind, row.base_url, row.api_key, row.model, row.models, row.created_at,
      )
    }
  })
})

describe('内核 Kernels', () => {
  it('列表含 builtin + 7 个真实内核（内核管理页顺序），log 与 404', async () => {
    const res = await server.request('GET', '/api/kernels')
    expect(res.json.map((k: { id: string }) => k.id)).toEqual(['builtin', 'hermes', 'claude-code', 'codex', 'pi', 'grok', 'gemini-cli', 'qwen-code'])
    expect(res.json[0]).toMatchObject({ installed: true, status: 'idle', requiresLogin: false })
    // 默认 scoped 模式（经本机网关用 LULUX 的 Provider），不需要 CLI 自己登录
    expect(res.json[1]).toMatchObject({ npmPackage: 'hermes-agent', avatar: '/agents/hermes.png', installed: false })
    expect(res.json[2]).toMatchObject({ npmPackage: '@anthropic-ai/claude-code', avatar: '/agents/claude.png', installed: false, version: null, requiresLogin: false, mode: 'scoped' })
    expect((await server.request('GET', '/api/kernels/claude-code/log')).json).toEqual({ lines: [] })
    expect((await server.request('POST', '/api/kernels/nope/install')).status).toBe(404)
    expect((await server.request('POST', '/api/kernels/builtin/install')).status).toBe(400)
    expect((await server.request('POST', '/api/kernels/codex/update')).status).toBe(409)
  })

  it('安装 / 卸载流程（替身 npm）：202 → 轮询 → idle', async () => {
    const fakeNpm = join(server.home, 'fake-npm')
    writeFileSync(
      fakeNpm,
      `#!${process.execPath}
const fs = require('fs'); const path = require('path')
const args = process.argv.slice(2)
const prefix = args[args.indexOf('--prefix') + 1]
const registry = args[args.indexOf('--registry') + 1]
console.log('npm http fetch GET 200 ' + registry + '/@google%2fgemini-cli')
const dir = path.join(prefix, 'node_modules', '@google', 'gemini-cli')
fs.mkdirSync(path.join(dir, 'bundle'), { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.64.0', bin: { gemini: 'bundle/gemini.js' } }))
fs.writeFileSync(path.join(dir, 'bundle', 'gemini.js'), 'console.log(1)')
console.log('added 1 package')
`,
    )
    chmodSync(fakeNpm, 0o755)
    process.env.LULUX_KERNEL_NPM = fakeNpm

    const started = await server.request('POST', '/api/kernels/gemini-cli/install')
    expect(started.status).toBe(202)
    expect(started.json.status).toBe('installing')
    expect((await server.request('POST', '/api/kernels/gemini-cli/install')).status).toBe(409)

    let kernel: any
    for (let i = 0; i < 50; i += 1) {
      kernel = (await server.request('GET', '/api/kernels')).json.find((k: { id: string }) => k.id === 'gemini-cli')
      if (kernel.status !== 'installing') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(kernel).toMatchObject({ status: 'idle', installed: true, version: '0.64.0', error: null })
    const log = (await server.request('GET', '/api/kernels/gemini-cli/log')).json.lines as string[]
    expect(log.some((line) => line.includes('--registry https://registry.npmmirror.com'))).toBe(true)
    expect(log.some((line) => line.includes('安装完成'))).toBe(true)

    expect((await server.request('POST', '/api/kernels/gemini-cli/uninstall')).status).toBe(202)
    for (let i = 0; i < 50; i += 1) {
      kernel = (await server.request('GET', '/api/kernels')).json.find((k: { id: string }) => k.id === 'gemini-cli')
      if (kernel.status !== 'uninstalling') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(kernel).toMatchObject({ status: 'idle', installed: false })
  })

  it('npm 不存在时给出清晰错误', async () => {
    process.env.LULUX_KERNEL_NPM = join(server.home, 'no-such-npm')
    await server.request('POST', '/api/kernels/qwen-code/install')
    let kernel: any
    for (let i = 0; i < 50; i += 1) {
      kernel = (await server.request('GET', '/api/kernels')).json.find((k: { id: string }) => k.id === 'qwen-code')
      if (kernel.status !== 'installing') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(kernel.status).toBe('error')
    expect(kernel.error).toMatch(/npm/)
    delete process.env.LULUX_KERNEL_NPM
  })

  it('kernel Agent 真正启动 CLI，stream-json 转成 SSE 增量，runtime=kernel', async () => {
    // global 模式：用 CLI 自己的登录与参数（scoped 模式的实测见 kernels-scoped.test.ts）
    await server.request('PATCH', '/api/settings', { body: { kernelModeClaudeCode: 'global', kernelModeCodex: 'global' } })
    const kernelsDir = join(server.home, 'kernels')
    fakeKernelPackage(
      kernelsDir,
      'claude-code',
      '@anthropic-ai/claude-code',
      'claude',
      'bin/claude.js',
      `let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const args = process.argv.slice(2).join(' ')
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ARGS[' + args + '] ' } } })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'GOT:' + input.split('\\n').pop() } } })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'full message should be skipped' }] } })
  out({ type: 'result', is_error: false, result: 'done' })
})`,
    )
    const agents = (await server.request('GET', '/api/agents')).json.agents
    expect(agents.find((a: { id: string }) => a.id === 'kernel-claude-code')).toMatchObject({ available: true, unavailableReason: null })

    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-claude-code'] } })
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: '写一封开发信' } })
    const events = parseSse(res.text)
    expect(events.map((e) => e.event)).toEqual(['start', 'agent', 'delta', 'delta', 'done'])
    const globalRuntime = {
      kind: 'kernel',
      kernelId: 'claude-code',
      version: '9.9.9-test',
      mode: 'global',
      providerName: null,
      model: null,
      label: 'Claude Code 9.9.9-test',
    }
    expect(events[1]!.data.runtime).toEqual(globalRuntime)
    const message = events[4]!.data.message
    // 全局默认 toolApproval=auto → 完全权限：Claude Code 带 bypassPermissions 参数（契约 §6.11）
    expect(message.content).toContain(
      'ARGS[-p --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions]',
    )
    expect(message.content).toContain('GOT:写一封开发信')
    expect(message.content).not.toContain('should be skipped')
    expect(message.runtime).toEqual(globalRuntime)
  })

  it('global 内核：会话的模型 / 推理强度映射成 CLI 参数（契约 §6.13）', async () => {
    const session = await server.request('POST', '/api/sessions', {
      body: { agentIds: ['kernel-claude-code'], model: 'opus', reasoningEffort: 'xhigh' },
    })
    expect(session.status, session.text).toBe(201)
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: '选了模型' } })
    const done = parseSse(res.text).find((e) => e.event === 'done')!
    expect(done.data.message.content).toContain('--model opus --effort xhigh')
  })

  it('内核未登录：错误事件 KERNEL_LOGIN_REQUIRED，提示清晰', async () => {
    const kernelsDir = join(server.home, 'kernels')
    // 与真实 codex exec --json 未登录时的输出一致
    fakeKernelPackage(
      kernelsDir,
      'codex',
      '@openai/codex',
      'codex',
      'bin/codex.js',
      `process.stdin.resume(); process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'thread.started', thread_id: 't' })
  out({ type: 'turn.started' })
  out({ type: 'error', message: 'Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' })
  out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } })
  process.exit(1)
})`,
    )
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-codex'] } })
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: 'hi' } })
    const error = parseSse(res.text).find((e) => e.event === 'error')!
    expect(error.data.code).toBe('KERNEL_LOGIN_REQUIRED')
    expect(error.data.message).toContain('Codex 需要登录')
    expect(error.data.message).toContain('codex login')
  })

  it('内核登录检测：未检测到凭据时 Agent 标记“需要登录”', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    const prevHome = process.env.HOME
    process.env.HOME = server.home
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    expect(findKernel('codex')!.detectLogin({})).toBe(false)
    const agents = (await server.request('GET', '/api/agents')).json.agents
    expect(agents.find((a: { id: string }) => a.id === 'kernel-codex')).toMatchObject({ available: false, unavailableReason: '需要登录' })
    // 切回 scoped：只要求已安装 + 有 Provider，不再要求登录
    await server.request('PATCH', '/api/settings', { body: { kernelModeCodex: 'scoped' } })
    const scoped = (await server.request('GET', '/api/agents')).json.agents
    expect(scoped.find((a: { id: string }) => a.id === 'kernel-codex')).toMatchObject({ available: true, unavailableReason: null })
    process.env.OPENAI_API_KEY = saved
    process.env.HOME = prevHome
  })
})
