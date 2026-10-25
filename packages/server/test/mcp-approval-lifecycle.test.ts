import { request as httpRequest } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * LULUX MCP 审批与调用生命周期（审计 2026-10-24 #5）：
 * CLI 侧已超时断开、或内核运行已结束时，审批卡片作废，之后批准也不会执行写操作；
 * 各 CLI 的 MCP 工具超时不小于审批等待时长。
 */
let server: TestServer
beforeAll(async () => {
  server = await startTestServer({})
})
afterAll(async () => {
  await server.close()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function issueFor(sessionId: string) {
  const { luluxMcpTokens } = await import('../src/services/lulux-mcp/server.js')
  const { LOCAL_ACTOR } = await import('../src/context.js')
  const seen = { requestId: '', results: [] as any[] }
  const issued = luluxMcpTokens.issue({
    actor: LOCAL_ACTOR as any,
    kernelId: 'codex',
    bridge: {
      sessionId,
      agentId: 'kernel-codex',
      signal: new AbortController().signal,
      send: (event, payload: any) => {
        if (event === 'tool_request') seen.requestId = payload.requestId
        if (event === 'tool_result') seen.results.push(payload)
      },
      trace: () => undefined,
    },
  })
  return { issued, seen }
}

function callCreateTask(token: string, title: string) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title } } })
  let response = ''
  const req = httpRequest({
    host: '127.0.0.1',
    port: server.port,
    method: 'POST',
    path: '/gateway/mcp',
    headers: { Host: `127.0.0.1:${server.port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    res.on('data', (chunk) => (response += chunk))
  })
  req.on('error', () => undefined)
  req.end(body)
  return { req, response: () => response }
}

async function taskTitles(): Promise<string[]> {
  return (await server.request('GET', '/api/tasks?status=all')).json.items.map((task: any) => task.title)
}

describe('LULUX MCP 审批生命周期', () => {
  it('CLI 侧超时断开后审批卡片作废：之后批准返回已过期，写操作不执行', async () => {
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-codex'], permissionLevel: 'ask' } })
    const sessionId = session.json.session.id
    const { issued, seen } = await issueFor(sessionId)
    const call = callCreateTask(issued.token, '断开后不应创建的任务')
    for (let i = 0; i < 40 && !seen.requestId; i += 1) await sleep(50)
    expect(seen.requestId).not.toBe('')
    call.req.destroy() // CLI 侧超时
    await sleep(300)
    const pending = await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)
    expect(pending.json.requests).toHaveLength(0)
    const decided = await server.request('POST', '/api/chat/tool-decision', { body: { requestId: seen.requestId, approved: true } })
    expect(decided.status).toBe(404)
    await sleep(200)
    expect(await taskTitles()).not.toContain('断开后不应创建的任务')
    // 卡片按拒绝收起，轨迹里说明原因
    expect(seen.results.at(-1)).toMatchObject({ approved: false })
    expect(seen.results.at(-1).result).toContain('审批已作废')
    issued.revoke()
  })

  it('内核运行结束（令牌吊销）时，名下等待中的审批一律作废', async () => {
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-codex'], permissionLevel: 'ask' } })
    const sessionId = session.json.session.id
    const { issued, seen } = await issueFor(sessionId)
    const call = callCreateTask(issued.token, '运行结束后不应创建的任务')
    for (let i = 0; i < 40 && !seen.requestId; i += 1) await sleep(50)
    expect(seen.requestId).not.toBe('')
    issued.revoke()
    await sleep(300)
    expect((await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests).toHaveLength(0)
    expect((await server.request('POST', '/api/chat/tool-decision', { body: { requestId: seen.requestId, approved: true } })).status).toBe(404)
    await sleep(200)
    expect(await taskTitles()).not.toContain('运行结束后不应创建的任务')
    expect(call.response()).toContain('审批已作废')
  })

  it('连接仍在时批准照常执行', async () => {
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-codex'], permissionLevel: 'ask' } })
    const sessionId = session.json.session.id
    const { issued, seen } = await issueFor(sessionId)
    const call = callCreateTask(issued.token, '正常批准的任务')
    for (let i = 0; i < 40 && !seen.requestId; i += 1) await sleep(50)
    expect((await server.request('POST', '/api/chat/tool-decision', { body: { requestId: seen.requestId, approved: true } })).status).toBe(200)
    for (let i = 0; i < 40 && !call.response(); i += 1) await sleep(50)
    expect(await taskTitles()).toContain('正常批准的任务')
    issued.revoke()
  })

  it('各 CLI 的 LULUX MCP 工具超时不小于审批等待时长', async () => {
    const { scopedLaunch } = await import('../src/services/kernels/scoped.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const { approvalTimeoutMs } = await import('../src/services/tool-approval.js')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const provider = { id: 'p', name: 'P', kind: 'openai', baseUrl: 'http://x/v1', model: 'm' } as any
    const ctx = (id: string) => ({ token: 't', port: 1, provider, model: 'm', home: join(server.home, 'scoped-timeout', id), mcpToken: 'mcp' })
    const minSeconds = approvalTimeoutMs() / 1000
    const codex = scopedLaunch(findKernel('codex')!, ctx('codex'))
    const codexTimeout = codex.args.find((arg) => arg.startsWith('mcp_servers.lulux.tool_timeout_sec='))
    expect(Number(codexTimeout?.split('=')[1])).toBeGreaterThanOrEqual(minSeconds)
    const claude = scopedLaunch(findKernel('claude-code')!, ctx('claude'))
    expect(Number(claude.env.MCP_TOOL_TIMEOUT)).toBeGreaterThanOrEqual(approvalTimeoutMs())
    scopedLaunch(findKernel('gemini-cli')!, ctx('gemini'))
    const gemini = JSON.parse(readFileSync(join(ctx('gemini').home, '.gemini', 'settings.json'), 'utf8'))
    expect(gemini.mcpServers.lulux.timeout).toBeGreaterThanOrEqual(approvalTimeoutMs())
  })
})
