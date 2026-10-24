import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeKernelPackage, parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * Hermes Agent / Pi 两个新内核：
 * - scopedLaunch 生成的隔离配置（网关地址、一次性令牌只走环境变量、LULUX MCP、只读工具）；
 * - 输出事件流的解析（替身 CLI，含 Pi 自动重试 / 最终失败、Hermes result.error）；
 * 真实 CLI 经内置 LULUX MCP 的实测见 kernel-mcp-hermes-pi-real.test.ts。
 */
const provider = { id: 'p', name: 'Mock', kind: 'openai', baseUrl: 'x', model: 'mock-model', models: ['mock-model'] } as any

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

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-real-key-1234567', model: 'mock-model' },
  })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('scopedLaunch：Hermes Agent / Pi', () => {
  it('Hermes：HERMES_HOME 隔离，config.yaml 声明 lulux provider（key_env，不落令牌），MCP 头用 ${LULUX_MCP_TOKEN} 插值，只开 skills + LULUX MCP', async () => {
    const { scopedLaunch } = await import('../src/services/kernels/scoped.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const home = join(server.home, 'launch-hermes')
    const launch = scopedLaunch(findKernel('hermes')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home, mcpToken: 'lulux-mcp-abc' })
    expect(launch.env).toEqual({ HERMES_HOME: home, LULUX_GATEWAY_KEY: 'gw-token', LULUX_MCP_TOKEN: 'lulux-mcp-abc' })
    expect(launch.args).toEqual([
      'chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--source', 'tool',
      '--provider', 'lulux', '--model', 'mock-model', '--ignore-rules', '--toolsets', 'skills,lulux',
    ])
    const text = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(text).not.toContain('gw-token')
    expect(text).not.toContain('lulux-mcp-abc')
    const config = JSON.parse(text)
    expect(config.model).toEqual({ provider: 'lulux', default: 'mock-model' })
    expect(config.providers.lulux).toEqual({ base_url: 'http://127.0.0.1:1234/gateway/openai/v1', key_env: 'LULUX_GATEWAY_KEY' })
    expect(config.tools.tool_search.enabled).toBe('off')
    expect(config.mcp_servers.lulux).toMatchObject({ url: 'http://127.0.0.1:1234/gateway/mcp', headers: { Authorization: 'Bearer ${LULUX_MCP_TOKEN}' } })

    const without = scopedLaunch(findKernel('hermes')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home })
    expect(without.args.at(-1)).toBe('skills')
    expect(without.env.LULUX_MCP_TOKEN).toBeUndefined()
    expect(JSON.parse(readFileSync(join(home, 'config.yaml'), 'utf8')).mcp_servers).toBeUndefined()
  })

  it('Pi：PI_CODING_AGENT_DIR 隔离，models.json 的 lulux provider 用 $LULUX_GATEWAY_KEY，mcp.json direct 暴露，--tools 只读 + mcp__lulux__*', async () => {
    const { scopedLaunch } = await import('../src/services/kernels/scoped.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const home = join(server.home, 'launch-pi')
    const launch = scopedLaunch(findKernel('pi')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home, mcpToken: 'lulux-mcp-abc' })
    expect(launch.env).toMatchObject({ PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', LULUX_GATEWAY_KEY: 'gw-token', LULUX_MCP_TOKEN: 'lulux-mcp-abc' })
    expect(launch.args).toEqual(['--mode', 'json', '--no-session', '--tools', 'read,grep,find,ls,mcp__lulux__*', '--provider', 'lulux', '--model', 'mock-model'])
    const models = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(models.providers.lulux).toEqual({
      baseUrl: 'http://127.0.0.1:1234/gateway/openai/v1',
      api: 'openai-completions',
      apiKey: '$LULUX_GATEWAY_KEY',
      models: [{ id: 'mock-model' }],
    })
    const mcp = readFileSync(join(home, 'mcp.json'), 'utf8')
    expect(mcp).not.toContain('lulux-mcp-abc')
    expect(JSON.parse(mcp).mcpServers.lulux).toMatchObject({ url: 'http://127.0.0.1:1234/gateway/mcp', exposure: 'direct', headers: { Authorization: 'Bearer ${LULUX_MCP_TOKEN}' } })

    const without = scopedLaunch(findKernel('pi')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home })
    expect(without.args).toContain('read,grep,find,ls')
    expect(existsSync(join(home, 'mcp.json'))).toBe(false)
  })

  it('scoped 环境剥掉用户自己的 Hermes / Pi 配置变量', async () => {
    const { scopedBaseEnv } = await import('../src/services/kernels/scoped.js')
    const env = scopedBaseEnv({ PATH: '/bin', HERMES_HOME: '/home/u/.hermes', NOUS_API_KEY: 'k', PI_CODING_AGENT_DIR: '/home/u/.pi', PIP_INDEX_URL: 'x' })
    expect(env.HERMES_HOME).toBeUndefined()
    expect(env.NOUS_API_KEY).toBeUndefined()
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(env.PIP_INDEX_URL).toBe('x')
    expect(env.PATH).toBe('/bin')
  })
})

describe('事件流解析（替身 CLI）', () => {
  async function runWith(kernelId: 'pi' | 'hermes', script: string) {
    const pkg = kernelId === 'pi' ? ['@earendil-works/pi-coding-agent', 'pi', 'dist/bundle/cli.js'] : ['hermes-agent', 'hermes', 'bin/hermes.js']
    rmSync(join(server.home, 'kernels', kernelId), { recursive: true, force: true })
    fakeKernelPackage(join(server.home, 'kernels'), kernelId, pkg[0]!, pkg[1]!, pkg[2]!, script)
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: [`kernel-${kernelId}`] } })
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: 'hi' } })
    return parseSse(res.text)
  }
  const OUT = `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n'); process.stdin.resume(); process.stdin.on('end', () => {`

  it('Pi：连接错误后自动重试成功 → 只算成功的回答；U+2028 不切断 JSON 行', async () => {
    const events = await runWith('pi', `${OUT}
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Connection error.', content: [] } })
  out({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: 'Connection error.' })
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第一行\\u2028同一行' } })
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ignored' }] } })
  out({ type: 'agent_settled', aborted: false })
})`)
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('第一行\u2028同一行')
  })

  it('Pi：没有流式增量时用 message_end 的完整内容；最终 error 报 KERNEL_FAILED 并带原因', async () => {
    let events = await runWith('pi', `${OUT}
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '整段回答' }] } })
  out({ type: 'agent_settled', aborted: false })
})`)
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('整段回答')
    events = await runWith('pi', `${OUT}
  out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '400 model not found', content: [] } })
  out({ type: 'agent_settled', aborted: false })
  process.exitCode = 1
})`)
    const error = events.find((e) => e.event === 'error')!
    expect(error.data.code).toBe('KERNEL_FAILED')
    expect(error.data.message).toContain('400 model not found')
  })

  it('Hermes：text 增量拼接；result.error 报 KERNEL_FAILED；只有 result.text 时用它兜底', async () => {
    let events = await runWith('hermes', `${OUT}
  out({ type: 'system', subtype: 'init', model: 'mock-model', session_id: 's' })
  out({ type: 'text', text: '你好，' })
  out({ type: 'text', text: '我是 Hermes。' })
  out({ type: 'result', exit_code: 0, text: '你好，我是 Hermes。' })
})`)
    expect(events.find((e) => e.event === 'done')!.data.message).toMatchObject({ content: '你好，我是 Hermes。', senderAgentId: 'kernel-hermes' })
    events = await runWith('hermes', `${OUT}
  out({ type: 'result', exit_code: 0, text: '只有最终结果' })
})`)
    expect(events.find((e) => e.event === 'done')!.data.message.content).toBe('只有最终结果')
    events = await runWith('hermes', `${OUT}
  out({ type: 'result', exit_code: 1, error: 'Provider returned 500' })
  process.exitCode = 1
})`)
    const error = events.find((e) => e.event === 'error')!
    expect(error.data.code).toBe('KERNEL_FAILED')
    expect(error.data.message).toContain('Provider returned 500')
  })
})
