import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * server（云端）模式下会话运行的权限（契约 §6.9 × §6.10）：看不到会话的人既不能接上流也不能取消、也看不到运行；
 * 能看不能改（viewer）的群成员可以接上流看进度，但不能取消。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''

type Who = { token: string; id: string }
let owner: Who
let alice: Who
let bob: Who
let victor: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) =>
  server.request(method, path, { body, token: who ? who.token : null })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

async function invite(role: string, email: string, teamId?: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role, ...(teamId ? { teamId } : {}) })
  expect(created.status, created.text).toBe(201)
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  expect(ok.status, ok.text).toBe(201)
  owner = { token: ok.json.token, id: ok.json.user.id }
  const team = await as(owner, 'POST', '/api/team/teams', { name: '一组' })
  alice = await invite('member', 'alice@acme.com', team.json.id)
  victor = await invite('viewer', 'victor@acme.com', team.json.id)
  bob = await invite('member', 'bob@acme.com')
  const provider = await as(owner, 'POST', '/api/providers', {
    name: 'Mock',
    kind: 'openai',
    baseUrl: `${mockBase}/v1`,
    apiKey: 'sk-mock-key-123456',
    model: 'mock-model',
  })
  expect(provider.status, provider.text).toBe(201)
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

/** 打开一条 SSE（GET），持续收集事件直到 close() */
function openSse(who: Who, path: string) {
  const events: Array<{ event: string; data: any }> = []
  let buffer = ''
  let resolveStatus: (n: number) => void = () => undefined
  const status = new Promise<number>((r) => (resolveStatus = r))
  const req: ClientRequest = httpRequest(
    {
      host: '127.0.0.1',
      port: server.port,
      method: 'GET',
      path,
      headers: { Host: `127.0.0.1:${server.port}`, Authorization: `Bearer ${who.token}`, Accept: 'text/event-stream' },
    },
    (res) => {
      resolveStatus(res.statusCode ?? 0)
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          events.push(...parseSse(buffer.slice(0, index + 2)))
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf('\n\n')
        }
      })
    },
  )
  req.on('error', () => undefined)
  req.end()
  return {
    status,
    events,
    async waitFor(pred: (e: { event: string; data: any }) => boolean, ms = 8000) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        const hit = events.find(pred)
        if (hit) return hit
        await sleep(20)
      }
      throw new Error(`SSE 事件未到达：${path} · 已收到 ${events.map((e) => e.event).join(',')}`)
    },
    close: () => req.destroy(),
  }
}

const script = (responses: unknown[]) =>
  fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })

async function waitRunning(who: Who, sessionId: string, running: boolean) {
  for (let i = 0; i < 200; i += 1) {
    if ((await as(who, 'GET', `/api/sessions/${sessionId}`)).json.session?.running === running) return
    await sleep(30)
  }
  throw new Error(`running 未变为 ${running}`)
}

/**
 * 会话可见性 = 负责人 + 群聊真人成员（契约 §5.6a / §6.10）。运行（§6.9）沿用这套可见性：
 * 群成员能接上 / 查看 / 取消；viewer 能接上不能取消；非成员（包括组织 owner）一律 404。
 */
describe('云端模式：会话运行的可见性与取消权限（群成员）', () => {
  it('私有单聊：别人（包括组织 owner）看不到运行、接不上、取消不了', async () => {
    const created = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(created.status, created.text).toBe(201)
    const sessionId = created.json.session.id
    await script([{ text: '很长很长的一段回复，用来测试权限。', chunkSize: 2, delayMs: 120 }])
    const original = as(alice, 'POST', '/api/chat', { sessionId, content: '写' })
    await waitRunning(alice, sessionId, true)
    for (const who of [bob, victor, owner]) {
      expect((await as(who, 'GET', `/api/sessions/${sessionId}/stream`)).status).toBe(404)
      expect((await as(who, 'GET', `/api/sessions/${sessionId}/run`)).status).toBe(404)
      // viewer 的写请求先被角色策略挡下（403，与会话无关，不泄露会话是否存在）
      const writeStatus = who === victor ? 403 : 404
      expect((await as(who, 'POST', `/api/sessions/${sessionId}/cancel`)).status).toBe(writeStatus)
      expect((await as(who, 'POST', '/api/chat/stop', { sessionId })).status).toBe(writeStatus)
      expect((await as(who, 'GET', '/api/chat/runs')).json.runs).toEqual([])
    }
    expect((await as(null, 'GET', `/api/sessions/${sessionId}/stream`)).status).toBe(401)
    expect((await as(alice, 'POST', `/api/sessions/${sessionId}/cancel`)).json.stopped).toBe(true)
    expect(parseSse((await original).text).at(-1)!.event).toBe('stopped')
  })

  it('多人群聊：成员 bob 能接上 / 查看 / 取消；viewer victor 能接上不能取消；非成员 owner 404', async () => {
    const created = await as(alice, 'POST', '/api/sessions', {
      kind: 'group',
      agentIds: ['builtin'],
      supervisorId: 'none',
      userIds: [bob.id, victor.id],
    })
    expect(created.status, created.text).toBe(201)
    const sessionId = created.json.session.id
    await script([{ text: '群里的一段很长的回复，成员都能看到进度。', chunkSize: 2, delayMs: 150 }])
    const original = as(alice, 'POST', '/api/chat', { sessionId, content: '写' })
    await waitRunning(bob, sessionId, true)

    // owner（组织 owner，但不是群成员）：完全看不到
    expect((await as(owner, 'GET', `/api/sessions/${sessionId}/stream`)).status).toBe(404)
    expect((await as(owner, 'POST', `/api/sessions/${sessionId}/cancel`)).status).toBe(404)
    expect((await as(owner, 'GET', '/api/chat/runs')).json.runs.map((r: any) => r.sessionId)).not.toContain(sessionId)

    // victor（viewer 群成员）：看得到运行、能接上，取消 403
    expect((await as(victor, 'GET', '/api/sessions')).json.sessions.find((s: any) => s.id === sessionId)?.running).toBe(true)
    expect((await as(victor, 'GET', `/api/sessions/${sessionId}/run`)).json.running).toBe(true)
    expect((await as(victor, 'GET', '/api/chat/runs')).json.runs.map((r: any) => r.sessionId)).toContain(sessionId)
    const watching = as(victor, 'GET', `/api/sessions/${sessionId}/stream`)
    expect((await as(victor, 'POST', `/api/sessions/${sessionId}/cancel`)).status).toBe(403)

    // bob（普通成员）：能接上，也能取消别人发起的运行
    const bobStream = as(bob, 'GET', `/api/sessions/${sessionId}/stream?after=0`)
    await sleep(300)
    expect((await as(bob, 'POST', `/api/sessions/${sessionId}/cancel`)).json.stopped).toBe(true)
    for (const text of [(await watching).text, (await bobStream).text, (await original).text]) {
      const seen = parseSse(text)
      expect(seen[0].event).toBe('start')
      expect(seen.at(-1)!.event).toBe('stopped')
    }
  })

  it('运行状态推送：群成员在会话事件流收到 run、在 /api/events 收到 session.run；非成员收不到；草稿不推 message，定稿推一次', async () => {
    const created = await as(alice, 'POST', '/api/sessions', { kind: 'group', agentIds: ['builtin'], supervisorId: 'none', userIds: [bob.id] })
    expect(created.status, created.text).toBe(201)
    const sessionId = created.json.session.id
    const bobLive = openSse(bob, `/api/sessions/${sessionId}/events`)
    expect(await bobLive.status).toBe(200)
    const ready = await bobLive.waitFor((e) => e.event === 'ready')
    expect(ready.data).toMatchObject({ sessionId, running: false, activeRunId: null })
    const bobGlobal = openSse(bob, '/api/events')
    const ownerGlobal = openSse(owner, '/api/events')
    const victorGlobal = openSse(victor, '/api/events')
    await Promise.all([bobGlobal.status, ownerGlobal.status, victorGlobal.status])
    await sleep(200)

    const reply = '这是一段会被逐步落库成草稿、最后定稿的回复。'
    await script([{ text: reply, chunkSize: 2, delayMs: 100 }])
    const sent = await as(alice, 'POST', '/api/chat', { sessionId, content: '你好' })
    expect(sent.status).toBe(200)
    const started = await bobLive.waitFor((e) => e.event === 'run' && e.data.running === true)
    expect(started.data.runId).toMatch(/^run_/)
    const ended = await bobLive.waitFor((e) => e.event === 'run' && e.data.running === false)
    expect(ended.data).toMatchObject({ runId: started.data.runId, status: 'completed' })
    await bobGlobal.waitFor((e) => e.event === 'session.run' && e.data.sessionId === sessionId && e.data.running === false)
    await sleep(300)

    // 助手消息只推一次（定稿），内容完整；运行中的草稿没有推
    const assistantEvents = bobLive.events.filter((e) => e.event === 'message' && e.data.message.role === 'assistant')
    expect(assistantEvents).toHaveLength(1)
    expect(assistantEvents[0].data.message).toMatchObject({ content: reply, finishReason: 'stop' })
    expect(bobLive.events.filter((e) => e.event === 'message' && e.data.message.role === 'user')).toHaveLength(1)

    // 非成员（组织 owner、同团队 viewer）收不到这个会话的运行状态
    for (const other of [ownerGlobal, victorGlobal]) {
      expect(other.events.some((e) => e.event === 'session.run' && e.data.sessionId === sessionId)).toBe(false)
    }
    for (const handle of [bobLive, bobGlobal, ownerGlobal, victorGlobal]) handle.close()
  })
})
