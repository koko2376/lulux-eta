import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_HERMES_JS, FAKE_PI_JS, fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 群聊主管：规划（dispatch_members / CLI 的 JSON 代码块）→ 成员按分工回答 → 主管汇总；
 * 用户 @ 覆盖派发；主管自己回答时不汇总；发言上限；停止；不可用成员跳过；无主管保持旧行为。
 * 真实 HTTP 服务 + tools/dev/mock-openai.js；Pi / Hermes 是经 LULUX 网关请求同一个 mock 的替身内核。
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
    method: body === undefined && path === '/__mock/requests' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? (path === '/__mock/requests' ? undefined : '{}') : JSON.stringify(body),
  })
  return res.json()
}
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function newSession(agentIds: string[], supervisorId?: string): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds, ...(supervisorId ? { supervisorId } : {}) } })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json.session.id
}

async function chat(sessionId: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await server.request('POST', '/api/chat', { body: { sessionId, content, ...extra } })
  expect(res.status, res.text).toBe(200)
  return parseSse(res.text)
}

const speakers = (events: Array<{ event: string; data: any }>) =>
  events.filter((e) => e.event === 'agent').map((e) => `${e.data.agentId}:${e.data.role}`)
const dones = (events: Array<{ event: string; data: any }>) => events.filter((e) => e.event === 'done').map((e) => e.data.message)
const dispatch = (members: string[], instructions = '') => ({ toolCalls: [{ name: 'dispatch_members', arguments: { members, instructions } }] })

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' },
  })
  await server.request('PATCH', '/api/settings', { body: { autoTitle: false, llmMaxRetries: 1, toolApproval: 'auto' } })
  const kernels = join(server.home, 'kernels')
  fakeKernelPackage(kernels, 'pi', '@earendil-works/pi-coding-agent', 'pi', 'dist/bundle/cli.js', FAKE_PI_JS)
  fakeKernelPackage(kernels, 'hermes', 'hermes-agent', 'hermes', 'bin/hermes.js', FAKE_HERMES_JS)
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
})

describe('群聊主管', () => {
  it('会话默认主管为 LULUX；只能选 builtin / none / 本群成员', async () => {
    const id = await newSession(['builtin', 'kernel-pi'])
    expect((await server.request('GET', `/api/sessions/${id}`)).json.session.supervisorId).toBe('builtin')
    let res = await server.request('PATCH', `/api/sessions/${id}`, { body: { supervisorId: 'kernel-pi' } })
    expect(res.json.session.supervisorId).toBe('kernel-pi')
    // 主管被移出群：恢复默认
    res = await server.request('PATCH', `/api/sessions/${id}`, { body: { agentIds: ['builtin', 'kernel-hermes'] } })
    expect(res.json.session.supervisorId).toBe('builtin')
    await server.request('PATCH', `/api/sessions/${id}`, { body: { agentIds: ['builtin', 'kernel-pi'] } })
    res = await server.request('PATCH', `/api/sessions/${id}`, { body: { supervisorId: 'kernel-codex' } })
    expect(res.status).toBe(400)
    res = await server.request('PATCH', `/api/sessions/${id}`, { body: { supervisorId: 'none' } })
    expect(res.json.session.supervisorId).toBe('none')
    res = await server.request('PATCH', `/api/sessions/${id}`, { body: { supervisorId: null } })
    expect(res.json.session.supervisorId).toBe('builtin')
    expect((await server.request('GET', '/api/sessions')).json.sessions.find((s: any) => s.id === id).supervisorId).toBe('builtin')
  })

  it('主管派发：规划（dispatch_members）→ 成员带着分工回答 → 主管汇总', async () => {
    const id = await newSession(['builtin', 'kernel-pi'])
    await script(
      dispatch(['kernel-pi', 'builtin', 'nobody'], 'Pi 负责润色开发信'),
      { text: '分工：请 Pi 润色。' },
      { text: 'Pi：润色好了。' },
      { text: '汇总：可以直接发送。' },
    )
    const events = await chat(id, '帮我写一封开发信')
    expect(events[0]!.data).toMatchObject({ speakMode: 'supervised', speakers: ['builtin'], supervisorId: 'builtin' })
    expect(speakers(events)).toEqual(['builtin:plan', 'kernel-pi:member', 'builtin:summary'])
    // 主管不能派发自己，未知 id 忽略
    expect(events.find((e) => e.event === 'dispatch')!.data).toEqual({ supervisorId: 'builtin', members: ['kernel-pi'], instructions: 'Pi 负责润色开发信' })
    const messages = dones(events)
    expect(messages.map((m) => [m.senderAgentId, m.supervisorRole ?? null, m.content])).toEqual([
      ['builtin', 'plan', '分工：请 Pi 润色。'],
      ['kernel-pi', null, 'Pi：润色好了。'],
      ['builtin', 'summary', '汇总：可以直接发送。'],
    ])
    expect(messages[0].toolTrace[0]).toMatchObject({ name: 'dispatch_members', ok: true })

    const reqs = await mockRequests()
    // 规划请求：系统提示含成员名单与擅长，提供 dispatch_members（成员 enum 不含主管自己）
    const planSystem = reqs[0].messages[0].content as string
    expect(planSystem).toContain('你是本群聊的主管「LULUX」')
    expect(planSystem).toContain('id: kernel-pi ｜ 名字：Pi')
    const tool = reqs[0].tools.find((t: any) => t.function.name === 'dispatch_members')
    expect(tool.function.parameters.properties.members.items.enum).toEqual(['kernel-pi'])
    // 成员（CLI 内核经网关）的提示词带着主管的分工
    expect(reqs[2].messages.at(-1).content).toContain('主管「LULUX」的分工说明')
    expect(reqs[2].messages.at(-1).content).toContain('Pi 负责润色开发信')
    // 汇总请求：汇总说明 + 看得到成员的回答
    expect(reqs[3].messages[0].content).toContain('请给出最终汇总')
    expect(JSON.stringify(reqs[3].messages)).toContain('Pi：润色好了。')
    expect(reqs[3].tools?.some((t: any) => t.function.name === 'dispatch_members') ?? false).toBe(false)

    const stored = (await server.request('GET', `/api/sessions/${id}`)).json.messages
    expect(stored.map((m: any) => m.supervisorRole ?? null)).toEqual([null, 'plan', null, 'summary'])
  })

  it('主管认为不需要成员：自己回答，没有汇总', async () => {
    const id = await newSession(['builtin', 'kernel-pi'])
    await script({ text: 'FOB 是装运港船上交货。' })
    const events = await chat(id, 'FOB 是什么意思？')
    expect(speakers(events)).toEqual(['builtin:plan'])
    expect(events.some((e) => e.event === 'dispatch')).toBe(false)
    expect(dones(events)[0]).toMatchObject({ content: 'FOB 是装运港船上交货。', supervisorRole: 'plan' })
  })

  it('用户 @ 覆盖派发：不规划；≥2 位成员发言后主管汇总，只 @ 一位不汇总', async () => {
    const id = await newSession(['builtin', 'kernel-pi', 'kernel-hermes'])
    await script({ text: 'Pi 的看法' }, { text: 'Hermes 的看法' }, { text: '综合两位的意见……' })
    let events = await chat(id, '@Pi @Hermes Agent 你们怎么看？')
    expect(events[0]!.data).toMatchObject({ speakMode: 'mentioned', speakers: ['kernel-pi', 'kernel-hermes'] })
    expect(speakers(events)).toEqual(['kernel-pi:member', 'kernel-hermes:member', 'builtin:summary'])

    await script({ text: '只有 Pi' })
    events = await chat(id, '@Pi 说一句')
    expect(speakers(events)).toEqual(['kernel-pi:member'])

    // targetAgentIds 同样覆盖派发
    await script({ text: 'H' })
    events = await chat(id, '你好', { targetAgentIds: ['kernel-hermes'] })
    expect(speakers(events)).toEqual(['kernel-hermes:member'])
  })

  it('CLI 主管：解析 JSON 代码块派发（不留在正文里）；成员 @ 已发言者不会循环；总发言 ≤ 成员数 + 3', async () => {
    const id = await newSession(['builtin', 'kernel-pi', 'kernel-hermes'], 'kernel-pi')
    await script(
      { text: '我来分工。\n```json\n{"members": ["kernel-pi", "LULUX", "kernel-hermes", "x"], "instructions": "内置查价格，Hermes 写文案"}\n```' },
      { text: '价格 12.5，@Pi 你看看 @Hermes Agent' },
      { text: '文案好了，@LULUX @Pi' },
      { text: 'Pi 汇总' },
    )
    const events = await chat(id, '报价并写文案')
    expect(events[0]!.data).toMatchObject({ speakMode: 'supervised', supervisorId: 'kernel-pi' })
    expect(speakers(events)).toEqual(['kernel-pi:plan', 'builtin:member', 'kernel-hermes:member', 'kernel-pi:summary'])
    expect(events.find((e) => e.event === 'dispatch')!.data.members).toEqual(['builtin', 'kernel-hermes'])
    const plan = dones(events)[0]
    expect(plan.content).toBe('我来分工。')
    expect(plan.supervisorRole).toBe('plan')
    // 成员拿到分工（内置成员在系统提示里）
    const reqs = await mockRequests()
    expect(reqs[0].messages.at(-1).content).toContain('```json') // CLI 规划提示要求 JSON 代码块
    expect(reqs[1].messages[0].content).toContain('主管「Pi」的分工说明')
    expect(speakers(events).length).toBeLessThanOrEqual(3 + 3)
  })

  it('CLI 主管也可以用 @成员 派发', async () => {
    const id = await newSession(['builtin', 'kernel-pi', 'kernel-hermes'], 'kernel-hermes')
    await script({ text: '这个问题请 @Pi 回答。' }, { text: 'Pi 回答' }, { text: 'Hermes 汇总' })
    const events = await chat(id, '帮忙看看')
    expect(speakers(events)).toEqual(['kernel-hermes:plan', 'kernel-pi:member', 'kernel-hermes:summary'])
  })

  it('默认主管 LULUX 不在群里时也能规划与汇总', async () => {
    const id = await newSession(['kernel-pi', 'kernel-hermes'])
    await script(dispatch(['kernel-hermes'], 'Hermes 回答'), { text: '交给 Hermes。' }, { text: 'Hermes 回答' }, { text: '内置汇总' })
    const events = await chat(id, '问个问题')
    expect(speakers(events)).toEqual(['builtin:plan', 'kernel-hermes:member', 'builtin:summary'])
    const stored = (await server.request('GET', `/api/sessions/${id}`)).json.messages
    expect(stored.at(-1)).toMatchObject({ senderAgentId: 'builtin', supervisorRole: 'summary' })
  })

  it('停止：规划阶段停止后不再派发、不汇总', async () => {
    const id = await newSession(['builtin', 'kernel-pi'])
    await script({ text: '我正在想要派发给谁……', chunkSize: 2, delayMs: 200 }, { text: '不应出现' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId: id, content: '慢慢想' } })
    for (let i = 0; i < 100; i += 1) {
      await sleep(30)
      if ((await server.request('GET', `/api/chat/pending?sessionId=${id}`)).json.running) break
    }
    await sleep(600)
    expect((await server.request('POST', '/api/chat/stop', { body: { sessionId: id } })).json).toEqual({ stopped: true })
    const events = parseSse((await pending).text)
    expect(speakers(events)).toEqual(['builtin:plan'])
    expect(events.map((e) => e.event).slice(-2)).toEqual(['done', 'stopped'])
    expect(dones(events)[0]).toMatchObject({ finishReason: 'aborted', supervisorRole: 'plan' })
    expect((await mockRequests()).length).toBe(1)
  })

  it('停止：成员发言时停止，不再汇总', async () => {
    const id = await newSession(['builtin', 'kernel-pi'])
    await script(dispatch(['kernel-pi']), { text: '交给 Pi。' }, { text: 'Pi 在慢慢回答……'.repeat(5), chunkSize: 2, delayMs: 150 }, { text: '不应出现的汇总' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId: id, content: '慢慢答' } })
    for (let i = 0; i < 200; i += 1) {
      await sleep(50)
      if ((await mockRequests()).length >= 3) break
    }
    await sleep(800)
    expect((await server.request('POST', '/api/chat/stop', { body: { sessionId: id } })).json).toEqual({ stopped: true })
    const events = parseSse((await pending).text)
    expect(speakers(events)).toEqual(['builtin:plan', 'kernel-pi:member'])
    expect(events.at(-1)!.event).toBe('stopped')
    expect((await mockRequests()).length).toBe(3)
  })

  it('不可用成员跳过并提示（不再整个拒绝）；全部不可用才 409', async () => {
    // Codex 未安装
    const id = await newSession(['builtin', 'kernel-codex'])
    await script({ text: '内置回答' })
    const events = await chat(id, '大家好')
    expect(events.find((e) => e.event === 'notice')!.data).toMatchObject({ kind: 'unavailable', agentId: 'kernel-codex', name: 'Codex', reason: '未安装' })
    // 唯一可派发的成员不可用：主管（内置成员）直接按普通成员回答，不规划
    expect(speakers(events)).toEqual(['builtin:member'])

    // 用户 @ 了不可用成员：忽略它，可用成员照常
    const group = await newSession(['builtin', 'kernel-pi', 'kernel-codex'])
    await script(dispatch(['kernel-codex', 'kernel-pi']), { text: '交给 Pi。' }, { text: 'Pi 回答' }, { text: '汇总' })
    const second = await chat(group, '请回答')
    expect(second.filter((e) => e.event === 'notice').map((e) => e.data.agentId)).toEqual(['kernel-codex'])
    expect(speakers(second)).toEqual(['builtin:plan', 'kernel-pi:member', 'builtin:summary'])
    const reqs = await mockRequests()
    expect(reqs.at(-4).tools.find((t: any) => t.function.name === 'dispatch_members').function.parameters.properties.members.items.enum).toEqual(['kernel-pi'])

    const dead = await newSession(['kernel-codex', 'kernel-gemini-cli'])
    const res = await server.request('POST', '/api/chat', { body: { sessionId: dead, content: 'hi' } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('KERNEL_UNAVAILABLE')
  })

  it('选中的主管不可用：退回 LULUX 并提示', async () => {
    const id = await newSession(['builtin', 'kernel-pi', 'kernel-codex'])
    // 直接写库模拟“选了 Codex 当主管，后来 Codex 被卸载”
    const { sessionService } = await import('../src/services/session-service.js')
    sessionService.setSupervisor(id, 'kernel-codex')
    await script({ text: '内置直接回答' })
    const events = await chat(id, '你好')
    expect(events.filter((e) => e.event === 'notice').map((e) => e.data.kind)).toEqual(['unavailable', 'supervisor_unavailable'])
    expect(events[0]!.data.supervisorId).toBe('builtin')
    expect(speakers(events)).toEqual(['builtin:plan'])
  })

  it('无主管：保持旧行为（全体按顺序，没有规划与汇总）', async () => {
    const id = await newSession(['builtin', 'kernel-pi'], 'none')
    await script({ text: 'A' }, { text: 'B' })
    const events = await chat(id, '都说说')
    expect(events[0]!.data).toMatchObject({ speakMode: 'all', supervisorId: null })
    expect(speakers(events)).toEqual(['builtin:member', 'kernel-pi:member'])
    expect(dones(events).every((m) => m.supervisorRole === undefined)).toBe(true)
  })

  it('派发 + 成员互相 @：发言总数不超过成员数 + 3，不会死循环', async () => {
    const id = await newSession(['builtin', 'kernel-pi', 'kernel-hermes'])
    await script(
      dispatch(['kernel-pi', 'kernel-hermes']),
      { text: '两位请回答。' },
      { text: '@Hermes Agent @LULUX 继续' },
      { text: '@Pi @LULUX 继续' },
      { text: '汇总' },
      { text: '多余' },
      { text: '多余' },
    )
    const events = await chat(id, '讨论一下')
    expect(speakers(events)).toEqual(['builtin:plan', 'kernel-pi:member', 'kernel-hermes:member', 'builtin:summary'])
    expect(speakers(events).length).toBeLessThanOrEqual(3 + 3)
  })
})

describe('supervisor 解析（单元）', () => {
  it('parseDispatchText：JSON 代码块优先，名字 / id / @ 都认，去重；没有代码块时用 @', async () => {
    const { parseDispatchText, normalizeDispatch } = await import('../src/services/chat/supervisor.js')
    const { agentService } = await import('../src/services/agent-service.js')
    const candidates = ['builtin', 'kernel-pi', 'kernel-hermes'].map((id) => agentService.find(id)!)
    expect(parseDispatchText('好\n```json\n{"members":["@Pi","kernel-pi","LULUX"],"instructions":"x"}\n```\n', candidates)).toEqual({
      members: ['kernel-pi', 'builtin'],
      instructions: 'x',
      cleaned: '好',
    })
    expect(parseDispatchText('请 @Hermes Agent 回答', candidates).members).toEqual(['kernel-hermes'])
    expect(parseDispatchText('```json\n{"not":"dispatch"}\n```', candidates).members).toEqual([])
    expect(parseDispatchText('```json\n{bad json, "members"}\n```', candidates).members).toEqual([])
    expect(normalizeDispatch({ members: 'kernel-pi' }, candidates)).toEqual({ members: [], instructions: '' })
  })
})
