import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_HERMES_JS, FAKE_PI_JS, fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

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


/**
 * 群聊成员实例：同一内核多次进群（builtin、builtin#2…），名字是内核原名，群头衔贴在名字旁；
 * 每个实例独立发言、独立上下文、可被 @ 群头衔点名、可做主管；旧接口 agentIds 保持兼容。
 */
const createGroup = (body: Record<string, unknown>) => server.request('POST', '/api/sessions', { body: { kind: 'group', ...body } })
const patch = (id: string, body: Record<string, unknown>) => server.request('PATCH', `/api/sessions/${id}`, { body })

describe('群聊成员实例', () => {
  it('同一内核多次进群：自动分配实例 id，返回群头衔 / 职责；列表与详情一致', async () => {
    const res = await createGroup({
      groupName: '外贸小组',
      members: [
        { agentId: 'builtin', role: '跟单员', instructions: '跟进订单交期' },
        { agentId: 'builtin', role: '写信员' },
        { agentId: 'kernel-pi' },
        { agentId: 'kernel-nope', role: 'x' },
      ],
    })
    expect(res.status, res.text).toBe(201)
    const s = res.json.session
    expect(s).toMatchObject({ kind: 'group', agentIds: ['builtin', 'builtin#2', 'kernel-pi'], groupName: '外贸小组' })
    expect(s.memberProfiles).toEqual({
      builtin: { role: '跟单员', instructions: '跟进订单交期', model: null },
      'builtin#2': { role: '写信员', instructions: '', model: null },
    })
    const listed = (await server.request('GET', '/api/sessions')).json.sessions.find((x: any) => x.id === s.id)
    expect(listed.agentIds).toEqual(s.agentIds)
    expect(listed.memberProfiles).toEqual(s.memberProfiles)
    const got = (await server.request('GET', `/api/sessions/${s.id}`)).json.session
    expect(got.memberProfiles).toEqual(s.memberProfiles)
  })

  it('改成员：给出实例 id 的保持身份；新增同内核取下一个空号；头衔可改可清', async () => {
    const id = (await createGroup({ members: [{ agentId: 'builtin', role: '跟单员' }, { agentId: 'builtin', role: '写信员' }] })).json.session.id
    let res = await patch(id, {
      members: [{ agentId: 'builtin#2', role: '写信主管' }, { agentId: 'builtin' }, { agentId: 'builtin', role: '报价员' }],
    })
    expect(res.status, res.text).toBe(200)
    expect(res.json.session.agentIds).toEqual(['builtin#2', 'builtin', 'builtin#3'])
    expect(res.json.session.memberProfiles).toEqual({
      'builtin#2': { role: '写信主管', instructions: '', model: null },
      'builtin#3': { role: '报价员', instructions: '', model: null },
    })
    // 旧接口 agentIds：留下的成员保留资料
    res = await patch(id, { agentIds: ['builtin#3', 'builtin'] })
    expect(res.json.session.agentIds).toEqual(['builtin#3', 'builtin'])
    expect(res.json.session.memberProfiles).toEqual({ 'builtin#3': { role: '报价员', instructions: '', model: null } })
    // 实例可以做主管；被移出后恢复默认
    res = await patch(id, { supervisorId: 'builtin#3' })
    expect(res.status, res.text).toBe(200)
    expect(res.json.session.supervisorId).toBe('builtin#3')
    res = await patch(id, { members: [{ agentId: 'builtin' }] })
    expect(res.json.session.supervisorId).toBe('builtin')
    // agentIds 与 members 不能同时给；空成员拒绝且不做部分修改
    expect((await patch(id, { agentIds: ['builtin'], members: [{ agentId: 'builtin' }] })).status).toBe(400)
    res = await patch(id, { groupName: '不该生效', members: [{ agentId: 'kernel-nope' }] })
    expect(res.status).toBe(400)
    expect((await server.request('GET', `/api/sessions/${id}`)).json.session.groupName).not.toBe('不该生效')
  })

  it('校验：单聊不接受实例 id / 成员资料；头衔截断；成员上限', async () => {
    expect((await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin#2'] } })).status).toBe(400)
    expect((await server.request('POST', '/api/sessions', { body: { kind: 'single', members: [{ agentId: 'builtin' }] } })).status).toBe(400)
    const single = (await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })).json.session.id
    expect((await patch(single, { agentIds: ['builtin#2'] })).status).toBe(400)
    expect((await patch(single, { members: [{ agentId: 'builtin' }] })).status).toBe(400)
    const long = (await createGroup({ members: [{ agentId: 'builtin', role: '一二三四五六七八九十一二三四五六七八' }] })).json.session
    expect(long.memberProfiles.builtin.role).toBe('一二三四五六七八九十一二三四五六')
    const many = Array.from({ length: 13 }, () => ({ agentId: 'builtin' }))
    const res = await createGroup({ members: many })
    expect(res.status).toBe(400)
    expect(['GROUP_MEMBER_LIMIT', 'VALIDATION_ERROR']).toContain(res.json.error.code)
    expect(res.json.error.message).toContain('12')
  })

  it('发言：两个 LULUX 实例各自独立发言，系统提示带各自的群头衔与职责，彼此看到的是对方的发言', async () => {
    const id = (
      await createGroup({
        supervisorId: 'none',
        members: [
          { agentId: 'builtin', role: '跟单员', instructions: '只关心交期' },
          { agentId: 'builtin', role: '写信员' },
        ],
      })
    ).json.session.id
    await script({ text: '交期 25 天。' }, { text: '开发信已写好。' })
    const events = await chat(id, '客户问 BV-50 球阀')
    const agents = events.filter((e) => e.event === 'agent').map((e) => e.data)
    expect(agents.map((a) => [a.agentId, a.name, a.kernelName, a.memberRole])).toEqual([
      ['builtin', 'LULUX（跟单员）', 'LULUX', '跟单员'],
      ['builtin#2', 'LULUX（写信员）', 'LULUX', '写信员'],
    ])
    const start = events.find((e) => e.event === 'start')!.data
    expect(start.members.map((m: any) => m.id)).toEqual(['builtin', 'builtin#2'])
    const messages = dones(events)
    expect(messages.map((m: any) => [m.senderAgentId, m.content])).toEqual([
      ['builtin', '交期 25 天。'],
      ['builtin#2', '开发信已写好。'],
    ])
    const reqs = await mockRequests()
    const sys0 = reqs[0].messages[0].content as string
    const sys1 = reqs[1].messages[0].content as string
    expect(sys0).toContain('你是「LULUX（跟单员）」')
    expect(sys0).toContain('你的职责：只关心交期')
    expect(sys1).toContain('你是「LULUX（写信员）」')
    expect(sys1).not.toContain('只关心交期')
    // 第二位看到第一位的回答是“别人的发言”，不是自己的
    const seen = JSON.stringify(reqs[1].messages)
    expect(seen).toContain('【LULUX（跟单员）】')
    expect(reqs[1].messages.some((m: any) => m.role === 'assistant' && m.content === '交期 25 天。')).toBe(false)

    // 下一轮：各自把自己上一轮的回答当作 assistant
    await mockCall('/__mock/reset')
    await script({ text: '好的。' }, { text: '收到。' })
    await chat(id, '继续')
    const next = await mockRequests()
    expect(next[0].messages.some((m: any) => m.role === 'assistant' && m.content === '交期 25 天。')).toBe(true)
    expect(next[1].messages.some((m: any) => m.role === 'assistant' && m.content === '开发信已写好。')).toBe(true)
    expect(next[1].messages.some((m: any) => m.role === 'assistant' && m.content === '交期 25 天。')).toBe(false)
  })

  it('@ 点名：@群头衔 只点一位；@内核原名 点到同内核全部；@带头衔的全名只点那一位', async () => {
    const id = (
      await createGroup({
        supervisorId: 'none',
        members: [{ agentId: 'builtin', role: '跟单员' }, { agentId: 'builtin', role: '写信员' }, { agentId: 'kernel-pi' }],
      })
    ).json.session.id
    await script({ text: 'A' })
    let events = await chat(id, '@写信员 写一封开发信')
    expect(speakers(events)).toEqual(['builtin#2:member'])
    await mockCall('/__mock/reset')
    await script({ text: 'B' })
    events = await chat(id, '@LULUX（跟单员） 查交期')
    expect(speakers(events)).toEqual(['builtin:member'])
    await mockCall('/__mock/reset')
    await script({ text: 'C' }, { text: 'D' })
    events = await chat(id, '@LULUX 你们俩都说说')
    expect(speakers(events)).toEqual(['builtin:member', 'builtin#2:member'])
  })

  it('同内核没填头衔：显示名用序号区分；主管名单里带群头衔与职责', async () => {
    const id = (
      await createGroup({ members: [{ agentId: 'builtin' }, { agentId: 'builtin' }, { agentId: 'kernel-pi', role: '审校', instructions: '检查语法' }] })
    ).json.session.id
    await script({ text: '我自己答。' })
    const events = await chat(id, '你好')
    expect(speakers(events)).toEqual(['builtin:plan'])
    const reqs = await mockRequests()
    const sys = reqs[0].messages[0].content as string
    expect(sys).toContain('id: builtin#2 ｜ 名字：LULUX #2')
    expect(sys).toContain('id: kernel-pi ｜ 名字：Pi（审校） ｜ 内核：Pi 命令行内核 ｜ 群头衔：审校 ｜ 职责：检查语法')
    const tool = reqs[0].tools.find((t: any) => t.function.name === 'dispatch_members')
    expect(tool.function.parameters.properties.members.items.enum).toEqual(['builtin#2', 'kernel-pi'])
  })

  it('导出 / 导入：成员实例与群头衔都能恢复', async () => {
    const created = (
      await createGroup({ groupName: '导出群', members: [{ agentId: 'builtin', role: '跟单员' }, { agentId: 'builtin', role: '写信员', instructions: '写开发信' }] })
    ).json.session
    const exported = (await server.request('GET', '/api/data/export')).json
    const entry = exported.sessions.find((x: any) => x.id === created.id)
    expect(entry.memberProfiles['builtin#2']).toEqual({ role: '写信员', instructions: '写开发信', model: null })
    await server.request('DELETE', `/api/sessions/${created.id}`)
    const imported = await server.request('POST', '/api/data/import', { body: { ...exported, sessions: [entry] } })
    expect(imported.status, imported.text).toBeLessThan(300)
    const restored = (await server.request('GET', `/api/sessions/${created.id}`)).json.session
    expect(restored.agentIds).toEqual(['builtin', 'builtin#2'])
    expect(restored.memberProfiles).toEqual(created.memberProfiles)
  })
})
