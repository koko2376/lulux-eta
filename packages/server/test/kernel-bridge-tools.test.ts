import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * LULUX MCP 桥（给 Claude Code / Codex / Hermes / Pi … 等命令行内核用）除了业务工具，
 * 还要带上用户在 LULUX 里装的 MCP Server 工具与 skill 工具：任何内核的会话都能用 LULUX 里装的 skill 与 MCP。
 */
let server: TestServer

/** 最小 stdio MCP Server：一个查价工具 */
const MCP_SCRIPT = `
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  let result = {}
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'price', version: '1' } }
  if (msg.method === 'tools/list') result = { tools: [{ name: 'lookup.price', description: 'price lookup', inputSchema: { type: 'object', properties: { sku: { type: 'string' } } } }] }
  if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'PRICE=42 for ' + msg.params.arguments.sku }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
})`

interface Captured {
  events: Array<{ event: string; payload: any }>
  trace: any[]
}

async function issue(actorOverride?: Record<string, unknown>, onRequest?: (payload: any) => void, permissionLevel?: 'read' | 'ask' | 'full') {
  const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
  const { LOCAL_ACTOR } = await import('../src/context.js')
  const captured: Captured = { events: [], trace: [] }
  const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-claude-code'], ...(permissionLevel ? { permissionLevel } : {}) } })
  const issued = luluxMcpTokens.issue({
    actor: { ...LOCAL_ACTOR, ...(actorOverride ?? {}) } as typeof LOCAL_ACTOR,
    kernelId: 'claude-code',
    bridge: {
      sessionId: session.json.session.id,
      agentId: 'kernel-claude-code',
      signal: new AbortController().signal,
      send: (event, payload) => {
        captured.events.push({ event, payload })
        if (event === 'tool_request') onRequest?.(payload)
      },
      trace: (entry) => captured.trace.push(entry),
    },
  })
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown> = {}) =>
    (await server.request('POST', '/gateway/mcp', { token: issued.token, body: { jsonrpc: '2.0', id: ++id, method, params } })).json
  return { issued, captured, rpc }
}

const textOf = (res: any): string => res.result.content[0].text

beforeAll(async () => {
  server = await startTestServer({})
  const { setConfirmChannelForTests } = await import('../src/services/mcp/confirm.js')
  setConfirmChannelForTests({ available: () => true, request: async () => true })
  const mcp = await server.request('POST', '/api/mcp/servers', { body: { name: 'Price Book', command: process.execPath, args: ['-e', MCP_SCRIPT] } })
  expect(mcp.status, mcp.text).toBe(201)
})

afterAll(async () => {
  const { mcpRuntime } = await import('../src/services/mcp/runtime.js')
  mcpRuntime.closeAll()
  await server.close()
})

describe('LULUX MCP 桥：用户 MCP 与 skill 工具', () => {
  it('tools/list：业务 + skill + 用户 MCP（<server>__<tool>），不含工作区与自配置工具', async () => {
    const { issued, rpc } = await issue()
    try {
      const names: string[] = (await rpc('tools/list')).result.tools.map((t: any) => t.name)
      expect(names).toEqual(expect.arrayContaining(['search_customers', 'skill_list', 'skill_view', 'run_skill_script', 'price_book__lookup_price']))
      expect(names.some((n) => /^(workspace_|fetch_url|skill_install|mcp_add|mcp_)/.test(n))).toBe(false)
      for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,48}$/)
      const tool = (await rpc('tools/list')).result.tools.find((t: any) => t.name === 'price_book__lookup_price')
      expect(tool.description).toContain('[Price Book]')
      expect(tool.annotations.readOnlyHint).toBe(false)
    } finally {
      issued.revoke()
    }
  })

  it('调用用户 MCP 工具：auto 直接执行，轨迹显示原工具名与 Server；ask 时等审批，拒绝不执行；记住后同会话不再问', async () => {
    await server.request('PATCH', '/api/settings', { body: { toolApproval: 'auto' } })
    const auto = await issue()
    try {
      const res = await auto.rpc('tools/call', { name: 'price_book__lookup_price', arguments: { sku: 'BV-25' } })
      expect(res.result.isError).toBe(false)
      expect(textOf(res)).toBe('PRICE=42 for BV-25')
      expect(auto.captured.trace[0]).toMatchObject({ name: 'lookup.price', server: 'Price Book', ok: true, approved: true, builtin: false, risk: 'write' })
      expect(auto.captured.events.find((e) => e.event === 'tool_request')!.payload).toMatchObject({ auto: true, via: 'mcp', name: 'lookup.price' })
    } finally {
      auto.issued.revoke()
    }

    await server.request('PATCH', '/api/settings', { body: { toolApproval: 'ask' } })
    const { resolveApproval } = await import('../src/services/tool-approval.js')
    let decision: { approved: boolean; remember?: 'session' } = { approved: false }
    const ask = await issue(undefined, (payload) => setTimeout(() => resolveApproval(payload.requestId, decision.approved, decision.remember), 20))
    try {
      const denied = await ask.rpc('tools/call', { name: 'price_book__lookup_price', arguments: { sku: 'X' } })
      expect(denied.result.isError).toBe(true)
      expect(textOf(denied)).toContain('拒绝')
      expect(ask.captured.events.find((e) => e.event === 'tool_request')!.payload).toMatchObject({ auto: false, server: 'Price Book', canRemember: true })
      decision = { approved: true, remember: 'session' }
      expect(textOf(await ask.rpc('tools/call', { name: 'price_book__lookup_price', arguments: { sku: 'Y' } }))).toBe('PRICE=42 for Y')
      decision = { approved: false }
      // 本会话已记住：不再询问（否则会被上面的 decision 拒绝）
      expect(textOf(await ask.rpc('tools/call', { name: 'price_book__lookup_price', arguments: { sku: 'Z' } }))).toBe('PRICE=42 for Z')
      expect(ask.captured.events.filter((e) => e.event === 'tool_request').map((e) => e.payload.auto)).toEqual([false, false, true])
    } finally {
      ask.issued.revoke()
      await server.request('PATCH', '/api/settings', { body: { toolApproval: 'auto' } })
    }
  })

  it('用户 MCP 调用写审计日志；viewer 身份调用返回无权限', async () => {
    const audit = await server.request('GET', '/api/audit?limit=50')
    const items = audit.json.items ?? audit.json.entries ?? audit.json.logs ?? []
    expect(JSON.stringify(items)).toContain('Price Book')
    const viewer = await issue({ role: 'viewer' })
    try {
      const res = await viewer.rpc('tools/call', { name: 'price_book__lookup_price', arguments: { sku: 'V' } })
      expect(res.result.isError).toBe(true)
      expect(textOf(res)).toContain('没有权限')
    } finally {
      viewer.issued.revoke()
    }
  })

  it('skill 工具：skill_list / skill_view 按该内核的 skill 配置；需审批会话里 run_skill_script 弹卡片', async () => {
    const { issued, rpc, captured } = await issue(undefined, async (payload) => {
      const { resolveApproval } = await import('../src/services/tool-approval.js')
      setTimeout(() => resolveApproval(payload.requestId, false), 20)
    }, 'ask')
    try {
      const list = await rpc('tools/call', { name: 'skill_list', arguments: {} })
      expect(list.result.isError).toBe(false)
      expect(textOf(list)).toContain('inquiry-triage')
      const view = await rpc('tools/call', { name: 'skill_view', arguments: { name: 'inquiry-triage' } })
      expect(view.result.isError, textOf(view)).toBe(false)
      const run = await rpc('tools/call', { name: 'run_skill_script', arguments: { skill: 'inquiry-triage', script: 'x.cjs' } })
      expect(run.result.isError).toBe(true)
      const request = captured.events.filter((e) => e.event === 'tool_request').at(-1)!.payload
      expect(request).toMatchObject({ name: 'run_skill_script', auto: false, approvalKind: 'skill_script', server: 'LULUX', toolKey: 'run_skill_script:inquiry-triage' })

      await server.request('PUT', '/api/agents/kernel-claude-code/skills', { body: { mode: 'none' } })
      const hidden = await rpc('tools/call', { name: 'skill_view', arguments: { name: 'inquiry-triage' } })
      expect(hidden.result.isError).toBe(true)
    } finally {
      await server.request('PUT', '/api/agents/kernel-claude-code/skills', { body: { mode: 'all' } })
      issued.revoke()
    }
  })
})
