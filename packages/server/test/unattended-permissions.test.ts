import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 无人值守运行与只读档的权限回归（审计 2026-10-24 #1 #2 #12 #13）：
 * - 工作流“允许写”时，不可恢复 / 高风险工具（delete_* / delete_group / mcp_* / skill_*）仍一律拒绝；
 * - 定时任务 / 工作流里的 CLI 内核不继承会话的“完全权限”：不允许写 → 只读，允许写 → 最多需审批；
 * - “仅可查看”下不提供外发网络的工具（fetch_url / web_search / 浏览器）；
 * - 非交互发起的 post_to_group 沿用发起方的 allowWrite，且不超过目标群自己的级别。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as any).port
      probe.close(() => resolve(port))
    })
  })
}
const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })
const script = (...responses: unknown[]) =>
  fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })
const requests = async (): Promise<any[]> => (await (await fetch(`${mockBase}/__mock/requests`)).json()) as any[]
const toolNames = (request: any): string[] => (request.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name)

/** 替身 codex：把收到的参数原样作为回答输出 */
function installEchoCodex(): void {
  fakeKernelPackage(
    join(server.home, 'kernels'),
    'codex',
    '@openai/codex',
    'codex',
    'bin/codex.js',
    `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ARGV='+process.argv.slice(2).join(' ')}})+'\\n')})`,
  )
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((resolve) => mock.stdout!.once('data', () => resolve()))
  mockBase = `http://127.0.0.1:${port}`
  // 内核登录态与本机环境无关：给一个假的 API Key，CI 上没有真实凭据也能跑
  server = await startTestServer({ OPENAI_API_KEY: `test-${'key'}` })
  await api('POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await api('PATCH', '/api/settings', {
    autoTitle: false,
    llmMaxRetries: 0,
    toolLoading: 'all',
    skillAutoPreload: false,
    defaultPermissionLevel: 'full',
    kernelModeCodex: 'global',
  })
  installEchoCodex()
}, 30_000)
afterAll(async () => {
  mock?.kill()
  await server.close()
})

async function runWorkflow(nodes: unknown[]): Promise<any> {
  const wf = await api('POST', '/api/workflows', { name: `wf-${Math.random().toString(36).slice(2, 8)}`, nodes, edges: [] })
  expect(wf.status, wf.text).toBe(201)
  const started = await api('POST', `/api/workflows/${wf.json.id}/run`, {})
  expect(started.status, started.text).toBe(200)
  let run: any
  for (let i = 0; i < 400; i += 1) {
    run = (await api('GET', `/api/workflow-runs/${started.json.id}`)).json
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) break
    await sleep(50)
  }
  return run
}
const node = (extra: Record<string, unknown> = {}) => ({ id: 'a', name: 'A', kernelId: 'builtin', prompt: 'x', joinStrategy: 'all', allowWrite: true, position: { x: 0, y: 0 }, ...extra })
async function traceOf(sessionId: string): Promise<any[]> {
  const messages = (await api('GET', `/api/sessions/${sessionId}`)).json.messages
  return messages.find((message: any) => message.role === 'assistant')?.toolTrace ?? []
}
async function assistantText(sessionId: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const messages = (await api('GET', `/api/sessions/${sessionId}`)).json.messages
    const reply = messages.find((message: any) => message.role === 'assistant')
    if (reply?.content) return reply.content
    await sleep(50)
  }
  return ''
}

describe('工作流“允许写”下的不可恢复 / 高风险工具', () => {
  it('delete_group / mcp_add / delete_task 一律拒绝，普通写工具照常自动批准', async () => {
    const gid = (await api('POST', '/api/sessions', { kind: 'group', groupName: '重要群', supervisorId: 'none', members: [{ agentId: 'builtin' }] })).json.session.id
    const task = (await api('POST', '/api/tasks', { title: '不能被删的任务' })).json
    const before = (await requests()).length
    await script(
      {
        toolCalls: [
          { id: 'c1', name: 'delete_group', arguments: { group: gid } },
          { id: 'c2', name: 'mcp_add', arguments: { name: 'evil', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'x' } } },
          { id: 'c3', name: 'delete_task', arguments: { taskId: task.id } },
          { id: 'c4', name: 'create_task', arguments: { title: '工作流允许写建的任务' } },
        ],
      },
      { text: '完成' },
    )
    const run = await runWorkflow([node()])
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    const trace = await traceOf(run.nodes[0].sessionId)
    for (const name of ['delete_group', 'mcp_add', 'delete_task']) {
      const entry = trace.find((item: any) => item.name === name)
      expect(entry, name).toMatchObject({ approved: false, ok: false })
      expect(entry.result).toContain('不会自动执行')
    }
    expect(trace.find((item: any) => item.name === 'create_task')).toMatchObject({ approved: true, ok: true })
    expect((await api('GET', `/api/sessions/${gid}`)).status).toBe(200)
    expect(JSON.stringify((await api('GET', '/api/mcp/servers')).json)).not.toContain('127.0.0.1:9')
    const titles = (await api('GET', '/api/tasks?status=all')).json.items.map((item: any) => item.title)
    expect(titles).toContain('不能被删的任务')
    expect(titles).toContain('工作流允许写建的任务')
    // 高风险工具根本不提供给模型
    const offered = toolNames((await requests())[before])
    expect(offered).toContain('create_task')
    for (const name of ['delete_group', 'mcp_add', 'mcp_update', 'mcp_remove', 'skill_install', 'delete_task', 'delete_customer']) expect(offered).not.toContain(name)
  })
})

describe('无人值守运行里的 CLI 内核级别', () => {
  it('定时任务：默认“完全权限”时 codex 也只按只读启动', async () => {
    const created = await api('POST', '/api/schedules', { name: '每日', target: { type: 'prompt', kernelId: 'kernel-codex', prompt: '整理一下' }, spec: { type: 'daily', time: '09:00' } })
    expect(created.status, created.text).toBe(201)
    const ran = await api('POST', `/api/schedules/${created.json.id}/run-now`)
    expect(ran.status, ran.text).toBeLessThan(300)
    let row: any
    for (let i = 0; i < 100; i += 1) {
      row = (await api('GET', `/api/schedules/${created.json.id}/runs`)).json.find((item: any) => item.status !== 'running')
      if (row) break
      await sleep(100)
    }
    const text = await assistantText(row.sessionId)
    expect(text).toContain('--sandbox read-only')
    expect(text).not.toContain('workspace-write')
  })

  it('定时任务追加到“完全权限”的已有会话：本次运行只读，会话自己的设置不变', async () => {
    const session = (await api('POST', '/api/sessions', { agentIds: ['kernel-codex'], permissionLevel: 'full' })).json.session
    const created = await api('POST', '/api/schedules', {
      name: '追加',
      target: { type: 'prompt', kernelId: 'kernel-codex', prompt: '继续', sessionMode: 'append', sessionId: session.id },
      spec: { type: 'daily', time: '09:00' },
    })
    expect(created.status, created.text).toBe(201)
    await api('POST', `/api/schedules/${created.json.id}/run-now`)
    const text = await assistantText(session.id)
    expect(text).toContain('--sandbox read-only')
    expect((await api('GET', `/api/sessions/${session.id}`)).json.session.permissionLevel).toBe('full')
  })

  it('级别取会话级别与 allowWrite 中更严的一个', async () => {
    const { setNonInteractiveApproval, clearNonInteractiveApproval, unattendedKernelLevel } = await import('../src/services/tool-approval.js')
    expect(unattendedKernelLevel('ses_x', 'full')).toBe('full')
    setNonInteractiveApproval('ses_x', false)
    expect(unattendedKernelLevel('ses_x', 'full')).toBe('read')
    setNonInteractiveApproval('ses_x', true)
    expect(unattendedKernelLevel('ses_x', 'full')).toBe('ask')
    expect(unattendedKernelLevel('ses_x', 'read')).toBe('read')
    clearNonInteractiveApproval('ses_x')
  })
})

describe('“仅可查看”下的外发网络工具', () => {
  it('不提供 fetch_url / 浏览器；硬要调用时拒绝，不发出请求', async () => {
    const session = (await api('POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'read' })).json.session
    const before = (await requests()).length
    await script({ toolCalls: [{ id: 'f1', name: 'fetch_url', arguments: { url: 'http://127.0.0.1:9/?leak=secret' } }] }, { text: '好' })
    const res = await api('POST', '/api/chat', { sessionId: session.id, content: '打开这个网址' })
    const events = parseSse(res.text)
    const result = events.find((event) => event.event === 'tool_result')
    expect(result?.data).toMatchObject({ name: 'fetch_url', ok: false })
    expect(result?.data.result).toContain('不能访问外部网络')
    const offered = toolNames((await requests())[before])
    expect(offered.length).toBeGreaterThan(0)
    expect(offered).not.toContain('fetch_url')
    expect(offered.some((name) => name.startsWith('browser_'))).toBe(false)
  })

  it('不允许写的工作流节点（会话为仅可查看）同样不提供', async () => {
    const before = (await requests()).length
    await script({ toolCalls: [{ id: 'f2', name: 'fetch_url', arguments: { url: 'http://127.0.0.1:9/?leak=1' } }] }, { text: '好' })
    const run = await runWorkflow([node({ allowWrite: false })])
    expect(run.status).toBe('succeeded')
    const trace = await traceOf(run.nodes[0].sessionId)
    expect(trace[0]).toMatchObject({ name: 'fetch_url', ok: false })
    expect(trace[0].result).toContain('不能访问外部网络')
    expect(toolNames((await requests())[before])).not.toContain('fetch_url')
  })

  it('需审批 / 完全权限下照常提供 fetch_url', async () => {
    const session = (await api('POST', '/api/sessions', { agentIds: ['builtin'], permissionLevel: 'ask' })).json.session
    const before = (await requests()).length
    await script({ text: '好' })
    await api('POST', '/api/chat', { sessionId: session.id, content: 'hi' })
    expect(toolNames((await requests())[before])).toContain('fetch_url')
  })
})

describe('非交互发起的 post_to_group', () => {
  it('沿用发起方的 allowWrite：发起方允许写时群里的普通写工具照常执行', async () => {
    const gid = (await api('POST', '/api/sessions', { kind: 'group', groupName: '执行群', supervisorId: 'none', members: [{ agentId: 'builtin' }] })).json.session.id
    await script(
      { toolCalls: [{ id: 'p1', name: 'post_to_group', arguments: { group: gid, message: '建个任务', timeout_seconds: 30 } }] },
      { toolCalls: [{ id: 'g1', name: 'create_task', arguments: { title: '群里建的任务' } }] },
      { text: '群里建好了' },
      { text: '节点完成' },
    )
    const run = await runWorkflow([node()])
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    const titles = (await api('GET', '/api/tasks?status=all')).json.items.map((item: any) => item.title)
    expect(titles).toContain('群里建的任务')
  })

  it('目标群是“仅可查看”时不写，即使发起方允许写', async () => {
    const group = (await api('POST', '/api/sessions', { kind: 'group', groupName: '只读群', supervisorId: 'none', members: [{ agentId: 'builtin' }] })).json.session
    expect((await api('PATCH', `/api/sessions/${group.id}`, { permissionLevel: 'read' })).status).toBe(200)
    await script(
      { toolCalls: [{ id: 'p2', name: 'post_to_group', arguments: { group: group.id, message: '建个任务', timeout_seconds: 30 } }] },
      { toolCalls: [{ id: 'g2', name: 'create_task', arguments: { title: '只读群不该建的任务' } }] },
      { text: '试过了' },
      { text: '节点完成' },
    )
    const run = await runWorkflow([node()])
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    const titles = (await api('GET', '/api/tasks?status=all')).json.items.map((item: any) => item.title)
    expect(titles).not.toContain('只读群不该建的任务')
  })

  it('群里的 CLI 成员：级别取发起方 allowWrite 与群级别中更严的一个（允许写 → 最多需审批，codex 退回只读），不按群自己的“完全权限”', async () => {
    const group = (await api('POST', '/api/sessions', { kind: 'group', groupName: 'CLI 群', supervisorId: 'none', members: [{ agentId: 'kernel-codex' }] })).json.session
    expect(group.id).toBeTruthy()
    await script(
      { toolCalls: [{ id: 'p3', name: 'post_to_group', arguments: { group: group.id, message: '看一下', timeout_seconds: 30 } }] },
      { text: '节点完成' },
    )
    const run = await runWorkflow([node()])
    expect(run.status, JSON.stringify(run)).toBe('succeeded')
    const text = await assistantText(group.id)
    expect(text).toContain('--sandbox read-only')
  })
})
