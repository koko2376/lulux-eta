import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 结构化日志（docs/API-CONTRACT.md §10.9）：JSON 行、X-Request-Id、脱敏、按天轮转 + 大小切分 + 保留期 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({ LULUX_LOG_LEVEL: 'info' })
}, 90_000)
afterAll(async () => {
  const { logger } = await import('../src/services/logger.js')
  logger.restoreConsole()
  await server?.close()
})

function lines(): any[] {
  const dir = join(server.home, 'logs')
  return readdirSync(dir)
    .filter((n) => n.startsWith('lulux-'))
    .flatMap((n) => readFileSync(join(dir, n), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('结构化日志', () => {
  it('每个 API 请求一行 JSON，带 requestId / actorId / 耗时；接受安全的 X-Request-Id；query 中的令牌被脱敏', async () => {
    const res = await server.request('GET', '/api/health?token=supersecretvalue123&x=1', { headers: { 'X-Request-Id': 'client-req-0001' } })
    expect(res.headers['x-request-id']).toBe('client-req-0001')
    const generated = await server.request('GET', '/api/customers', { headers: { 'X-Request-Id': 'bad id with spaces' } })
    expect(generated.headers['x-request-id']).toMatch(/^req_[a-f0-9]{16}$/)
    await server.request('GET', '/api/does-not-exist')
    const all = lines()
    const health = all.find((l) => l.requestId === 'client-req-0001')
    expect(health).toMatchObject({ level: 'info', msg: 'http', method: 'GET', status: 200, actorId: 'local' })
    expect(health.path).toBe('/api/health?token=[REDACTED]&x=1')
    expect(typeof health.ms).toBe('number')
    expect(JSON.stringify(all)).not.toContain('supersecretvalue123')
    expect(all.find((l) => l.path === '/api/does-not-exist')).toMatchObject({ level: 'warn', status: 404, errorCode: 'NOT_FOUND' })
  })

  it('console 捕获 + 脱敏：密钥字段、Bearer、sk- 形态', async () => {
    const { logger, redact } = await import('../src/services/logger.js')
    logger.captureConsole()
    console.warn('[lulux-eta] upstream said Authorization: Bearer abcdef1234567890 key sk-proj-ABCDEFGHIJKLMNOP')
    logger.info('provider saved', { apiKey: 'sk-live-should-not-appear', nested: { password: 'p@ss', ok: 'visible' } })
    logger.restoreConsole()
    const text = JSON.stringify(lines())
    expect(text).not.toContain('abcdef1234567890')
    expect(text).not.toContain('ABCDEFGHIJKLMNOP')
    expect(text).not.toContain('should-not-appear')
    expect(text).not.toContain('p@ss')
    expect(text).toContain('visible')
    expect(redact({ token: 'x', list: [{ secret: 'y' }] })).toEqual({ token: '[REDACTED]', list: [{ secret: '[REDACTED]' }] })
  })

  it('超过大小切分到 .1；保留期外的日志被删除', async () => {
    const { logger } = await import('../src/services/logger.js')
    process.env.LULUX_LOG_MAX_MB = '1'
    const current = logger.currentFile()
    writeFileSync(current, 'x'.repeat(1024 * 1024 + 10))
    expect(logger.currentFile()).toBe(`${current}.1`)
    delete process.env.LULUX_LOG_MAX_MB
    const old = join(logger.dir(), 'lulux-2000-01-01.log')
    writeFileSync(old, '{}\n')
    utimesSync(old, new Date('2000-01-01'), new Date('2000-01-01'))
    expect(logger.prune()).toBeGreaterThanOrEqual(1)
    expect(readdirSync(logger.dir())).not.toContain('lulux-2000-01-01.log')
  })
})
