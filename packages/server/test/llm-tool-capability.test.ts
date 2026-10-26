import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 模型适配回归（审计 2026-10-24 #6 #7）：
 * “不支持工具”只认明确的能力错误、按 Provider + 模型记、有时效；
 * 不带 index 的并行工具调用按 id 区分。
 */
let server: TestServer
let upstream: Server
let url = ''
const handlers: Array<(res: ServerResponse, body: any) => void> = []
const bodies: any[] = []
beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'))
      const handler = handlers.shift()
      if (!handler) return void res.writeHead(500).end('none')
      handler(res, bodies.at(-1))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(upstream.address() as any).port}/v1`
  server = await startTestServer()
})
afterAll(async () => {
  upstream.close()
  await server.close()
})
afterEach(async () => {
  handlers.length = 0
  vi.useRealTimers()
  const { resetLearnedCapabilitiesForTests } = await import('../src/services/llm/capabilities.js')
  resetLearnedCapabilitiesForTests()
})

const sse = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}
const okReply = (res: ServerResponse) => sse(res, [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
const reject400 = (message: string) => (res: ServerResponse) =>
  void res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { type: 'invalid_request_error', message } }))
const tool = (name: string) => ({ name, description: 'x', inputSchema: { type: 'object' }, serverId: 's', serverName: 's', originalName: name })

async function stream(request: Record<string, unknown>, downgrades: string[] = []) {
  const { streamResilient } = await import('../src/services/llm/resilient.js')
  for await (const _ of streamResilient(
    'openai',
    { baseUrl: url, apiKey: 'k', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...request } as any,
    { maxRetries: 0, timeoutMs: 5000, onDowngrade: (what) => void downgrades.push(what) },
  ))
    void _
}

describe('“不支持工具”降级', () => {
  it('某个工具 schema 不合法：只去掉被点名的工具重发，不学习降级', async () => {
    const { capabilitiesFor } = await import('../src/services/llm/capabilities.js')
    handlers.push(reject400('tools.1.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12'), okReply)
    const downgrades: string[] = []
    await stream({ tools: [tool('get_time'), tool('mcp_crm_search'), tool('calculator')] }, downgrades)
    expect(bodies.at(-1).tools.map((t: any) => t.function.name)).toEqual(['get_time', 'calculator'])
    expect(downgrades).toEqual([])
    expect(capabilitiesFor('gpt-4o', { kind: 'openai', baseUrl: url }).tools).toBe(true)
    expect(capabilitiesFor('gpt-4o', 'openai').tools).toBe(true)
  })

  it('按名字点名的参数错误（function \'x\' has invalid parameters）：同样只去掉那个工具', async () => {
    handlers.push(reject400("function 'calculator' has invalid parameters"), okReply)
    await stream({ tools: [tool('calculator'), tool('calculator_pro')] })
    expect(bodies.at(-1).tools.map((t: any) => t.function.name)).toEqual(['calculator_pro'])
  })

  it('明确不支持工具：降级只作用于这个 Provider + 模型', async () => {
    const { capabilitiesFor } = await import('../src/services/llm/capabilities.js')
    handlers.push(reject400('this model does not support tools'), okReply)
    const downgrades: string[] = []
    await stream({ tools: [tool('get_time')] }, downgrades)
    expect(downgrades).toEqual(['tools'])
    expect(bodies.at(-1).tools).toBeUndefined()
    expect(capabilitiesFor('gpt-4o', { kind: 'openai', baseUrl: url }).tools).toBe(false)
    // 另一个 Provider 的同名模型、不带 Provider 的查询都不受影响
    expect(capabilitiesFor('gpt-4o', { kind: 'openai', baseUrl: 'https://api.other.example/v1' }).tools).toBe(true)
    expect(capabilitiesFor('gpt-4o', 'openai').tools).toBe(true)
  })

  it('“不支持工具”的降级有时效，过期后自动恢复', async () => {
    const { capabilitiesFor, learnCapability, TOOLS_LEARN_TTL_MS } = await import('../src/services/llm/capabilities.js')
    vi.useFakeTimers({ toFake: ['Date'] })
    learnCapability('gpt-4o', { tools: false }, url)
    expect(capabilitiesFor('gpt-4o', { kind: 'openai', baseUrl: url }).tools).toBe(false)
    vi.setSystemTime(Date.now() + TOOLS_LEARN_TTL_MS + 1000)
    expect(capabilitiesFor('gpt-4o', { kind: 'openai', baseUrl: url }).tools).toBe(true)
  })

  it('能力错误文案识别：明确的“不支持”才算', async () => {
    const yes = [
      'this model does not support tools',
      'tools are not supported',
      'Unrecognized request argument supplied: tools',
      "Unknown parameter: 'tools'",
      'function calling is not supported for this model',
      'tool_choice is not supported',
    ]
    const no = [
      'tools.3.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12',
      "function 'x' has invalid parameters",
      'Invalid parameter: tools[0].function.parameters',
    ]
    for (const message of [...yes, ...no]) {
      handlers.push(reject400(message), okReply, okReply)
      const downgrades: string[] = []
      await stream({ tools: [tool('x')] }, downgrades).catch(() => undefined)
      expect(downgrades.includes('tools'), message).toBe(yes.includes(message))
      handlers.length = 0
      const { resetLearnedCapabilitiesForTests } = await import('../src/services/llm/capabilities.js')
      resetLearnedCapabilitiesForTests()
    }
  })
})

describe('流式工具调用分片', () => {
  async function callsOf(chunks: unknown[]) {
    const { streamOpenAIExtended } = await import('../src/services/llm/openai.js')
    handlers.push((res) => sse(res, chunks))
    const events: any[] = []
    for await (const event of streamOpenAIExtended({ baseUrl: url, apiKey: 'k', model: 'some-model', messages: [{ role: 'user', content: 'x' }] } as any)) events.push(event)
    return events.find((event) => event.type === 'tool_calls')?.calls
  }

  it('不带 index 的并行工具调用按 id 区分，不拼接', async () => {
    const calls = await callsOf([
      { choices: [{ delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    expect(calls).toEqual([
      { id: 'call_a', name: 'get_time', arguments: '{}' },
      { id: 'call_b', name: 'calculator', arguments: '{"expression":"1+1"}' },
    ])
  })

  it('不带 index、也不带 id 的续传分片接在上一项后面', async () => {
    const calls = await callsOf([
      { choices: [{ delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'calculator', arguments: '{"expr' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: 'ession":"2*3"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    expect(calls).toEqual([{ id: 'call_a', name: 'calculator', arguments: '{"expression":"2*3"}' }])
  })

  it('带 index 的标准分片照旧按 index 归并', async () => {
    const calls = await callsOf([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'get_time', arguments: '' } }, { index: 1, id: 'c1', function: { name: 'calculator', arguments: '{"e' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'xpression":"1"}' } }, { index: 0, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    expect(calls).toEqual([
      { id: 'c0', name: 'get_time', arguments: '{}' },
      { id: 'c1', name: 'calculator', arguments: '{"expression":"1"}' },
    ])
  })
})
