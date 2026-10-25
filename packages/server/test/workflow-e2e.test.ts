import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FAKE_HERMES_JS, fakeKernelPackage, startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * 工作流 + 定时任务端到端：真实 HTTP 服务 + tools/dev/mock-openai.js，节点走内置内核（chatOrchestrator）。
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
  const res = await fetch(`${mockBase}${path}`, {
    method: get ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: get ? undefined : JSON.stringify(body ?? {}),
  })
  return res.json()
}
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const api = async (method: string, path: string, body?: unknown) => server.request(method, path, { body })

function node(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `节点${id.toUpperCase()}`, kernelId: 'builtin', prompt: `你是第 ${id} 步`, joinStrategy: 'all', allowWrite: false, position: { x: 0, y: 0 }, ...extra }
}
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })

async function createWorkflow(body: Record<string, unknown>) {
  const res = await api('POST', '/api/workflows', body)
  expect(res.status, res.text).toBe(201)
  return res.json
}

const TERMINAL = ['succeeded', 'failed', 'cancelled']
async function waitRun(runId: string, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await api('GET', `/api/workflow-runs/${runId}`)
    if (TERMINAL.includes(res.json.status)) return res.json
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${res.json.status}`)
    await sleep(40)
  }
}

async function waitScheduleRun(scheduleId: string, runId: string): Promise<any> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const res = await api('GET', `/api/schedules/${scheduleId}/runs`)
    const run = res.json.find((r: any) => r.id === runId)
    if (run && TERMINAL.includes(run.status)) return run
    if (Date.now() > deadline) throw new Error(`schedule run ${runId} still ${run?.status}`)
    await sleep(40)
  }
}

/** 订阅 /api/events，收集事件直到 stop() */
function subscribe(): { events: Array<{ event: string; data: any }>; stop: () => void } {
  const events: Array<{ event: string; data: any }> = []
  const controller = new AbortController()
  void (async () => {
    try {
      const res = await fetch(`${server.base}/api/events`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` }, signal: controller.signal })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          events.push({ event, data: data ? JSON.parse(data) : null })
        }
      }
    } catch {
      // aborted
    }
  })()
  return { events, stop: () => controller.abort() }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  const provider = await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  expect(provider.status, provider.text).toBe(201)
  const settings = await api('PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, toolLoading: 'all', skillAutoPreload: false, timezone: 'Asia/Shanghai' })
  expect(settings.status, settings.text).toBe(200)
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
})

describe('工作流 CRUD 与校验', () => {
  it('创建 / 列表 / 读取 / 修改；环、悬空边、未知内核被拒绝；导出 / 导入 / 复制 / 删除', async () => {
    const wf = await createWorkflow({ name: '询盘处理', description: 'd', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] })
    expect(wf).toMatchObject({ name: '询盘处理', nodeCount: 2, edgeCount: 1, ownerId: 'local', lastRun: null, viewport: null })
    expect(wf.nodes[0]).toMatchObject({ id: 'a', kernelId: 'builtin', providerId: null, model: null, joinStrategy: 'all', allowWrite: false, skills: [] })

    const list = await api('GET', '/api/workflows')
    expect(list.json.some((w: any) => w.id === wf.id && w.nodeCount === 2)).toBe(true)

    const cycle = await api('PATCH', `/api/workflows/${wf.id}`, { edges: [edge('a', 'b'), edge('b', 'a')] })
    expect(cycle.status).toBe(400)
    expect(cycle.json.error.code).toBe('CYCLE_DETECTED')
    const dangling = await api('PATCH', `/api/workflows/${wf.id}`, { edges: [edge('a', 'zzz')] })
    expect(dangling.json.error.code).toBe('DANGLING_EDGE')
    const unknown = await api('PATCH', `/api/workflows/${wf.id}`, { nodes: [node('a', { kernelId: 'kernel-nope' }), node('b')] })
    expect(unknown.json.error.code).toBe('UNKNOWN_KERNEL')
    const badProvider = await api('PATCH', `/api/workflows/${wf.id}`, { nodes: [node('a', { providerId: 'prv_missing' }), node('b')] })
    expect(badProvider.json.error.code).toBe('UNKNOWN_PROVIDER')
    // 失败的修改不落库
    expect((await api('GET', `/api/workflows/${wf.id}`)).json.edges).toEqual([edge('a', 'b')])

    const patched = await api('PATCH', `/api/workflows/${wf.id}`, {
      name: '询盘处理 v2',
      viewport: { x: 10, y: 20, zoom: 1.5 },
      nodes: [node('a', { kernelId: 'lux-trade', joinStrategy: 'any', skills: ['x', 'x'] }), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('a', 'c'), { id: 'dup', source: 'a', target: 'b' }],
    })
    expect(patched.status, patched.text).toBe(200)
    expect(patched.json).toMatchObject({ name: '询盘处理 v2', viewport: { x: 10, y: 20, zoom: 1.5 }, nodeCount: 3, edgeCount: 2 })
    expect(patched.json.nodes[0]).toMatchObject({ kernelId: 'builtin', joinStrategy: 'any', skills: ['x'] }) // 旧 persona id → builtin

    const exported = await api('GET', `/api/workflows/${wf.id}/export`)
    expect(exported.status).toBe(200)
    expect(exported.headers['content-disposition']).toContain('attachment')
    expect(exported.json).toMatchObject({ format: 'lulux-workflow', version: 1, name: '询盘处理 v2' })
    const imported = await api('POST', '/api/workflows/import', { json: JSON.stringify(exported.json) })
    expect(imported.status, imported.text).toBe(201)
    expect(imported.json.id).not.toBe(wf.id)
    expect(imported.json).toMatchObject({ name: '询盘处理 v2', nodeCount: 3, edgeCount: 2 })
    const badImport = await api('POST', '/api/workflows/import', { json: '{not json' })
    expect(badImport.json.error.code).toBe('INVALID_IMPORT')
    const cyclicImport = await api('POST', '/api/workflows/import', { json: { nodes: [node('a')], edges: [edge('a', 'a')] } })
    expect(cyclicImport.json.error.code).toBe('CYCLE_DETECTED')

    const copy = await api('POST', `/api/workflows/${wf.id}/duplicate`)
    expect(copy.status).toBe(201)
    expect(copy.json.name).toBe('询盘处理 v2 副本')

    const emptyRun = await api('POST', `/api/workflows/${(await createWorkflow({ name: 'empty' })).id}/run`, {})
    expect(emptyRun.json.error.code).toBe('EMPTY_WORKFLOW')

    expect((await api('DELETE', `/api/workflows/${copy.json.id}`)).status).toBe(204)
    expect((await api('GET', `/api/workflows/${copy.json.id}`)).status).toBe(404)

    const audit = await api('GET', '/api/audit?action=workflow.')
    const actions = audit.json.items.map((i: any) => i.action)
    expect(actions).toEqual(expect.arrayContaining(['workflow.create', 'workflow.update', 'workflow.import', 'workflow.delete']))
  })
})

describe('工作流运行（内置内核 + mock LLM）', () => {
  it('a → b → c：根节点拿到输入，下游拿到上游输出；隐藏会话不在列表里但能打开；事件推送', async () => {
    const wf = await createWorkflow({ name: '三步', nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] })
    await script({ text: 'A 的结论' }, { text: 'B 的结论' }, { text: 'C 的结论' })
    const sub = subscribe()
    await sleep(100)
    const started = await api('POST', `/api/workflows/${wf.id}/run`, { input: '客户要 500 套木屋' })
    expect(started.status, started.text).toBe(200)
    expect(started.json).toMatchObject({ workflowId: wf.id, trigger: 'manual', scheduleId: null, status: 'queued', input: '客户要 500 套木屋' })
    expect(started.json.nodes.map((n: any) => n.nodeId)).toEqual(['a', 'b', 'c'])

    const run = await waitRun(started.json.id)
    expect(run.status).toBe('succeeded')
    expect(run.error).toBeNull()
    expect(run.nodes.map((n: any) => [n.nodeId, n.status, n.output])).toEqual([
      ['a', 'succeeded', 'A 的结论'],
      ['b', 'succeeded', 'B 的结论'],
      ['c', 'succeeded', 'C 的结论'],
    ])
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt)

    const reqs = await mockRequests()
    const userText = (r: any) => {
      const msgs = r.messages.filter((m: any) => m.role === 'user')
      const last = msgs[msgs.length - 1]
      return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    }
    expect(reqs).toHaveLength(3)
    expect(userText(reqs[0])).toContain('你是第 a 步')
    expect(userText(reqs[0])).toContain('## 输入\n客户要 500 套木屋')
    expect(userText(reqs[1])).toContain('## 上游输出\n### 节点A\nA 的结论')
    expect(userText(reqs[1])).not.toContain('客户要 500 套木屋')
    expect(userText(reqs[2])).toContain('### 节点B\nB 的结论')

    const sessions = (await api('GET', '/api/sessions')).json.sessions.map((s: any) => s.id)
    for (const n of run.nodes) {
      expect(n.sessionId).toBeTruthy()
      expect(sessions).not.toContain(n.sessionId)
      const opened = await api('GET', `/api/sessions/${n.sessionId}`)
      expect(opened.status).toBe(200)
      expect(opened.json.session.title).toContain('[工作流] 三步')
      expect(opened.json.session.workflowRunId).toBe(run.id)
    }
    // 隐藏会话只读：发消息 / 改名 → 409 WORKFLOW_SESSION_READONLY
    const hiddenId = run.nodes[0].sessionId
    const send = await api('POST', '/api/chat', { sessionId: hiddenId, content: '继续' })
    expect(send.status).toBe(409)
    expect(send.json.error.code).toBe('WORKFLOW_SESSION_READONLY')
    const rename = await api('PATCH', `/api/sessions/${hiddenId}`, { title: '改名' })
    expect(rename.status).toBe(409)

    const list = await api('GET', `/api/workflows/${wf.id}/runs?limit=5`)
    expect(list.json[0].id).toBe(run.id)
    expect((await api('GET', `/api/workflows/${wf.id}`)).json.lastRun).toMatchObject({ id: run.id, status: 'succeeded' })

    await sleep(100)
    sub.stop()
    const runEvents = sub.events.filter((e) => e.event === 'workflow.run' && e.data.runId === run.id).map((e) => e.data.status)
    expect(runEvents).toEqual(['queued', 'running', 'succeeded'])
    const nodeEvents = sub.events.filter((e) => e.event === 'workflow.node' && e.data.runId === run.id)
    expect(nodeEvents.some((e) => e.data.nodeId === 'a' && e.data.delta)).toBe(true)
    expect(nodeEvents.filter((e) => !e.data.delta).map((e) => `${e.data.nodeId}:${e.data.status}`)).toEqual([
      'a:running',
      'a:succeeded',
      'b:running',
      'b:succeeded',
      'c:running',
      'c:succeeded',
    ])
    expect(nodeEvents[0].data).toMatchObject({ type: 'workflow.node', workflowId: wf.id })
  })

  it('菱形 a → (b: Hermes CLI 内核, c: 内置) → d(all)：CLI 节点经本机网关运行；d 拿到两个上游；未安装的内核节点失败', async () => {
    const missing = await createWorkflow({ name: '缺内核', nodes: [node('a', { kernelId: 'kernel-codex' })] })
    const failed = await waitRun((await api('POST', `/api/workflows/${missing.id}/run`, {})).json.id)
    expect(failed.status).toBe('failed')
    expect(failed.nodes[0].error).toContain('未安装')

    fakeKernelPackage(join(server.home, 'kernels'), 'hermes', 'hermes-agent', 'hermes', 'bin/hermes.js', FAKE_HERMES_JS)
    const wf = await createWorkflow({
      name: '菱形',
      nodes: [node('a'), node('b', { kernelId: 'kernel-hermes' }), node('c'), node('d')],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    })
    await script({ text: '根结论' }, { text: '并行分支' }, { text: '并行分支' }, { text: '汇总完成' })
    const run = await waitRun((await api('POST', `/api/workflows/${wf.id}/run`, { input: '开始' })).json.id)
    expect(run.status, JSON.stringify(run.nodes)).toBe('succeeded')
    expect(run.nodes.map((n: any) => n.output)).toEqual(['根结论', '并行分支', '并行分支', '汇总完成'])
    const reqs = await mockRequests()
    const last = reqs[3].messages.filter((m: any) => m.role === 'user').pop().content
    expect(last).toContain('### 节点B\n并行分支')
    expect(last).toContain('### 节点C\n并行分支')
    // Hermes 节点的隐藏会话：消息由 kernel-hermes 发出
    const msgs = (await api('GET', `/api/sessions/${run.nodes[1].sessionId}`)).json.messages
    expect(msgs[1]).toMatchObject({ senderAgentId: 'kernel-hermes', content: '并行分支' })
  })

  it('群聊讨论节点：同一内核两个成员带群头衔讨论，主管汇总作为输出交给下游；旧节点数据按单内核读出', async () => {
    const wf = await createWorkflow({
      name: '群聊讨论',
      nodes: [
        node('g', {
          kind: 'group',
          prompt: '讨论 BV-50 报价口径',
          members: [
            { agentId: 'builtin', role: '跟单员', instructions: '只看交期' },
            { agentId: 'builtin', role: '报价员' },
          ],
          supervisorId: 'none',
        }),
        node('n'),
      ],
      edges: [edge('g', 'n')],
    })
    expect(wf.nodes[0]).toMatchObject({
      kind: 'group',
      supervisorId: 'none',
      members: [
        { agentId: 'builtin', role: '跟单员', instructions: '只看交期', model: null },
        { agentId: 'builtin#2', role: '报价员', instructions: '', model: null },
      ],
    })
    expect(wf.nodes[1]).toMatchObject({ kind: 'agent', members: [] })
    await script({ text: '交期 25 天' }, { text: 'FOB 12.5 美元' }, { text: '下游收到' })
    const run = await waitRun((await api('POST', `/api/workflows/${wf.id}/run`, { input: '客户询价' })).json.id)
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    expect(run.nodes[0].output).toBe('【LULUX（跟单员）】\n交期 25 天\n\n【LULUX（报价员）】\nFOB 12.5 美元')
    const reqs = await mockRequests()
    expect(reqs[0].messages[0].content).toContain('你的职责：只看交期')
    expect(JSON.stringify(reqs[2].messages)).toContain('FOB 12.5 美元')
    // 群聊讨论节点的隐藏会话不出现在会话列表里，也不会被群聊工具找到
    const sessions = (await api('GET', '/api/sessions')).json.sessions
    expect(sessions.some((s: any) => s.groupName === '节点G')).toBe(false)

    // 校验：群聊讨论没有成员 / 主管不是成员 → 400
    expect((await api('POST', '/api/workflows', { name: 'x', nodes: [node('g', { kind: 'group', members: [] })], edges: [] })).status).toBe(400)
    expect(
      (await api('POST', '/api/workflows', { name: 'x', nodes: [node('g', { kind: 'group', members: [{ agentId: 'builtin' }], supervisorId: 'kernel-pi' })], edges: [] })).status,
    ).toBe(400)
  })

  it('节点失败 → 下游跳过，运行记为失败', async () => {
    const wf = await createWorkflow({ name: '失败', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] })
    await script({ status: 400, body: '{"error":{"message":"bad request from mock"}}' })
    const started = await api('POST', `/api/workflows/${wf.id}/run`, {})
    const run = await waitRun(started.json.id)
    expect(run.status).toBe('failed')
    expect(run.nodes[0]).toMatchObject({ nodeId: 'a', status: 'failed' })
    expect(run.nodes[0].error).toBeTruthy()
    expect(run.nodes[1]).toMatchObject({ nodeId: 'b', status: 'skipped' })
    expect(run.error).toContain('节点A')
  })

  it('allowWrite=false：写工具自动拒绝（即使全局 toolApproval=auto）；allowWrite=true：自动批准', async () => {
    await api('PATCH', '/api/settings', { toolApproval: 'auto' })
    const denied = await createWorkflow({ name: '只读', nodes: [node('a', { allowWrite: false })] })
    await script({ toolCalls: [{ id: 'c1', name: 'create_task', arguments: { title: '工作流建的任务-拒绝' } }] }, { text: '已尝试' })
    const r1 = await waitRun((await api('POST', `/api/workflows/${denied.id}/run`, {})).json.id)
    expect(r1.status).toBe('succeeded')
    const tasks1 = (await api('GET', '/api/tasks?status=all')).json.items.map((t: any) => t.title)
    expect(tasks1).not.toContain('工作流建的任务-拒绝')
    const msgs = (await api('GET', `/api/sessions/${r1.nodes[0].sessionId}`)).json.messages
    const trace = msgs.find((m: any) => m.role === 'assistant').toolTrace
    expect(trace[0]).toMatchObject({ name: 'create_task', approved: false })

    await api('PATCH', '/api/settings', { toolApproval: 'ask' })
    const allowed = await createWorkflow({ name: '可写', nodes: [node('a', { allowWrite: true })] })
    await script({ toolCalls: [{ id: 'c2', name: 'create_task', arguments: { title: '工作流建的任务-允许' } }] }, { text: '建好了' })
    const r2 = await waitRun((await api('POST', `/api/workflows/${allowed.id}/run`, {})).json.id, 10_000)
    expect(r2.status).toBe('succeeded')
    const tasks2 = (await api('GET', '/api/tasks?status=all')).json.items.map((t: any) => t.title)
    expect(tasks2).toContain('工作流建的任务-允许')
  })

  it('取消：中止运行中的节点，下游记为 cancelled', async () => {
    const wf = await createWorkflow({ name: '取消', nodes: [node('a'), node('b')], edges: [edge('a', 'b')] })
    await script({ hang: true })
    const started = await api('POST', `/api/workflows/${wf.id}/run`, {})
    const deadline = Date.now() + 5000
    while ((await api('GET', `/api/workflow-runs/${started.json.id}`)).json.nodes[0].status !== 'running') {
      if (Date.now() > deadline) throw new Error('node never started')
      await sleep(30)
    }
    await sleep(100)
    const cancelled = await api('POST', `/api/workflow-runs/${started.json.id}/cancel`)
    expect(cancelled.status, cancelled.text).toBe(200)
    expect(cancelled.json.status).toBe('cancelled')
    expect(cancelled.json.nodes.map((n: any) => n.status)).toEqual(['cancelled', 'cancelled'])
    // 已结束的运行再取消：原样返回
    expect((await api('POST', `/api/workflow-runs/${started.json.id}/cancel`)).json.status).toBe('cancelled')
    expect((await api('GET', '/api/workflow-runs/wfr_missing')).status).toBe(404)
  })

  it('删除工作流：运行记录与隐藏会话一并删除，指向它的定时任务被停用', async () => {
    const wf = await createWorkflow({ name: '待删', nodes: [node('a')] })
    await script({ text: 'ok' })
    const run = await waitRun((await api('POST', `/api/workflows/${wf.id}/run`, {})).json.id)
    const sessionId = run.nodes[0].sessionId
    const sch = await api('POST', '/api/schedules', { name: '每天', target: { type: 'workflow', workflowId: wf.id }, spec: { type: 'daily', time: '09:00' } })
    expect(sch.status, sch.text).toBe(201)
    expect((await api('DELETE', `/api/workflows/${wf.id}`)).status).toBe(204)
    expect((await api('GET', `/api/workflow-runs/${run.id}`)).status).toBe(404)
    expect((await api('GET', `/api/sessions/${sessionId}`)).status).toBe(404)
    expect((await api('GET', `/api/schedules/${sch.json.id}`)).json).toMatchObject({ enabled: false, nextRunAt: null, lastError: '目标工作流已删除' })
  })
})

describe('定时任务', () => {
  it('预览（纽约跨夏令时 / 上海）与校验错误', async () => {
    const preview = await api('POST', '/api/schedules/preview', { spec: { type: 'cron', expr: '0 9 * * *' }, timezone: 'America/New_York' })
    expect(preview.status, preview.text).toBe(200)
    expect(preview.json.next).toHaveLength(5)
    const sh = await api('POST', '/api/schedules/preview', { spec: { type: 'daily', time: '08:30' } }) // 默认时区 = 设置 Asia/Shanghai
    for (const t of sh.json.next) {
      const d = new Date(t + 8 * 3_600_000)
      expect([d.getUTCHours(), d.getUTCMinutes()]).toEqual([8, 30])
    }
    const bad = async (body: unknown, code: string) => {
      const res = await api('POST', '/api/schedules', body)
      expect(res.status, res.text).toBe(400)
      expect(res.json.error.code).toBe(code)
    }
    const target = { type: 'prompt', kernelId: 'builtin', prompt: 'hi', sessionMode: 'new' }
    await bad({ name: 'x', target, spec: { type: 'interval', minutes: 4 } }, 'INVALID_SCHEDULE')
    await bad({ name: 'x', target, spec: { type: 'once', at: Date.now() - 1000 } }, 'INVALID_SCHEDULE')
    await bad({ name: 'x', target, spec: { type: 'cron', expr: '0 0 30 2 *' } }, 'INVALID_SCHEDULE')
    await bad({ name: 'x', target, spec: { type: 'cron', expr: '61 * * * *' } }, 'INVALID_SCHEDULE')
    await bad({ name: 'x', target, spec: { type: 'daily', time: '09:00' }, timezone: 'Mars/Base' }, 'INVALID_TIMEZONE')
    await bad({ name: 'x', target: { ...target, kernelId: 'kernel-nope' }, spec: { type: 'daily', time: '09:00' } }, 'UNKNOWN_KERNEL')
    await bad({ name: 'x', target: { type: 'workflow', workflowId: 'wf_missing' }, spec: { type: 'daily', time: '09:00' } }, 'WORKFLOW_NOT_FOUND')
    await bad({ name: 'x', target: { ...target, sessionMode: 'append', sessionId: 'ses_missing' }, spec: { type: 'daily', time: '09:00' } }, 'SESSION_NOT_FOUND')
  })

  it('工作流目标：创建（nextRunAt）、run-now、运行记录、停用 / 启用、删除；通知事件', async () => {
    const wf = await createWorkflow({ name: '日报', nodes: [node('a')] })
    const created = await api('POST', '/api/schedules', {
      name: '每天 9 点日报',
      target: { type: 'workflow', workflowId: wf.id, input: '今天的询盘' },
      spec: { type: 'daily', time: '09:00' },
      timezone: 'America/New_York',
    })
    expect(created.status, created.text).toBe(201)
    const sch = created.json
    expect(sch).toMatchObject({ enabled: true, timezone: 'America/New_York', lastRunAt: null, lastStatus: null, ownerId: 'local' })
    expect(sch.nextRunAt).toBeGreaterThan(Date.now())
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(sch.nextRunAt))
    expect(local).toBe('09:00')

    await script({ text: '日报内容' })
    const sub = subscribe()
    await sleep(100)
    const now = await api('POST', `/api/schedules/${sch.id}/run-now`)
    expect(now.status, now.text).toBe(200)
    expect(now.json).toMatchObject({ scheduleId: sch.id, status: 'running', missed: false })
    const finished = await waitScheduleRun(sch.id, now.json.id)
    expect(finished.status).toBe('succeeded')
    expect(finished.workflowRunId).toBeTruthy()
    const wfRun = (await api('GET', `/api/workflow-runs/${finished.workflowRunId}`)).json
    expect(wfRun).toMatchObject({ trigger: 'schedule', scheduleId: sch.id, input: '今天的询盘', status: 'succeeded' })
    const after = (await api('GET', `/api/schedules/${sch.id}`)).json
    expect(after).toMatchObject({ lastStatus: 'succeeded', lastError: null, nextRunAt: sch.nextRunAt })
    expect(after.lastRunAt).toBeGreaterThan(0)
    await sleep(50)
    sub.stop()
    expect(sub.events.filter((e) => e.event === 'schedule.run' && e.data.scheduleId === sch.id).map((e) => e.data.status)).toEqual(['running', 'succeeded'])

    const disabled = await api('PATCH', `/api/schedules/${sch.id}`, { enabled: false })
    expect(disabled.json).toMatchObject({ enabled: false, nextRunAt: null })
    const enabled = await api('PATCH', `/api/schedules/${sch.id}`, { enabled: true, spec: { type: 'interval', minutes: 30 } })
    expect(enabled.json.enabled).toBe(true)
    expect(enabled.json.nextRunAt).toBeGreaterThan(Date.now() + 29 * 60_000)

    const audit = (await api('GET', '/api/audit?action=schedule.')).json.items.map((i: any) => i.action)
    expect(audit).toEqual(expect.arrayContaining(['schedule.create', 'schedule.update', 'schedule.run_now']))
    expect((await api('DELETE', `/api/schedules/${sch.id}`)).status).toBe(204)
    expect((await api('GET', `/api/schedules/${sch.id}`)).status).toBe(404)
  })

  it('提示词目标：新会话（出现在会话列表）/ 追加到已有会话', async () => {
    await script({ text: '新会话里的回复' })
    const created = await api('POST', '/api/schedules', {
      name: '提醒',
      target: { type: 'prompt', kernelId: 'builtin', prompt: '总结今天的待办', sessionMode: 'new' },
      spec: { type: 'weekly', days: [1, 3, 5], time: '18:00' },
    })
    expect(created.status, created.text).toBe(201)
    expect(created.json.timezone).toBe('Asia/Shanghai')
    const run = await waitScheduleRun(created.json.id, (await api('POST', `/api/schedules/${created.json.id}/run-now`)).json.id)
    expect(run.status, run.error).toBe('succeeded')
    const sessions = (await api('GET', '/api/sessions')).json.sessions
    const session = sessions.find((s: any) => s.id === run.sessionId)
    expect(session.title).toContain('[定时] 提醒')

    const target = (await api('POST', '/api/sessions', { body: undefined, agentIds: ['builtin'] })).json.session
    await script({ text: '追加的回复' })
    const append = await api('POST', '/api/schedules', {
      name: '追加',
      target: { type: 'prompt', kernelId: 'builtin', prompt: '再看一眼', sessionMode: 'append', sessionId: target.id },
      spec: { type: 'cron', expr: '0 9 * * 1-5' },
    })
    expect(append.status, append.text).toBe(201)
    const run2 = await waitScheduleRun(append.json.id, (await api('POST', `/api/schedules/${append.json.id}/run-now`)).json.id)
    expect(run2).toMatchObject({ status: 'succeeded', sessionId: target.id })
    const msgs = (await api('GET', `/api/sessions/${target.id}`)).json.messages
    expect(msgs.map((m: any) => m.content)).toEqual(['再看一眼', '追加的回复'])
  })

  it('错过的运行：窗口内补跑一次（missed），超出窗口跳到下一次；窗口为 0 不补跑；上一次未结束则跳过', async () => {
    const { db } = await import('../src/db.js')
    const { scheduler } = await import('../src/services/schedule/scheduler.js')
    const mk = async (name: string) =>
      (
        await api('POST', '/api/schedules', {
          name,
          target: { type: 'prompt', kernelId: 'builtin', prompt: `${name} 的提示`, sessionMode: 'new' },
          spec: { type: 'interval', minutes: 60 },
        })
      ).json
    const recent = await mk('近期错过')
    const old = await mk('很久以前错过')
    const now = Date.now()
    db.prepare('UPDATE schedules SET next_run_at = ?, anchor_at = ? WHERE id = ?').run(now - 3_600_000, now - 7_200_000, recent.id)
    db.prepare('UPDATE schedules SET next_run_at = ?, anchor_at = ? WHERE id = ?').run(now - 30 * 3_600_000, now - 31 * 3_600_000, old.id)
    await script({ text: '补跑结果' })
    const result = scheduler.tick(now)
    expect(result).toEqual({ fired: 1, skipped: 1 })
    await scheduler.waitIdle(recent.id)
    const recentRuns = (await api('GET', `/api/schedules/${recent.id}/runs`)).json
    expect(recentRuns).toHaveLength(1)
    expect(recentRuns[0]).toMatchObject({ status: 'succeeded', missed: true })
    const oldRuns = (await api('GET', `/api/schedules/${old.id}/runs`)).json
    expect(oldRuns).toHaveLength(1)
    expect(oldRuns[0]).toMatchObject({ status: 'skipped', missed: true })
    expect(oldRuns[0].error).toContain('超出补跑窗口')
    // 两者的下一次都推进到未来，并按锚点对齐（anchor + k·60 分钟）
    for (const s of [recent, old]) {
      const fresh = (await api('GET', `/api/schedules/${s.id}`)).json
      expect(fresh.nextRunAt).toBeGreaterThan(now)
      expect(fresh.nextRunAt).toBeLessThanOrEqual(now + 3_600_000)
    }
    expect(scheduler.tick(now)).toEqual({ fired: 0, skipped: 0 })

    // 补跑窗口 0：错过 5 分钟也不补跑
    await api('PATCH', '/api/settings', { scheduleMissedRunHours: 0 })
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(now - 5 * 60_000, recent.id)
    expect(scheduler.tick(now)).toEqual({ fired: 0, skipped: 1 })
    await api('PATCH', '/api/settings', { scheduleMissedRunHours: 24 })

    // 上一次还没结束：新的触发记为 skipped
    await script({ hang: true })
    const first = await api('POST', `/api/schedules/${old.id}/run-now`)
    expect(first.json.status).toBe('running')
    await sleep(100)
    const second = await api('POST', `/api/schedules/${old.id}/run-now`)
    expect(second.json).toMatchObject({ status: 'skipped', error: '上一次运行尚未结束' })
  })

  it('一次性任务触发后停用', async () => {
    const { db } = await import('../src/db.js')
    const { scheduler } = await import('../src/services/schedule/scheduler.js')
    const at = Date.now() + 3_600_000
    const sch = (
      await api('POST', '/api/schedules', { name: '一次', target: { type: 'prompt', kernelId: 'builtin', prompt: '一次性', sessionMode: 'new' }, spec: { type: 'once', at } })
    ).json
    expect(sch.nextRunAt).toBe(at)
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, sch.id)
    await script({ text: 'done' })
    expect(scheduler.tick().fired).toBe(1)
    await scheduler.waitIdle(sch.id)
    expect((await api('GET', `/api/schedules/${sch.id}`)).json).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'succeeded' })
  })
})
