import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FAKE_HERMES_JS, FAKE_PI_JS, fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 内置内核端到端：真实 HTTP 服务 + tools/dev/mock-openai.js（可编排：reasoning / tool_calls / 429 / 截断 / 挂起）。
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
  const res = await fetch(`${mockBase}${path}`, {
    method: body === undefined && path === '/__mock/requests' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? (path === '/__mock/requests' ? undefined : '{}') : JSON.stringify(body),
  })
  return res.json()
}
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')

async function newSession(agentIds = ['builtin']): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds } })
  return res.json.session.id
}

async function chat(sessionId: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await server.request('POST', '/api/chat', { body: { sessionId, content, ...extra } })
  expect(res.status).toBe(200)
  return parseSse(res.text)
}

async function settings(patch: Record<string, unknown>): Promise<void> {
  const res = await server.request('PATCH', '/api/settings', { body: patch })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  const provider = await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' },
  })
  providerId = provider.json.provider.id
  // 测试里不需要业务工具，减少请求体；自动标题默认关，个别用例再开
  await settings({ autoTitle: false, llmMaxRetries: 2 })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
})

describe('推理与 usage', () => {
  it('reasoning 作为独立事件下发并落库；usage（含缓存）入库、按单价估算费用、可查询', async () => {
    await settings({ modelPricing: JSON.stringify({ 'mock-*': { input: 2, output: 8, cacheRead: 0.5, currency: 'CNY' } }) })
    await script({ reasoning: '先分析客户需求', text: '结论：报 FOB 价。', usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } } })
    const sessionId = await newSession()
    const events = await chat(sessionId, '怎么报价？')
    const kinds = events.map((e) => e.event)
    expect(kinds.filter((k) => k === 'reasoning').length).toBeGreaterThan(0)
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.indexOf('delta'))
    expect(events.filter((e) => e.event === 'reasoning').map((e) => e.data.text).join('')).toBe('先分析客户需求')
    const message = events.find((e) => e.event === 'done')!.data.message
    expect(message).toMatchObject({ content: '结论：报 FOB 价。', reasoning: '先分析客户需求', finishReason: 'stop' })
    // (1000-600)*2 + 600*0.5 + 200*8 = 2700 / 1e6
    expect(message.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, estimated: false, calls: 1, cost: 0.0027, currency: 'CNY' })
    const reqs = await mockRequests()
    expect(reqs[0].stream_options).toEqual({ include_usage: true })
    expect(reqs[0].messages.some((m: any) => 'reasoning_content' in m)).toBe(false)

    // 历史消息里不回传推理
    await script({ text: '好的' })
    await chat(sessionId, '继续')
    const second = (await mockRequests())[1]
    expect(JSON.stringify(second.messages)).not.toContain('先分析客户需求')

    const usage = await server.request('GET', `/api/usage?sessionId=${sessionId}&groupBy=model`)
    expect(usage.json.totals).toMatchObject({ calls: 2, unpricedCalls: 0 })
    expect(usage.json.totals.cost.CNY).toBeGreaterThan(0.0027) // 第二次按估算 token 计价
    expect(usage.json.totals.estimatedCalls).toBe(1) // 第二次上游没给 usage → 估算
    expect(usage.json.groups[0]).toMatchObject({ key: 'mock-model', calls: 2 })
    const records = await server.request('GET', `/api/usage/records?sessionId=${sessionId}`)
    expect(records.json.total).toBe(2)
    expect(records.json.items[1]).toMatchObject({ purpose: 'chat', messageId: message.id, agentId: 'builtin', inputTokens: 1000 })
    const messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    expect(messages[1]).toMatchObject({ reasoning: '先分析客户需求', usage: { inputTokens: 1000 } })
    await settings({ modelPricing: '' })
  })
})

describe('重试 / 续写 / 空回复', () => {
  it('429 注入：退避重试后成功，下发 retry 事件', async () => {
    await script({ status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"Rate limit reached"}}' }, { status: 502, headers: { 'retry-after': '0' } }, { text: '恢复了' })
    const events = await chat(await newSession(), '你好')
    const retries = events.filter((e) => e.event === 'retry')
    expect(retries.map((e) => e.data.code)).toEqual(['UPSTREAM_RATE_LIMITED', 'UPSTREAM_ERROR'])
    expect(retries[0].data).toMatchObject({ attempt: 1, maxRetries: 2, delayMs: 0, status: 429 })
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('恢复了')
  })

  it('重试耗尽：error 事件带分类错误码与 retryable', async () => {
    await script({ status: 500 }, { status: 500 }, { status: 500 })
    await settings({ llmMaxRetries: 0 })
    const events = await chat(await newSession(), '你好')
    await settings({ llmMaxRetries: 2 })
    const error = events.find((e) => e.event === 'error')!
    expect(error.data).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true, status: 500 })
    await mockCall('/__mock/reset')
  })

  it('finish_reason=length 自动续写，文本无缝拼接；中途断流也续写', async () => {
    await script({ text: '第一段，', finish: 'length' }, { text: '第二段，', dropAfter: true }, { text: '完。' })
    const events = await chat(await newSession(), '写长文')
    const cont = events.filter((e) => e.event === 'continuation').map((e) => e.data.reason)
    expect(cont).toEqual(['length', 'interrupted'])
    expect(events.find((e) => e.event === 'done')!.data.message).toMatchObject({ content: '第一段，第二段，完。', finishReason: 'stop' })
    const reqs = await mockRequests()
    expect(reqs).toHaveLength(3)
    const last = reqs[2].messages
    expect(last.at(-2)).toMatchObject({ role: 'assistant', content: '第二段，' })
    expect(last.at(-1).role).toBe('user')
    expect(last.at(-1).content).toContain('接着写')
  })

  it('空回复重试一次', async () => {
    await script({ text: '' }, { text: '这次有内容' })
    const events = await chat(await newSession(), '在吗')
    expect(events.filter((e) => e.event === 'retry').map((e) => e.data.code)).toEqual(['EMPTY_REPLY'])
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('这次有内容')
  })
})

describe('工具调用', () => {
  it('同一轮多个只读工具并行执行，结果按调用顺序回填、配对完整', async () => {
    await script(
      {
        text: '我算一下。',
        toolCalls: [
          { id: 'call_a', name: 'calculator', arguments: { expression: '(12.5*1200+380)*1.13' } },
          { id: 'call_b', name: 'get_time', arguments: { time: '2026-01-15 09:00', from: 'Asia/Shanghai', to: ['Europe/Berlin'] } },
          { id: 'call_c', name: 'calculator', arguments: '{"expression":' },
        ],
      },
      { text: '合计 17379.4。' },
    )
    const events = await chat(await newSession(), '算一下报价')
    const results = events.filter((e) => e.event === 'tool_result')
    expect(results).toHaveLength(3)
    expect(results.every((e) => e.data.builtin && e.data.risk === 'read')).toBe(true)
    const done = events.find((e) => e.event === 'done')!.data.message
    expect(done.content).toBe('我算一下。合计 17379.4。')
    expect(done.toolTrace.map((t: any) => t.ok)).toEqual([true, true, false])
    const second = (await mockRequests())[1].messages
    const tools = second.filter((m: any) => m.role === 'tool')
    expect(tools.map((m: any) => m.tool_call_id)).toEqual(['call_a', 'call_b', 'call_c'])
    expect(tools[0].content).toContain('17379.4')
    expect(tools[1].content).toContain('2026-01-15 02:00:00')
    expect(tools[2].content).toContain('不是合法的 JSON')
  })

  it('write 工具走审批：remember=session 后同会话不再询问；拒绝时模型收到拒绝结果', async () => {
    await settings({ toolApproval: 'ask' })
    const sessionId = await newSession()
    await script({ toolCalls: [{ id: 'w1', name: 'workspace_write', arguments: { path: 'a.md', content: 'hello' } }] }, { text: '写好了' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '写文件' } })
    let requestId = ''
    for (let i = 0; i < 100 && !requestId; i += 1) {
      await sleep(30)
      const p = await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)
      requestId = p.json.requests[0]?.requestId ?? ''
      if (requestId) expect(p.json.requests[0]).toMatchObject({ name: 'workspace_write', risk: 'write', sessionId })
    }
    expect(requestId).not.toBe('')
    expect((await server.request('POST', '/api/chat/tool-decision', { body: { requestId, approved: true, remember: 'session' } })).status).toBe(200)
    const events = parseSse((await pending).text)
    expect(events.find((e) => e.event === 'tool_request')!.data).toMatchObject({ auto: false, risk: 'write' })
    expect(events.find((e) => e.event === 'tool_result')!.data).toMatchObject({ ok: true, approved: true })
    const read = await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)
    expect(read.json.allowedTools).toEqual(['workspace_write'])

    // 记住之后：同会话自动执行
    await script({ toolCalls: [{ id: 'w2', name: 'workspace_write', arguments: { path: 'b.md', content: 'x' } }] }, { text: 'ok' })
    const again = await chat(sessionId, '再写一个')
    expect(again.find((e) => e.event === 'tool_request')!.data.auto).toBe(true)

    // 另一个会话仍需审批：拒绝
    const other = await newSession()
    await script({ toolCalls: [{ id: 'w3', name: 'workspace_write', arguments: { path: 'c.md', content: 'x' } }] }, { text: '好吧' })
    const p2 = server.request('POST', '/api/chat', { body: { sessionId: other, content: '写' } })
    let rid = ''
    for (let i = 0; i < 100 && !rid; i += 1) {
      await sleep(30)
      rid = (await server.request('GET', `/api/chat/pending?sessionId=${other}`)).json.requests[0]?.requestId ?? ''
    }
    await server.request('POST', '/api/chat/tool-decision', { body: { requestId: rid, approved: false } })
    const denied = parseSse((await p2).text)
    expect(denied.find((e) => e.event === 'tool_result')!.data).toMatchObject({ approved: false, ok: false })
    const toolMsg = (await mockRequests()).at(-1).messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toContain('拒绝')
    await settings({ toolApproval: 'auto' })
  })

  it('工具轮数上限：到上限后带 tool_choice=none 收尾，finishReason=tool_limit', async () => {
    await settings({ 'agent.maxTurns': 1 })
    await script({ toolCalls: [{ id: 't1', name: 'calculator', arguments: { expression: '1+1' } }] }, { text: '结果是 2。' })
    const events = await chat(await newSession(), '算')
    await settings({ 'agent.maxTurns': 90 })
    expect(events.find((e) => e.event === 'tool_limit')!.data).toMatchObject({ reason: 'max_turns', maxTurns: 1, maxToolRounds: 1, used: 1 })
    expect(events.find((e) => e.event === 'done')!.data.message).toMatchObject({ content: '结果是 2。', finishReason: 'tool_limit' })
    const reqs = await mockRequests()
    expect(reqs[0].tool_choice).toBe('auto')
    expect(reqs[1].tool_choice).toBe('none')
    expect(reqs[1].messages.at(-1).content).toContain('上限')
  })

  it('默认 90 轮；预算提醒在 70% / 90% 附到工具结果后；可关闭；0 = 不限制', async () => {
    const all = (await server.request('GET', '/api/settings')).json
    expect(JSON.stringify(all)).toContain('agent.maxTurns')
    await settings({ 'agent.maxTurns': 10 })
    const call = (i: number) => ({ toolCalls: [{ id: `b${i}`, name: 'calculator', arguments: { expression: `${i}+1` } }] })
    await script(...Array.from({ length: 9 }, (_, i) => call(i)), { text: '完成。' })
    const events = await chat(await newSession(), '连算')
    const budget = events.filter((e) => e.event === 'budget').map((e) => e.data)
    expect(budget).toMatchObject([
      { level: 'caution', used: 7, maxTurns: 10 },
      { level: 'warning', used: 9, maxTurns: 10 },
    ])
    expect(events.some((e) => e.event === 'tool_limit')).toBe(false)
    const reqs = await mockRequests()
    const lastTool = (i: number) => reqs[i].messages.filter((m: any) => m.role === 'tool').at(-1).content as string
    expect(lastTool(7)).toContain('[BUDGET: 7/10. 3 iterations left. Start consolidating.]')
    expect(lastTool(9)).toContain('[BUDGET WARNING: 9/10. Only 1 left. Respond NOW.]')
    // 落库的工具结果不带提醒
    const done = events.find((e) => e.event === 'done')!.data.message
    expect(JSON.stringify(done.toolRounds ?? done)).not.toContain('BUDGET')

    await mockCall('/__mock/reset')
    await settings({ 'agent.budgetPressure': false })
    await script(...Array.from({ length: 9 }, (_, i) => call(i)), { text: '完成。' })
    const quiet = await chat(await newSession(), '连算')
    expect(quiet.some((e) => e.event === 'budget')).toBe(false)
    await settings({ 'agent.budgetPressure': true, 'agent.maxTurns': 0 })

    await mockCall('/__mock/reset')
    await script(...Array.from({ length: 12 }, (_, i) => call(i)), { text: '不限。' })
    const unlimited = await chat(await newSession(), '连算')
    expect(unlimited.some((e) => e.event === 'tool_limit' || e.event === 'budget')).toBe(false)
    expect(unlimited.find((e) => e.event === 'done')!.data.message).toMatchObject({ content: '不限。', finishReason: 'stop' })
    await settings({ 'agent.maxTurns': 90 })
    const bad = await server.request('PATCH', '/api/settings', { body: { 'agent.maxTurns': 501 } })
    expect(bad.status).toBe(400)
  })

  it('循环保护：同一工具相同参数连续 3 次 → 第 3 次不执行，停用工具让模型总结', async () => {
    const same = (id: string, args: unknown) => ({ toolCalls: [{ id, name: 'calculator', arguments: args }] })
    await script(same('r1', { expression: '2*3' }), same('r2', { expression: '2*3' }), same('r3', { expression: '2*3' }), { text: '算过了，是 6。' })
    const events = await chat(await newSession(), '算')
    expect(events.filter((e) => e.event === 'tool_result')).toHaveLength(2)
    expect(events.find((e) => e.event === 'tool_limit')!.data).toMatchObject({ reason: 'loop_guard', tool: 'calculator', repeats: 3 })
    const done = events.find((e) => e.event === 'done')!.data.message
    expect(done).toMatchObject({ content: '算过了，是 6。', finishReason: 'tool_limit' })
    expect(done.toolTrace.map((t: any) => t.ok)).toEqual([true, true, false])
    const reqs = await mockRequests()
    expect(reqs).toHaveLength(4)
    expect(reqs[3].tool_choice).toBe('none')
    expect(reqs[3].messages.filter((m: any) => m.role === 'tool').at(-1).content).toContain('连续 3 次')
    expect(reqs[3].messages.at(-1).content).toContain('重复')
  })

  it('create_artifact：产物事件 + 代码块追加进正文（现有产物面板可直接提取），文件写入工作区', async () => {
    const sessionId = await newSession()
    await script(
      { toolCalls: [{ id: 'art', name: 'create_artifact', arguments: { title: '报价单', language: 'html', content: '<html><title>报价单</title><body>USD 100</body></html>' } }] },
      { text: '已生成报价单。' },
    )
    const events = await chat(sessionId, '做个报价单页面')
    const artifact = events.find((e) => e.event === 'artifact')!.data.artifact
    expect(artifact).toMatchObject({ title: '报价单', language: 'html', path: 'artifacts/报价单.html' })
    const content = events.find((e) => e.event === 'done')!.data.message.content
    expect(content).toContain('```html\n<html><title>报价单</title>')
    expect(content).toContain('已生成报价单。')
    const list = await server.request('GET', '/api/chat/tools')
    expect(list.json.tools.find((t: any) => t.name === 'create_artifact')).toMatchObject({ risk: 'read', group: 'core' })
  })

  it('能力降级：不支持工具的模型不发 tools，系统提示不提工具', async () => {
    await settings({ modelCapabilities: JSON.stringify({ 'mock-notools': { tools: false } }) })
    await server.request('PATCH', `/api/providers/${providerId}`, { body: { model: 'mock-notools', models: ['mock-model', 'mock-notools'] } })
    await script({ text: '纯文本回答' })
    const events = await chat(await newSession(), '你好')
    expect(events[0]!.data.tools).toEqual([])
    expect(events[0]!.data.capabilities).toMatchObject({ tools: false })
    const req = (await mockRequests())[0]
    expect(req.tools).toBeUndefined()
    expect(req.messages[0].content).not.toContain('calculator')
    await server.request('PATCH', `/api/providers/${providerId}`, { body: { model: 'mock-model' } })
    await settings({ modelCapabilities: '' })
  })
})

describe('取消', () => {
  it('POST /api/chat/stop：立即中止上游请求，下发 done(aborted) + stopped，已输出部分落库', async () => {
    const sessionId = await newSession()
    await script({ text: '正在写一封很长的开发信', chunkSize: 2, delayMs: 300 })
    const started = Date.now()
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '写开发信' } })
    for (let i = 0; i < 100; i += 1) {
      await sleep(30)
      if ((await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.running) break
    }
    await sleep(700)
    expect((await server.request('POST', '/api/chat/stop', { body: { sessionId } })).json).toEqual({ stopped: true })
    const events = parseSse((await pending).text)
    expect(Date.now() - started).toBeLessThan(3000)
    const kinds = events.map((e) => e.event)
    expect(kinds.slice(-2)).toEqual(['done', 'stopped'])
    const done = events.find((e) => e.event === 'done')!.data
    expect(done.aborted).toBe(true)
    expect(done.message.finishReason).toBe('aborted')
    expect(done.message.content.length).toBeGreaterThan(0)
    expect('正在写一封很长的开发信'.startsWith(done.message.content)).toBe(true)
    expect((await server.request('POST', '/api/chat/stop', { body: { sessionId } })).json).toEqual({ stopped: false })
  })

  it('停止时正在等待审批：审批立即按拒绝结束', async () => {
    await settings({ toolApproval: 'ask' })
    const sessionId = await newSession()
    await script({ toolCalls: [{ id: 'w', name: 'workspace_write', arguments: { path: 'x.md', content: 'x' } }] })
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '写' } })
    for (let i = 0; i < 100; i += 1) {
      await sleep(30)
      if ((await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests.length) break
    }
    await server.request('POST', '/api/chat/stop', { body: { sessionId } })
    const events = parseSse((await pending).text)
    expect(events.find((e) => e.event === 'tool_result')!.data).toMatchObject({ approved: false })
    expect(events.at(-1)!.event).toBe('stopped')
    expect((await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests).toEqual([])
    await settings({ toolApproval: 'auto' })
  })
})

describe('会话能力', () => {
  it('编辑重发：截断该用户消息及之后全部消息再重跑；重新生成：替换最后的回复', async () => {
    const sessionId = await newSession()
    await script({ text: '回答一' }, { text: '回答二' })
    await chat(sessionId, '问题一')
    await chat(sessionId, '问题二')
    let messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    expect(messages.map((m: any) => m.content)).toEqual(['问题一', '回答一', '问题二', '回答二'])

    await script({ text: '新回答一' })
    const edit = await server.request('POST', '/api/chat/edit', { body: { sessionId, messageId: messages[0].id, content: '问题一（改）' } })
    expect(parseSse(edit.text)[0]!.data.mode).toBe('edit')
    messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    expect(messages.map((m: any) => m.content)).toEqual(['问题一（改）', '新回答一'])
    // 上游只看到改过的问题
    const sent = (await mockRequests()).at(-1).messages
    expect(JSON.stringify(sent)).not.toContain('问题二')

    await script({ text: '重新生成的回答' })
    const regen = await server.request('POST', '/api/chat/regenerate', { body: { sessionId } })
    expect(regen.status).toBe(200)
    messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    expect(messages.map((m: any) => m.content)).toEqual(['问题一（改）', '重新生成的回答'])
    expect((await mockRequests()).at(-1).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual(['问题一（改）'])

    // 错误：编辑助手消息 / 不存在的消息（JSON 错误，不打开 SSE）
    expect((await server.request('POST', '/api/chat/edit', { body: { sessionId, messageId: messages[1].id, content: 'x' } })).json.error.code).toBe('NOT_USER_MESSAGE')
    expect((await server.request('POST', '/api/chat/edit', { body: { sessionId, messageId: 'msg_nope', content: 'x' } })).status).toBe(404)
  })

  it('按会话切换内核：PATCH 到 Pi 后，之后的消息真的经 Pi CLI（替身）→ 本机网关 → 当前 Provider；旧消息不变；旧 persona id 是内置内核的别名', async () => {
    fakeKernelPackage(join(server.home, 'kernels'), 'pi', '@earendil-works/pi-coding-agent', 'pi', 'dist/bundle/cli.js', FAKE_PI_JS)
    const sessionId = await newSession(['lux-trade'])
    expect((await server.request('GET', `/api/sessions/${sessionId}`)).json.session.agentIds).toEqual(['builtin'])
    await script({ text: '内置回答' })
    const first = (await chat(sessionId, '你好')).find((e) => e.event === 'done')!.data.message
    expect(first.senderAgentId).toBe('builtin')
    expect(first.runtime).toMatchObject({ kind: 'provider', model: 'mock-model' })

    const pi = (await server.request('GET', '/api/agents')).json.agents.find((a: any) => a.id === 'kernel-pi')
    expect(pi).toMatchObject({ kind: 'kernel', available: true, avatar: '/agents/pi.png' })
    const patched = await server.request('PATCH', `/api/sessions/${sessionId}`, { body: { agentIds: ['kernel-pi'] } })
    expect(patched.status).toBe(200)
    expect(patched.json.session.agentIds).toEqual(['kernel-pi'])
    // 持久化在会话上：重新读取 / 会话列表里都是新内核
    expect((await server.request('GET', `/api/sessions/${sessionId}`)).json.session.agentIds).toEqual(['kernel-pi'])
    const listed = (await server.request('GET', '/api/sessions')).json.sessions.find((s: any) => s.id === sessionId)
    expect(listed.agentIds).toEqual(['kernel-pi'])

    await script({ text: 'Pi 经网关回答' })
    const events = await chat(sessionId, '再问一次')
    const agentEvent = events.find((e) => e.event === 'agent')!
    expect(agentEvent.data).toMatchObject({ agentId: 'kernel-pi', name: 'Pi', avatar: '/agents/pi.png' })
    expect(agentEvent.data.runtime).toMatchObject({ kind: 'kernel', kernelId: 'pi', mode: 'scoped', model: 'mock-model' })
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toBe('Pi 经网关回答')
    const second = events.find((e) => e.event === 'done')!.data.message
    expect(second).toMatchObject({ senderAgentId: 'kernel-pi', content: 'Pi 经网关回答' })
    expect(second.runtime.label).toBe('Pi 9.9.9-test · 经由 Mock/mock-model')
    // 上游真的收到了 Pi 发来的请求：真实模型名、提示词里带着用户这条消息（网关不把一次性令牌转给上游）
    const req = (await mockRequests()).at(-1)
    expect(req.model).toBe('mock-model')
    expect(JSON.stringify(req.messages)).toContain('再问一次')
    const messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    expect(messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.senderAgentId)).toEqual(['builtin', 'kernel-pi'])
  })

  it('导出 Markdown（含工具与推理）与单条消息复制', async () => {
    const sessionId = await newSession()
    await script({ reasoning: '想一想', toolCalls: [{ id: 'k', name: 'calculator', arguments: { expression: '6*7' } }] }, { text: '答案是 **42**。' })
    await chat(sessionId, '6 乘 7？')
    const md = await server.request('GET', `/api/chat/sessions/${sessionId}/export?format=markdown&tools=1&reasoning=1&usage=1`)
    expect(md.status).toBe(200)
    expect(md.headers['content-type']).toContain('text/markdown')
    expect(md.headers['content-disposition']).toContain("filename*=UTF-8''")
    expect(md.text).toContain('### 用户')
    expect(md.text).toContain('6 乘 7？')
    expect(md.text).toContain('### LULUX')
    expect(md.text).toContain('答案是 **42**。')
    expect(md.text).toContain('**calculator**')
    expect(md.text).toContain('> 想一想')
    const messages = (await server.request('GET', `/api/sessions/${sessionId}`)).json.messages
    const copy = await server.request('GET', `/api/chat/sessions/${sessionId}/messages/${messages[1].id}/markdown`)
    expect(copy.text).toBe('答案是 **42**。')
  })

  it('群聊由内核组成：@ 指定发言者；内核回复里 @ 未发言成员时接着发言；targetAgentIds 优先', async () => {
    const kernels = join(server.home, 'kernels')
    fakeKernelPackage(kernels, 'pi', '@earendil-works/pi-coding-agent', 'pi', 'dist/bundle/cli.js', FAKE_PI_JS)
    fakeKernelPackage(kernels, 'hermes', 'hermes-agent', 'hermes', 'bin/hermes.js', FAKE_HERMES_JS)
    const sessionId = await newSession(['builtin', 'kernel-hermes', 'kernel-pi'])
    // 无主管：旧行为（主管的派发 / 汇总见 supervisor.test.ts）
    await server.request('PATCH', `/api/sessions/${sessionId}`, { body: { supervisorId: 'none' } })
    await script({ text: '我来分析。' })
    let events = await chat(sessionId, '@Hermes Agent 这个市场怎么样？')
    expect(events[0]!.data).toMatchObject({ speakMode: 'mentioned', speakers: ['kernel-hermes'] })
    expect(events.filter((e) => e.event === 'agent').map((e) => e.data.agentId)).toEqual(['kernel-hermes'])
    expect(events.find((e) => e.event === 'done')!.data.message).toMatchObject({ senderAgentId: 'kernel-hermes', content: '我来分析。' })

    await script({ text: '价格我来报，文案请 @Pi 润色。' }, { text: '润色好了。' })
    events = await chat(sessionId, '@LULUX 报个价')
    expect(events.filter((e) => e.event === 'agent').map((e) => e.data.agentId)).toEqual(['builtin', 'kernel-pi'])

    await script({ text: '收到。' })
    events = await chat(sessionId, '@LULUX 你好', { targetAgentIds: ['kernel-pi'] })
    expect(events.filter((e) => e.event === 'agent').map((e) => e.data.agentId)).toEqual(['kernel-pi'])

    await script({ text: 'A' }, { text: 'B' }, { text: 'C' })
    events = await chat(sessionId, '大家都说说')
    expect(events.filter((e) => e.event === 'agent').map((e) => e.data.agentId)).toEqual(['builtin', 'kernel-hermes', 'kernel-pi'])
    expect(events.filter((e) => e.event === 'done').map((e) => e.data.message.content)).toEqual(['A', 'B', 'C'])
  })

  it('业务上下文：会话绑定当前客户/报价后注入系统提示；看不到的客户 404', async () => {
    const customer = await server.request('POST', '/api/customers', {
      body: { company: 'Nordic Valve AB', country: 'Sweden', stage: 'quoted', contacts: [{ name: 'Erik', email: 'erik@nordic.example', isPrimary: true }] },
    })
    const quote = await server.request('POST', '/api/quotes', {
      body: { customerId: customer.json.id, currency: 'USD', incoterm: 'FOB', items: [{ name: 'Ball valve DN50', qty: 200, unit: 'pcs', unitPrice: 12.5 }] },
    })
    const sessionId = await newSession()
    expect((await server.request('PUT', `/api/chat/sessions/${sessionId}/context`, { body: { customerId: 'cus_nope' } })).status).toBe(404)
    const put = await server.request('PUT', `/api/chat/sessions/${sessionId}/context`, { body: { customerId: customer.json.id } })
    expect(put.json).toEqual({ customerId: customer.json.id, quoteId: null })
    await script({ text: '好的' }, { text: '好的' })
    await chat(sessionId, '跟进一下')
    let system = (await mockRequests())[0].messages[0].content
    expect(system).toContain('当前业务上下文')
    expect(system).toContain('Nordic Valve AB')
    expect(system).toContain('erik@nordic.example')
    expect(system).toMatch(/今天是 \d{4}-\d{2}-\d{2}/)
    // chat 请求体也能直接绑定报价
    await chat(sessionId, '看看报价', { context: { customerId: customer.json.id, quoteId: quote.json.id } })
    system = (await mockRequests())[1].messages[0].content
    expect(system).toContain(quote.json.number)
    expect(system).toContain('Ball valve DN50 × 200 pcs @ 12.5 USD')
  })

  it('自动标题：首轮回复后后台生成（purpose=title 计入 usage），用户改过的标题不覆盖', async () => {
    await settings({ autoTitle: true })
    const sessionId = await newSession()
    await script({ text: '可以，我来起草。' }, { text: '“德国客户阀门报价”。' })
    await chat(sessionId, '帮我给德国客户报阀门价格，顺便写封邮件，内容要专业一点，还要说明交期和付款方式')
    const { chatOrchestrator } = await import('../src/services/chat/orchestrator.js')
    expect(await chatOrchestrator.lastTitleJob).toBe('德国客户阀门报价')
    expect((await server.request('GET', `/api/sessions/${sessionId}`)).json.session.title).toBe('德国客户阀门报价')
    const usage = await server.request('GET', `/api/usage?sessionId=${sessionId}&groupBy=purpose`)
    expect(usage.json.groups.map((g: any) => g.key).sort()).toEqual(['chat', 'title'])

    const renamed = await newSession()
    await server.request('PATCH', `/api/sessions/${renamed}`, { body: { title: '我自己起的名字' } })
    await script({ text: '好' })
    await chat(renamed, '你好')
    expect((await server.request('GET', `/api/sessions/${renamed}`)).json.session.title).toBe('我自己起的名字')
    await settings({ autoTitle: false })
  })
})

describe('上下文压缩（端到端）', () => {
  it('超出模型窗口时把较早消息压缩成摘要并缓存复用，保留部分从用户消息开始，下发 compaction 事件', async () => {
    await settings({ modelCapabilities: JSON.stringify({ 'mock-small': { contextWindow: 4000, maxOutput: 512 } }), builtinTools: false })
    const sessionId = await newSession()
    const long = '这是一段很长的历史内容。'.repeat(60) // 约 720 token
    for (let i = 0; i < 4; i += 1) {
      await script({ text: `回答${i}：${long}` })
      const events = await chat(sessionId, `问题${i}：${long}`)
      expect(events.some((e) => e.event === 'error')).toBe(false)
    }
    // 历史在大窗口模型上积累，再切到小窗口模型
    await server.request('PATCH', `/api/providers/${providerId}`, { body: { model: 'mock-small', models: ['mock-model', 'mock-small'] } })
    const before = (await mockRequests()).length
    await script({ text: '摘要：用户问了 0-2 号问题，均已回答。' }, { text: '基于摘要回答。' })
    const events = await chat(sessionId, '总结一下')
    const compaction = events.find((e) => e.event === 'compaction' && e.data.kind === 'summary')
    expect(compaction).toBeDefined()
    expect(compaction!.data.ok).toBe(true)
    expect(compaction!.data.summarizedMessages).toBeGreaterThan(0)
    expect(compaction!.data.tokensAfter).toBeLessThan(compaction!.data.tokensBefore)
    const reqs = (await mockRequests()).slice(before)
    expect(reqs).toHaveLength(2)
    expect(reqs[0].messages[0].content).toContain('压缩')
    expect(reqs[1].messages[0].content).toContain('更早对话的摘要')
    expect(reqs[1].messages[0].content).toContain('用户问了 0-2 号问题')
    expect(reqs[1].messages[1].role).toBe('user') // 保留部分从用户消息开始
    expect(reqs[1].messages.at(-1)).toMatchObject({ role: 'user', content: '总结一下' })

    // 下一轮复用已存摘要（不再请求压缩）
    await script({ text: '短回答' })
    const next = await chat(sessionId, '好的')
    const after = (await mockRequests()).slice(before + 2)
    expect(after).toHaveLength(1)
    expect(after[0].messages[0].content).toContain('用户问了 0-2 号问题')
    expect(next.some((e) => e.event === 'compaction' && e.data.kind === 'summary')).toBe(false)
    const usage = await server.request('GET', `/api/usage?sessionId=${sessionId}&groupBy=purpose`)
    expect(usage.json.groups.map((g: any) => g.key)).toContain('compaction')

    await server.request('PATCH', `/api/providers/${providerId}`, { body: { model: 'mock-model' } })
    await settings({ modelCapabilities: '', builtinTools: true })
  })
})
