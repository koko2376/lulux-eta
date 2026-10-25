import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 按需工具集（toolLoading=auto，契约 §6.5.1）：核心工具常驻、意图命中加载、tool_search 动态加载、历史用过的工具保持；
 * 输入 token 相比 all 降低 ≥ 60%；同一轮里有写工具时按顺序执行（写后读不读旧数据）。
 */
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
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const requests = (): Promise<any[]> => mockCall('/__mock/requests')
const names = (req: any): string[] => (req.tools ?? []).map((t: any) => t.function.name)
const toolBytes = (req: any): number => Buffer.byteLength(JSON.stringify(req.tools ?? []))

async function settings(patch: Record<string, unknown>) {
  const res = await server.request('PATCH', '/api/settings', { body: patch })
  expect(res.status, res.text).toBe(200)
}
async function chat(content: string, sessionId?: string) {
  const sid = sessionId ?? (await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })).json.session.id
  const res = await server.request('POST', '/api/chat', { body: { sessionId: sid, content } })
  expect(res.status, res.text).toBe(200)
  return { sessionId: sid, events: parseSse(res.text) }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', { body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' } })
  await settings({ autoTitle: false, llmMaxRetries: 0, toolApproval: 'auto', skillAutoPreload: false })
}, 60_000)
afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('按需工具集', () => {
  it('默认 auto：闲聊只带核心工具；与 all 相比工具定义体积降低 ≥ 60%', async () => {
    expect((await server.request('GET', '/api/settings')).json.settings.toolLoading).toBe('auto')
    await mockCall('/__mock/reset')
    await script({ text: '你好！' })
    await chat('你好')
    const auto = (await requests())[0]
    expect(names(auto).sort()).toEqual(['calculator', 'get_customer', 'get_time', 'memory_add', 'memory_remove', 'memory_replace', 'search_customers', 'skill_view', 'tool_search'])

    await settings({ toolLoading: 'all' })
    await mockCall('/__mock/reset')
    await script({ text: '你好！' })
    await chat('你好')
    const all = (await requests())[0]
    await settings({ toolLoading: 'auto' })
    expect(names(all)).not.toContain('tool_search')
    const reduction = 1 - toolBytes(auto) / toolBytes(all)
    console.log(`[toolsets] tools bytes all=${toolBytes(all)} (${names(all).length} tools) auto/chit-chat=${toolBytes(auto)} (${names(auto).length}) reduction=${(reduction * 100).toFixed(1)}%`)
    expect(reduction).toBeGreaterThanOrEqual(0.6)
  })

  it('意图命中加载对应工具集；不相关的不带', async () => {
    await mockCall('/__mock/reset')
    await script({ text: '好的' })
    await chat('看看这周有哪些逾期应收，帮我催款')
    const req = (await requests())[0]
    expect(names(req)).toEqual(expect.arrayContaining(['list_overdue_receivables', 'record_payment', 'list_orders', 'tool_search']))
    expect(names(req)).not.toContain('update_quote')
    expect(names(req)).not.toContain('mcp_add')
    // 基准 25.5KB：v0.1.2 起 tool_search 目录多了“内置浏览器”“电脑操作”“群聊”“开发客户”“开发信序列”工具集各一行
    expect(1 - toolBytes(req) / 25_500).toBeGreaterThan(0.6)
  })

  it('tool_search 加载后下一次上游请求即带上新工具，并可调用；之后同会话保持', async () => {
    const customer = (await server.request('POST', '/api/customers', { body: { company: 'Toolset Buyer Ltd' } })).json
    await mockCall('/__mock/reset')
    await script(
      { toolCalls: [{ id: 's1', name: 'tool_search', arguments: { toolsets: ['deals'] } }] },
      { toolCalls: [{ id: 'd1', name: 'create_deal', arguments: { customerId: customer.id, title: '年框', amount: 5000 } }] },
      { text: '已建商机' },
    )
    const { sessionId, events } = await chat('你好呀')
    const reqs = await requests()
    expect(names(reqs[0])).not.toContain('create_deal')
    expect(names(reqs[1])).toEqual(expect.arrayContaining(['create_deal', 'update_deal', 'list_deals', 'pipeline_stats']))
    const results = events.filter((e) => e.event === 'tool_result').map((e) => e.data)
    expect(JSON.parse(results[0].result).loaded.map((t: any) => t.name)).toContain('create_deal')
    expect(results[1]).toMatchObject({ ok: true, name: 'create_deal' })
    expect((await server.request('GET', `/api/deals?customerId=${customer.id}`)).json.total).toBe(1)

    // 下一轮对话：历史里用过的工具（create_deal）仍在活动集里
    await mockCall('/__mock/reset')
    await script({ text: 'ok' })
    await chat('谢谢', sessionId)
    expect(names((await requests())[0])).toContain('create_deal')
  })

  it('未发送定义的已注册工具仍可执行（RBAC / 审批不变）', async () => {
    await mockCall('/__mock/reset')
    await script({ toolCalls: [{ id: 'x', name: 'list_team_members', arguments: {} }] }, { text: 'ok' })
    const { events } = await chat('你好')
    expect(names((await requests())[0])).not.toContain('list_team_members')
    expect(events.find((e) => e.event === 'tool_result')?.data).toMatchObject({ ok: true, name: 'list_team_members' })
  })
})

describe('同一轮读写工具顺序', () => {
  it('写 + 读同轮：按模型给出的顺序串行执行，读到写之后的数据', async () => {
    await settings({ parallelToolCalls: true, toolLoading: 'all' })
    const customer = (await server.request('POST', '/api/customers', { body: { company: 'Order Matters GmbH', stage: 'lead' } })).json
    for (let i = 0; i < 3; i += 1) {
      await mockCall('/__mock/reset')
      const stage = ['contacted', 'quoted', 'negotiating'][i]
      await script(
        {
          toolCalls: [
            { id: `w${i}`, name: 'update_customer', arguments: { customerId: customer.id, stage } },
            { id: `r${i}`, name: 'get_customer', arguments: { customerId: customer.id } },
            { id: `s${i}`, name: 'search_customers', arguments: { query: 'Order Matters' } },
          ],
        },
        { text: 'ok' },
      )
      const { events } = await chat('改阶段再查')
      const results = events.filter((e) => e.event === 'tool_result').map((e) => e.data)
      expect(results.map((r) => r.toolCallId)).toEqual([`w${i}`, `r${i}`, `s${i}`])
      expect(results[1].result).toContain(`"stage": "${stage}"`)
      expect(JSON.parse(results[2].result).items[0].stage).toBe(stage)
    }
    await settings({ toolLoading: 'auto' })
  })
})
