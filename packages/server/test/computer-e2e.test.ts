import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 电脑操作端到端（docs/computer-use.md）：真实 HTTP 服务 + mock-openai + 注入的假桌面通道。
 * 重点验证截图如何进入模型上下文：本轮工具结果之后追加带图 user 轮，同一次回复只保留最近 2 张。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
const commands: Array<Record<string, unknown>> = []
const IMAGE = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`

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

async function settings(patch: Record<string, unknown>): Promise<void> {
  const res = await server.request('PATCH', '/api/settings', { body: patch })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
}

async function newSession(): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })
  return res.json.session.id
}

async function chat(sessionId: string, content: string) {
  const res = await server.request('POST', '/api/chat', { body: { sessionId, content } })
  expect(res.status).toBe(200)
  return parseSse(res.text)
}

const shotCall = (id: string) => ({ toolCalls: [{ id, name: 'computer_screenshot', arguments: {} }] })

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-vision' },
  })
  const { setComputerChannel } = await import('../src/services/computer/channel.js')
  setComputerChannel({
    available: () => true,
    async request<T>(cmd: Record<string, unknown>): Promise<T> {
      commands.push(cmd)
      if (cmd.action === 'screenshot') return { image: IMAGE, width: 1280, height: 800, displayId: 1, scale: 1 } as T
      return {} as T
    },
  })
  await settings({
    autoTitle: false,
    computerUse: true,
    modelCapabilities: JSON.stringify({ 'mock-vision': { vision: true, tools: true } }),
  })
}, 120_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
  commands.length = 0
})

describe('电脑操作：截图进入模型上下文', () => {
  it('会话未开启时工具返回提示且不碰桌面；开启后截图以带图 user 轮跟在工具结果后，只保留最近 2 张', async () => {
    const sessionId = await newSession()
    const status = await server.request('GET', `/api/sessions/${sessionId}/computer`)
    expect(status.json).toMatchObject({ enabled: false, available: true })

    // 未开启
    await script(shotCall('s0'), { text: '没开' })
    const off = await chat(sessionId, '帮我操作电脑看看屏幕')
    expect(off.find((e) => e.event === 'tool_result')!.data.ok).toBe(false)
    expect(commands).toHaveLength(0)

    const enabled = await server.request('POST', `/api/sessions/${sessionId}/computer`, { body: { enabled: true } })
    expect(enabled.json).toMatchObject({ enabled: true })

    await mockCall('/__mock/reset')
    await script(shotCall('s1'), shotCall('s2'), shotCall('s3'), { text: '看完了' })
    const events = await chat(sessionId, '帮我操作电脑看看屏幕')
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('看完了')
    expect(commands.map((c) => c.action)).toEqual(['begin', 'screenshot', 'screenshot', 'screenshot', 'end'])

    const requests = await mockRequests()
    expect(requests).toHaveLength(4)
    const imageParts = (messages: any[]) =>
      messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'image_url') : []))
    // 第 2 次请求：tool 结果后面紧跟一条带图 user 轮
    const second = requests[1].messages
    const toolIndex = second.findIndex((m: any) => m.role === 'tool' && m.tool_call_id === 's1')
    expect(toolIndex).toBeGreaterThan(0)
    expect(second[toolIndex + 1].role).toBe('user')
    expect(imageParts(second)).toHaveLength(1)
    expect(imageParts(second)[0].image_url.url).toBe(IMAGE)
    // 第 4 次请求：三张截图只保留最近两张，最早那条换成省略说明
    const fourth = requests[3].messages
    expect(imageParts(fourth)).toHaveLength(2)
    expect(JSON.stringify(fourth)).toContain('较早的截图已省略')
    // 工具结果与图片轮配对完整：每个 tool_call 都紧跟自己的 tool 结果
    for (const id of ['s1', 's2', 's3']) {
      const at = fourth.findIndex((m: any) => m.tool_calls?.some((c: any) => c.id === id))
      expect(fourth[at + 1]).toMatchObject({ role: 'tool', tool_call_id: id })
    }

    // 历史里不落图片：下一次对话的请求不带任何图片
    await mockCall('/__mock/reset')
    await script({ text: '好' })
    await chat(sessionId, '继续')
    expect(imageParts((await mockRequests())[0].messages)).toHaveLength(0)
  })

  it('截图连续 9 次同参数：第 8 次起被拦但不停用工具、不结束本轮，模型还能接着做', async () => {
    const sessionId = await newSession()
    await server.request('POST', `/api/sessions/${sessionId}/computer`, { body: { enabled: true } })
    await mockCall('/__mock/reset')
    const shots = Array.from({ length: 9 }, (_, i) => shotCall(`r${i}`))
    await script(...shots, { toolCalls: [{ id: 'k1', name: 'computer_cursor', arguments: {} }] }, { text: '换了做法' })
    const events = await chat(sessionId, '一直看屏幕')
    expect(events.some((e) => e.event === 'tool_limit')).toBe(false)
    // 前 7 次执行；第 8、9 次（连续同参数达到 8 次）被拦，拦截结果作为 tool 消息交给模型
    expect(commands.filter((c) => c.action === 'screenshot')).toHaveLength(7)
    const requests = await mockRequests()
    // 第 10 次请求（拦截之后）仍提供工具，且没有强制 tool_choice=none
    expect(requests[9].messages.filter((m: any) => m.role === 'tool' && String(m.content).includes('系统拦截'))).toHaveLength(2)
    expect(requests[9].tools?.length).toBeGreaterThan(0)
    expect(requests[9].tool_choice).not.toBe('none')
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('换了做法')
  })

  it('模型不支持看图时不提供 computer_* 工具', async () => {
    await settings({ modelCapabilities: JSON.stringify({ 'mock-vision': { vision: false, tools: true } }) })
    const sessionId = await newSession()
    await server.request('POST', `/api/sessions/${sessionId}/computer`, { body: { enabled: true } })
    await script({ text: 'ok' })
    await chat(sessionId, '帮我操作电脑')
    const names = ((await mockRequests())[0].tools ?? []).map((t: any) => t.function?.name)
    expect(names.some((n: string) => n?.startsWith('computer_'))).toBe(false)
    await settings({ modelCapabilities: JSON.stringify({ 'mock-vision': { vision: true, tools: true } }) })
  })

  it('点击即使“完全权限”也要审批；审批卡带截图地址与红点，不带 base64', async () => {
    const sessionId = await newSession()
    await server.request('PATCH', `/api/sessions/${sessionId}`, { body: { permissionLevel: 'full' } })
    await server.request('POST', `/api/sessions/${sessionId}/computer`, { body: { enabled: true } })
    await script(shotCall('c0'), { toolCalls: [{ id: 'c1', name: 'computer_click', arguments: { x: 100, y: 200 } }] }, { text: '点了' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '帮我操作电脑点一下' } })
    let request: any = null
    for (let i = 0; i < 200 && !request; i += 1) {
      await new Promise((r) => setTimeout(r, 30))
      const p = await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)
      request = p.json.requests[0] ?? null
    }
    expect(request).toBeTruthy()
    expect(request).toMatchObject({ name: 'computer_click' })
    expect((await server.request('POST', '/api/chat/tool-decision', { body: { requestId: request.requestId, approved: true } })).status).toBe(200)
    const events = parseSse((await pending).text)
    const ask = events.find((e) => e.event === 'tool_request' && e.data.name === 'computer_click')!.data
    expect(ask).toMatchObject({ auto: false, approvalKind: 'computer-action', canRemember: true, toolKey: 'computer:click' })
    expect(ask.detail).toMatchObject({ action: 'click', x: 100, y: 200, marker: { x: 100, y: 200 } })
    expect(ask.detail.screenshotUrl).toMatch(/^\/api\/chat\/sessions\/.+\/files\?path=computer%2Fshot-/)
    expect(JSON.stringify(ask.detail)).not.toContain('base64')
    expect(commands.some((c) => c.action === 'click' && c.x === 100 && c.y === 200)).toBe(true)
  })
})
