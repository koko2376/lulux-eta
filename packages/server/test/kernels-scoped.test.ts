import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * scoped 模式实测：用 tools/dev/mock-openai.js 做上游 Provider，真实运行已安装的 CLI。
 *
 * 内核目录：LULUX_TEST_KERNELS_DIR，缺省为 <dataDir 默认值 ~/.lulux-eta>/kernels。
 * 该目录下没有某个内核时：LULUX_TEST_INSTALL_KERNELS=1 则通过 POST /api/kernels/:id/install 安装
 * （安装源取 LULUX_KERNEL_REGISTRY，默认 npmmirror），否则跳过该内核的实测（CI 无网络时不会失败）。
 */
const KERNELS_DIR = process.env.LULUX_TEST_KERNELS_DIR || join(homedir(), '.lulux-eta', 'kernels')
const INSTALL = process.env.LULUX_TEST_INSTALL_KERNELS === '1'
const REAL_KEY = 'sk-mock-real-key-should-never-leak-123'
/** mock-openai.js 固定回复的开头 */
const MOCK_REPLY_HEAD = '好的，我按北欧客户常用的木屋规格整理了一版报价草稿。'

let server: TestServer
let mock: ChildProcess
let mockPort = 0

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolvePort(port))
    })
  })
}

beforeAll(async () => {
  mockPort = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(mockPort)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  server = await startTestServer({ LULUX_KERNELS_DIR: KERNELS_DIR })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

/** 递归找文件内容里有没有某个字符串（检查隔离目录不含真实 Key） */
function dirContains(dir: string, needle: string): string | null {
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      const hit = dirContains(file, needle)
      if (hit) return hit
    } else if (stat.size < 5_000_000 && readFileSync(file).includes(needle)) {
      return file
    }
  }
  return null
}

async function ensureInstalled(id: string): Promise<boolean> {
  const list = await server.request('GET', '/api/kernels')
  if (list.json.find((kernel: any) => kernel.id === id)?.installed) return true
  if (!INSTALL) return false
  const started = await server.request('POST', `/api/kernels/${id}/install`)
  expect(started.status).toBe(202)
  const deadline = Date.now() + 280_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    const state = (await server.request('GET', '/api/kernels')).json.find((k: any) => k.id === id)
    if (state?.status === 'idle' && state.installed) {
      const log = (await server.request('GET', `/api/kernels/${id}/log`)).json.lines as string[]
      console.info(`[kernels-scoped] ${id} 已经 API 安装：${log.filter((line) => !/http (fetch|cache)/.test(line)).slice(-6).join(' | ')}`)
      return true
    }
    if (state?.status === 'error') {
      console.warn(`[kernels-scoped] ${id} 安装失败：${state.error}`)
      return false
    }
  }
  return false
}

describe('内核 scoped 模式：可用性与设置', () => {
  it('没有 Provider 时 kernel Agent 不可用，原因是“请先在模型与密钥中配置模型”（已安装的内核）', async () => {
    const agents = (await server.request('GET', '/api/agents')).json.agents.filter((agent: any) => agent.kind === 'kernel')
    for (const agent of agents) {
      expect(agent.available).toBe(false)
      expect(['未安装', '请先在模型与密钥中配置模型']).toContain(agent.unavailableReason)
    }
    const kernels = (await server.request('GET', '/api/kernels')).json
    const claude = kernels.find((kernel: any) => kernel.id === 'claude-code')
    expect(claude).toMatchObject({ mode: 'scoped', modeSettingKey: 'kernelModeClaudeCode', requiresLogin: false, scopedProvider: null })
    expect(kernels.find((kernel: any) => kernel.id === 'builtin')).toMatchObject({ mode: null, modeSettingKey: null })
  })

  it('设置白名单含 6 个内核模式键，默认 scoped；切到 global 后 requiresLogin=true', async () => {
    const schema = (await server.request('GET', '/api/settings/schema')).json
    for (const key of ['kernelModeHermes', 'kernelModeClaudeCode', 'kernelModeCodex', 'kernelModePi', 'kernelModeGeminiCli', 'kernelModeQwenCode']) {
      expect(schema.find((item: any) => item.key === key)).toMatchObject({ type: 'enum', default: 'scoped', enum: ['scoped', 'global'] })
    }
    expect((await server.request('PATCH', '/api/settings', { body: { kernelModeCodex: 'local' } })).status).toBe(400)
    await server.request('PATCH', '/api/settings', { body: { kernelModeCodex: 'global' } })
    const codex = (await server.request('GET', '/api/kernels')).json.find((kernel: any) => kernel.id === 'codex')
    expect(codex).toMatchObject({ mode: 'global', requiresLogin: true, scopedProvider: null })
    await server.request('PATCH', '/api/settings', { body: { kernelModeCodex: 'scoped' } })
  })

  it('配置 Provider（上游 = tools/dev/mock-openai.js）后 scopedProvider 有值', async () => {
    const res = await server.request('POST', '/api/providers', {
      body: { name: 'MockUp', kind: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: REAL_KEY, model: 'mock-model-1' },
    })
    expect(res.status).toBe(201)
    const claude = (await server.request('GET', '/api/kernels')).json.find((kernel: any) => kernel.id === 'claude-code')
    expect(claude.scopedProvider).toMatchObject({ name: 'MockUp', model: 'mock-model-1' })
  })
})

const REAL = [
  { id: 'hermes', name: 'Hermes Agent' },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'pi', name: 'Pi' },
  { id: 'gemini-cli', name: 'Gemini CLI' },
  { id: 'qwen-code', name: 'Qwen Code' },
]

describe('内核 scoped 模式：真实 CLI 经网关对话（上游为 mock）', () => {
  for (const kernel of REAL) {
    it(`${kernel.name}：不登录，经网关得到 mock 上游的回复`, async (ctx) => {
      if (!(await ensureInstalled(kernel.id))) {
        console.warn(`[kernels-scoped] 跳过 ${kernel.name}：${KERNELS_DIR} 下未安装（设 LULUX_TEST_INSTALL_KERNELS=1 可经 API 安装）`)
        ctx.skip()
        return
      }
      const agent = (await server.request('GET', '/api/agents')).json.agents.find((item: any) => item.id === `kernel-${kernel.id}`)
      expect(agent).toMatchObject({ available: true, unavailableReason: null })

      const session = await server.request('POST', '/api/sessions', { body: { agentIds: [`kernel-${kernel.id}`] } })
      const sessionId = session.json.session.id
      const started = Date.now()
      const res = await server.request('POST', '/api/chat', { body: { sessionId, content: '你好，请简单介绍一下你自己' } })
      const events = parseSse(res.text)
      const error = events.find((event) => event.event === 'error')
      const done = events.find((event) => event.event === 'done')
      console.info(`[kernels-scoped] ${kernel.name}: ${error ? `失败 ${error.data.code} ${error.data.message}` : '成功'}（${Date.now() - started} ms）`)
      expect(error).toBeUndefined()
      expect(done!.data.message.content.startsWith(MOCK_REPLY_HEAD)).toBe(true)
      expect(done!.data.message.runtime).toMatchObject({
        kind: 'kernel',
        kernelId: kernel.id,
        mode: 'scoped',
        providerName: 'MockUp',
        model: 'mock-model-1',
      })
      expect(done!.data.message.runtime.label).toMatch(new RegExp(`^${kernel.name} \\S+ · 经由 MockUp/mock-model-1$`))
      // 一次性令牌随进程结束吊销
      const { gatewayTokens } = await import('../src/services/gateway/tokens.js')
      expect(gatewayTokens.size()).toBe(0)
      // 隔离配置目录存在，且不含真实 Provider Key
      const home = join(KERNELS_DIR, kernel.id, 'home', sessionId)
      expect(existsSync(home)).toBe(true)
      expect(dirContains(home, REAL_KEY)).toBeNull()
    }, 300_000)
  }
})

describe('内核 scoped 模式：上游失败', () => {
  it('Provider 不可达时报 KERNEL_FAILED（不是“需要登录”），并带上网关记录的上游原因', async (ctx) => {
    if (!(await ensureInstalled('claude-code'))) {
      ctx.skip()
      return
    }
    const down = await server.request('POST', '/api/providers', {
      body: { name: 'DownUp', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-down-123456', model: 'm-down' },
    })
    const session = await server.request('POST', '/api/sessions', {
      body: { agentIds: ['kernel-claude-code'], providerId: down.json.provider.id },
    })
    expect(session.json.session.providerId).toBe(down.json.provider.id)
    const started = Date.now()
    const res = await server.request('POST', '/api/chat', { body: { sessionId: session.json.session.id, content: 'hi' } })
    const error = parseSse(res.text).find((event) => event.event === 'error')
    console.info(`[kernels-scoped] Claude Code 上游失败用例：${error?.data.code} ${error?.data.message}（${Date.now() - started} ms）`)
    expect(error!.data.code).toBe('KERNEL_FAILED')
    expect(error!.data.message).toContain('DownUp')
  }, 300_000)
})
