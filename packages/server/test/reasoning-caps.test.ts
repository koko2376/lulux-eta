import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 思考强度支持识别：
 * - 规则表覆盖当前常见推理模型家族（含厂商前缀 / 中转别名）；
 * - 优先级：手动设置 > 设置 modelCapabilities > 上游元数据 > 规则；运行时降级最后叠加；
 * - 各推理风格怎么发参数（OpenAI 兼容对话 / 网关透传 / Anthropic 协议）；
 * - Provider 按模型手动设置思考强度（任意模型名）：持久化、立即反映到 GET /api/models、真的发给上游；
 * - 发现模型时识别上游元数据；
 * - 上游 400 拒绝推理参数：去掉参数重发、记住降级并发 downgrade 事件，运行不失败。
 */
let server: TestServer
let upstream: Server
let upstreamBase = ''
type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void
const handlers: Handler[] = []
const received: any[] = []
let modelsPayload: unknown = { data: [] }

function okStream(res: ServerResponse, text = 'ok'): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.end('data: [DONE]\n\n')
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(modelsPayload))
        return
      }
      const body = raw ? JSON.parse(raw) : {}
      const system = body.messages?.[0]?.role === 'system' ? JSON.stringify(body.messages[0].content) : ''
      // 后台旁路请求（标题 / 记忆提取）不记录
      if (system.includes('【LULUX 记忆提取】')) return okStream(res, '{"operations":[]}')
      received.push(body)
      const handler = handlers.shift()
      if (handler) handler(req, body, res)
      else okStream(res)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
  server = await startTestServer()
  await server.request('PATCH', '/api/settings', {
    body: { autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false, toolLoading: 'all', builtinTools: false },
  })
}, 60_000)

afterAll(async () => {
  await server?.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

beforeEach(() => {
  handlers.length = 0
  received.length = 0
})

async function createProvider(models: string[], kind = 'openai'): Promise<any> {
  const res = await server.request('POST', '/api/providers', {
    body: { name: `Relay ${Math.random().toString(36).slice(2, 7)}`, kind, baseUrl: upstreamBase, apiKey: 'sk-test-123456', model: models[0], models },
  })
  expect(res.status, res.text).toBe(201)
  return res.json.provider
}

function catalogOption(catalog: any, providerId: string, model: string): any {
  return catalog.groups.find((g: any) => g.id === providerId)?.options.find((o: any) => o.model === model)
}

describe('规则表：常见推理模型家族', () => {
  it('识别各家族的推理风格（含厂商前缀与中转别名）', async () => {
    const { capabilitiesFor, choiceOf } = await import('../src/services/llm/capabilities.js')
    const choice = (model: string, kind = 'openai') => choiceOf(capabilitiesFor(model, kind))
    const table: Array<[string, string]> = [
      ['gpt-5', 'openai'],
      ['gpt-5.2-codex', 'openai'],
      ['openai/gpt-5-mini', 'openai'],
      ['azure-gpt-5', 'openai'],
      ['my-gpt5', 'openai'],
      ['gpt-6.1-sol', 'openai'],
      ['gpt-5-chat-latest', 'none'],
      ['o3', 'openai'],
      ['o4-mini', 'openai'],
      ['openai/o1-pro', 'openai'],
      ['gpt-oss-120b', 'openai'],
      ['openai/gpt-oss-20b', 'openai'],
      ['claude-sonnet-4-5', 'anthropic'],
      ['claude-opus-4-1', 'anthropic'],
      ['claude-haiku-4-5-20251001', 'anthropic'],
      ['anthropic/claude-3.7-sonnet', 'anthropic'],
      ['claude-4.5-sonnet', 'anthropic'],
      ['claude-3-5-haiku', 'none'],
      ['deepseek-reasoner', 'fixed'],
      ['deepseek-r1-distill-qwen-32b', 'fixed'],
      ['deepseek-chat', 'toggle'],
      ['deepseek-v3.1', 'toggle'],
      ['deepseek-ai/DeepSeek-V3.2', 'toggle'],
      ['deepseek-v4-pro', 'toggle'],
      ['qwen3-max', 'qwen'],
      ['qwen3-235b-a22b', 'qwen'],
      ['Qwen/Qwen3-32B', 'qwen'],
      ['qwen-plus', 'qwen'],
      ['qwen-flash', 'qwen'],
      ['qwen3-235b-a22b-thinking-2507', 'fixed'],
      ['qwen3-235b-a22b-instruct-2507', 'none'],
      ['qwen3-coder-plus', 'none'],
      ['qwq-32b', 'fixed'],
      ['kimi-k2-thinking', 'fixed'],
      ['moonshotai/kimi-k2-thinking-turbo', 'fixed'],
      ['kimi-k2-0905-preview', 'none'],
      ['grok-3-mini', 'openai'],
      ['grok-4', 'fixed'],
      ['grok-4-fast-reasoning', 'fixed'],
      ['grok-4-fast-non-reasoning', 'none'],
      ['grok-4.6', 'openai'],
      ['gemini-2.5-pro', 'openai'],
      ['gemini-2.5-flash', 'openai'],
      ['google/gemini-3-pro-preview', 'openai'],
      ['gemini-2.0-flash', 'none'],
      ['MiniMax-M2', 'fixed'],
      ['minimax-m1', 'fixed'],
      ['glm-4.5', 'toggle'],
      ['glm-4.6', 'toggle'],
      ['zai-org/GLM-4.5-Air', 'toggle'],
      ['glm-4-plus', 'none'],
      ['doubao-seed-1-6-250615', 'toggle'],
      ['doubao-seed-1.6-thinking', 'fixed'],
      ['doubao-1.5-pro-32k', 'none'],
      ['totally-unknown', 'none'],
    ]
    const wrong = table.filter(([model, expected]) => choice(model) !== expected).map(([model, expected]) => `${model}: 期望 ${expected}，实际 ${choice(model)}`)
    expect(wrong).toEqual([])
  })
})

describe('优先级：手动 > 设置覆盖 > 上游元数据 > 规则', () => {
  it('按 Provider 的模型能力叠加', async () => {
    const { capabilitiesFor, choiceOf, autoReasoningChoice, learnCapability, resetLearnedCapabilitiesForTests } = await import(
      '../src/services/llm/capabilities.js'
    )
    const choice = (model: string, ctx: any) => choiceOf(capabilitiesFor(model, ctx))
    // 规则不认识 → none；上游元数据说支持 → openai
    expect(choice('acme-brain', { kind: 'openai', modelCaps: {} })).toBe('none')
    expect(choice('acme-brain', { kind: 'openai', modelCaps: { 'acme-brain': { detected: 'openai' } } })).toBe('openai')
    // 规则已识别具体风格时，元数据“支持”不改风格；元数据“不支持”生效
    expect(choice('glm-4.6', { kind: 'openai', modelCaps: { 'glm-4.6': { detected: 'openai' } } })).toBe('toggle')
    expect(choice('gpt-5', { kind: 'openai', modelCaps: { 'gpt-5': { detected: 'none' } } })).toBe('none')
    // 设置 modelCapabilities 覆盖元数据
    await server.request('PATCH', '/api/settings', { body: { modelCapabilities: '{"acme-*":{"reasoning":"qwen"}}' } })
    expect(choice('acme-brain', { kind: 'openai', modelCaps: { 'acme-brain': { detected: 'openai' } } })).toBe('qwen')
    // 手动设置覆盖一切（模型名不区分大小写）
    const ctx = { kind: 'openai', modelCaps: { 'ACME-Brain': { reasoning: 'anthropic' as const, detected: 'openai' as const } } }
    expect(choice('acme-brain', ctx)).toBe('anthropic')
    // “自动检测”结果不含手动设置
    expect(autoReasoningChoice('acme-brain', ctx)).toBe('qwen')
    // 运行时学到的降级最后叠加
    learnCapability('acme-brain', { reasoning: 'none', thinkingToggle: false })
    expect(choice('acme-brain', ctx)).toBe('none')
    resetLearnedCapabilitiesForTests()
    await server.request('PATCH', '/api/settings', { body: { modelCapabilities: '' } })
    // 字符串 kind 的旧调用方式仍然可用
    expect(capabilitiesFor('claude-sonnet-4-5', 'anthropic')).toMatchObject({ reasoning: 'anthropic', streamUsage: false })
  })
})

describe('参数映射', () => {
  it('OpenAI 兼容对话体：各风格的推理参数', async () => {
    const { applyChatReasoningParams } = await import('../src/services/llm/reasoning-params.js')
    const build = (caps: any, effort: any, extra: Record<string, unknown> = {}) => {
      const body: Record<string, unknown> = { ...extra }
      applyChatReasoningParams(body, caps, effort)
      return body
    }
    expect(build({ reasoning: 'openai', thinkingToggle: false }, 'high')).toEqual({ reasoning_effort: 'high' })
    expect(build({ reasoning: 'openai', thinkingToggle: false }, 'off')).toEqual({})
    expect(build({ reasoning: 'qwen', thinkingToggle: false }, 'medium')).toEqual({ enable_thinking: true, thinking_budget: 8192 })
    expect(build({ reasoning: 'qwen', thinkingToggle: false }, 'off')).toEqual({ enable_thinking: false })
    expect(build({ reasoning: 'deepseek', thinkingToggle: true }, 'high')).toEqual({ thinking: { type: 'enabled' } })
    expect(build({ reasoning: 'deepseek', thinkingToggle: true }, 'off')).toEqual({ thinking: { type: 'disabled' } })
    expect(build({ reasoning: 'deepseek', thinkingToggle: false }, 'high')).toEqual({})
    expect(build({ reasoning: 'anthropic', thinkingToggle: false }, 'low', { max_tokens: 1000 })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2048 },
      max_tokens: 2048 + 4096,
    })
    expect(build({ reasoning: 'none', thinkingToggle: false }, 'high')).toEqual({})
    // 没指定强度：什么都不加；调用方已有的字段不覆盖
    expect(build({ reasoning: 'qwen', thinkingToggle: false }, undefined)).toEqual({})
    expect(build({ reasoning: 'openai', thinkingToggle: false }, 'high', { reasoning_effort: 'low' })).toEqual({ reasoning_effort: 'low' })
  })

  it('网关：手动设置的风格也会补参数；Anthropic 风格不在网关里开', async () => {
    const { passthroughBody, gatewayEffort } = await import('../src/services/gateway/upstream.js')
    const provider = (reasoning: string) => ({ id: 'p', name: 'P', kind: 'openai', modelCaps: { 'odd-model': { reasoning } } }) as any
    const route = (reasoning: string, effort: any) => ({ provider: provider(reasoning), model: 'odd-model', alias: 'x', reasoningEffort: effort })
    expect(passthroughBody(route('openai', 'medium'), '/chat/completions', {})).toMatchObject({ model: 'odd-model', reasoning_effort: 'medium' })
    expect(passthroughBody(route('qwen', 'high'), '/chat/completions', {})).toMatchObject({ enable_thinking: true, thinking_budget: 24_576 })
    expect(passthroughBody(route('qwen', 'off'), '/chat/completions', {})).toMatchObject({ enable_thinking: false })
    expect(passthroughBody(route('toggle', 'high'), '/chat/completions', {})).toMatchObject({ thinking: { type: 'enabled' } })
    expect(gatewayEffort(route('anthropic', 'high'))).toBeNull()
    expect(gatewayEffort(route('openai', 'off'))).toBeNull()
    expect(passthroughBody(route('none', 'high'), '/chat/completions', {})).toEqual({ model: 'odd-model' })
  })

  it('档位与滑块形态', async () => {
    const { builtinEfforts, gatewayEfforts, effortModeFor, effectiveBuiltinEffort, effectiveGatewayEffort } = await import(
      '../src/services/models/catalog.js'
    )
    const ctx = (reasoning?: string, kind = 'openai') => ({ kind, modelCaps: reasoning ? { 'odd-model': { reasoning } } : {} }) as any
    expect(builtinEfforts('odd-model', ctx())).toEqual(['off'])
    expect(effortModeFor('odd-model', ctx(), ['off'])).toBe('none')
    expect(builtinEfforts('odd-model', ctx('openai'))).toEqual(['off', 'low', 'medium', 'high'])
    expect(builtinEfforts('odd-model', ctx('qwen'))).toEqual(['off', 'low', 'medium', 'high'])
    expect(builtinEfforts('odd-model', ctx('anthropic'))).toEqual(['off', 'low', 'medium', 'high'])
    expect(builtinEfforts('odd-model', ctx('toggle'))).toEqual(['off', 'high'])
    expect(effortModeFor('odd-model', ctx('toggle'), ['off', 'high'])).toBe('toggle')
    expect(effortModeFor('kimi-k2-thinking', 'openai', ['off'])).toBe('fixed')
    // Anthropic 协议 Provider：任何可调节风格都按思考预算分档
    expect(builtinEfforts('odd-model', ctx('qwen', 'anthropic'))).toEqual(['off', 'low', 'medium', 'high'])
    expect(gatewayEfforts('odd-model', ctx('anthropic'))).toEqual(['off'])
    expect(gatewayEfforts('odd-model', ctx('toggle'))).toEqual(['off', 'high'])
    // 开关风格：要求了任意思考档 → 开
    expect(effectiveBuiltinEffort('medium', 'odd-model', ctx('toggle'))).toBe('high')
    expect(effectiveBuiltinEffort('off', 'odd-model', ctx('toggle'))).toBe('off')
    expect(effectiveGatewayEffort('off', 'odd-model', ctx('toggle'))).toBe('off')
    expect(effectiveGatewayEffort('off', 'o3-mini', 'openai')).toBeNull()
  })
})

describe('Provider 按模型手动设置思考强度', () => {
  it('任意模型名：持久化、立即反映到模型列表、真的发给上游；恢复自动检测', async () => {
    const provider = await createProvider(['zz-house-model-v7', 'other'])
    expect(provider.modelReasoning['zz-house-model-v7']).toEqual({ manual: null, detected: null, auto: 'none', effective: 'none' })
    let catalog = (await server.request('GET', '/api/models?kernel=builtin')).json
    expect(catalogOption(catalog, provider.id, 'zz-house-model-v7')).toMatchObject({ efforts: ['off'], effortMode: 'none' })

    const put = (model: string, reasoning: string) =>
      server.request('PUT', `/api/providers/${provider.id}/model-caps`, { body: { model, reasoning } })
    let res = await put('zz-house-model-v7', 'openai')
    expect(res.status, res.text).toBe(200)
    expect(res.json.provider.modelReasoning['zz-house-model-v7']).toMatchObject({ manual: 'openai', auto: 'none', effective: 'openai' })
    // 持久化：重新列出仍在
    const listed = (await server.request('GET', '/api/providers')).json.providers.find((p: any) => p.id === provider.id)
    expect(listed.modelReasoning['zz-house-model-v7'].manual).toBe('openai')
    catalog = (await server.request('GET', '/api/models?kernel=builtin')).json
    expect(catalogOption(catalog, provider.id, 'zz-house-model-v7')).toMatchObject({ efforts: ['off', 'low', 'medium', 'high'], effortMode: 'graded' })

    // 会话选这个模型 + 高 → 上游收到 reasoning_effort
    const session = (await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })).json.session
    res = await server.request('PATCH', `/api/sessions/${session.id}`, { body: { providerId: provider.id, model: 'zz-house-model-v7', reasoningEffort: 'high' } })
    expect(res.status, res.text).toBe(200)
    const chat = async () => {
      received.length = 0
      const r = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '你好' } })
      expect(r.status, r.text).toBe(200)
      return { events: parseSse(r.text), body: received.find((b) => b.model === 'zz-house-model-v7') }
    }
    let sent = await chat()
    expect(sent.body.reasoning_effort).toBe('high')

    // Qwen 风格
    await put('zz-house-model-v7', 'qwen')
    sent = await chat()
    expect(sent.body).toMatchObject({ enable_thinking: true, thinking_budget: 24_576 })
    expect(sent.body.reasoning_effort).toBeUndefined()

    // 开关风格：界面是开关，上游收到 thinking.type
    await put('zz-house-model-v7', 'toggle')
    catalog = (await server.request('GET', '/api/models?kernel=builtin')).json
    expect(catalogOption(catalog, provider.id, 'zz-house-model-v7')).toMatchObject({ efforts: ['off', 'high'], effortMode: 'toggle' })
    sent = await chat()
    expect(sent.body.thinking).toEqual({ type: 'enabled' })

    // Anthropic 思考预算（经 OpenAI 兼容中转）
    await put('zz-house-model-v7', 'anthropic')
    sent = await chat()
    expect(sent.body.thinking).toEqual({ type: 'enabled', budget_tokens: 24_576 })

    // 恢复自动检测 → 不支持，不带参数
    res = await put('zz-house-model-v7', 'auto')
    expect(res.json.provider.modelReasoning['zz-house-model-v7']).toMatchObject({ manual: null, effective: 'none' })
    sent = await chat()
    expect(sent.body.reasoning_effort).toBeUndefined()
    expect(sent.body.thinking).toBeUndefined()
    expect(sent.body.enable_thinking).toBeUndefined()

    // 不在模型列表里的模型 / 非法值 → 400
    expect((await put('not-in-list', 'openai')).status).toBe(400)
    expect((await put('other', 'maybe')).status).toBe(400)
    // 从模型列表删掉后，设置跟着清理
    await put('other', 'openai')
    res = await server.request('PATCH', `/api/providers/${provider.id}`, { body: { models: ['zz-house-model-v7'] } })
    expect(res.status, res.text).toBe(200)
    const { db } = await import('../src/db.js')
    const row = db.prepare('SELECT model_caps FROM providers WHERE id = ?').get(provider.id) as { model_caps: string }
    expect(JSON.parse(row.model_caps)).toEqual({})
  })

  it('发现模型：记录上游元数据（OpenRouter supported_parameters / capabilities）；手动设置优先', async () => {
    const provider = await createProvider(['seed'])
    modelsPayload = {
      data: [
        { id: 'vendor/odd-thinker', supported_parameters: ['tools', 'reasoning', 'include_reasoning'] },
        { id: 'vendor/plain', supported_parameters: ['tools', 'temperature'] },
        { id: 'relay-brain', capabilities: { reasoning: true } },
        { id: 'no-meta' },
      ],
    }
    const res = await server.request('POST', `/api/providers/${provider.id}/discover-models`)
    expect(res.status, res.text).toBe(200)
    const reasoning = res.json.provider.modelReasoning
    expect(reasoning['vendor/odd-thinker']).toMatchObject({ detected: 'openai', auto: 'openai', effective: 'openai' })
    expect(reasoning['vendor/plain']).toMatchObject({ detected: 'none', effective: 'none' })
    expect(reasoning['relay-brain']).toMatchObject({ detected: 'openai', effective: 'openai' })
    expect(reasoning['no-meta']).toMatchObject({ detected: null, effective: 'none' })
    const put = await server.request('PUT', `/api/providers/${provider.id}/model-caps`, { body: { model: 'vendor/odd-thinker', reasoning: 'none' } })
    expect(put.json.provider.modelReasoning['vendor/odd-thinker']).toMatchObject({ manual: 'none', detected: 'openai', effective: 'none' })
    modelsPayload = { data: [] }
  })

  it('上游 400 拒绝推理参数：去掉参数重发，运行成功并提示降级', async () => {
    const provider = await createProvider(['strict-relay-model'])
    await server.request('PUT', `/api/providers/${provider.id}/model-caps`, { body: { model: 'strict-relay-model', reasoning: 'openai' } })
    const session = (await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })).json.session
    await server.request('PATCH', `/api/sessions/${session.id}`, { body: { providerId: provider.id, model: 'strict-relay-model', reasoningEffort: 'medium' } })
    handlers.push((_req, _body, res) =>
      void res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}'),
    )
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '试试' } })
    expect(res.status, res.text).toBe(200)
    const events = parseSse(res.text)
    expect(events.find((e) => e.event === 'downgrade')?.data).toMatchObject({ what: 'reasoning', model: 'strict-relay-model' })
    expect(events.some((e) => e.event === 'done')).toBe(true)
    expect(events.some((e) => e.event === 'error')).toBe(false)
    const mine = received.filter((b) => b.model === 'strict-relay-model')
    expect(mine[0].reasoning_effort).toBe('medium')
    expect(mine[1].reasoning_effort).toBeUndefined()
    // 改设置会清掉学到的降级
    const { capabilitiesFor } = await import('../src/services/llm/capabilities.js')
    expect(capabilitiesFor('strict-relay-model').reasoning).toBe('none')
    await server.request('PUT', `/api/providers/${provider.id}/model-caps`, { body: { model: 'strict-relay-model', reasoning: 'qwen' } })
    const fresh = (await server.request('GET', '/api/providers')).json.providers.find((p: any) => p.id === provider.id)
    expect(fresh.modelReasoning['strict-relay-model'].effective).toBe('qwen')
  })
})

describe('迁移 26', () => {
  it('providers 有 model_caps 列', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const migrations = await import('../src/db/migrations.js')
    const db = new DatabaseSync(':memory:')
    migrations.runMigrations(db)
    const columns = (db.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toContain('model_caps')
    expect(migrations.MIGRATIONS.some((m) => m.version === 26 && m.name === 'provider_model_caps')).toBe(true)
    db.close()
  })
})
