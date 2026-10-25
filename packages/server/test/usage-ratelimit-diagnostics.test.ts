import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/** server 模式：按成员统计用量、/api/chat 按用户限流、服务器日志诊断包 */
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''

type Who = { token: string; id: string }
let owner: Who
let alice: Who
let bob: Who

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
  expect(created.status, created.text).toBe(201)
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

const script = (responses: unknown[]) =>
  fetch(`${mockBase}/__mock/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ responses }) })

async function newSession(who: Who): Promise<string> {
  const created = await as(who, 'POST', '/api/sessions', { agentIds: ['builtin'] })
  expect(created.status, created.text).toBe(201)
  return created.json.session.id
}

async function waitRunning(who: Who, sessionId: string, running: boolean) {
  for (let i = 0; i < 200; i += 1) {
    if ((await as(who, 'GET', `/api/sessions/${sessionId}`)).json.session?.running === running) return
    await sleep(30)
  }
  throw new Error(`running 未变为 ${running}`)
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  expect(ok.status, ok.text).toBe(201)
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@acme.com', 'Alice')
  bob = await invite('member', 'bob@acme.com', 'Bob')
  const provider = await as(owner, 'POST', '/api/providers', {
    name: 'Mock',
    kind: 'openai',
    baseUrl: `${mockBase}/v1`,
    apiKey: 'sk-mock-key-123456',
    model: 'mock-model',
  })
  expect(provider.status, provider.text).toBe(201)
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false })
}, 30_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('用量：按成员分组', () => {
  it('管理员看全组织按成员汇总（显示名）；成员只看到自己', async () => {
    const { db } = await import('../src/db.js')
    const orgId = (db.prepare('SELECT org_id FROM users WHERE id = ?').get(owner.id) as { org_id: string }).org_id
    const insert = db.prepare(
      `INSERT INTO llm_usage (id, org_id, owner_id, provider_id, provider_name, model, purpose, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated, cost, currency, created_at)
       VALUES (?, ?, ?, 'p', 'Mock', 'm', 'chat', ?, ?, 0, 0, 0, 0, ?, 'CNY', ?)`,
    )
    const now = Date.now()
    insert.run('u-a1', orgId, alice.id, 100, 10, 0.5, now)
    insert.run('u-a2', orgId, alice.id, 200, 20, 0.25, now)
    insert.run('u-b1', orgId, bob.id, 50, 5, 1, now)

    const all = await as(owner, 'GET', '/api/usage?groupBy=member&scope=all')
    expect(all.status, all.text).toBe(200)
    const byKey = new Map<string, any>(all.json.groups.map((g: any) => [g.key, g]))
    expect(byKey.get(alice.id)).toMatchObject({ label: 'Alice', calls: 2, inputTokens: 300, outputTokens: 30, cost: { CNY: 0.75 } })
    expect(byKey.get(bob.id)).toMatchObject({ label: 'Bob', calls: 1, inputTokens: 50 })

    // 成员即便带 scope=all 也只汇总自己
    const mine = await as(alice, 'GET', '/api/usage?groupBy=member&scope=all')
    expect(mine.status, mine.text).toBe(200)
    expect(mine.json.groups.map((g: any) => g.key)).toEqual([alice.id])
    expect(mine.json.totals.calls).toBe(2)
  })
})

describe('/api/chat 按用户限流', () => {
  it('默认值存在；成员不能改限流设置', async () => {
    const settings = (await as(owner, 'GET', '/api/settings')).json
    const values = settings.settings ?? settings
    expect(values.chatMaxConcurrentRunsPerUser).toBe('3')
    expect(values.chatRunsPerMinutePerUser).toBe('20')
    expect((await as(alice, 'PATCH', '/api/settings', { chatRunsPerMinutePerUser: 0 })).status).toBe(403)
  })

  it('每分钟次数超限返回 429（中文说明 + Retry-After），不影响其他成员', async () => {
    const patched = await as(owner, 'PATCH', '/api/settings', { chatRunsPerMinutePerUser: 2, chatMaxConcurrentRunsPerUser: 0 })
    expect(patched.status, patched.text).toBe(200)
    const sessionId = await newSession(alice)
    for (let i = 0; i < 2; i += 1) {
      await script([{ text: `好的 ${i}` }])
      const res = await as(alice, 'POST', '/api/chat', { sessionId, content: `第 ${i} 条` })
      expect(res.status, res.text).toBe(200)
      expect(parseSse(res.text).at(-1)!.event).toBe('done')
    }
    const limited = await as(alice, 'POST', '/api/chat', { sessionId, content: '第三条' })
    expect(limited.status, limited.text).toBe(429)
    expect(limited.json.error.code).toBe('RATE_LIMITED')
    expect(limited.json.error.message).toContain('每分钟最多发起 2 次对话')
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)

    const bobSession = await newSession(bob)
    await script([{ text: 'bob 的回复' }])
    const other = await as(bob, 'POST', '/api/chat', { sessionId: bobSession, content: 'hi' })
    expect(other.status, other.text).toBe(200)
  })

  it('同时进行中的运行数超限返回 429；运行结束后释放名额', async () => {
    await as(owner, 'PATCH', '/api/settings', { chatRunsPerMinutePerUser: 0, chatMaxConcurrentRunsPerUser: 1 })
    const first = await newSession(bob)
    const second = await newSession(bob)
    await script([{ text: '一段比较长的回复，用来占住运行名额。', chunkSize: 2, delayMs: 80 }])
    const running = as(bob, 'POST', '/api/chat', { sessionId: first, content: '写' })
    await waitRunning(bob, first, true)
    const limited = await as(bob, 'POST', '/api/chat', { sessionId: second, content: '再写' })
    expect(limited.status, limited.text).toBe(429)
    expect(limited.json.error.message).toContain('同时进行中的对话已达上限（1 个）')
    expect((await as(bob, 'POST', `/api/sessions/${first}/cancel`)).json.stopped).toBe(true)
    await running
    await waitRunning(bob, first, false)
    await script([{ text: '现在可以了' }])
    const ok = await as(bob, 'POST', '/api/chat', { sessionId: second, content: '再写' })
    expect(ok.status, ok.text).toBe(200)
    await as(owner, 'PATCH', '/api/settings', { chatRunsPerMinutePerUser: 20, chatMaxConcurrentRunsPerUser: 3 })
  })
})

describe('服务器日志诊断包', () => {
  it('只给所有者 / 管理员；zip 里有 info.json 与脱敏后的日志', async () => {
    const logs = join(server.home, 'logs')
    mkdirSync(logs, { recursive: true })
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    writeFileSync(join(logs, `lulux-${stamp}.log.7`), '{"msg":"call with Bearer abcdefghijklmnop and sk-abcdef1234567890xyz"}\n')

    expect((await as(alice, 'GET', '/api/diagnostics/logs')).status).toBe(403)
    const res = await server.request('GET', '/api/diagnostics/logs?days=2', { token: owner.token })
    expect(res.status, res.text.slice(0, 200)).toBe(200)
    expect(res.headers['content-type']).toContain('application/zip')
    expect(res.headers['content-disposition']).toMatch(/lulux-server-logs-\d{8}\.zip/)

    const { readZip } = await import('../src/services/skills/zip.js')
    // helpers 以 utf8 解码响应体；重新拉一次原始字节
    const raw = await new Promise<Buffer>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request(
          { host: '127.0.0.1', port: server.port, path: '/api/diagnostics/logs', headers: { Host: `127.0.0.1:${server.port}`, Authorization: `Bearer ${owner.token}` } },
          (r) => {
            const chunks: Buffer[] = []
            r.on('data', (c: Buffer) => chunks.push(c))
            r.on('end', () => resolve(Buffer.concat(chunks)))
          },
        )
        req.on('error', reject)
        req.end()
      })
    })
    const entries = readZip(raw, { maxEntries: 100, maxTotalBytes: 100 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 })
    const names = entries.map((e: any) => e.path)
    expect(names[0]).toBe('info.json')
    const info = JSON.parse(entries[0]!.data.toString('utf8'))
    expect(info).toMatchObject({ app: 'LULUX ETA', mode: 'server' })
    expect(info.platform).toBe(process.platform)
    const planted = entries.find((e: any) => e.path === `logs/lulux-${stamp}.log.7`)
    expect(planted).toBeTruthy()
    const text = planted!.data.toString('utf8')
    expect(text).toContain('Bearer [REDACTED]')
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('1234567890xyz')

    const audit = (await as(owner, 'GET', '/api/audit?action=diagnostics.logs')).json
    const items = Array.isArray(audit) ? audit : audit.items
    expect(items.length).toBeGreaterThanOrEqual(1)
  })
})
