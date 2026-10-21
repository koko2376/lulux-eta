import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 会话模型与推理强度（契约 §6.13）：
 * - 纯函数：每个模型的档位、档位收紧、各 CLI 内核的参数映射、网关透传补 reasoning_effort；
 * - 迁移 22：sessions.model / sessions.reasoning_effort；
 * - 接口：GET /api/models（builtin / scoped / global）、PATCH / POST 会话 model + reasoningEffort；
 * - 内置内核：上游收到会话选的模型与 reasoning_effort，不支持的档位按模型收紧。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
let providerId = ''

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
  const res = await fetch(`${mockBase}${path}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: get ? undefined : JSON.stringify(body ?? {}),
  })
  return res.json()
}
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')

async function newSession(body: Record<string, unknown> = { agentIds: ['builtin'] }): Promise<any> {
  const res = await server.request('POST', '/api/sessions', { body })
  expect(res.status, res.text).toBe(201)
  return res.json.session
}
async function patch(id: string, body: Record<string, unknown>) {
  return server.request('PATCH', `/api/sessions/${id}`, { body })
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], {
    stdio: 'pipe',
  })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  const res = await server.request('POST', '/api/providers', {
    body: {
      name: 'Mock',
      kind: 'openai',
      baseUrl: `${mockBase}/v1`,
      apiKey: 'sk-mock-key-123456',
      model: 'mock-model',
      models: ['mock-model', 'gpt-5.2', 'o3-mini'],
    },
  })
  expect(res.status, res.text).toBe(201)
  providerId = res.json.provider.id
  await server.request('PATCH', '/api/settings', {
    body: { autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false, toolLoading: 'all', builtinTools: false },
  })
})

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('纯函数', () => {
  it('每个模型的档位：OpenAI 推理模型 / gpt-5.2+ 极高 / Anthropic / 普通模型只有关闭', async () => {
    const { builtinEfforts, gatewayEfforts } = await import('../src/services/models/catalog.js')
    expect(builtinEfforts('o3-mini', 'openai')).toEqual(['off', 'low', 'medium', 'high'])
    expect(builtinEfforts('gpt-5.2', 'openai')).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(builtinEfforts('gpt-6.1-sol', 'openai')).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(builtinEfforts('claude-sonnet-4-5', 'anthropic')).toEqual(['off', 'low', 'medium', 'high'])
    // DeepSeek V3.1+ 混合思考：只有开 / 关
    expect(builtinEfforts('deepseek-chat', 'openai')).toEqual(['off', 'high'])
    expect(builtinEfforts('mock-model', 'openai')).toEqual(['off'])
    // 网关不开 Anthropic 思考（签名回传不了）
    expect(gatewayEfforts('claude-sonnet-4-5', 'anthropic')).toEqual(['off'])
    expect(gatewayEfforts('o3-mini', 'openai')).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('clampEffort：取不超过请求的最高可用档', async () => {
    const { clampEffort, effectiveBuiltinEffort, effectiveGatewayEffort } = await import('../src/services/models/catalog.js')
    expect(clampEffort('xhigh', ['off', 'low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('medium', ['off'])).toBe('off')
    expect(clampEffort('off', ['low', 'medium'])).toBe('low')
    expect(effectiveBuiltinEffort('xhigh', 'claude-opus-4-1', 'anthropic')).toBe('high')
    expect(effectiveBuiltinEffort('high', 'mock-model', 'openai')).toBe('off')
    expect(effectiveGatewayEffort(null, 'o3-mini', 'openai')).toBeNull()
    expect(effectiveGatewayEffort('xhigh', 'o3-mini', 'openai')).toBe('high')
    expect(effectiveGatewayEffort('high', 'mock-model', 'openai')).toBeNull()
  })

  it('applyCliModel：各 CLI 的模型 / 推理强度参数', async () => {
    const { applyCliModel } = await import('../src/services/models/catalog.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const base = (id: string) => findKernel(id)!.args
    // Claude Code：--model / --effort；“关闭”不受支持 → 最低档
    expect(applyCliModel('claude-code', base('claude-code'), 'opus', 'xhigh').args.slice(-4)).toEqual([
      '--model',
      'opus',
      '--effort',
      'xhigh',
    ])
    expect(applyCliModel('claude-code', base('claude-code'), null, 'off').args.slice(-2)).toEqual(['--effort', 'low'])
    // Codex：exec 之后插入 -m 与 -c model_reasoning_effort，末尾仍是 stdin 的 -
    const codex = applyCliModel('codex', base('codex'), 'gpt-6.1-sol', 'high').args
    expect(codex.slice(0, 5)).toEqual(['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"'])
    expect(codex.at(-1)).toBe('-')
    // Gemini / Qwen / Grok：只有 -m；推理强度忽略
    expect(applyCliModel('gemini-cli', base('gemini-cli'), 'gemini-2.5-pro', 'high').args.slice(-2)).toEqual([
      '-m',
      'gemini-2.5-pro',
    ])
    expect(applyCliModel('qwen-code', base('qwen-code'), null, 'high').args).toEqual(base('qwen-code'))
    expect(applyCliModel('grok', base('grok'), 'grok-4.7', null).args.slice(-2)).toEqual(['-m', 'grok-4.7'])
    // Pi：--model / --thinking（支持 off）
    expect(applyCliModel('pi', base('pi'), 'sonnet', 'off').args.slice(-4)).toEqual(['--model', 'sonnet', '--thinking', 'off'])
    // Hermes：不改
    expect(applyCliModel('hermes', base('hermes'), null, 'high').args).toEqual(base('hermes'))
    // 以 - 开头的模型名拒绝（不会被 CLI 当成参数）
    expect(() => applyCliModel('codex', base('codex'), '--dangerously-bypass', null)).toThrow(/不合法/)
  })

  it('网关透传：Chat Completions 补 reasoning_effort（CLI 自带的不改；非推理模型不加）', async () => {
    const { passthroughBody } = await import('../src/services/gateway/upstream.js')
    const provider = { id: 'p', name: 'P', kind: 'openai' } as any
    const route = { provider, model: 'o3-mini', alias: 'x', reasoningEffort: 'medium' as const }
    expect(passthroughBody(route, '/chat/completions', { model: 'x', messages: [] })).toMatchObject({
      model: 'o3-mini',
      reasoning_effort: 'medium',
    })
    expect(passthroughBody(route, '/chat/completions', { reasoning_effort: 'low' }).reasoning_effort).toBe('low')
    expect(passthroughBody({ ...route, model: 'deepseek-chat' }, '/chat/completions', {}).reasoning_effort).toBeUndefined()
    expect(passthroughBody(route, '/messages', {}).reasoning_effort).toBeUndefined()
  })
})

describe('迁移 22', () => {
  it('sessions 有 model / reasoning_effort 列', () => {
    const db = new DatabaseSync(':memory:')
    return import('../src/db/migrations.js').then((migrations) => {
      migrations.runMigrations(db)
      const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).toContain('model')
      expect(columns).toContain('reasoning_effort')
      expect(migrations.MIGRATIONS.some((m) => m.version === 22 && m.name === 'session_model_effort')).toBe(true)
      db.close()
    })
  })
})

describe('GET /api/models', () => {
  it('builtin：按 Provider 分组列出模型与档位，默认模型与全局推理强度', async () => {
    await server.request('PATCH', '/api/settings', { body: { reasoningEffort: 'medium' } })
    const res = await server.request('GET', '/api/models?kernel=builtin')
    expect(res.status, res.text).toBe(200)
    expect(res.json.mode).toBe('builtin')
    expect(res.json.effort).toBe(true)
    expect(res.json.defaultEffort).toBe('medium')
    expect(res.json.default).toMatchObject({ providerId, model: null, label: 'mock-model' })
    const group = res.json.groups.find((g: any) => g.id === providerId)
    expect(group.label).toBe('Mock')
    expect(group.options.map((o: any) => o.model)).toEqual(['mock-model', 'gpt-5.2', 'o3-mini'])
    expect(group.options.find((o: any) => o.model === 'gpt-5.2').efforts).toContain('xhigh')
    expect(group.options.find((o: any) => o.model === 'mock-model').efforts).toEqual(['off'])
    await server.request('PATCH', '/api/settings', { body: { reasoningEffort: 'off' } })
  })

  it('global CLI 内核：CLI 已知模型；没有推理强度参数的内核 effort=false；scoped 内核用 Provider 模型', async () => {
    await server.request('PATCH', '/api/settings', { body: { kernelModeClaudeCode: 'global', kernelModeGeminiCli: 'global' } })
    const claude = (await server.request('GET', '/api/models?kernel=claude-code')).json
    expect(claude.mode).toBe('global')
    expect(claude.effort).toBe(true)
    expect(claude.groups[0].options.map((o: any) => o.model)).toContain('opus')
    expect(claude.groups[0].options[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    const gemini = (await server.request('GET', '/api/models?kernel=gemini-cli')).json
    expect(gemini.effort).toBe(false)
    const codex = (await server.request('GET', '/api/models?kernel=codex')).json
    expect(codex.mode).toBe('scoped')
    expect(codex.groups.find((g: any) => g.id === providerId).options).toHaveLength(3)
    expect((await server.request('GET', '/api/models?kernel=nope')).status).toBe(404)
    await server.request('PATCH', '/api/settings', { body: { kernelModeClaudeCode: 'scoped', kernelModeGeminiCli: 'scoped' } })
  })
})

describe('会话模型 / 推理强度', () => {
  it('PATCH 保存、校验、null 恢复默认；单聊换内核时清空', async () => {
    const session = await newSession()
    expect(session.model).toBeNull()
    expect(session.reasoningEffort).toBeNull()
    let res = await patch(session.id, { providerId, model: 'gpt-5.2', reasoningEffort: 'xhigh' })
    expect(res.status, res.text).toBe(200)
    expect(res.json.session).toMatchObject({ providerId, model: 'gpt-5.2', reasoningEffort: 'xhigh' })
    expect((await server.request('GET', `/api/sessions/${session.id}`)).json.session.model).toBe('gpt-5.2')
    expect((await patch(session.id, { model: 'no-such-model' })).status).toBe(400)
    expect((await patch(session.id, { reasoningEffort: 'max' })).status).toBe(400)
    res = await patch(session.id, { reasoningEffort: null })
    expect(res.json.session).toMatchObject({ model: 'gpt-5.2', reasoningEffort: null })
    res = await patch(session.id, { model: null })
    expect(res.json.session.model).toBeNull()
    await patch(session.id, { model: 'o3-mini', reasoningEffort: 'low' })
    res = await patch(session.id, { agentIds: ['kernel-codex'] })
    expect(res.status, res.text).toBe(200)
    expect(res.json.session).toMatchObject({ model: null, reasoningEffort: null })
  })

  it('global CLI 内核的会话只接受该 CLI 的模型名；POST 新建时可带上', async () => {
    await server.request('PATCH', '/api/settings', { body: { kernelModeClaudeCode: 'global' } })
    const session = await newSession({ agentIds: ['kernel-claude-code'], model: 'opus', reasoningEffort: 'high' })
    expect(session).toMatchObject({ model: 'opus', reasoningEffort: 'high' })
    expect((await patch(session.id, { model: 'gpt-5.2' })).status).toBe(400)
    expect((await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'], model: 'opus' } })).status).toBe(400)
    await server.request('PATCH', '/api/settings', { body: { kernelModeClaudeCode: 'scoped' } })
  })

  it('内置内核：上游收到会话的模型与 reasoning_effort；不支持的模型不带', async () => {
    const session = await newSession()
    await patch(session.id, { providerId, model: 'gpt-5.2', reasoningEffort: 'xhigh' })
    await mockCall('/__mock/reset')
    let res = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '你好' } })
    expect(res.status, res.text).toBe(200)
    expect(parseSse(res.text).some((e) => e.event === 'done')).toBe(true)
    let requests = await mockRequests()
    expect(requests[0].model).toBe('gpt-5.2')
    expect(requests[0].reasoning_effort).toBe('xhigh')

    // o3-mini 没有极高 → 收紧为 high
    await patch(session.id, { model: 'o3-mini' })
    await mockCall('/__mock/reset')
    res = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '再来' } })
    requests = await mockRequests()
    expect(requests[0].model).toBe('o3-mini')
    expect(requests[0].reasoning_effort).toBe('high')

    // 默认模型（普通模型）：不带 reasoning_effort
    await patch(session.id, { model: null, reasoningEffort: null })
    await mockCall('/__mock/reset')
    res = await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '三' } })
    requests = await mockRequests()
    expect(requests[0].model).toBe('mock-model')
    expect(requests[0].reasoning_effort).toBeUndefined()
  })
})
