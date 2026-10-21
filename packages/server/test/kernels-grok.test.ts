import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeKernelPackage, GATEWAY_CALL_JS, parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * Grok（xAI 官方 Grok Build CLI，npm @xai-official/grok）：
 * - scopedLaunch：GROK_HOME 隔离，config.toml 的自定义模型 [model.lulux] 指向本机网关（env_key，令牌不落盘），
 *   旁路模型（标题 / 摘要）也走 lulux，关闭 Claude / Cursor 兼容扫描，LULUX MCP 用 bearer_token_env_var；
 * - 提示词经 --prompt-file（运行结束删除），streaming-json 解析；
 * - 原生二进制解压、npmmirror 旧版本过滤、skill 同步目录、选择器里的 Grok 行。
 * 真实 CLI 的实测见 kernel-mcp-hermes-pi-real.test.ts（grok 一项）。
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

/** 替身 Grok：读 --prompt-file，按 $GROK_HOME/config.toml 的 [model.<-m>] 调网关，输出 streaming-json */
const FAKE_GROK_JS = `${GATEWAY_CALL_JS}
const fs = require('fs'); const path = require('path')
;(async () => {
  const prompt = fs.readFileSync(argOf('--prompt-file'), 'utf8')
  const toml = fs.readFileSync(path.join(process.env.GROK_HOME, 'config.toml'), 'utf8')
  const section = toml.split('[model.' + argOf('-m') + ']')[1].split('\\n[')[0]
  const field = (k) => JSON.parse(section.match(new RegExp('^' + k + ' = (.*)$', 'm'))[1])
  out({ type: 'available_commands', tools: ['read_file'] })
  await callGateway(field('base_url'), process.env[field('env_key')], field('model'), prompt + ' | file=' + argOf('--prompt-file'), (data) => out({ type: 'text', data }))
  out({ type: 'usage' })
  out({ type: 'end', stopReason: 'end_turn', sessionId: 's' })
})().catch((e) => { out({ type: 'error', message: 'Internal error: ' + String(e.message || e) }); process.exit(1) })
`

describe('Grok：目录与 scoped 配置', () => {
  it('选择器里有 Grok 行（SpaceXAI · npm，原版 grok.png 头像），排在 Pi 之后', async () => {
    const agents = (await server.request('GET', '/api/agents')).json.agents as Array<{ id: string; name: string; avatar: string; kind: string; kernelId: string }>
    const ids = agents.map((a) => a.id)
    expect(ids.indexOf('kernel-grok')).toBe(ids.indexOf('kernel-pi') + 1)
    expect(agents.find((a) => a.id === 'kernel-grok')).toMatchObject({ name: 'Grok', avatar: '/agents/grok.png', kind: 'kernel', kernelId: 'grok' })
    const kernelsBody = (await server.request('GET', '/api/kernels')).json
    const kernels = (Array.isArray(kernelsBody) ? kernelsBody : kernelsBody.kernels) as Array<{ id: string; npmPackage: string; vendor: string; tagline?: string }>
    expect(kernels.find((k) => k.id === 'grok')).toMatchObject({ npmPackage: '@xai-official/grok', vendor: 'SpaceXAI' })
  })

  it('scopedLaunch：GROK_HOME 隔离，[model.lulux] 指向网关（env_key），旁路模型也走 lulux，关兼容扫描；MCP 用 bearer_token_env_var', async () => {
    const { scopedLaunch } = await import('../src/services/kernels/scoped.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const home = join(server.home, 'launch-grok')
    const launch = scopedLaunch(findKernel('grok')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home, mcpToken: 'lulux-mcp-abc' })
    expect(launch.env).toMatchObject({
      GROK_HOME: home,
      LULUX_GATEWAY_KEY: 'gw-token',
      LULUX_MCP_TOKEN: 'lulux-mcp-abc',
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_WRITE_FILE: '0',
      GROK_CLAUDE_MCPS_ENABLED: '0',
      GROK_CURSOR_MCPS_ENABLED: '0',
    })
    expect(launch.env.XAI_API_KEY).toBeUndefined()
    expect(launch.args.slice(0, 2)).toEqual(['--prompt-file', '{promptFile}'])
    expect(launch.args).toEqual(expect.arrayContaining(['--output-format', 'streaming-json', '--no-alt-screen', '--always-approve', '--tools', 'read_file,list_dir,grep']))
    expect(launch.args.slice(-2)).toEqual(['-m', 'lulux'])
    const toml = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(toml).not.toContain('gw-token')
    expect(toml).not.toContain('lulux-mcp-abc')
    expect(toml).toContain('[model.lulux]\nmodel = "mock-model"\nbase_url = "http://127.0.0.1:1234/gateway/openai/v1"')
    expect(toml).toContain('env_key = "LULUX_GATEWAY_KEY"')
    expect(toml).toContain('api_backend = "chat_completions"')
    expect(toml).toMatch(/\[models\]\ndefault = "lulux"\nsession_summary = "lulux"/)
    expect(toml).toContain('[compat.claude]\nskills = false')
    expect(toml).toContain('[mcp_servers.lulux]\nurl = "http://127.0.0.1:1234/gateway/mcp"\nbearer_token_env_var = "LULUX_MCP_TOKEN"')

    const without = scopedLaunch(findKernel('grok')!, { token: 'gw-token', port: 1234, provider, model: 'mock-model', home })
    expect(without.env.LULUX_MCP_TOKEN).toBeUndefined()
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('[mcp_servers')
  })

  it('scoped 环境剥掉用户自己的 XAI_API_KEY / GROK_HOME；skill 同步到 $GROK_HOME/skills', async () => {
    const { scopedBaseEnv } = await import('../src/services/kernels/scoped.js')
    const env = scopedBaseEnv({ PATH: '/bin', XAI_API_KEY: 'xai-secret', GROK_HOME: '/home/u/.grok', GROKKY: 'x' })
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.GROK_HOME).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    const { CLI_SKILL_DIRS } = await import('../src/services/skills/cli-sync.js')
    expect(CLI_SKILL_DIRS.grok!('/h')).toBe(join('/h', 'skills'))
  })

  it('最低版本：npmmirror 上的 0.1.x 不算数；npm 安装用 @xai-official/grok@>=1.0.0', async () => {
    const { satisfiesMinVersion } = await import('../src/services/kernels/kernel-service.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const range = findKernel('grok')!.versionRange
    expect(range).toBe('>=1.0.0')
    expect(satisfiesMinVersion('0.1.4', range)).toBe(false)
    expect(satisfiesMinVersion('1.0.62', range)).toBe(true)
    expect(satisfiesMinVersion('2.0.0-beta.1', range)).toBe(true)
    expect(satisfiesMinVersion('0.1.4', undefined)).toBe(true)
  })

  it('原生二进制：bin/grok 是 node 启动器时，从平台包解压 grok.br 到 bin/grok-native 并直接运行', async () => {
    const { resolveKernelBinary } = await import('../src/services/kernels/kernel-service.js')
    const { findKernel } = await import('../src/services/kernels/catalog.js')
    const def = findKernel('grok')!
    const root = join(server.home, 'kernels', 'grok')
    rmSync(root, { recursive: true, force: true })
    fakeKernelPackage(join(server.home, 'kernels'), 'grok', '@xai-official/grok', 'grok', 'bin/grok', '#!/usr/bin/env node\nconsole.log("launcher")\n')
    expect(resolveKernelBinary(def)).toMatchObject({ viaNode: true })
    const exe = process.platform === 'win32' ? '.exe' : ''
    const platformBin = join(root, 'node_modules', '@xai-official', `grok-${process.platform}-${process.arch}`, 'bin')
    mkdirSync(platformBin, { recursive: true })
    writeFileSync(join(platformBin, `grok${exe}.br`), brotliCompressSync(Buffer.from('#!/bin/sh\necho native\n')))
    const resolved = resolveKernelBinary(def)!
    expect(resolved).toEqual({ file: join(root, 'node_modules', '@xai-official', 'grok', 'bin', `grok-native${exe}`), viaNode: false })
    expect(readFileSync(resolved.file, 'utf8')).toBe('#!/bin/sh\necho native\n')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('Grok：运行（替身 CLI）', () => {
  async function runWith(script: string, content = 'hi grok') {
    rmSync(join(server.home, 'kernels', 'grok'), { recursive: true, force: true })
    fakeKernelPackage(join(server.home, 'kernels'), 'grok', '@xai-official/grok', 'grok', 'bin/grok.js', script)
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['kernel-grok'] } })
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content } })
    return parseSse(res.text)
  }

  it('scoped：提示词经 --prompt-file 传入，网关转给 LULUX 的 Provider，text 增量拼成回复；运行结束删掉提示词文件', async () => {
    await fetch(`${mockBase}/__mock/reset`, { method: 'POST' })
    await fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses: [{ text: '你好，我是 Grok。', chunkSize: 3 }] }) })
    const events = await runWith(FAKE_GROK_JS, '第一行\n第二行')
    expect(events.find((e) => e.event === 'error')).toBeUndefined()
    const message = events.find((e) => e.event === 'done')!.data.message
    expect(message).toMatchObject({ content: '你好，我是 Grok。', senderAgentId: 'kernel-grok' })
    expect(message.runtime).toMatchObject({ kind: 'kernel', kernelId: 'grok', mode: 'scoped', model: 'mock-model' })
    const requests = await (await fetch(`${mockBase}/__mock/requests`)).json()
    const sent = String(requests[0].messages.at(-1).content)
    expect(sent).toContain('第一行\n第二行')
    const promptFile = sent.split('file=')[1]!
    expect(existsSync(promptFile)).toBe(false)
    expect(readdirSync(join(server.home, 'kernels', 'grok', 'tmp'))).toEqual([])
  })

  it('error 事件 → KERNEL_FAILED（去掉 “Internal error:” 前缀，带原因）', async () => {
    const events = await runWith(`const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'error', message: 'Internal error: {"message":"API error (status 404 Not Found)"}' })
process.exitCode = 1`)
    const error = events.find((e) => e.event === 'error')!
    expect(error.data.code).toBe('KERNEL_FAILED')
    expect(error.data.message).toContain('API error (status 404 Not Found)')
    expect(error.data.message).not.toContain('Internal error')
  })
})
