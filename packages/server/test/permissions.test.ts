import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 会话权限级别（契约 §6.11）：仅可查看 / 需审批 / 完全权限。
 * - 纯函数：工具闸门、级别比较、旧设置换算、每个 CLI 内核的参数映射；
 * - 迁移 20：旧 toolApproval → defaultPermissionLevel；
 * - 接口：设置同步、GET /api/permissions、PATCH 会话 permissionLevel；
 * - 内置内核：read 不提供写工具、full 直接执行、ask 弹卡片；群聊同样生效；
 * - LULUX MCP 桥（CLI 内核）：read 隐藏写工具、Claude Code 的 approval_prompt 权限提示。
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
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function newSession(body: Record<string, unknown> = { agentIds: ['builtin'] }): Promise<any> {
  const res = await server.request('POST', '/api/sessions', { body })
  expect(res.status, res.text).toBe(201)
  return res.json.session
}
async function settings(patch: Record<string, unknown>): Promise<Record<string, string>> {
  const res = await server.request('PATCH', '/api/settings', { body: patch })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return res.json.settings
}
async function setLevel(sessionId: string, permissionLevel: string | null) {
  return server.request('PATCH', `/api/sessions/${sessionId}`, { body: { permissionLevel } })
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
  await settings({ autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false, toolLoading: 'all' })
})

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('纯函数', () => {
  it('toolGate：read 隐藏写工具、ask 询问、full 直接执行（组织级配置变更仍询问）', async () => {
    const { toolGate, minLevel, levelFromToolApproval, toolApprovalFromLevel } = await import('../src/services/permissions.js')
    const read = { risk: 'read' as const }
    const write = { risk: 'write' as const }
    const script = { risk: 'write' as const, approval: 'always' as const }
    const mcpAdd = { risk: 'write' as const, approval: 'always' as const, orgLevel: true }
    // 记忆工具（契约 §6.12）：approval='never' + personal —— “仅可查看”下隐藏，其他级别直接执行、不弹卡片
    const memory = { risk: 'write' as const, approval: 'never' as const, personal: true }
    expect([read, write, script, mcpAdd, memory].map((t) => toolGate('read', t))).toEqual(['auto', 'hidden', 'hidden', 'hidden', 'hidden'])
    expect([read, write, script, mcpAdd, memory].map((t) => toolGate('ask', t))).toEqual(['auto', 'ask', 'ask', 'ask', 'auto'])
    expect([read, write, script, mcpAdd, memory].map((t) => toolGate('full', t))).toEqual(['auto', 'auto', 'auto', 'ask', 'auto'])
    expect(minLevel('full', 'ask', 'full')).toBe('ask')
    expect(minLevel('full', 'read', 'ask')).toBe('read')
    expect(minLevel()).toBe('full')
    expect(levelFromToolApproval('auto')).toBe('full')
    expect(levelFromToolApproval('ask')).toBe('ask')
    expect(levelFromToolApproval(undefined)).toBe('ask')
    expect(['read', 'ask', 'full'].map((l) => toolApprovalFromLevel(l as 'read'))).toEqual(['ask', 'ask', 'auto'])
  })

  it('mcp_add / mcp_update / mcp_remove 标了 orgLevel；其他 approval=always 工具没有', async () => {
    const { skillTools } = await import('../src/services/skills/tools.js')
    const always = skillTools.filter((t) => t.approval === 'always')
    expect(always.filter((t) => t.orgLevel).map((t) => t.name).sort()).toEqual(['mcp_add', 'mcp_remove', 'mcp_update'])
    expect(always.filter((t) => !t.orgLevel).map((t) => t.name)).toEqual(expect.arrayContaining(['run_skill_script', 'skill_install']))
  })

  it('CLI 参数映射：每个内核 read / ask / full', async () => {
    const { applyKernelPermission, kernelAskSupport } = await import('../src/services/kernels/permissions.js')
    const { KERNELS } = await import('../src/services/kernels/catalog.js')
    const base = (id: string) => KERNELS.find((k) => k.id === id)!.args
    const run = (id: string, level: 'read' | 'ask' | 'full', mcp = false, args = base(id)) => applyKernelPermission(id, level, args, { mcp })

    // Claude Code：ask 有 LULUX MCP 时经审批卡片（permission-prompt-tool），否则退回只读
    expect(run('claude-code', 'read').args).toEqual([...base('claude-code'), '--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob'])
    const claudeAsk = run('claude-code', 'ask', true)
    expect(claudeAsk.level).toBe('ask')
    expect(claudeAsk.args.slice(-4)).toEqual(['--permission-mode', 'default', '--permission-prompt-tool', 'mcp__lulux__approval_prompt'])
    expect(run('claude-code', 'ask', false)).toMatchObject({ level: 'read' })
    expect(run('claude-code', 'ask', false).args).toContain('dontAsk')
    expect(run('claude-code', 'full').args.slice(-3)).toEqual(['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'])
    // 已有的权限参数被替换而不是重复
    const twice = run('claude-code', 'full', false, run('claude-code', 'read').args).args
    expect(twice.filter((a) => a === '--permission-mode')).toHaveLength(1)
    expect(twice).not.toContain('--tools')

    // Codex：sandbox；ask 退回 read-only；末尾的 `-`（stdin 提示词）保持在最后
    expect(run('codex', 'read').args).toEqual(base('codex'))
    const codexFull = run('codex', 'full').args
    expect(codexFull[codexFull.indexOf('--sandbox') + 1]).toBe('workspace-write')
    expect(codexFull.at(-1)).toBe('-')
    expect(run('codex', 'ask')).toMatchObject({ level: 'read' })
    expect(run('codex', 'ask').args).toContain('read-only')

    for (const id of ['gemini-cli', 'qwen-code']) {
      const mode = (level: 'read' | 'ask' | 'full') => {
        const args = run(id, level).args
        return args[args.indexOf('--approval-mode') + 1]
      }
      expect([mode('read'), mode('ask'), mode('full')]).toEqual(['plan', 'plan', 'yolo'])
      expect(run(id, 'full').args.filter((a) => a === '--approval-mode')).toHaveLength(1)
    }

    // Grok：full 去掉只读工具白名单、允许写文件
    expect(run('grok', 'read').args).toEqual(expect.arrayContaining(['--tools', 'read_file,list_dir,grep', '--always-approve']))
    expect(run('grok', 'read').env).toEqual({ GROK_WRITE_FILE: '0' })
    expect(run('grok', 'full').args).not.toContain('--tools')
    expect(run('grok', 'full').args).toContain('--always-approve')
    expect(run('grok', 'full').env).toEqual({ GROK_WRITE_FILE: '1' })

    // Hermes：toolsets；scoped 的 lulux（MCP）保留；full 加 file/terminal 与 --yolo
    const scopedHermes = [...base('hermes'), '--toolsets', 'skills,lulux']
    expect(run('hermes', 'read', true, scopedHermes).args.slice(-2)).toEqual(['--toolsets', 'skills,lulux'])
    expect(run('hermes', 'full', true, scopedHermes).args.slice(-3)).toEqual(['--toolsets', 'skills,file,terminal,lulux', '--yolo'])
    expect(run('hermes', 'read').args.slice(-2)).toEqual(['--toolsets', 'skills'])
    expect(run('hermes', 'ask')).toMatchObject({ level: 'read' })

    // Pi：工具白名单
    const piTools = (level: 'read' | 'full', mcp = false) => {
      const args = run('pi', level, mcp).args
      return args[args.indexOf('--tools') + 1]
    }
    expect(piTools('read')).toBe('read,grep,find,ls')
    expect(piTools('full')).toBe('read,bash,edit,write,grep,find,ls')
    expect(piTools('full', true)).toBe('read,bash,edit,write,grep,find,ls,mcp__lulux__*')

    expect(kernelAskSupport('claude-code', true)).toBe('card')
    expect(kernelAskSupport('claude-code', false)).toBe('readonly')
    for (const id of ['codex', 'gemini-cli', 'qwen-code', 'grok', 'hermes', 'pi']) expect(kernelAskSupport(id, true)).toBe('readonly')
  })
})

describe('迁移 20', () => {
  it('旧 toolApproval=auto → defaultPermissionLevel=full，sessions 加 permission_level 列；ask → ask；已有新键不覆盖', async () => {
    const migrations = await import('../src/db/migrations.js')
    const before = migrations.MIGRATIONS.filter((m) => m.version < 20)
    for (const [old, expected, preset] of [
      ['auto', 'full', null],
      ['ask', 'ask', null],
      ['auto', 'read', 'read'],
    ] as const) {
      const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'lulux-perm-mig-')), 'x.db'))
      migrations.runMigrations(db, {}, before)
      db.prepare("INSERT INTO settings (key, value) VALUES ('toolApproval', ?)").run(old)
      if (preset) db.prepare("INSERT INTO settings (key, value) VALUES ('defaultPermissionLevel', ?)").run(preset)
      expect(migrations.runMigrations(db).applied).toEqual(migrations.MIGRATIONS.filter((m) => m.version >= 20).map((m) => m.version))
      const row = db.prepare("SELECT value FROM settings WHERE key = 'defaultPermissionLevel'").get() as { value: string }
      expect(row.value).toBe(expected)
      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain('permission_level')
      db.close()
    }
  })
})

describe('接口', () => {
  it('旧键 toolApproval 与 defaultPermissionLevel 双向同步；非法值 400', async () => {
    expect(await settings({ toolApproval: 'auto' })).toMatchObject({ toolApproval: 'auto', defaultPermissionLevel: 'full' })
    expect(await settings({ defaultPermissionLevel: 'read' })).toMatchObject({ toolApproval: 'ask', defaultPermissionLevel: 'read' })
    expect(await settings({ defaultPermissionLevel: 'full' })).toMatchObject({ toolApproval: 'auto', defaultPermissionLevel: 'full' })
    expect(await settings({ toolApproval: 'ask' })).toMatchObject({ toolApproval: 'ask', defaultPermissionLevel: 'ask' })
    const bad = await server.request('PATCH', '/api/settings', { body: { defaultPermissionLevel: 'yolo' } })
    expect(bad.status).toBe(400)
  })

  it('GET /api/permissions：级别、默认、desktop 上限 full、各内核 ask 支持', async () => {
    const res = await server.request('GET', '/api/permissions')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ levels: ['read', 'ask', 'full'], defaultLevel: 'ask', cap: 'full', capsEnabled: false })
    expect(res.json.kernels['claude-code'].ask).toBe('card')
    expect(res.json.kernels.codex.ask).toBe('readonly')
    // global 模式没有 LULUX MCP：Claude Code 也只能退回只读
    await settings({ kernelModeClaudeCode: 'global' })
    expect((await server.request('GET', '/api/permissions')).json.kernels['claude-code'].ask).toBe('readonly')
    await settings({ kernelModeClaudeCode: 'scoped' })
    // desktop 模式没有团队上限接口
    expect((await server.request('GET', '/api/team/permission-caps')).status).toBe(404)
  })

  it('会话：新建默认 null（跟随默认）；新建可指定；PATCH 切换 / 恢复默认；非法值 400', async () => {
    const plain = await newSession()
    expect(plain.permissionLevel).toBeNull()
    const preset = await newSession({ agentIds: ['builtin'], permissionLevel: 'read' })
    expect(preset.permissionLevel).toBe('read')
    const full = await setLevel(plain.id, 'full')
    expect(full.status, full.text).toBe(200)
    expect(full.json.session.permissionLevel).toBe('full')
    expect((await server.request('GET', `/api/sessions/${plain.id}`)).json.session.permissionLevel).toBe('full')
    expect((await setLevel(plain.id, null)).json.session.permissionLevel).toBeNull()
    expect((await setLevel(plain.id, 'yolo')).status).toBe(400)
    const list = (await server.request('GET', '/api/sessions')).json.sessions
    expect(list.find((s: any) => s.id === preset.id).permissionLevel).toBe('read')
  })
})

describe('内置内核闸门', () => {
  async function runWrite(sessionId: string, decide?: (req: any) => Promise<void>) {
    const customer = (await server.request('POST', '/api/customers', { body: { company: `Perm ${Math.random()}` } })).json
    await script({ toolCalls: [{ id: 'u', name: 'update_customer', arguments: { customerId: customer.id, stage: 'won' } }] }, { text: '好的' })
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '改成赢单' } })
    if (decide) {
      let req: any = null
      for (let i = 0; i < 150 && !req; i += 1) {
        await sleep(30)
        req = (await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests[0] ?? null
      }
      expect(req, '应出现审批卡片').toBeTruthy()
      await decide(req)
    }
    const events = parseSse((await pending).text)
    const stage = (await server.request('GET', `/api/customers/${customer.id}`)).json.stage
    return { events, stage }
  }

  it('仅可查看：写工具不提供给模型；被调用也直接拒绝且不弹卡片', async () => {
    const session = await newSession({ agentIds: ['builtin'], permissionLevel: 'read' })
    const { events, stage } = await runWrite(session.id)
    const start = events.find((e) => e.event === 'start')!.data
    expect(start.permissionLevel).toBe('read')
    expect(start.tools.length).toBeGreaterThan(0)
    // 只剩读工具（记忆工具也不提供）
    expect(start.tools.every((t: any) => t.risk === 'read')).toBe(true)
    expect(start.tools.some((t: any) => t.name.startsWith('memory_'))).toBe(false)
    const offered = (await mockRequests()).at(-2).tools.map((t: any) => t.function.name)
    expect(offered).toContain('search_customers')
    expect(offered).not.toContain('memory_add')
    expect(offered).not.toContain('update_customer')
    expect(offered.some((n: string) => /^(skill_install|mcp_add|run_skill_script|workspace_write)/.test(n))).toBe(false)
    // 模型硬要调用没提供的写工具：明确说明“仅可查看”，记在 LULUX 名下，不执行、不弹卡片
    const refused = events.find((e) => e.event === 'tool_result')!.data
    expect(refused).toMatchObject({ ok: false, server: 'LULUX', name: 'update_customer' })
    expect(refused.result).toContain('仅可查看')
    expect(events.some((e) => e.event === 'tool_request')).toBe(false)
    expect(stage).toBe('lead')
  })

  it('完全权限：写工具直接执行，不弹卡片', async () => {
    const session = await newSession({ agentIds: ['builtin'], permissionLevel: 'full' })
    const { events, stage } = await runWrite(session.id)
    expect(events.find((e) => e.event === 'tool_request')!.data).toMatchObject({ name: 'update_customer', auto: true })
    expect(events.find((e) => e.event === 'tool_result')!.data).toMatchObject({ ok: true, approved: true })
    expect(stage).toBe('won')
  })

  it('需审批：弹卡片，批准后执行；默认级别跟随设置（null 会话）', async () => {
    await settings({ defaultPermissionLevel: 'ask' })
    const session = await newSession()
    const { events, stage } = await runWrite(session.id, async (req) => {
      expect(req).toMatchObject({ name: 'update_customer', risk: 'write' })
      await server.request('POST', '/api/chat/tool-decision', { body: { requestId: req.requestId, approved: true } })
    })
    expect(events.find((e) => e.event === 'tool_request')!.data.auto).toBe(false)
    expect(stage).toBe('won')
    // 全局默认改成 full：跟随默认的会话直接执行
    await settings({ defaultPermissionLevel: 'full' })
    expect((await runWrite(session.id)).stage).toBe('won')
    await settings({ defaultPermissionLevel: 'ask' })
  })

  it('群聊：级别作用于群里全部内置成员', async () => {
    const group = await newSession({ kind: 'group', agentIds: ['lux-trade', 'lux-analyst'], supervisorId: 'none', permissionLevel: 'read' })
    const res = await server.request('POST', '/api/chat', { body: { sessionId: group.id, content: '大家看看', targetAgentIds: ['lux-trade'] } })
    const start = parseSse(res.text).find((e) => e.event === 'start')!.data
    expect(start.permissionLevel).toBe('read')
    expect(start.tools.every((t: any) => t.risk === 'read')).toBe(true)
  })

  it('仅可查看：不提供记忆工具；模型硬调用 memory_add 被拒绝、不写入', async () => {
    const session = await newSession({ agentIds: ['builtin'], permissionLevel: 'read' })
    const content = `只读会话不能写记忆 ${Math.random().toString(36).slice(2, 8)}`
    await script({ toolCalls: [{ id: 'm', name: 'memory_add', arguments: { section: 'notes', content } }] }, { text: '好的' })
    const events = parseSse((await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '记住这个' } })).text)
    const start = events.find((e) => e.event === 'start')!.data
    expect(start.permissionLevel).toBe('read')
    expect(start.tools.map((t: any) => t.name)).not.toContain('memory_add')
    const offered = (await mockRequests()).at(-2).tools.map((t: any) => t.function.name)
    expect(offered).not.toContain('memory_add')
    expect(offered).not.toContain('memory_replace')
    expect(offered).not.toContain('memory_remove')
    expect(events.some((e) => e.event === 'tool_request')).toBe(false)
    const result = events.find((e) => e.event === 'tool_result')!.data
    expect(result).toMatchObject({ name: 'memory_add', ok: false, server: 'LULUX' })
    expect(result.result).toContain('仅可查看')
    const notes = (await server.request('GET', '/api/memory')).json.notes.entries.map((e: any) => e.content)
    expect(notes).not.toContain(content)
    // 用户自己经 REST / 设置页管理记忆不受会话级别影响
    expect((await server.request('POST', '/api/memory/entries', { body: { section: 'notes', content } })).status).toBe(201)
    await server.request('DELETE', '/api/memory?section=notes')
  })

  it('非交互运行（工作流 / 定时任务）：不提供记忆工具，硬调用也被拒绝', async () => {
    const { setNonInteractiveApproval, clearNonInteractiveApproval } = await import('../src/services/tool-approval.js')
    const session = await newSession({ agentIds: ['builtin'], permissionLevel: 'full' })
    const content = `非交互不能写记忆 ${Math.random().toString(36).slice(2, 8)}`
    setNonInteractiveApproval(session.id, true)
    try {
      await script({ toolCalls: [{ id: 'm', name: 'memory_add', arguments: { section: 'notes', content } }] }, { text: '好的' })
      const events = parseSse((await server.request('POST', '/api/chat', { body: { sessionId: session.id, content: '记住这个' } })).text)
      const start = events.find((e) => e.event === 'start')!.data
      expect(start.tools.map((t: any) => t.name)).not.toContain('memory_add')
      expect(start.tools.map((t: any) => t.name)).toContain('update_customer')
      const offered = (await mockRequests()).at(-2).tools.map((t: any) => t.function.name)
      expect(offered).not.toContain('memory_add')
      const result = events.find((e) => e.event === 'tool_result')!.data
      expect(result).toMatchObject({ name: 'memory_add', ok: false })
      expect(result.result).toContain('非交互')
    } finally {
      clearNonInteractiveApproval(session.id)
    }
    const notes = (await server.request('GET', '/api/memory')).json.notes.entries.map((e: any) => e.content)
    expect(notes).not.toContain(content)
  })
})

describe('LULUX MCP 桥（CLI 内核）', () => {
  async function issue(kernelId: string, sessionId: string, onRequest?: (payload: any) => void) {
    const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const events: Array<{ event: string; payload: any }> = []
    const issued = luluxMcpTokens.issue({
      actor: { ...LOCAL_ACTOR },
      kernelId,
      bridge: {
        sessionId,
        agentId: `kernel-${kernelId}`,
        signal: new AbortController().signal,
        send: (event, payload) => {
          events.push({ event, payload })
          if (event === 'tool_request') onRequest?.(payload)
        },
        trace: () => undefined,
      },
    })
    let id = 0
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
    return { issued, events, rpc }
  }

  it('仅可查看：tools/list 只有读工具，调用写工具直接拒绝；切到完全权限后可用', async () => {
    const session = await newSession({ agentIds: ['kernel-codex'], permissionLevel: 'read' })
    const bridge = await issue('codex', session.id)
    try {
      const tools = (await bridge.rpc('tools/list')).result.tools
      expect(tools.map((t: any) => t.name)).toContain('search_customers')
      expect(tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true)
      expect(tools.map((t: any) => t.name)).not.toContain('approval_prompt')
      const res = await bridge.rpc('tools/call', { name: 'create_customer', arguments: { company: 'Should Not Exist' } })
      expect(res.result.isError).toBe(true)
      expect(res.result.content[0].text).toContain('仅可查看')
      expect(bridge.events.filter((e) => e.event === 'tool_request')).toHaveLength(0)
      await setLevel(session.id, 'full')
      const names = (await bridge.rpc('tools/list')).result.tools.map((t: any) => t.name)
      expect(names).toContain('create_customer')
      const created = await bridge.rpc('tools/call', { name: 'create_customer', arguments: { company: 'Full Co' } })
      expect(created.result.isError).toBe(false)
      expect(bridge.events.find((e) => e.event === 'tool_request')!.payload.auto).toBe(true)
    } finally {
      bridge.issued.revoke()
    }
  })

  it('仅可查看 / 非交互：桥上不列出记忆工具，tools/call memory_add 直接拒绝（CLI 内核）', async () => {
    const session = await newSession({ agentIds: ['kernel-codex'], permissionLevel: 'read' })
    const bridge = await issue('codex', session.id)
    const content = `经 MCP 只读会话不能写记忆 ${Math.random().toString(36).slice(2, 8)}`
    try {
      const names = (await bridge.rpc('tools/list')).result.tools.map((t: any) => t.name)
      expect(names.some((n: string) => n.startsWith('memory_'))).toBe(false)
      expect(names).toContain('search_customers')
      const res = await bridge.rpc('tools/call', { name: 'memory_add', arguments: { section: 'notes', content } })
      expect(res.result.isError).toBe(true)
      expect(res.result.content[0].text).toContain('仅可查看')
      expect(bridge.events.filter((e) => e.event === 'tool_request')).toHaveLength(0)
    } finally {
      bridge.issued.revoke()
    }
    // 非交互（完全权限）：同样不列、不执行
    const { setNonInteractiveApproval, clearNonInteractiveApproval } = await import('../src/services/tool-approval.js')
    const auto = await newSession({ agentIds: ['kernel-codex'], permissionLevel: 'full' })
    const bridge2 = await issue('codex', auto.id)
    setNonInteractiveApproval(auto.id, true)
    try {
      const names = (await bridge2.rpc('tools/list')).result.tools.map((t: any) => t.name)
      expect(names.some((n: string) => n.startsWith('memory_'))).toBe(false)
      expect(names).toContain('create_customer')
      const res = await bridge2.rpc('tools/call', { name: 'memory_add', arguments: { section: 'notes', content } })
      expect(res.result.isError).toBe(true)
      expect(res.result.content[0].text).toContain('非交互')
    } finally {
      clearNonInteractiveApproval(auto.id)
      bridge2.issued.revoke()
    }
    expect((await server.request('GET', '/api/memory')).json.notes.entries.map((e: any) => e.content)).not.toContain(content)
  })

  it('Claude Code 需审批：approval_prompt 把自带工具的权限请求变成审批卡片（批准 allow / 拒绝 deny / 本会话始终允许）', async () => {
    const session = await newSession({ agentIds: ['kernel-claude-code'], permissionLevel: 'ask' })
    const { resolveApproval } = await import('../src/services/tool-approval.js')
    let decision: { approved: boolean; remember?: 'session' } = { approved: false }
    const bridge = await issue('claude-code', session.id, (payload) => setTimeout(() => resolveApproval(payload.requestId, decision.approved, decision.remember), 20))
    try {
      const tools = (await bridge.rpc('tools/list')).result.tools.map((t: any) => t.name)
      expect(tools).toContain('approval_prompt')
      const ask = (input: Record<string, unknown>) => bridge.rpc('tools/call', { name: 'approval_prompt', arguments: { tool_name: 'Bash', input, tool_use_id: 'tu_1' } })
      const denied = JSON.parse((await ask({ command: 'rm -rf build' })).result.content[0].text)
      expect(denied.behavior).toBe('deny')
      const card = bridge.events.find((e) => e.event === 'tool_request')!.payload
      expect(card).toMatchObject({ name: 'Bash', server: 'Claude Code', auto: false, risk: 'write', via: 'permission_prompt', canRemember: true })
      decision = { approved: true, remember: 'session' }
      expect(JSON.parse((await ask({ command: 'ls' })).result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
      decision = { approved: false }
      // 本会话已始终允许 Bash：不再询问
      expect(JSON.parse((await ask({ command: 'pwd' })).result.content[0].text).behavior).toBe('allow')
      expect(bridge.events.filter((e) => e.event === 'tool_request').map((e) => e.payload.auto)).toEqual([false, false, true])
      // 其他内核 / 其他级别不提供 approval_prompt
      await setLevel(session.id, 'full')
      expect((await bridge.rpc('tools/list')).result.tools.map((t: any) => t.name)).not.toContain('approval_prompt')
    } finally {
      bridge.issued.revoke()
    }
    const codexSession = await newSession({ agentIds: ['kernel-codex'], permissionLevel: 'ask' })
    const codex = await issue('codex', codexSession.id)
    try {
      expect((await codex.rpc('tools/list')).result.tools.map((t: any) => t.name)).not.toContain('approval_prompt')
    } finally {
      codex.issued.revoke()
    }
  })
})
