import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 内置内核单元测试：错误分类与退避、可恢复流（重试/超时/取消/降级）、适配器（推理/usage/结束原因/思考签名）、
 * 能力矩阵、上下文压缩与工具配对、通用工具（路径穿越、fetch 协议与内网限制、计算器、时区）、费用估算、@ 解析。
 */
let server: TestServer
let upstream: Server
let upstreamUrl = ''
type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void | Promise<void>
const handlers: Handler[] = []
const received: any[] = []

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
function okStream(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString()
      const body = text ? JSON.parse(text) : {}
      received.push(body)
      const handler = handlers.shift()
      if (!handler) {
        res.writeHead(500).end('no handler')
        return
      }
      await handler(req, body, res)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
  server = await startTestServer()
})

afterAll(async () => {
  upstream.closeAllConnections?.()
  await new Promise((resolve) => upstream.close(resolve))
  await server.close()
})

describe('上游错误分类与退避', () => {
  it('按状态码/文案分类，Retry-After 解析，指数退避带封顶', async () => {
    const { classifyStatus, parseRetryAfter, backoffDelay, toUpstreamError, UpstreamError } = await import('../src/services/llm/errors.js')
    expect(classifyStatus(429, '')).toBe('rate_limit')
    expect(classifyStatus(529, '')).toBe('overloaded')
    expect(classifyStatus(503, '')).toBe('overloaded')
    expect(classifyStatus(500, '')).toBe('server')
    expect(classifyStatus(401, '')).toBe('auth')
    expect(classifyStatus(400, "This model's maximum context length is 8192 tokens")).toBe('context_length')
    expect(classifyStatus(400, 'bad param')).toBe('bad_request')
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3000)
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4000)).toBe(6000)
    expect(backoffDelay(0, null, { random: () => 0 })).toBe(1000)
    expect(backoffDelay(3, null, { random: () => 0 })).toBe(8000)
    expect(backoffDelay(10, null, { random: () => 1 })).toBe(30_000)
    expect(backoffDelay(0, 2500)).toBe(2500)
    expect(backoffDelay(0, 999_999)).toBe(60_000)
    const net = toUpstreamError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    expect(net.kind).toBe('network')
    expect(net.retryable).toBe(true)
    expect(new UpstreamError('auth', 'x').retryable).toBe(false)
    expect(new UpstreamError('rate_limit', 'x').code).toBe('UPSTREAM_RATE_LIMITED')
  })
})

describe('可恢复流 streamResilient', () => {
  const base = () => ({ baseUrl: upstreamUrl, apiKey: 'k', model: 'mock-model', messages: [{ role: 'user' as const, content: 'hi' }] })

  it('429 + 503 后成功：按 Retry-After / 指数退避重试，事件只出现一次', async () => {
    const { streamResilient } = await import('../src/services/llm/resilient.js')
    handlers.push(
      (_req, _b, res) => void res.writeHead(429, { 'retry-after': '2' }).end('{"error":{"message":"rate limited"}}'),
      (_req, _b, res) => void res.writeHead(503).end('overloaded'),
      (_req, _b, res) => {
        okStream(res)
        sse(res, { choices: [{ delta: { content: 'OK' } }] })
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
        res.end('data: [DONE]\n\n')
      },
    )
    const delays: number[] = []
    const retries: string[] = []
    const events: any[] = []
    for await (const event of streamResilient('openai', base(), {
      maxRetries: 3,
      timeoutMs: 5000,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0,
      onRetry: (info) => retries.push(info.error.code),
    })) {
      events.push(event)
    }
    expect(retries).toEqual(['UPSTREAM_RATE_LIMITED', 'UPSTREAM_OVERLOADED'])
    expect(delays).toEqual([2000, 2000]) // Retry-After 2s；第二次 2^1·1s
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'OK' }])
    expect(events).toContainEqual({ type: 'finish', reason: 'stop', raw: 'stop' })
  })

  it('超过重试次数抛分类错误；鉴权错误不重试', async () => {
    const { streamResilient } = await import('../src/services/llm/resilient.js')
    handlers.push((_r, _b, res) => void res.writeHead(500).end('boom'), (_r, _b, res) => void res.writeHead(500).end('boom'))
    let attempts = 0
    await expect(async () => {
      for await (const _ of streamResilient('openai', base(), { maxRetries: 1, timeoutMs: 5000, sleep: async () => void attempts++ })) void _
    }).rejects.toMatchObject({ kind: 'server', status: 500 })
    expect(attempts).toBe(1)

    handlers.push((_r, _b, res) => void res.writeHead(401).end('bad key'))
    await expect(async () => {
      for await (const _ of streamResilient('openai', base(), { maxRetries: 3, timeoutMs: 5000, sleep: async () => undefined })) void _
    }).rejects.toMatchObject({ kind: 'auth', code: 'UPSTREAM_AUTH' })
  })

  it('已有输出后断流：不重放（抛 network，由编排层续写）', async () => {
    const { streamResilient } = await import('../src/services/llm/resilient.js')
    handlers.push((_r, _b, res) => {
      okStream(res)
      sse(res, { choices: [{ delta: { content: '半句' } }] })
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const texts: string[] = []
    let retried = 0
    await expect(async () => {
      for await (const e of streamResilient('openai', base(), { maxRetries: 3, timeoutMs: 5000, onRetry: () => void retried++, sleep: async () => undefined })) {
        if (e.type === 'text') texts.push(e.text)
      }
    }).rejects.toMatchObject({ kind: 'network' })
    expect(texts).toEqual(['半句'])
    expect(retried).toBe(0)
  })

  it('首包超时归类为 timeout 并重试；用户取消立即中止（不等超时）', async () => {
    const { streamResilient } = await import('../src/services/llm/resilient.js')
    handlers.push(
      (_r, _b, res) => okStream(res), // 只发头
      (_r, _b, res) => {
        okStream(res)
        sse(res, { choices: [{ delta: { content: 'late' } }] })
        res.end('data: [DONE]\n\n')
      },
    )
    const codes: string[] = []
    const out: string[] = []
    for await (const e of streamResilient('openai', base(), { maxRetries: 1, timeoutMs: 300, sleep: async () => undefined, onRetry: (i) => codes.push(i.error.code) })) {
      if (e.type === 'text') out.push(e.text)
    }
    expect(codes).toEqual(['UPSTREAM_TIMEOUT'])
    expect(out).toEqual(['late'])

    handlers.push((_r, _b, res) => okStream(res))
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    await expect(async () => {
      for await (const _ of streamResilient('openai', { ...base(), signal: controller.signal }, { maxRetries: 3, timeoutMs: 10_000 })) void _
    }).rejects.toMatchObject({ kind: 'aborted' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('退避等待可被取消', async () => {
    const { abortableSleep } = await import('../src/services/llm/resilient.js')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 50)
    await expect(abortableSleep(10_000, controller.signal)).rejects.toMatchObject({ kind: 'aborted' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('Provider 不认 stream_options / tools 时自动降级重发', async () => {
    const { streamResilient } = await import('../src/services/llm/resilient.js')
    const { capabilitiesFor, resetLearnedCapabilitiesForTests } = await import('../src/services/llm/capabilities.js')
    received.length = 0
    handlers.push(
      (_r, _b, res) => void res.writeHead(400).end('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}'),
      (_r, _b, res) => void res.writeHead(400).end('{"error":{"message":"this model does not support tools"}}'),
      (_r, _b, res) => {
        okStream(res)
        sse(res, { choices: [{ delta: { content: 'fine' } }] })
        res.end('data: [DONE]\n\n')
      },
    )
    const downgrades: string[] = []
    const tools = [{ name: 'calculator', description: 'calc', inputSchema: { type: 'object' } }]
    for await (const _ of streamResilient('openai', { ...base(), model: 'legacy-x', tools }, { maxRetries: 0, timeoutMs: 5000, onDowngrade: (w) => downgrades.push(w) })) void _
    expect(downgrades).toEqual(['stream_usage', 'tools'])
    expect(received[0].stream_options).toEqual({ include_usage: true })
    expect(received[2].stream_options).toBeUndefined()
    expect(received[2].tools).toBeUndefined()
    expect(capabilitiesFor('legacy-x')).toMatchObject({ tools: false, streamUsage: false })
    resetLearnedCapabilitiesForTests()
  })
})

describe('适配器：推理、usage、结束原因', () => {
  it('OpenAI 兼容：reasoning_content、<think>、usage（含缓存命中）、finish_reason=length；旧接口只给 text/tool_calls', async () => {
    const { getExtendedStreamChat, getStreamChat } = await import('../src/services/llm/index.js')
    const script: Handler = (_r, _b, res) => {
      okStream(res)
      sse(res, { choices: [{ delta: { reasoning_content: '先想' } }] })
      sse(res, { choices: [{ delta: { content: '<thi' } }] })
      sse(res, { choices: [{ delta: { content: 'nk>内心</think>正文' } }] })
      sse(res, { choices: [{ delta: {}, finish_reason: 'length' }] })
      sse(res, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100, completion_tokens_details: { reasoning_tokens: 9 } } })
      res.end('data: [DONE]\n\n')
    }
    handlers.push(script, script)
    const events: any[] = []
    for await (const e of getExtendedStreamChat('openai')({ baseUrl: upstreamUrl, apiKey: 'k', model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'x' }] })) {
      if (e.type !== 'ping') events.push(e)
    }
    expect(events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('')).toBe('先想内心')
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('正文')
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 9 } })
    expect(events).toContainEqual({ type: 'finish', reason: 'length', raw: 'length' })

    const legacy: any[] = []
    for await (const e of getStreamChat('openai')({ baseUrl: upstreamUrl, apiKey: 'k', model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'x' }] })) legacy.push(e)
    expect(new Set(legacy.map((e) => e.type))).toEqual(new Set(['text']))
    expect(received.at(-1).stream_options).toBeUndefined()
  })

  it('DeepSeek 思考模式：工具循环内回传 reasoning_content，历史消息不带', async () => {
    const { getExtendedStreamChat } = await import('../src/services/llm/index.js')
    handlers.push((_r, _b, res) => {
      okStream(res)
      res.end('data: [DONE]\n\n')
    })
    received.length = 0
    for await (const _ of getExtendedStreamChat('openai')({
      baseUrl: upstreamUrl,
      apiKey: 'k',
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculator', arguments: '{}' }], reasoning: '要算一下' },
        { role: 'tool', content: '6', toolCallId: 'c1' },
      ],
    })) void _
    expect(received[0].messages[1]).toMatchObject({ role: 'assistant', reasoning_content: '要算一下' })
  })

  it('Anthropic：thinking 增量 + 签名块、tool_use、usage（含缓存）、max_tokens 截断；开启思考时回传签名块', async () => {
    const { getExtendedStreamChat } = await import('../src/services/llm/index.js')
    handlers.push((_r, _b, res) => {
      okStream(res)
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, output_tokens: 1 } } })
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '思考中' } })
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } })
      ev('content_block_start', { index: 1, content_block: { type: 'text' } })
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '好的' } })
      ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'calculator' } })
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"expression":"1+1"}' } })
      ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } })
      ev('message_stop', {})
      res.end()
    })
    received.length = 0
    const events: any[] = []
    for await (const e of getExtendedStreamChat('anthropic')({
      baseUrl: upstreamUrl,
      apiKey: 'k',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'calculator', arguments: '{}' }], reasoningBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }] },
        { role: 'tool', content: '2', toolCallId: 'old' },
      ],
      tools: [{ name: 'calculator', description: 'c', inputSchema: { type: 'object' } }],
    })) {
      if (e.type !== 'ping') events.push(e)
    }
    expect(received[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(received[0].max_tokens).toBeGreaterThan(2048)
    expect(received[0].messages[1].content[0]).toEqual({ type: 'thinking', thinking: 't', signature: 's' })
    expect(events).toContainEqual({ type: 'reasoning', text: '思考中' })
    expect(events).toContainEqual({ type: 'reasoning_blocks', blocks: [{ type: 'thinking', thinking: '思考中', signature: 'SIG' }] })
    expect(events).toContainEqual({ type: 'tool_calls', calls: [{ id: 'tu1', name: 'calculator', arguments: '{"expression":"1+1"}' }] })
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 65, outputTokens: 42, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 0 } })
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_calls', raw: 'tool_use' })
  })
})

describe('能力矩阵与降级', () => {
  it('内置规则 + 设置覆盖（通配）+ 非法覆盖被拒', async () => {
    const { capabilitiesFor } = await import('../src/services/llm/capabilities.js')
    expect(capabilitiesFor('deepseek-reasoner')).toMatchObject({ reasoning: 'deepseek', contextWindow: 128_000 })
    expect(capabilitiesFor('gpt-4o-mini')).toMatchObject({ vision: true, tools: true })
    expect(capabilitiesFor('gemma2:9b')).toMatchObject({ tools: false })
    expect(capabilitiesFor('claude-sonnet-4-5', 'anthropic')).toMatchObject({ reasoning: 'anthropic', streamUsage: false })
    expect(capabilitiesFor('totally-unknown')).toMatchObject({ contextWindow: 32_000, tools: true })

    const bad = await server.request('PATCH', '/api/settings', { body: { modelCapabilities: '{"x":{"tools":"no"}}' } })
    expect(bad.status).toBe(400)
    const ok = await server.request('PATCH', '/api/settings', { body: { modelCapabilities: '{"my-local-*":{"tools":false,"contextWindow":8192}}' } })
    expect(ok.status).toBe(200)
    expect(capabilitiesFor('my-local-qwen')).toMatchObject({ tools: false, contextWindow: 8192, maxOutput: 4096 })
    const caps = await server.request('GET', '/api/chat/capabilities?model=my-local-qwen')
    expect(caps.json.capabilities.tools).toBe(false)
    await server.request('PATCH', '/api/settings', { body: { modelCapabilities: '' } })
  })
})

describe('上下文压缩保持工具配对', () => {
  it('以消息为单位切分：压缩后的历史没有孤立 tool 结果，也没有缺结果的调用', async () => {
    const { planCompaction, sanitizeToolPairing, toolPairingProblems } = await import('../src/services/chat/compaction.js')
    const { buildTurns, turnsForMessage } = await import('../src/services/chat/history.js')
    const { agentService } = await import('../src/services/agent-service.js')
    const speaker = agentService.find('builtin') as any
    const big = 'x'.repeat(4000)
    const messages: any[] = []
    for (let i = 0; i < 8; i += 1) {
      messages.push({ id: `u${i}`, sessionId: 's', role: 'user', content: `问题${i} ${big}`, senderAgentId: null, toolTrace: [], toolRounds: [], runtime: null, reasoning: '', usage: null, finishReason: null, createdAt: i })
      messages.push({
        id: `a${i}`,
        sessionId: 's',
        role: 'assistant',
        content: `回答${i}`,
        senderAgentId: 'builtin',
        toolTrace: [],
        toolRounds: [
          { text: '查一下', calls: [{ id: `c${i}a`, name: 'calculator', arguments: '{}' }, { id: `c${i}b`, name: 'get_time', arguments: '{}' }], results: [{ toolCallId: `c${i}a`, toolName: 'calculator', content: big }, { toolCallId: `c${i}b`, toolName: 'get_time', content: 'now' }] },
          { text: `回答${i}`, calls: [], results: [] },
        ],
        runtime: null,
        reasoning: '',
        usage: null,
        finishReason: 'stop',
        createdAt: i,
      })
    }
    messages.push({ id: 'last', sessionId: 's', role: 'user', content: '最后的问题', senderAgentId: null, toolTrace: [], toolRounds: [], runtime: null, reasoning: '', usage: null, finishReason: null, createdAt: 99 })
    const tools = ['calculator', 'get_time'].map((name) => ({ name, description: '', inputSchema: {}, serverId: 'builtin', serverName: 'LULUX', originalName: name }))
    const { estimateTurns } = await import('../src/services/llm/tokens.js')
    const toolNames = new Set(tools.map((t) => t.name))
    const per = messages.map((m) => estimateTurns(turnsForMessage(m, speaker, 'builtin', toolNames, () => undefined)))
    const plan = planCompaction(per, messages.map((m) => m.role), 500, 6000)
    expect(plan.cut).toBeGreaterThan(0)
    expect(plan.cut).toBeLessThan(messages.length) // 最后一条用户消息永远保留
    expect(messages[plan.cut].role).toBe('user') // 保留部分从用户消息开始
    const kept = buildTurns(messages.slice(plan.cut), speaker, [speaker], null, tools as any, () => undefined)
    expect(toolPairingProblems(kept)).toEqual([])
    expect(kept.at(-1)).toMatchObject({ role: 'user', content: '最后的问题' })
    expect(plan.tokensAfter).toBeLessThan(plan.tokensBefore)

    // 兜底修复：孤立结果丢弃、缺结果补占位
    const broken: any[] = [
      { role: 'tool', content: 'orphan', toolCallId: 'zzz' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'k1', name: 'calculator', arguments: '{}' }, { id: 'k2', name: 'get_time', arguments: '{}' }] },
      { role: 'tool', content: 'r1', toolCallId: 'k1' },
      { role: 'user', content: 'next' },
    ]
    expect(toolPairingProblems(broken).length).toBeGreaterThan(0)
    const fixed = sanitizeToolPairing(broken)
    expect(toolPairingProblems(fixed)).toEqual([])
    expect(fixed.find((t) => t.toolCallId === 'zzz')).toBeUndefined()
    expect(fixed.find((t) => t.toolCallId === 'k2')).toMatchObject({ role: 'tool', toolName: 'get_time' })
  })

  it('总量未超预算时不压缩；工具循环内超预算时截短较早工具结果但保留配对', async () => {
    const { planCompaction, shrinkToolResults, toolPairingProblems } = await import('../src/services/chat/compaction.js')
    expect(planCompaction([100, 100], ['user', 'assistant'], 100, 10_000).cut).toBe(0)
    const turns: any[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'fetch_url', arguments: '{}' }] },
      { role: 'tool', content: 'y'.repeat(40_000), toolCallId: 'a' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'fetch_url', arguments: '{}' }] },
      { role: 'tool', content: 'z'.repeat(8000), toolCallId: 'b' },
    ]
    const shrunk = shrinkToolResults(turns, 4000, 0, 4)
    expect(shrunk).toBe(1)
    expect(turns[3].content.length).toBeLessThan(3000)
    expect(turns[5].content.length).toBe(8000) // 最近一轮完整
    expect(toolPairingProblems(turns)).toEqual([])
  })
})

describe('通用工具', () => {
  const ctx = (sessionId = 'ses_unit1') => ({ sessionId, agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })

  it('工作区：路径穿越、绝对路径、盘符、NUL、符号链接逃逸全部拒绝；正常读写列目录', async () => {
    const { findTool, runTool } = await import('../src/services/tools/registry.js')
    const { sessionWorkspace } = await import('../src/services/tools/workspace.js')
    const write = findTool('workspace_write')!
    const read = findTool('workspace_read')!
    const list = findTool('workspace_list')!
    expect(write.risk).toBe('write')
    expect(read.risk).toBe('read')

    const ok = await runTool(write, { path: 'notes/plan.md', content: '# 计划' }, ctx())
    expect(ok.ok).toBe(true)
    expect(JSON.parse(ok.text)).toMatchObject({ path: 'notes/plan.md', created: true })
    expect(JSON.parse((await runTool(read, { path: './notes/plan.md' }, ctx())).text).content).toBe('# 计划')
    expect(JSON.parse((await runTool(list, { recursive: true }, ctx())).text).entries.map((e: any) => e.path)).toEqual(['notes', 'notes/plan.md'])

    // 另一个会话看不到
    expect((await runTool(read, { path: 'notes/plan.md' }, ctx('ses_unit2'))).ok).toBe(false)

    const outside = join(server.home, 'secret.txt')
    writeFileSync(outside, 'TOP SECRET')
    for (const path of ['../secret.txt', '../../secret.txt', 'notes/../../secret.txt', '/etc/passwd', outside, 'C:\\Windows\\win.ini', '..\\secret.txt', 'a\0b', '~/x']) {
      const res = await runTool(read, { path }, ctx())
      expect(res.ok, path).toBe(false)
      expect(res.text).not.toContain('TOP SECRET')
      expect((await runTool(write, { path, content: 'pwn' }, ctx())).ok, path).toBe(false)
    }
    // 符号链接指向沙箱外
    const base = sessionWorkspace('ses_unit1')
    symlinkSync(server.home, join(base, 'escape'))
    const viaLink = await runTool(read, { path: 'escape/secret.txt' }, ctx())
    expect(viaLink.ok).toBe(false)
    expect(viaLink.text).toContain('符号链接')
    expect((await runTool(write, { path: 'escape/new.txt', content: 'x' }, ctx())).ok).toBe(false)
    // 会话 id 本身也校验
    expect((await runTool(list, {}, ctx('../../etc'))).ok).toBe(false)
    // 大小限制
    expect((await runTool(write, { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, ctx())).text).toContain('不能超过')
  })

  it('fetch_url：只允许 http/https；拒绝本机/内网/链路本地/元数据地址；可抓取并把 HTML 转文本', async () => {
    const { findTool, runTool } = await import('../src/services/tools/registry.js')
    const { isPrivateAddress } = await import('../src/services/tools/net-guard.js')
    const fetchTool = findTool('fetch_url')!
    expect(fetchTool.risk).toBe('read')
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://x']) {
      const res = await runTool(fetchTool, { url }, ctx())
      expect(res.ok, url).toBe(false)
      expect(res.text).toMatch(/只支持 http|格式不正确/)
    }
    for (const url of [`${upstreamUrl}/x`, 'http://localhost:1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:1/', 'http://10.1.2.3/', 'http://user:pw@example.com/']) {
      const res = await runTool(fetchTool, { url }, ctx())
      expect(res.ok, url).toBe(false)
    }
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false)

    // 测试环境放开内网，验证 HTML 转文本、重定向与大小限制
    process.env.LULUX_FETCH_ALLOW_PRIVATE = '1'
    try {
      handlers.push((_r, _b, res) => void res.writeHead(302, { location: '/v1/page' }).end())
      handlers.push((_r, _b, res) =>
        void res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><head><title>ACME &amp; Co</title><script>alert(1)</script><style>p{}</style></head><body><h1>Valves</h1><p>DN50 &lt;PN16&gt;</p><a href="/v1/contact">联系我们</a></body></html>'),
      )
      const res = await runTool(fetchTool, { url: `${upstreamUrl}/start` }, ctx())
      expect(res.ok).toBe(true)
      expect(res.text).toContain('标题：ACME & Co')
      expect(res.text).toContain('# Valves')
      expect(res.text).toContain('DN50 <PN16>')
      expect(res.text).toContain(`[联系我们](${upstreamUrl}/contact)`)
      expect(res.text).not.toContain('alert(1)')
      expect(res.text).toContain('不可信')
      expect(res.text).toContain('重定向')
    } finally {
      delete process.env.LULUX_FETCH_ALLOW_PRIVATE
    }
  })

  it('calculator（无 eval）与 get_time 时区换算', async () => {
    const { findTool, runTool } = await import('../src/services/tools/registry.js')
    const { evaluate, formatNumber } = await import('../src/services/tools/calculator.js')
    expect(evaluate('(12.5*1200 + 380) * 1.13')).toBeCloseTo(17379.4)
    expect(evaluate('2^3^2')).toBe(512)
    expect(evaluate('-2^2')).toBe(-4)
    expect(evaluate('round(10/3, 2) + max(1, 2, 3) + sqrt(16) + 7 % 4')).toBe(3.33 + 3 + 4 + 3)
    expect(evaluate('3 × （2 ÷ 4）')).toBe(1.5)
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    const calc = findTool('calculator')!
    for (const bad of ['process.exit()', 'constructor', '1/0', '2+', 'this', 'a=1', '[1]']) {
      expect((await runTool(calc, { expression: bad }, ctx())).ok, bad).toBe(false)
    }
    expect(JSON.parse((await runTool(calc, { expression: '1e3 * 2' }, ctx())).text).result).toBe('2000')

    const time = findTool('get_time')!
    const conv = JSON.parse((await runTool(time, { time: '2026-01-15 09:00', from: 'Asia/Shanghai', to: ['Europe/Berlin', 'America/New_York'] }, ctx())).text)
    expect(conv.converted[0]).toMatchObject({ local: '2026-01-15 02:00:00', utcOffset: 'UTC+01:00' })
    expect(conv.converted[1]).toMatchObject({ local: '2026-01-14 20:00:00', utcOffset: 'UTC-05:00' })
    const summer = JSON.parse((await runTool(time, { time: '2026-07-15 09:00', from: 'Asia/Shanghai', to: ['Europe/Berlin'] }, ctx())).text)
    expect(summer.converted[0].local).toBe('2026-07-15 03:00:00')
    expect((await runTool(time, { timezone: 'Mars/Base' }, ctx())).ok).toBe(false)
  })

  it('web_search 未配置时不出现在工具列表；配置后出现且 Key 不回传', async () => {
    const { listTools } = await import('../src/services/tools/registry.js')
    expect(listTools().map((t) => t.name)).not.toContain('web_search')
    const initial = await server.request('GET', '/api/chat/search-config')
    expect(initial.json).toMatchObject({ provider: 'none', enabled: false, hasApiKey: false })
    const saved = await server.request('PUT', '/api/chat/search-config', { body: { provider: 'tavily', apiKey: 'tvly-secret-123456' } })
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain('tvly-secret-123456')
    expect(saved.json).toMatchObject({ provider: 'tavily', enabled: true, hasApiKey: true })
    expect(listTools().map((t) => t.name)).toContain('web_search')
    const { db } = await import('../src/db.js')
    expect(JSON.stringify(db.prepare('SELECT value FROM kernel_config').all())).not.toContain('tvly-secret-123456')
    expect((await server.request('PUT', '/api/chat/search-config', { body: { provider: 'searxng' } })).status).toBe(400)
    await server.request('PUT', '/api/chat/search-config', { body: { provider: 'none', apiKey: '' } })
    expect(listTools().map((t) => t.name)).not.toContain('web_search')
    // 通用工具开关
    await server.request('PATCH', '/api/settings', { body: { kernelTools: false } })
    // kernelTools=false 只关通用工具：业务工具保留；Skill / Agent 自配置工具（skill_*、mcp_*）不受此开关影响
    const remaining = listTools()
    expect(remaining.some((t) => t.group === 'core')).toBe(false)
    // 契约 4.9 的 6 个业务工具在前，其后是 CRM 扩展工具（crm-tools.ts）
    expect(remaining.filter((t) => t.group === 'business').map((t) => t.name).slice(0, 6)).toEqual(['search_customers', 'get_customer', 'create_customer', 'create_quote_draft', 'search_emails', 'create_email_draft'])
    expect(remaining.filter((t) => t.group === 'business').map((t) => t.name)).toEqual(expect.arrayContaining(['update_customer', 'add_activity', 'update_quote', 'create_task', 'pipeline_stats']))
    expect(remaining.filter((t) => t.group !== 'business').every((t) => /^(skill_|run_skill_script$|mcp_|memory_)/.test(t.name))).toBe(true)
    expect(remaining.map((t) => t.name)).toEqual(expect.arrayContaining(['skill_list', 'skill_view', 'run_skill_script', 'mcp_add']))
    await server.request('PATCH', '/api/settings', { body: { kernelTools: true } })
  })
})

describe('费用估算、@ 解析', () => {
  it('按单价估算（缓存命中单独计价，Provider 名优先于通配）', async () => {
    const { estimateCost, priceFor, parsePricing } = await import('../src/services/llm/pricing.js')
    const pricing = JSON.stringify({ 'gpt-4o*': { input: 2.5, output: 10, cacheRead: 1.25, currency: 'USD' }, 'Mine/gpt-4o': { input: 1, output: 1, currency: 'CNY' } })
    expect(priceFor('OpenAI', 'gpt-4o-mini', pricing)).toMatchObject({ input: 2.5, currency: 'USD' })
    expect(priceFor('Mine', 'gpt-4o', pricing)).toMatchObject({ input: 1, currency: 'CNY' })
    expect(priceFor('X', 'other', pricing)).toBeNull()
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 0, reasoningTokens: 0 }, priceFor('OpenAI', 'gpt-4o', pricing))
    expect(cost).toEqual({ cost: 0.6 * 2.5 + 0.4 * 1.25 + 0.1 * 10, currency: 'USD' })
    expect(() => parsePricing('{"m":{"input":-1,"output":1}}')).toThrow()
    expect((await server.request('PATCH', '/api/settings', { body: { modelPricing: '{"m":{"input":1}}' } })).status).toBe(400)
  })

  it('@ 名字 / @id 按出现顺序；代码块里的 @ 不算', async () => {
    const { parseMentions, initialSpeakers } = await import('../src/services/chat/mentions.js')
    const members = [
      { id: 'builtin', name: 'LULUX' },
      { id: 'kernel-claude-code', name: 'Claude Code' },
      { id: 'kernel-codex', name: 'Codex' },
    ]
    expect(parseMentions('@Codex 帮我改一下，@Claude Code 也看看', members)).toEqual(['kernel-codex', 'kernel-claude-code'])
    expect(parseMentions('请 @kernel-claude-code 分析', members)).toEqual(['kernel-claude-code'])
    expect(parseMentions('```\n@LULUX\n```', members)).toEqual([])
    expect(initialSpeakers(members as any, '大家好').mode).toBe('all')
    expect(initialSpeakers(members as any, '@Claude Code 你说').order.map((m) => m.id)).toEqual(['kernel-claude-code'])
    expect(initialSpeakers(members as any, '@Claude Code 你说', ['kernel-codex']).order.map((m) => m.id)).toEqual(['kernel-codex'])
  })
})
