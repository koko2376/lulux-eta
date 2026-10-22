import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 账户隔离（契约 §5.6a）与多人群聊（契约 §6.10），server 模式：
 * 两个成员 + 管理员（+ owner），逐个接口证明别人的会话看不到、改不了、收不到推送；
 * 群聊只有真人成员可见，成员可发言，别人实时收到新消息。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
type Who = { token: string; id: string; role: string; name: string }
let owner: Who
let admin: Who
let alice: Who
let bob: Who
let carol: Who
let viewer: Who

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

async function invite(role: string, email: string, name: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, role, name }
}

/** 打开一条 SSE（GET），收集事件直到 close() */
interface SseHandle {
  status: Promise<number>
  events: Array<{ event: string; data: any }>
  waitFor(pred: (e: { event: string; data: any }) => boolean, ms?: number): Promise<{ event: string; data: any }>
  ended: Promise<void>
  close(): void
}
function openSse(who: Who, path: string): SseHandle {
  const events: Array<{ event: string; data: any }> = []
  let buffer = ''
  let resolveStatus: (n: number) => void = () => undefined
  let resolveEnded: () => void = () => undefined
  const status = new Promise<number>((r) => (resolveStatus = r))
  const ended = new Promise<void>((r) => (resolveEnded = r))
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
      res.on('error', () => resolveEnded())
      res.on('end', () => resolveEnded())
      res.on('close', () => resolveEnded())
    },
  )
  req.on('error', () => resolveEnded())
  req.end()
  return {
    status,
    events,
    ended,
    async waitFor(pred, ms = 8000) {
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

async function chat(who: Who, sessionId: string, content: string) {
  const res = await as(who, 'POST', '/api/chat', { sessionId, content })
  return { status: res.status, events: res.status === 200 ? parseSse(res.text) : [], json: res.json }
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id, role: 'owner', name: 'Owner' }
  admin = await invite('admin', 'admin@acme.com', 'Ada Admin')
  alice = await invite('member', 'alice@acme.com', 'Alice')
  bob = await invite('member', 'bob@acme.com', 'Bob')
  carol = await invite('member', 'carol@acme.com', 'Carol')
  viewer = await invite('viewer', 'viewer@acme.com', 'Vic Viewer')
  const provider = await as(owner, 'POST', '/api/providers', {
    name: 'Mock',
    kind: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-mock-key-123456',
    model: 'mock-model',
  })
  expect(provider.status, provider.text).toBe(201)
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('会话严格按账号隔离（两名成员 + 管理员）', () => {
  let secret: { id: string; title: string; messageId: string }

  beforeAll(async () => {
    const created = await as(alice, 'POST', '/api/sessions', { title: 'Alice 的机密询盘', agentIds: ['builtin'] })
    expect(created.status, created.text).toBe(201)
    const sent = await chat(alice, created.json.session.id, '帮我给 Nordic Build 报个价')
    expect(sent.status).toBe(200)
    expect(sent.events.some((e) => e.event === 'done')).toBe(true)
    const detail = await as(alice, 'GET', `/api/sessions/${created.json.session.id}`)
    const userMessage = detail.json.messages.find((m: any) => m.role === 'user')
    expect(userMessage.senderUserId).toBe(alice.id)
    secret = { id: created.json.session.id, title: 'Alice 的机密询盘', messageId: userMessage.id }
    // 会话工作区放一个文件
    const up = await as(alice, 'POST', `/api/chat/sessions/${secret.id}/files`, { path: 'quote.txt', dataBase64: Buffer.from('secret').toString('base64') })
    expect(up.status, up.text).toBe(201)
  })

  it('列表：负责人看得到；另一名成员、管理员、owner 都看不到（scope=all 也不行）', async () => {
    const ids = async (who: Who, q = '') => (await as(who, 'GET', `/api/sessions${q}`)).json.sessions.map((s: any) => s.id)
    expect(await ids(alice)).toContain(secret.id)
    for (const who of [bob, admin, owner]) {
      expect(await ids(who)).not.toContain(secret.id)
      expect(await ids(who, '?scope=all')).not.toContain(secret.id)
    }
  })

  it('读取类接口：GET / messages / participants / pending / context / export / 单条 markdown / 文件 全部 404', async () => {
    const paths = [
      `/api/sessions/${secret.id}`,
      `/api/sessions/${secret.id}/messages`,
      `/api/sessions/${secret.id}/participants`,
      `/api/chat/pending?sessionId=${secret.id}`,
      `/api/chat/sessions/${secret.id}/context`,
      `/api/chat/sessions/${secret.id}/export`,
      `/api/chat/sessions/${secret.id}/messages/${secret.messageId}/markdown`,
      `/api/chat/sessions/${secret.id}/files/list`,
      `/api/chat/sessions/${secret.id}/files?path=quote.txt`,
    ]
    for (const path of paths) {
      expect((await as(alice, 'GET', path)).status, `alice ${path}`).toBe(200)
      for (const who of [bob, admin, owner]) {
        const res = await as(who, 'GET', path)
        expect(res.status, `${who.name} ${path}`).toBe(404)
        expect(res.text).not.toContain('Nordic')
      }
    }
  })

  it('写入类接口：改名 / 删除 / 发消息 / 重新生成 / 编辑 / 停止 / 绑定上下文 / 上传 / 邀请成员 全部 404', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['PATCH', `/api/sessions/${secret.id}`, { title: 'hacked' }],
      ['DELETE', `/api/sessions/${secret.id}`, undefined],
      ['POST', '/api/chat', { sessionId: secret.id, content: 'hi' }],
      ['POST', '/api/chat/regenerate', { sessionId: secret.id }],
      ['POST', '/api/chat/edit', { sessionId: secret.id, messageId: secret.messageId, content: 'x' }],
      ['POST', '/api/chat/stop', { sessionId: secret.id }],
      ['PUT', `/api/chat/sessions/${secret.id}/context`, { customerId: null }],
      ['POST', `/api/chat/sessions/${secret.id}/files`, { path: 'x.txt', dataBase64: 'eA==' }],
      ['POST', `/api/sessions/${secret.id}/participants`, { userIds: [bob.id] }],
      ['DELETE', `/api/sessions/${secret.id}/participants/me`, undefined],
    ]
    for (const [method, path, body] of calls) {
      for (const who of [bob, admin, owner]) {
        const res = await as(who, method, path, body)
        expect(res.status, `${who.name} ${method} ${path} → ${res.text}`).toBe(404)
      }
    }
    const still = await as(alice, 'GET', `/api/sessions/${secret.id}`)
    expect(still.json.session.title).toBe(secret.title)
  })

  it('会话事件流：别人订阅 404；负责人订阅收到自己的新消息', async () => {
    for (const who of [bob, admin]) {
      const sse = openSse(who, `/api/sessions/${secret.id}/events`)
      expect(await sse.status).toBe(404)
      sse.close()
    }
    const mine = openSse(alice, `/api/sessions/${secret.id}/events`)
    expect(await mine.status).toBe(200)
    await mine.waitFor((e) => e.event === 'ready')
    await chat(alice, secret.id, '再补一句：交期 30 天')
    const hit = await mine.waitFor((e) => e.event === 'message' && e.data.message.content === '再补一句：交期 30 天')
    expect(hit.data.message.senderUserId).toBe(alice.id)
    mine.close()
  })

  it('不能共享：visibility team / org 被拒绝；新会话一律 private', async () => {
    expect((await as(alice, 'POST', '/api/sessions', { visibility: 'org' })).status).toBe(400)
    expect((await as(alice, 'POST', '/api/sessions', { visibility: 'team', teamId: 'x' })).status).toBe(400)
    const ok = await as(alice, 'POST', '/api/sessions', { visibility: 'private' })
    expect(ok.status).toBe(201)
    expect(ok.json.session.visibility).toBe('private')
  })

  it('工作台最近会话、管理员导出 / 用量 / 清空：都不含别人的会话', async () => {
    const workbench = await as(admin, 'GET', '/api/workbench/summary')
    expect(workbench.status).toBe(200)
    expect(JSON.stringify(workbench.json)).not.toContain(secret.id)

    const exported = await as(admin, 'GET', '/api/data/export')
    expect(exported.status).toBe(200)
    expect(exported.json.sessions.map((s: any) => s.id)).not.toContain(secret.id)
    expect(exported.text).not.toContain('Nordic Build')
    const ownExport = await as(alice, 'GET', '/api/data/export')
    // member 没有 data:export 权限
    expect(ownExport.status).toBe(403)

    const usage = await as(admin, 'GET', '/api/usage?groupBy=session&scope=all')
    expect(usage.status).toBe(200)
    expect(usage.json.totals.calls).toBeGreaterThan(0)
    expect(JSON.stringify(usage.json.groups)).not.toContain(secret.title)
    expect(usage.json.groups.map((g: any) => g.key)).not.toContain(secret.id)
    expect(usage.json.groups.some((g: any) => g.key === '__others__')).toBe(true)
    const aliceUsage = await as(alice, 'GET', '/api/usage?groupBy=session')
    expect(aliceUsage.json.groups.map((g: any) => g.key)).toContain(secret.id)

    const adminOwn = await as(admin, 'POST', '/api/sessions', { title: 'admin 自己的' })
    const cleared = await as(admin, 'DELETE', '/api/data/sessions')
    expect(cleared.status, cleared.text).toBe(200)
    expect((await as(admin, 'GET', `/api/sessions/${adminOwn.json.session.id}`)).status).toBe(404)
    expect((await as(alice, 'GET', `/api/sessions/${secret.id}`)).status).toBe(200)
  })

  it('导入不能覆盖别人的会话（同 id）', async () => {
    const res = await as(admin, 'POST', '/api/data/import', {
      app: 'LULUX ETA',
      sessions: [
        {
          id: secret.id,
          title: '被覆盖',
          providerId: null,
          groupName: null,
          agentIds: ['builtin'],
          createdAt: 1,
          updatedAt: 2,
          messages: [],
        },
      ],
    })
    expect(res.status, res.text).toBeLessThan(300)
    expect((await as(alice, 'GET', `/api/sessions/${secret.id}`)).json.session.title).toBe(secret.title)
    expect((await as(admin, 'GET', `/api/sessions/${secret.id}`)).status).toBe(404)
  })

  it('定时任务不能追加到别人的会话；全局事件流不推别人的会话事件', async () => {
    const sch = await as(bob, 'POST', '/api/schedules', {
      name: 'peek',
      target: { type: 'prompt', kernelId: 'builtin', prompt: 'hi', sessionMode: 'append', sessionId: secret.id },
      spec: { type: 'daily', time: '09:00' },
      timezone: 'Asia/Shanghai',
    })
    expect(sch.status).toBe(400)
    expect(sch.json.error.code).toBe('SESSION_NOT_FOUND')

    const adminEvents = openSse(admin, '/api/events')
    const bobEvents = openSse(bob, '/api/events')
    expect(await adminEvents.status).toBe(200)
    await adminEvents.waitFor((e) => e.event === 'ping')
    await bobEvents.waitFor((e) => e.event === 'ping')
    // Alice 拉 Carol 建群并发言：Carol 收到 session.message，admin / bob 收不到
    const carolEvents = openSse(carol, '/api/events')
    await carolEvents.waitFor((e) => e.event === 'ping')
    const group = await as(alice, 'POST', '/api/sessions', { kind: 'group', agentIds: ['builtin', 'lux-analyst'], userIds: [carol.id], supervisorId: 'none' })
    expect(group.status, group.text).toBe(201)
    await chat(alice, group.json.session.id, '只给 Carol 看的消息')
    await carolEvents.waitFor((e) => e.event === 'session.message' && e.data.sessionId === group.json.session.id)
    await sleep(200)
    for (const handle of [adminEvents, bobEvents]) {
      expect(handle.events.some((e) => JSON.stringify(e.data ?? '').includes(group.json.session.id))).toBe(false)
      expect(handle.events.some((e) => JSON.stringify(e.data ?? '').includes(secret.id))).toBe(false)
      handle.close()
    }
    carolEvents.close()
  })
})

describe('多人群聊：真人成员', () => {
  let groupId = ''

  it('建群时邀请同事：kind=group 才能带 userIds；只能邀请同组织在用的账号；单聊不能邀请', async () => {
    expect((await as(alice, 'POST', '/api/sessions', { kind: 'single', agentIds: ['builtin'], userIds: [bob.id] })).status).toBe(400)
    expect((await as(alice, 'POST', '/api/sessions', { kind: 'group', agentIds: ['builtin', 'lux-analyst'], userIds: ['usr_nobody'] })).status).toBe(400)
    const created = await as(alice, 'POST', '/api/sessions', {
      kind: 'group',
      groupName: '欧洲线报价群',
      agentIds: ['builtin', 'lux-analyst'],
      userIds: [bob.id, alice.id],
    })
    expect(created.status, created.text).toBe(201)
    groupId = created.json.session.id
    expect(created.json.session.participants.map((p: any) => [p.userId, p.role, p.name])).toEqual([
      [alice.id, 'owner', 'Alice'],
      [bob.id, 'member', 'Bob'],
    ])
    expect(created.json.session.myRole).toBe('owner')
    // 失败时不留半成品
    const before = (await as(alice, 'GET', '/api/sessions')).json.sessions.length
    await as(alice, 'POST', '/api/sessions', { kind: 'group', agentIds: ['builtin', 'lux-analyst'], userIds: ['usr_nobody'] })
    expect((await as(alice, 'GET', '/api/sessions')).json.sessions.length).toBe(before)
  })

  it('同事列表：同组织、不含自己和停用账号', async () => {
    const res = await as(alice, 'GET', '/api/sessions/colleagues')
    expect(res.status).toBe(200)
    const ids = res.json.users.map((u: any) => u.id)
    expect(ids).toEqual(expect.arrayContaining([bob.id, carol.id, admin.id, owner.id]))
    expect(ids).not.toContain(alice.id)
    expect(res.json.users[0]).not.toHaveProperty('role')
  })

  it('只有真人成员看得到群：Bob 可见，Carol / 管理员 / owner 看不到', async () => {
    const listed = (await as(bob, 'GET', '/api/sessions')).json.sessions.find((s: any) => s.id === groupId)
    expect(listed).toBeTruthy()
    expect(listed.myRole).toBe('member')
    expect(listed.participants).toHaveLength(2)
    for (const who of [carol, admin, owner]) {
      expect((await as(who, 'GET', '/api/sessions')).json.sessions.map((s: any) => s.id)).not.toContain(groupId)
      expect((await as(who, 'GET', `/api/sessions/${groupId}`)).status).toBe(404)
    }
  })

  it('Bob 发言：Agent（主管派发不变）回应；Alice 的会话事件流实时收到 Bob 的消息和 Agent 回复；消息带发言人', async () => {
    const live = openSse(alice, `/api/sessions/${groupId}/events`)
    expect(await live.status).toBe(200)
    await live.waitFor((e) => e.event === 'ready')
    const sent = await chat(bob, groupId, '@远航 请帮忙估一下运费')
    expect(sent.status).toBe(200)
    const names = sent.events.filter((e) => e.event === 'agent').map((e) => e.data.agentId)
    expect(names.length).toBeGreaterThan(0)
    const userEvent = await live.waitFor((e) => e.event === 'message' && e.data.message.role === 'user')
    expect(userEvent.data.message).toMatchObject({ senderUserId: bob.id, senderName: 'Bob', content: '@远航 请帮忙估一下运费' })
    await live.waitFor((e) => e.event === 'message' && e.data.message.role === 'assistant')
    live.close()

    const detail = await as(alice, 'GET', `/api/sessions/${groupId}`)
    const users = detail.json.messages.filter((m: any) => m.role === 'user')
    expect(users.at(-1)).toMatchObject({ senderUserId: bob.id, senderName: 'Bob' })
    expect(detail.json.messages.some((m: any) => m.role === 'assistant')).toBe(true)
    // 导出里写发言人名字
    const md = await as(alice, 'GET', `/api/chat/sessions/${groupId}/export`)
    expect(md.text).toContain('Bob')
  })

  it('普通成员不能改群设置 / 邀请 / 解散；编辑或重新生成别人的消息被拒绝', async () => {
    expect((await as(bob, 'PATCH', `/api/sessions/${groupId}`, { groupName: 'x' })).status).toBe(403)
    expect((await as(bob, 'POST', `/api/sessions/${groupId}/participants`, { userIds: [carol.id] })).status).toBe(403)
    const del = await as(bob, 'DELETE', `/api/sessions/${groupId}`)
    expect(del.status).toBe(403)
    expect(del.json.error.code).toBe('NOT_GROUP_OWNER')

    await chat(alice, groupId, 'Alice 的问题')
    const detail = await as(bob, 'GET', `/api/sessions/${groupId}`)
    const aliceMsg = detail.json.messages.find((m: any) => m.role === 'user' && m.senderUserId === alice.id)
    const edit = await as(bob, 'POST', '/api/chat/edit', { sessionId: groupId, messageId: aliceMsg.id, content: '改掉' })
    expect(edit.status).toBe(403)
    expect(edit.json.error.code).toBe('NOT_YOUR_MESSAGE')
    const regen = await as(bob, 'POST', '/api/chat/regenerate', { sessionId: groupId })
    expect(regen.status).toBe(403)
    // 自己的消息：之后已有同事发言时不能编辑（截断会删掉同事的消息）
    const bobMsg = detail.json.messages.find((m: any) => m.role === 'user' && m.senderUserId === bob.id)
    const blocked = await as(bob, 'POST', '/api/chat/edit', { sessionId: groupId, messageId: bobMsg.id, content: '@远航 运费改成 CIF' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('OTHERS_REPLIED')
    // 最后一条是自己的：可以编辑重发
    await chat(bob, groupId, 'Bob 的追问')
    const latest = (await as(bob, 'GET', `/api/sessions/${groupId}`)).json.messages.filter((m: any) => m.role === 'user').at(-1)
    expect(latest.senderUserId).toBe(bob.id)
    const own = await as(bob, 'POST', '/api/chat/edit', { sessionId: groupId, messageId: latest.id, content: 'Bob 的追问（改）' })
    expect(own.status).toBe(200)
    const after = (await as(alice, 'GET', `/api/sessions/${groupId}`)).json.messages
    expect(after.some((m: any) => m.content === 'Alice 的问题')).toBe(true)
  })

  it('群主设群管理员；群管理员能邀请 / 移出普通成员，不能移出群主或其他管理员，不能设管理员', async () => {
    expect((await as(bob, 'PATCH', `/api/sessions/${groupId}/participants/${bob.id}`, { role: 'admin' })).status).toBe(403)
    const promote = await as(alice, 'PATCH', `/api/sessions/${groupId}/participants/${bob.id}`, { role: 'admin' })
    expect(promote.status, promote.text).toBe(200)
    expect(promote.json.session.participants.find((p: any) => p.userId === bob.id).role).toBe('admin')

    const added = await as(bob, 'POST', `/api/sessions/${groupId}/participants`, { userIds: [carol.id, viewer.id] })
    expect(added.status, added.text).toBe(201)
    expect(added.json.added).toEqual([carol.id, viewer.id])
    expect((await as(bob, 'POST', `/api/sessions/${groupId}/participants`, { userIds: [admin.id], role: 'admin' })).status).toBe(403)
    expect((await as(carol, 'GET', `/api/sessions/${groupId}`)).status).toBe(200)
    // 群管理员可以改群名
    expect((await as(bob, 'PATCH', `/api/sessions/${groupId}`, { groupName: '欧洲线报价群（新）' })).status).toBe(200)

    expect((await as(bob, 'DELETE', `/api/sessions/${groupId}/participants/${alice.id}`)).status).toBe(400)
    expect((await as(carol, 'DELETE', `/api/sessions/${groupId}/participants/${bob.id}`)).status).toBe(403)
    // viewer 只读：能看不能发
    expect((await as(viewer, 'GET', `/api/sessions/${groupId}`)).status).toBe(200)
    expect((await as(viewer, 'POST', '/api/chat', { sessionId: groupId, content: 'hi' })).status).toBe(403)
  })

  it('移出成员：被移出的人立刻看不到群，会话事件流收到 removed 并断开；退出群聊同理；群主不能退出', async () => {
    const carolLive = openSse(carol, `/api/sessions/${groupId}/events`)
    expect(await carolLive.status).toBe(200)
    await carolLive.waitFor((e) => e.event === 'ready')
    const carolGlobal = openSse(carol, '/api/events')
    await carolGlobal.waitFor((e) => e.event === 'ping')
    expect((await as(bob, 'DELETE', `/api/sessions/${groupId}/participants/${carol.id}`)).status).toBe(204)
    await carolLive.waitFor((e) => e.event === 'removed')
    await carolLive.ended
    await carolGlobal.waitFor((e) => e.event === 'session.removed' && e.data.sessionId === groupId)
    carolGlobal.close()
    expect((await as(carol, 'GET', `/api/sessions/${groupId}`)).status).toBe(404)
    expect((await as(carol, 'POST', '/api/chat', { sessionId: groupId, content: '还在吗' })).status).toBe(404)

    expect((await as(viewer, 'DELETE', `/api/sessions/${groupId}/participants/me`)).status).toBe(204)
    expect((await as(viewer, 'GET', `/api/sessions/${groupId}`)).status).toBe(404)
    const leave = await as(alice, 'DELETE', `/api/sessions/${groupId}/participants/me`)
    expect(leave.status).toBe(400)
    expect(leave.json.error.code).toBe('OWNER_CANNOT_LEAVE')
    const people = (await as(alice, 'GET', `/api/sessions/${groupId}/participants`)).json.participants
    expect(people.map((p: any) => p.userId)).toEqual([alice.id, bob.id])
  })

  it('审计：邀请 / 移出成员留痕', async () => {
    const audit = await as(owner, 'GET', '/api/audit?pageSize=200')
    const actions = audit.json.items.map((e: any) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['session.member_add', 'session.member_remove', 'session.member_role']))
  })

  it('群主解散群聊：成员的事件流收到 removed；成员列表里消失', async () => {
    const bobLive = openSse(bob, `/api/sessions/${groupId}/events`)
    await bobLive.waitFor((e) => e.event === 'ready')
    expect((await as(alice, 'DELETE', `/api/sessions/${groupId}`)).status).toBe(204)
    await bobLive.waitFor((e) => e.event === 'removed')
    expect((await as(bob, 'GET', '/api/sessions')).json.sessions.map((s: any) => s.id)).not.toContain(groupId)
  })

  it('desktop 模式之外的检查：单聊没有 participants；群聊 participants 只含群主', async () => {
    const single = await as(alice, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(single.json.session.participants).toEqual([])
    const group = await as(alice, 'POST', '/api/sessions', { kind: 'group', agentIds: ['builtin', 'lux-analyst'] })
    expect(group.json.session.participants.map((p: any) => p.userId)).toEqual([alice.id])
    // 单聊不能加人
    expect((await as(alice, 'POST', `/api/sessions/${single.json.session.id}/participants`, { userIds: [bob.id] })).status).toBe(400)
  })
})
