import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

const PWNED = '/tmp/pwned3'

let server: TestServer

beforeAll(async () => {
  rmSync(PWNED, { force: true })
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
  rmSync(PWNED, { force: true })
})

describe('鉴权与传输（契约第 1 节）', () => {
  it('无 token → 401，统一错误格式', async () => {
    const res = await server.request('GET', '/api/health', { token: null })
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } })
  })

  it('错误 token → 401', async () => {
    const res = await server.request('GET', '/api/sessions', { token: 'b2'.repeat(32) })
    expect(res.status).toBe(401)
  })

  it('正确 token → 200，health 只返回 ok', async () => {
    const res = await server.request('GET', '/api/health')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
  })

  it('错误 Host（DNS rebinding）→ 403', async () => {
    const res = await server.request('GET', '/api/health', { host: `evil.example:${server.port}` })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('HOST_NOT_ALLOWED')
  })

  it('端口不对的 Host → 403；localhost:<port> 允许', async () => {
    expect((await server.request('GET', '/api/health', { host: '127.0.0.1:1' })).status).toBe(403)
    expect((await server.request('GET', '/api/health', { host: `localhost:${server.port}` })).status).toBe(200)
  })

  it('非 /api 路径也校验 Host', async () => {
    const res = await server.request('GET', '/', { host: 'attacker.test', token: null })
    expect(res.status).toBe(403)
  })

  it('跨源 Origin → 403；同源 Origin 放行', async () => {
    const evil = await server.request('GET', '/api/health', { headers: { Origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    expect(evil.json.error.code).toBe('ORIGIN_NOT_ALLOWED')
    const nullOrigin = await server.request('GET', '/api/health', { headers: { Origin: 'null' } })
    expect(nullOrigin.status).toBe(403)
    const same = await server.request('GET', '/api/health', { headers: { Origin: `http://127.0.0.1:${server.port}` } })
    expect(same.status).toBe(200)
  })

  it('production 下不放行 Vite 开发 origin', async () => {
    const res = await server.request('GET', '/api/health', { headers: { Origin: 'http://localhost:51790' } })
    expect(res.status).toBe(403)
  })

  it('非 JSON 请求体 → 415（表单 / 纯文本）', async () => {
    const form = await server.request('POST', '/api/sessions', {
      raw: 'title=x',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(form.status).toBe(415)
    expect(form.json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    const text = await server.request('POST', '/api/sessions', { raw: '{}', headers: { 'Content-Type': 'text/plain' } })
    expect(text.status).toBe(415)
  })

  it('非法 JSON → 400 INVALID_JSON', async () => {
    const res = await server.request('POST', '/api/sessions', {
      raw: '{bad',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('INVALID_JSON')
  })

  it('无 CORS 头', async () => {
    const res = await server.request('OPTIONS', '/api/mcp/servers', {
      headers: { Origin: `http://127.0.0.1:${server.port}`, 'Access-Control-Request-Method': 'POST' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('未知接口 → 404 JSON', async () => {
    const res = await server.request('GET', '/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('NOT_FOUND')
  })
})

describe('原 RCE 复现请求必须失败', () => {
  const payload = { name: 'x3', command: 'touch', args: [PWNED] }

  it('带 Origin https://evil.example（无 token）→ 403，文件不存在', async () => {
    const res = await server.request('POST', '/api/mcp/servers', {
      body: payload,
      token: null,
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(PWNED)).toBe(false)
  })

  it('带 Origin https://evil.example 且带正确 token → 仍 403', async () => {
    const res = await server.request('POST', '/api/mcp/servers', {
      body: payload,
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(PWNED)).toBe(false)
  })

  it('表单 POST（无需预检）→ 401/415，文件不存在', async () => {
    const res = await server.request('POST', '/api/mcp/servers', {
      raw: 'name=x&command=touch%20%2Ftmp%2Fpwned3',
      token: null,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect([401, 403, 415]).toContain(res.status)
    expect(existsSync(PWNED)).toBe(false)
  })

  it('同源 + 正确 token，但没有原生确认通道且未开启 allowMcpWithoutNativeConfirm → 403 MCP_COMMAND_REJECTED', async () => {
    const res = await server.request('POST', '/api/mcp/servers', { body: payload })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('MCP_COMMAND_REJECTED')
    const list = await server.request('GET', '/api/mcp/servers')
    expect(list.json.servers).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(PWNED)).toBe(false)
  })
})

describe('MCP 原生确认与子进程环境', () => {
  it('确认通道拒绝 → 403；允许 → 201', async () => {
    const { setConfirmChannelForTests } = await import('../src/services/mcp/confirm.js')
    const asked: unknown[] = []
    let answer = false
    setConfirmChannelForTests({
      available: () => true,
      request: async (spec) => {
        asked.push(spec)
        return answer
      },
    })
    const body = { name: 'echo', command: process.execPath, args: ['-e', 'setTimeout(()=>{},10)'] }
    const rejected = await server.request('POST', '/api/mcp/servers', { body })
    expect(rejected.status).toBe(403)
    expect(rejected.json.error.code).toBe('MCP_COMMAND_REJECTED')

    answer = true
    const created = await server.request('POST', '/api/mcp/servers', { body: { ...body, enabled: false } })
    expect(created.status).toBe(201)
    expect(created.json.server.approved).toBe(true)
    expect(asked).toHaveLength(2)

    // 只改名字不需要确认；改 args 需要
    answer = false
    const renamed = await server.request('PATCH', `/api/mcp/servers/${created.json.server.id}`, { body: { name: 'echo2' } })
    expect(renamed.status).toBe(200)
    expect(asked).toHaveLength(2)
    const changed = await server.request('PATCH', `/api/mcp/servers/${created.json.server.id}`, {
      body: { args: ['-e', '1'] },
    })
    expect(changed.status).toBe(403)
    expect(asked).toHaveLength(3)
    setConfirmChannelForTests({ available: () => false, request: async () => false })
  })

  it('浏览器开发态开启 allowMcpWithoutNativeConfirm 后放行', async () => {
    await server.request('PATCH', '/api/settings', { body: { allowMcpWithoutNativeConfirm: true } })
    const res = await server.request('POST', '/api/mcp/servers', {
      body: { name: 'dev', command: process.execPath, args: ['-v'], enabled: false },
    })
    expect(res.status).toBe(201)
    await server.request('PATCH', '/api/settings', { body: { allowMcpWithoutNativeConfirm: false } })
  })

  it('子进程环境变量只含白名单 + 显式配置', async () => {
    const { buildMcpEnv } = await import('../src/services/mcp/spawn-env.js')
    const env = buildMcpEnv(
      { MY_TOKEN: 'x' },
      { PATH: '/bin', HOME: '/home/u', LULUX_API_TOKEN: 'secret', OPENAI_API_KEY: 'sk-1', AWS_SECRET_ACCESS_KEY: 'y' },
    )
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', MY_TOKEN: 'x' })
  })

  it('MCP 子进程实际拿不到父进程的密钥变量', async () => {
    const { McpConnection } = await import('../src/services/mcp/client.js')
    process.env.SUPER_SECRET_FOR_TEST = 'leak'
    // 一个最小 MCP server：把收到的环境变量作为工具描述返回
    const script = `
      const rl = require('readline').createInterface({ input: process.stdin })
      rl.on('line', (line) => {
        const msg = JSON.parse(line)
        if (msg.id === undefined) return
        let result = {}
        if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } }
        if (msg.method === 'tools/list') result = { tools: [{ name: 'env', description: JSON.stringify(Object.keys(process.env)), inputSchema: { type: 'object' } }] }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
      })`
    const connection = new McpConnection({
      id: 'm',
      name: 't',
      command: process.execPath,
      args: ['-e', script],
      env: { EXPLICIT: '1' },
      enabled: true,
      approved: true,
      createdAt: 0,
    })
    await connection.connect()
    const keys = JSON.parse(connection.tools[0]!.description!) as string[]
    connection.close()
    expect(keys).toContain('EXPLICIT')
    expect(keys).not.toContain('SUPER_SECRET_FOR_TEST')
    expect(keys.filter((key) => key.startsWith('LULUX_'))).toEqual([])
  })
})

describe('token 文件', () => {
  it('开发态 token 写入 <dataDir>/api-token，权限 0600', async () => {
    const { resolveApiToken, tokensEqual } = await import('../src/security/api-token.js')
    delete process.env.LULUX_API_TOKEN
    const info = resolveApiToken(server.home)
    expect(info.source).toBe('file')
    expect(info.file).toBe(join(server.home, 'api-token'))
    if (process.platform !== 'win32') expect(statSync(info.file!).mode & 0o777).toBe(0o600)
    expect(info.token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokensEqual(info.token, info.token)).toBe(true)
    expect(tokensEqual(info.token, TEST_TOKEN)).toBe(false)
  })

  it('环境变量 token 读取后从 process.env 删除', async () => {
    const { resolveApiToken } = await import('../src/security/api-token.js')
    process.env.LULUX_API_TOKEN = 'c3'.repeat(32)
    const info = resolveApiToken(server.home)
    expect(info).toMatchObject({ source: 'env', token: 'c3'.repeat(32) })
    expect(process.env.LULUX_API_TOKEN).toBeUndefined()
  })
})

describe('IPC 原生确认通道', () => {
  it('经 process.send 请求、按 id 匹配回复；断开时按拒绝处理', async () => {
    const { EventEmitter } = await import('node:events')
    const { createIpcConfirmChannel } = await import('../src/services/mcp/confirm.js')
    const sent: Array<{ type: string; id: string; spec: { env: unknown } }> = []
    const fake = Object.assign(new EventEmitter(), {
      connected: true,
      send: (message: { type: string; id: string; spec: { env: unknown } }) => {
        sent.push(message)
        return true
      },
    }) as unknown as NodeJS.Process
    const channel = createIpcConfirmChannel(fake)
    const spec = { name: 'n', command: 'npx', args: ['-y', 'pkg'], env: { SECRET: 'value' } }
    const first = channel.request(spec)
    const second = channel.request(spec)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.type).toBe('lulux:mcp-confirm')
    // 只把 env 的键名交给主进程展示，不传值
    expect(sent[0]!.spec.env).toEqual(['SECRET'])
    fake.emit('message', { type: 'lulux:mcp-confirm-result', id: sent[1]!.id, approved: true })
    fake.emit('message', { type: 'other', id: sent[0]!.id, approved: true })
    expect(await second).toBe(true)
    fake.emit('disconnect')
    expect(await first).toBe(false)
  })
})
