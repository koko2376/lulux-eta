import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 网关鉴权与转发（真实 HTTP 服务 + 进程内 mock 上游）。
 * OpenAI 兼容上游：用户说“查价格”且带工具时发起工具调用；最后一条是 tool 时回显工具结果；否则回“你好，我来自上游”。
 * Anthropic 上游：记录请求并回一个固定 message（验证同协议透传）。
 */
const REAL_KEY = 'sk-real-provider-key-0123456789'
const ANTHROPIC_KEY = 'sk-ant-real-key-abcdef'

let server: TestServer
let openaiMock: Server
let anthropicMock: Server
let openaiUrl = ''
let anthropicUrl = ''
const upstream: Array<{ path: string; auth: string; body: any }> = []

function listen(srv: Server): Promise<string> {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`)))
}

beforeAll(async () => {
  openaiMock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      upstream.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body })
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      const last = body.messages[body.messages.length - 1]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last.role === 'user' && String(last.content).includes('查价格') && body.tools?.length) {
        send({ choices: [{ delta: { content: '我来查。' } }] })
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_up_1', function: { name: body.tools[0].function.name, arguments: '{"sku":' } }] } }] })
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"BV-25"}' } }] } }] })
      } else if (last.role === 'tool') {
        send({ choices: [{ delta: { content: `结果：${last.content}` } }] })
      } else {
        send({ choices: [{ delta: { content: '你好，' } }] })
        send({ choices: [{ delta: { content: '我来自上游' } }] })
      }
      // 故意不发 finish_reason（考验透传兜底）
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  anthropicMock = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      upstream.push({ path: req.url ?? '', auth: String(req.headers['x-api-key'] ?? ''), body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_up', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'anthropic 上游' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })
  })
  openaiUrl = await listen(openaiMock)
  anthropicUrl = await listen(anthropicMock)
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
  await new Promise((resolve) => openaiMock.close(resolve))
  await new Promise((resolve) => anthropicMock.close(resolve))
})

async function provider(body: Record<string, unknown>): Promise<string> {
  const res = await server.request('POST', '/api/providers', { body })
  expect(res.status).toBe(201)
  return res.json.provider.id
}

describe('内核网关', () => {
  let openaiProviderId = ''
  let token = ''
  let revoke: () => void = () => undefined

  it('准备：OpenAI 兼容 Provider + 一次性令牌', async () => {
    openaiProviderId = await provider({ name: 'Mock Up', kind: 'openai', baseUrl: openaiUrl, apiKey: REAL_KEY, model: 'mock-1', models: ['mock-1', 'mock-2'] })
    const { gatewayTokens } = await import('../src/services/gateway/tokens.js')
    const issued = gatewayTokens.issue({ providerId: openaiProviderId, model: 'mock-1', kernelId: 'claude-code', sessionId: 's1' })
    token = issued.token
    revoke = issued.revoke
    expect(token).toMatch(/^lulux-gw-[0-9a-f]{64}$/)
  })

  const anthropicBody = { model: 'claude-lulux-mock-up-mock-1', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] }

  it('无令牌 / 错令牌 → 401（Anthropic 错误格式），不需要主 API 的 Bearer', async () => {
    const none = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token: null })
    expect(none.status).toBe(401)
    expect(none.json).toMatchObject({ type: 'error', error: { type: 'authentication_error' } })
    const wrong = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token: null, headers: { 'x-api-key': 'lulux-gw-' + '0'.repeat(64) } })
    expect(wrong.status).toBe(401)
    // 主 API 的 token 不能当网关令牌用
    const apiToken = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody })
    expect(apiToken.status).toBe(401)
    expect(upstream).toHaveLength(0)
  })

  it('带 Origin / Sec-Fetch-Site / X-Forwarded-For 的请求即使令牌正确也 403；错误 Host 403', async () => {
    for (const headers of [
      { Origin: `http://127.0.0.1:${server.port}` },
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'X-Forwarded-For': '1.2.3.4' },
    ]) {
      const res = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token, headers })
      expect(res.status).toBe(403)
    }
    const host = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token, host: 'evil.example' })
    expect(host.status).toBe(403)
    expect(upstream).toHaveLength(0)
  })

  it('非 JSON 请求体 415', async () => {
    const res = await server.request('POST', '/gateway/anthropic/v1/messages', { raw: 'x=1', token, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(res.status).toBe(415)
  })

  it('Anthropic 非流式 → OpenAI 上游：用真实 Key 与会话模型，回 Anthropic Message', async () => {
    const res = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token: null, headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-lulux-mock-up-mock-1', stop_reason: 'end_turn', content: [{ type: 'text', text: '你好，我来自上游' }] })
    const call = upstream.pop()!
    expect(call.path).toBe('/v1/chat/completions')
    expect(call.auth).toBe(`Bearer ${REAL_KEY}`)
    expect(call.body.model).toBe('mock-1')
    expect(res.text).not.toContain(REAL_KEY)
  })

  it('请求同 Provider 下另一个模型（别名）会被采用；别的模型名回落到会话模型', async () => {
    await server.request('POST', '/gateway/anthropic/v1/messages', { body: { ...anthropicBody, model: 'claude-lulux-mock-up-mock-2' }, token })
    expect(upstream.pop()!.body.model).toBe('mock-2')
    await server.request('POST', '/gateway/anthropic/v1/messages', { body: { ...anthropicBody, model: 'claude-opus-4' }, token })
    expect(upstream.pop()!.body.model).toBe('mock-1')
  })

  it('Anthropic 流式 + 工具调用：SSE 里有 tool_use 块，再把 tool_result 送回得到最终回答', async () => {
    const tools = [{ name: 'lookup', description: '查价格', input_schema: { type: 'object', properties: { sku: { type: 'string' } } } }]
    const res = await server.request('POST', '/gateway/anthropic/v1/messages', {
      token,
      body: { ...anthropicBody, stream: true, tools, messages: [{ role: 'user', content: '帮我查价格' }] },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const events = res.text.split('\n\n').filter(Boolean).map((block) => JSON.parse(/data: (.*)/.exec(block)![1]!))
    const toolStart = events.find((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use')
    expect(toolStart.content_block).toMatchObject({ id: 'call_up_1', name: 'lookup' })
    const json = events.filter((event) => event.delta?.type === 'input_json_delta').map((event) => event.delta.partial_json).join('')
    expect(JSON.parse(json)).toEqual({ sku: 'BV-25' })
    expect(events.find((event) => event.type === 'message_delta').delta.stop_reason).toBe('tool_use')
    expect(upstream.pop()!.body.tools[0].function.name).toBe('lookup')

    const second = await server.request('POST', '/gateway/anthropic/v1/messages', {
      token,
      body: {
        ...anthropicBody,
        tools,
        messages: [
          { role: 'user', content: '帮我查价格' },
          { role: 'assistant', content: [{ type: 'text', text: '我来查。' }, { type: 'tool_use', id: 'call_up_1', name: 'lookup', input: { sku: 'BV-25' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_up_1', content: 'PRICE=42' }] },
        ],
      },
    })
    expect(second.json.content[0].text).toBe('结果：PRICE=42')
    const history = upstream.pop()!.body.messages
    expect(history.slice(-2)).toEqual([
      { role: 'assistant', content: '我来查。', tool_calls: [{ id: 'call_up_1', type: 'function', function: { name: 'lookup', arguments: '{"sku":"BV-25"}' } }] },
      { role: 'tool', content: 'PRICE=42', tool_call_id: 'call_up_1' },
    ])
  })

  it('count_tokens 估算；/v1/models 列出 claude- 开头的别名', async () => {
    const count = await server.request('POST', '/gateway/anthropic/v1/messages/count_tokens', { body: anthropicBody, token })
    expect(count.json.input_tokens).toBeGreaterThan(0)
    const models = await server.request('GET', '/gateway/anthropic/v1/models', { token })
    expect(models.json.data.map((item: any) => item.id)).toEqual(['claude-lulux-mock-up-mock-1', 'claude-lulux-mock-up-mock-2'])
    const openaiModels = await server.request('GET', '/gateway/openai/v1/models', { token })
    expect(openaiModels.json.data.map((item: any) => item.id)).toContain('mock-1')
  })

  it('Responses 流式：文本与 function_call，function_call_output 往返', async () => {
    const res = await server.request('POST', '/gateway/openai/v1/responses', {
      token,
      body: {
        model: 'mock-1',
        stream: true,
        instructions: 'SYS',
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '查价格' }] }],
      },
    })
    const types = [...res.text.matchAll(/^event: (.*)$/gm)].map((match) => match[1])
    expect(types[0]).toBe('response.created')
    expect(types).toContain('response.output_text.delta')
    expect(types).toContain('response.function_call_arguments.delta')
    expect(types[types.length - 1]).toBe('response.completed')
    const sent = upstream.pop()!.body
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'SYS' })

    const second = await server.request('POST', '/gateway/openai/v1/responses', {
      token,
      body: {
        model: 'mock-1',
        input: [
          { type: 'message', role: 'user', content: '查价格' },
          { type: 'function_call', call_id: 'call_up_1', name: 'shell', arguments: '{"sku":"BV-25"}' },
          { type: 'function_call_output', call_id: 'call_up_1', output: 'PRICE=7' },
        ],
      },
    })
    expect(second.json).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '结果：PRICE=7' }] }] })
  })

  it('Chat Completions 透传：替换模型与鉴权，缺失的 finish_reason 会补上', async () => {
    const res = await server.request('POST', '/gateway/openai/v1/chat/completions', {
      token,
      body: { model: 'whatever', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.status).toBe(200)
    const call = upstream.pop()!
    expect(call.auth).toBe(`Bearer ${REAL_KEY}`)
    expect(call.body.model).toBe('mock-1')
    const datas = res.text.split('\n\n').filter(Boolean).map((block) => block.replace(/^data: /, ''))
    expect(datas[datas.length - 1]).toBe('[DONE]')
    expect(JSON.parse(datas[datas.length - 2]!).choices[0].finish_reason).toBe('stop')
    expect(res.text).toContain('我来自上游')
  })

  it('Gemini streamGenerateContent（x-goog-api-key）', async () => {
    const res = await server.request('POST', '/gateway/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {
      token: null,
      headers: { 'x-goog-api-key': token },
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    })
    expect(res.status).toBe(200)
    const datas = res.text.split(/\r\n\r\n/).filter(Boolean).map((block) => JSON.parse(block.replace(/^data: /, '')))
    expect(datas.map((data) => data.candidates[0].content.parts[0].text).join('')).toBe('你好，我来自上游')
    expect(datas[datas.length - 1].candidates[0].finishReason).toBe('STOP')
    const count = await server.request('POST', '/gateway/gemini/v1beta/models/gemini-2.5-pro:countTokens', { token, body: { contents: [{ role: 'user', parts: [{ text: 'hello world' }] }] } })
    expect(count.json.totalTokens).toBeGreaterThan(0)
  })

  it('Anthropic 上游：同协议直接透传（x-api-key 用真实 Key）', async () => {
    const anthropicId = await provider({ name: 'Ant', kind: 'anthropic', baseUrl: anthropicUrl, apiKey: ANTHROPIC_KEY, model: 'claude-x' })
    const { gatewayTokens } = await import('../src/services/gateway/tokens.js')
    const issued = gatewayTokens.issue({ providerId: anthropicId, model: 'claude-x', kernelId: 'claude-code', sessionId: 's2' })
    const res = await server.request('POST', '/gateway/anthropic/v1/messages', { token: issued.token, body: anthropicBody, headers: { 'anthropic-version': '2023-06-01' } })
    expect(res.json.content[0].text).toBe('anthropic 上游')
    const call = upstream.pop()!
    expect(call.path).toBe('/v1/messages')
    expect(call.auth).toBe(ANTHROPIC_KEY)
    expect(call.body).toMatchObject({ model: 'claude-x', messages: anthropicBody.messages })
    issued.revoke()
  })

  it('上游失败：以协议错误返回，并记到令牌目标上', async () => {
    const { gatewayTokens } = await import('../src/services/gateway/tokens.js')
    const badId = await provider({ name: 'Down', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' })
    const issued = gatewayTokens.issue({ providerId: badId, model: 'm', kernelId: 'codex', sessionId: 's3' })
    const res = await server.request('POST', '/gateway/openai/v1/responses', { token: issued.token, body: { model: 'm', input: 'hi', stream: true } })
    expect(res.status).toBe(502)
    expect(res.json.error.message).toContain('Down')
    expect(issued.target.lastError).toContain('Down')
    issued.revoke()
  })

  it('吊销后令牌立即失效；未知路径先鉴权再 404', async () => {
    const unknownUnauth = await server.request('GET', '/gateway/nope', { token: null })
    expect(unknownUnauth.status).toBe(401)
    const unknown = await server.request('GET', '/gateway/nope', { token })
    expect(unknown.status).toBe(404)
    revoke()
    const res = await server.request('POST', '/gateway/anthropic/v1/messages', { body: anthropicBody, token })
    expect(res.status).toBe(401)
  })
})
