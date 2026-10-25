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
 * 群聊工具（一句话建群并讨论）：内置内核调用 create_group → post_to_group（群里真实发言、结论带回）→ update_group → delete_group；
 * 防自投、防循环；命令行内核经 LULUX MCP 同样能建群。
 */
const call = (name: string, args: Record<string, unknown>, id = `c-${name}`) => ({ toolCalls: [{ id, name, arguments: args }] })

async function single(permissionLevel: 'ask' | 'full' = 'full'): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'], permissionLevel } })
  expect(res.status, res.text).toBe(201)
  return res.json.session.id
}

const toolResults = (events: Array<{ event: string; data: any }>) => events.filter((e) => e.event === 'tool_result').map((e) => e.data)
const groups = async () => (await server.request('GET', '/api/sessions')).json.sessions.filter((s: any) => s.kind === 'group')

describe('群聊工具', () => {
  it('一句话建群：同一内核两个成员带群头衔；侧栏能看到；主管可设成员', async () => {
    const sid = await single()
    await script(
      call('create_group', {
        name: 'BV-50 报价小组',
        members: [
          { kernel: 'LULUX', role: '跟单员', instructions: '核对交期' },
          { kernel: 'builtin', role: '写信员' },
          { kernel: 'Pi', role: '审校' },
        ],
        supervisor: '写信员',
      }),
      { text: '群建好了。' },
    )
    const events = await chat(sid, '帮我拉个群讨论 BV-50 报价，两个 LULUX 一个跟单一个写信，再加 Pi 审校')
    const result = toolResults(events).find((r) => r.name === 'create_group')
    expect(result.ok, result.result).toBe(true)
    expect(result.result).toContain('LULUX（跟单员）（builtin）')
    expect(result.result).toContain('LULUX（写信员）（builtin#2）')
    const group = (await groups()).find((g: any) => g.groupName === 'BV-50 报价小组')
    expect(group).toMatchObject({ agentIds: ['builtin', 'builtin#2', 'kernel-pi'], supervisorId: 'builtin#2' })
    expect(group.memberProfiles.builtin).toEqual({ role: '跟单员', instructions: '核对交期', model: null })
    expect(result.result).toContain(group.id)
  })

  it('post_to_group：群里真实发起一轮讨论（用户可见），等结束把各成员回答带回来', async () => {
    const created = await server.request('POST', '/api/sessions', {
      body: { kind: 'group', groupName: '跟单群', supervisorId: 'none', members: [{ agentId: 'builtin', role: '跟单员' }, { agentId: 'builtin', role: '写信员' }] },
    })
    const gid = created.json.session.id
    const sid = await single()
    await script(
      call('post_to_group', { group: '跟单群', message: '客户催 BV-50 交期，请给口径' }),
      { text: '交期 25 天，可分批。' },
      { text: '已写好回信。' },
      { text: '群里结论：25 天，可分批。' },
    )
    const events = await chat(sid, '让跟单群讨论一下 BV-50 交期')
    const result = toolResults(events).find((r) => r.name === 'post_to_group')
    expect(result.ok, result.result).toBe(true)
    expect(result.result).toContain('群聊「跟单群」讨论结束')
    expect(result.result).toContain('【LULUX（跟单员）】\n交期 25 天，可分批。')
    expect(result.result).toContain('【LULUX（写信员）】\n已写好回信。')
    const msgs = (await server.request('GET', `/api/sessions/${gid}`)).json.messages
    expect(msgs.map((m: any) => [m.role, m.senderAgentId ?? null])).toEqual([
      ['user', null],
      ['assistant', 'builtin'],
      ['assistant', 'builtin#2'],
    ])
    expect(msgs[0].content).toContain('客户催 BV-50 交期')
    expect(dones(events).at(-1).content).toBe('群里结论：25 天，可分批。')
  })

  it('post_to_group wait=false：发起后立刻返回，讨论在群里继续', async () => {
    const gid = (await server.request('POST', '/api/sessions', { body: { kind: 'group', groupName: '异步群', supervisorId: 'none', members: [{ agentId: 'builtin' }] } })).json.session.id
    const sid = await single()
    await script(call('post_to_group', { group: gid, message: '你好', wait: false }), { text: '已发起。' }, { text: '群里回答' })
    const events = await chat(sid, '在异步群里打个招呼，不用等')
    expect(toolResults(events).find((r) => r.name === 'post_to_group').result).toContain('已在群聊「异步群」发起讨论')
    for (let i = 0; i < 50; i++) {
      const msgs = (await server.request('GET', `/api/sessions/${gid}`)).json.messages
      if (msgs.some((m: any) => m.role === 'assistant')) break
      await sleep(100)
    }
    const msgs = (await server.request('GET', `/api/sessions/${gid}`)).json.messages
    expect(msgs.filter((m: any) => m.role === 'assistant').length).toBe(1)
  })

  it('不能往自己所在的群发、不能解散自己所在的群；找不到群时列出现有群', async () => {
    const gid = (await server.request('POST', '/api/sessions', { body: { kind: 'group', groupName: '自己群', supervisorId: 'none', members: [{ agentId: 'builtin' }] } })).json.session.id
    await script(call('post_to_group', { group: gid, message: 'x' }, 'p1'), call('post_to_group', { group: '不存在的群', message: 'x' }, 'p2'), { text: '好' })
    const events = await chat(gid, '试试')
    const results = toolResults(events)
    expect(results[0]).toMatchObject({ name: 'post_to_group', ok: false })
    expect(results[0].result).toContain('不能往自己所在的群')
    expect(results[1].result).toContain('没有找到群聊「不存在的群」')
    expect(results[1].result).toContain('自己群')
    // 解散自己所在的群：直接调用工具（审批之后的检查）
    const { groupTools } = await import('../src/services/chat/group-tools.js')
    const { runAs, LOCAL_ACTOR } = await import('../src/context.js')
    const del = groupTools.find((t) => t.name === 'delete_group')!
    await expect(
      runAs(LOCAL_ACTOR, () => del.run({ group: gid }, { sessionId: gid, agentId: 'builtin', signal: new AbortController().signal, addArtifact: () => undefined })),
    ).rejects.toThrow('不能解散自己所在的群')
    expect((await server.request('GET', `/api/sessions/${gid}`)).status).toBe(200)
  })

  it('update_group：加同内核成员、改头衔、移除、换主管；delete_group 需要确认（完全权限下也弹卡片）', async () => {
    const gid = (await server.request('POST', '/api/sessions', { body: { kind: 'group', groupName: '改群', members: [{ agentId: 'builtin', role: '跟单员' }, { agentId: 'kernel-pi' }] } })).json.session.id
    const sid = await single('full')
    await script(
      call('update_group', {
        group: '改群',
        name: '改群2',
        add_members: [{ kernel: 'builtin', role: '报价员' }],
        remove_members: ['Pi'],
        update_members: [{ member: '跟单员', role: '跟单主管' }],
        supervisor: '报价员',
      }),
      { text: '改好了。' },
    )
    let events = await chat(sid, '改一下改群')
    const updated = toolResults(events).find((r) => r.name === 'update_group')
    expect(updated.ok, updated.result).toBe(true)
    const after = (await server.request('GET', `/api/sessions/${gid}`)).json.session
    expect(after).toMatchObject({ groupName: '改群2', agentIds: ['builtin', 'builtin#2'], supervisorId: 'builtin#2' })
    expect(after.memberProfiles).toEqual({
      builtin: { role: '跟单主管', instructions: '', model: null },
      'builtin#2': { role: '报价员', instructions: '', model: null },
    })

    // 解散：完全权限下也要确认；拒绝后群还在
    await mockCall('/__mock/reset')
    await script(call('delete_group', { group: gid }), { text: '没删。' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId: sid, content: '把改群2解散' } })
    let requestId: string | null = null
    for (let i = 0; i < 50 && !requestId; i++) {
      const p = (await server.request('GET', `/api/chat/pending?sessionId=${sid}`)).json
      requestId = p.requests[0]?.requestId ?? p.requests[0]?.id ?? null
      if (!requestId) await sleep(100)
    }
    expect(requestId).toBeTruthy()
    await server.request('POST', '/api/chat/tool-decision', { body: { requestId, approved: false } })
    events = parseSse((await pending).text)
    expect((await server.request('GET', `/api/sessions/${gid}`)).status).toBe(200)

    await mockCall('/__mock/reset')
    await script(call('delete_group', { group: gid }), { text: '已解散。' })
    const pending2 = server.request('POST', '/api/chat', { body: { sessionId: sid, content: '确定解散改群2' } })
    requestId = null
    for (let i = 0; i < 50 && !requestId; i++) {
      const p = (await server.request('GET', `/api/chat/pending?sessionId=${sid}`)).json
      requestId = p.requests[0]?.requestId ?? p.requests[0]?.id ?? null
      if (!requestId) await sleep(100)
    }
    await server.request('POST', '/api/chat/tool-decision', { body: { requestId, approved: true } })
    events = parseSse((await pending2).text)
    expect(toolResults(events).find((r) => r.name === 'delete_group').result).toContain('已解散群聊「改群2」')
    expect((await server.request('GET', `/api/sessions/${gid}`)).status).toBe(404)
  })

  it('防循环：A 正在等 B 的讨论时，B 里的成员不能再往 A 发', async () => {
    const sid = await single()
    const gid = (await server.request('POST', '/api/sessions', { body: { kind: 'group', groupName: '循环群', supervisorId: 'none', members: [{ agentId: 'builtin' }] } })).json.session.id
    await script(
      call('post_to_group', { group: gid, message: '讨论一下' }, 'a1'),
      // 群里的成员试图往发起会话 A 发（A 不是群，所以按“不存在的群”拒绝）；再往自己群发同样被拒
      call('post_to_group', { group: gid, message: '回传' }, 'b1'),
      { text: '群里的回答' },
      { text: '完成' },
    )
    const events = await chat(sid, '让循环群讨论')
    const post = toolResults(events).find((r) => r.name === 'post_to_group')
    expect(post.result).toContain('群里的回答')
    const groupMsgs = (await server.request('GET', `/api/sessions/${gid}`)).json.messages
    const trace = groupMsgs.find((m: any) => m.role === 'assistant').toolTrace
    expect(trace[0]).toMatchObject({ name: 'post_to_group', ok: false })
    expect(trace[0].result).toContain('不能往自己所在的群')
  })

  it('LULUX MCP：命令行内核的 tools/list 带群聊工具，能直接建群', async () => {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-pi'], permissionLevel: 'full' } })
    const issued = luluxMcpTokens.issue({
      actor: LOCAL_ACTOR,
      kernelId: 'pi',
      bridge: { sessionId: session.json.session.id, agentId: 'kernel-pi', signal: new AbortController().signal, send: () => undefined, trace: () => undefined },
    })
    let id = 0
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    const names = (await rpc('tools/list')).result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_group_options', 'create_group', 'update_group', 'post_to_group', 'delete_group']))
    const res = await rpc('tools/call', { name: 'create_group', arguments: { name: 'MCP 群', members: [{ kernel: 'kernel-pi', role: '甲' }, { kernel: 'kernel-pi', role: '乙' }] } })
    expect(res.result.isError ?? false, JSON.stringify(res)).toBe(false)
    const group = (await groups()).find((g: any) => g.groupName === 'MCP 群')
    expect(group.agentIds).toEqual(['kernel-pi', 'kernel-pi#2'])
    issued.revoke()
  })
})
