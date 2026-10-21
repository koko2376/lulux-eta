import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FAKE_PI_JS, fakeKernelPackage, parseSse, startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * 服务端持有的会话运行（契约 §6.9）：客户端断开不影响运行、逐步落库、重新接上回放、显式取消、409、服务关闭标记 interrupted。
 * 真实 HTTP 服务 + tools/dev/mock-openai.js（delayMs 让回复足够慢）。
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
  const res = await fetch(`${mockBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const LONG = '这是一封写给北欧客户的长开发信，介绍我们的木屋产品与交期。'

async function newSession(agentIds = ['builtin']): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds } })
  expect(res.status, res.text).toBe(201)
  return res.json.session.id
}

/** 发起对话，收到 untilEvent 事件后主动断开连接（模拟关窗 / 刷新），返回断开前收到的原始 SSE 文本 */
function chatThenDisconnect(body: unknown, untilEvent = 'delta', path = '/api/chat'): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path,
        headers: {
          Host: `127.0.0.1:${server.port}`,
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
          if (text.includes(`event: ${untilEvent}\n`)) {
            req.destroy()
            resolve(text)
          }
        })
        res.on('end', () => resolve(text))
      },
    )
    req.on('error', (error) => ((error as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(error)))
    req.write(payload)
    req.end()
  })
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  throw new Error('waitFor timeout')
}

async function sessionDetail(id: string) {
  return (await server.request('GET', `/api/sessions/${id}`)).json
}

async function waitIdle(id: string) {
  return waitFor(async () => {
    const detail = await sessionDetail(id)
    return detail.session.running ? null : detail
  })
}

/** SSE 原文里每个事件的 id（seq） */
function seqs(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' },
  })
  await server.request('PATCH', '/api/settings', { body: { autoTitle: false, llmMaxRetries: 0, toolApproval: 'auto' } })
  fakeKernelPackage(join(server.home, 'kernels'), 'pi', '@earendil-works/pi-coding-agent', 'pi', 'dist/bundle/cli.js', FAKE_PI_JS)
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
})

describe('客户端断开不中止运行', () => {
  it('发起请求的连接断开后运行继续完成，完整回复落库；运行中可在会话列表/详情看到 running 与草稿', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 3, delayMs: 120 })
    const partial = await chatThenDisconnect({ sessionId, content: '写开发信' })
    expect(partial).toContain('event: start')
    expect(seqs(partial)[0]).toBe(1)

    // 运行中：列表与详情带 running / activeRunId，草稿消息逐步落库
    const listed = (await server.request('GET', '/api/sessions')).json.sessions.find((s: any) => s.id === sessionId)
    expect(listed.running).toBe(true)
    expect(listed.activeRunId).toMatch(/^run_/)
    const draft = await waitFor(async () => {
      const detail = await sessionDetail(sessionId)
      const m = detail.messages.find((x: any) => x.role === 'assistant')
      return m && m.content.length > 0 ? { detail, m } : null
    })
    expect(draft.detail.session.running).toBe(true)
    expect(draft.detail.run).toMatchObject({ status: 'running', id: listed.activeRunId })
    expect(draft.m.finishReason).toBe('streaming')
    expect(LONG.startsWith(draft.m.content)).toBe(true)

    const done = await waitIdle(sessionId)
    expect(done.session).toMatchObject({ running: false, activeRunId: null })
    expect(done.run).toMatchObject({ status: 'completed' })
    const assistants = done.messages.filter((x: any) => x.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ id: draft.m.id, content: LONG, finishReason: 'stop' })
    expect(done.messages.filter((x: any) => x.role === 'user').map((x: any) => x.content)).toEqual(['写开发信'])
  })

  it('群聊主管运行（规划 → 成员 → 汇总）同样在断开后跑完', async () => {
    const res = await server.request('POST', '/api/sessions', { body: { kind: 'group', agentIds: ['builtin', 'kernel-pi'] } })
    expect(res.status, res.text).toBe(201)
    const sessionId = res.json.session.id
    await script(
      { toolCalls: [{ name: 'dispatch_members', arguments: { members: ['kernel-pi'], instructions: 'Pi 润色' } }] },
      { text: '分工：请 Pi 润色。', chunkSize: 2, delayMs: 60 },
      { text: 'Pi：润色好了。', chunkSize: 2, delayMs: 60 },
      { text: '汇总：可以直接发送。', chunkSize: 2, delayMs: 60 },
    )
    await chatThenDisconnect({ sessionId, content: '帮我写开发信' }, 'agent')
    const done = await waitIdle(sessionId)
    const assistants = done.messages.filter((x: any) => x.role === 'assistant')
    expect(assistants.map((m: any) => [m.senderAgentId, m.supervisorRole ?? null, m.content])).toEqual([
      ['builtin', 'plan', '分工：请 Pi 润色。'],
      ['kernel-pi', null, 'Pi：润色好了。'],
      ['builtin', 'summary', '汇总：可以直接发送。'],
    ])
    expect(assistants.every((m: any) => m.finishReason === 'stop')).toBe(true)
  })
})

describe('重新接上（GET /api/sessions/:id/stream）', () => {
  it('after=0 回放全部缓存事件再推实时直到结束；after=N 只回放之后的；seq 连续递增', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 3, delayMs: 100 })
    const first = await chatThenDisconnect({ sessionId, content: '写' }, 'delta')
    const seenSeq = Math.max(...seqs(first))

    const full = await server.request('GET', `/api/sessions/${sessionId}/stream?after=0`)
    expect(full.status).toBe(200)
    expect(full.headers['content-type']).toContain('text/event-stream')
    const events = parseSse(full.text)
    expect(events[0].event).toBe('start')
    expect(events.at(-1)!.event).toBe('done')
    const ids = seqs(full.text)
    expect(ids).toEqual(ids.map((_, i) => i + 1))
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
    expect(text).toBe(LONG)

    // 运行刚结束：缓存仍保留，after=N 只拿尾部
    const tail = await server.request('GET', `/api/sessions/${sessionId}/stream?after=${seenSeq}`)
    const tailIds = seqs(tail.text)
    expect(tailIds[0]).toBe(seenSeq + 1)
    expect(tailIds.at(-1)).toBe(ids.at(-1))
    // Last-Event-ID 头与 after 等价
    const byHeader = await server.request('GET', `/api/sessions/${sessionId}/stream`, { headers: { 'Last-Event-ID': String(seenSeq) } })
    expect(seqs(byHeader.text)).toEqual(tailIds)
  })

  it('运行中接上的流与原始流收到相同的实时事件；没有运行过的会话返回空流', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 4, delayMs: 80 })
    const original = server.request('POST', '/api/chat', { body: { sessionId, content: '写' } })
    await waitFor(async () => (await sessionDetail(sessionId)).session.running)
    const attached = await server.request('GET', `/api/sessions/${sessionId}/stream`)
    const a = parseSse((await original).text)
    const b = parseSse(attached.text)
    // 重新接上的流在回放结束处多一个 replayed（不带 id）
    const replayedAt = b.findIndex((e) => e.event === 'replayed')
    expect(replayedAt).toBeGreaterThan(0)
    expect(b[replayedAt].data.lastSeq).toBe(replayedAt)
    expect(b.filter((e) => e.event !== 'replayed')).toEqual(a)

    const idle = await newSession()
    const empty = await server.request('GET', `/api/sessions/${idle}/stream`)
    expect(empty.status).toBe(200)
    expect(empty.text).toBe('')
    expect((await server.request('GET', `/api/sessions/nope/stream`)).status).toBe(404)
  })
})

describe('取消与并发', () => {
  it('同一会话已有运行：再次发送 / 重新生成 409 RUN_ACTIVE，且不写入新用户消息', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 3, delayMs: 100 })
    const original = server.request('POST', '/api/chat', { body: { sessionId, content: '第一条' } })
    await waitFor(async () => (await sessionDetail(sessionId)).session.running)
    const again = await server.request('POST', '/api/chat', { body: { sessionId, content: '第二条' } })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('RUN_ACTIVE')
    const regen = await server.request('POST', '/api/chat/regenerate', { body: { sessionId } })
    expect(regen.status).toBe(409)
    await original
    const done = await waitIdle(sessionId)
    expect(done.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual(['第一条'])
  })

  it('POST /api/sessions/:id/cancel：断开后的运行也能取消，已输出部分按 aborted 保留；再取消返回 stopped:false', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 2, delayMs: 200 })
    await chatThenDisconnect({ sessionId, content: '写' })
    const attached = server.request('GET', `/api/sessions/${sessionId}/stream`)
    await sleep(500)
    const runId = (await sessionDetail(sessionId)).session.activeRunId
    const cancel = await server.request('POST', `/api/sessions/${sessionId}/cancel`)
    expect(cancel.json).toEqual({ stopped: true, runId })
    const events = parseSse((await attached).text)
    expect(events.slice(-2).map((e) => e.event)).toEqual(['done', 'stopped'])
    expect(events.at(-2)!.data).toMatchObject({ aborted: true, message: { finishReason: 'aborted' } })
    const done = await waitIdle(sessionId)
    expect(done.run).toMatchObject({ id: runId, status: 'cancelled' })
    const m = done.messages.find((x: any) => x.role === 'assistant')
    expect(m.finishReason).toBe('aborted')
    expect(m.content.length).toBeGreaterThan(0)
    expect((await server.request('POST', `/api/sessions/${sessionId}/cancel`)).json).toEqual({ stopped: false, runId: null })
    expect((await server.request('POST', `/api/sessions/nope/cancel`)).status).toBe(404)
  })

  it('GET /api/chat/runs 列出进行中的运行；删除运行中的会话会先停止运行', async () => {
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 2, delayMs: 200 })
    void chatThenDisconnect({ sessionId, content: '写' })
    await waitFor(async () => (await sessionDetail(sessionId)).session.running)
    const runs = (await server.request('GET', '/api/chat/runs')).json.runs
    expect(runs.map((r: any) => r.sessionId)).toContain(sessionId)
    expect((await server.request('DELETE', `/api/sessions/${sessionId}`)).status).toBe(204)
    expect((await server.request('GET', '/api/chat/runs')).json.runs.map((r: any) => r.sessionId)).not.toContain(sessionId)
  })
})

describe('服务关闭与崩溃恢复', () => {
  it('shutdownRuns 中止运行，已输出部分标记 interrupted；启动恢复把残留草稿改为 interrupted', async () => {
    const { shutdownRuns, recoverInterruptedMessages } = await import('../src/services/chat/run-registry.js')
    const sessionId = await newSession()
    await script({ text: LONG, chunkSize: 2, delayMs: 200 })
    void chatThenDisconnect({ sessionId, content: '写' })
    await waitFor(async () => {
      const m = (await sessionDetail(sessionId)).messages.find((x: any) => x.role === 'assistant')
      return m?.content.length > 2
    })
    expect(await shutdownRuns(3000)).toBe(1)
    const done = await waitIdle(sessionId)
    expect(done.run.status).toBe('interrupted')
    const m = done.messages.find((x: any) => x.role === 'assistant')
    expect(m.finishReason).toBe('interrupted')
    expect(m.content.length).toBeGreaterThan(0)

    // 模拟进程被强杀：库里留下 streaming 草稿，下次启动恢复
    const { db } = await import('../src/db.js')
    db.prepare("UPDATE messages SET finish_reason = 'streaming' WHERE id = ?").run(m.id)
    expect(recoverInterruptedMessages()).toBe(1)
    expect((await sessionDetail(sessionId)).messages.find((x: any) => x.id === m.id).finishReason).toBe('interrupted')
  })

  it('草稿不进模型上下文：下一轮请求里没有 streaming 草稿', async () => {
    const sessionId = await newSession()
    const { db } = await import('../src/db.js')
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, finish_reason, created_at) VALUES ('msg_draft_x', ?, 'assistant', 'DRAFT-SHOULD-NOT-APPEAR', 'streaming', ?)",
    ).run(sessionId, Date.now())
    await script({ text: 'ok' })
    const res = await server.request('POST', '/api/chat', { body: { sessionId, content: '你好' } })
    expect(res.status).toBe(200)
    const requests = await (await fetch(`${mockBase}/__mock/requests`)).json()
    expect(JSON.stringify(requests.at(-1))).not.toContain('DRAFT-SHOULD-NOT-APPEAR')
  })
})

describe('无人接上时的工具审批（契约 §6.9）', () => {
  async function waitPending(sessionId: string): Promise<any> {
    return waitFor(async () => (await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests[0] ?? null)
  }

  it('客户端断开后审批不自动拒绝（默认等 30 分钟）；重新接上时回放出审批卡片，批准后运行继续完成', async () => {
    await server.request('PATCH', '/api/settings', { body: { toolApproval: 'ask' } })
    try {
      const customer = (await server.request('POST', '/api/customers', { body: { company: 'Detached Approval Co' } })).json
      const sessionId = await newSession()
      await script(
        { toolCalls: [{ id: 'u1', name: 'update_customer', arguments: { customerId: customer.id, stage: 'won' } }] },
        { text: '已改成赢单。' },
      )
      // 收到审批请求后断开（模拟关窗）：此时没有任何客户端接上
      const partial = await chatThenDisconnect({ sessionId, content: '改成赢单' }, 'tool_request')
      expect(partial).toContain('event: tool_request')
      const req = await waitPending(sessionId)
      expect(req).toMatchObject({ name: 'update_customer', risk: 'write' })
      expect(req.expiresAt - req.createdAt).toBe(30 * 60_000)

      // 过一段时间仍在等待，运行仍在进行
      await sleep(1500)
      expect((await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json).toMatchObject({
        running: true,
        requests: [{ requestId: req.requestId }],
      })
      expect((await sessionDetail(sessionId)).session.running).toBe(true)

      // 重新接上：回放里有同一个 tool_request（客户端据此显示可操作的审批卡片）
      const attached = server.request('GET', `/api/sessions/${sessionId}/stream?after=0`)
      await sleep(300)
      const decision = await server.request('POST', '/api/chat/tool-decision', { body: { requestId: req.requestId, approved: true } })
      expect(decision.status, decision.text).toBe(200)
      const events = parseSse((await attached).text)
      const replayedAt = events.findIndex((e) => e.event === 'replayed')
      const replayedRequest = events.slice(0, replayedAt).find((e) => e.event === 'tool_request')
      expect(replayedRequest?.data).toMatchObject({ requestId: req.requestId, name: 'update_customer' })
      expect(events.some((e) => e.event === 'tool_result' && e.data.requestId === req.requestId)).toBe(true)
      expect(events.at(-1)!.event).toBe('done')

      const done = await waitIdle(sessionId)
      expect(done.run.status).toBe('completed')
      expect(done.messages.filter((m: any) => m.role === 'assistant').at(-1).content).toBe('已改成赢单。')
      const updated = (await server.request('GET', `/api/customers/${customer.id}`)).json
      expect(updated.stage ?? updated.customer?.stage).toBe('won')
    } finally {
      await server.request('PATCH', '/api/settings', { body: { toolApproval: 'auto' } })
    }
  }, 30_000)

  it('LULUX_APPROVAL_TIMEOUT_MS 可调：超时仍无人决定才按拒绝处理，运行照常结束', async () => {
    const { approvalTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS } = await import('../src/services/tool-approval.js')
    expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS)
    process.env.LULUX_APPROVAL_TIMEOUT_MS = 'abc'
    expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS)
    process.env.LULUX_APPROVAL_TIMEOUT_MS = '1200'
    await server.request('PATCH', '/api/settings', { body: { toolApproval: 'ask' } })
    try {
      expect(approvalTimeoutMs()).toBe(1200)
      const customer = (await server.request('POST', '/api/customers', { body: { company: 'Timeout Co' } })).json
      const sessionId = await newSession()
      await script({ toolCalls: [{ id: 'u2', name: 'update_customer', arguments: { customerId: customer.id, stage: 'won' } }] }, { text: '没有获得批准。' })
      await chatThenDisconnect({ sessionId, content: '改成赢单' }, 'tool_request')
      const req = await waitPending(sessionId)
      expect(req.expiresAt - req.createdAt).toBe(1200)
      const done = await waitIdle(sessionId)
      expect(done.run.status).toBe('completed')
      const trace = done.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.toolTrace ?? [])
      expect(trace.find((t: any) => t.name === 'update_customer')?.approved).toBe(false)
      const unchanged = (await server.request('GET', `/api/customers/${customer.id}`)).json
      expect(unchanged.stage ?? unchanged.customer?.stage).not.toBe('won')
    } finally {
      delete process.env.LULUX_APPROVAL_TIMEOUT_MS
      await server.request('PATCH', '/api/settings', { body: { toolApproval: 'auto' } })
    }
  }, 30_000)
})
