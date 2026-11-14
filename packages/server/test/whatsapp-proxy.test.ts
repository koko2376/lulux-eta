import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 单机个人号的出口代理（本机模式）：校验格式、密码加密存储且不回传、不传密码保留原密码、可清除、写审计；
 * 测试连接失败时返回原因而不是报错；已连接时改代理用新出口重连。
 */
let server: TestServer

const api = (method: string, path: string, body?: unknown) => server.request(method, path, body === undefined ? {} : { body })

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T
  do {
    last = await fn()
    if (ok(last)) return last
    await new Promise((r) => setTimeout(r, 25))
  } while (Date.now() < deadline)
  throw new Error(`timeout; last=${JSON.stringify(last)}`)
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_WHATSAPP_ENGINE: 'fake', LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS: '20' })
}, 90_000)

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  await server.close()
})

describe('WhatsApp 出口代理（单机个人号）', () => {
  it('未设置时为空；格式不对 400；密码加密存储、不回传；不传密码保留原密码；可清除并写审计', async () => {
    expect((await api('GET', '/api/whatsapp/proxy')).json.proxy).toBeNull()
    const proxy = { protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u1', password: 's3cret-pass' }
    expect((await api('PUT', '/api/whatsapp/proxy', { ...proxy, host: 'bad host!' })).status).toBe(400)
    expect((await api('PUT', '/api/whatsapp/proxy', { ...proxy, port: 70000 })).status).toBe(400)

    const saved = await api('PUT', '/api/whatsapp/proxy', proxy)
    expect(saved.status, saved.text).toBe(200)
    expect(saved.json.proxy).toMatchObject({ protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u1', hasPassword: true })
    expect(saved.json.reconnected).toBe(false)
    expect(JSON.stringify(saved.json)).not.toContain('s3cret-pass')

    const file = join(server.home, 'whatsapp', 'sessions', 'default', 'proxy.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('s3cret-pass')
    if (process.platform !== 'win32') expect((statSync(file).mode & 0o777).toString(8)).toBe('600')

    const kept = await api('PUT', '/api/whatsapp/proxy', { protocol: 'http', host: '10.0.0.8', port: 8080, username: 'u1' })
    expect(kept.json.proxy).toMatchObject({ protocol: 'http', host: '10.0.0.8', hasPassword: true })
    expect((await api('GET', '/api/whatsapp/proxy')).json.proxy.host).toBe('10.0.0.8')

    const cleared = await api('DELETE', '/api/whatsapp/proxy')
    expect(cleared.status).toBe(200)
    expect(cleared.json.proxy).toBeNull()
    expect(existsSync(file)).toBe(false)

    const { db } = await import('../src/db.js')
    const n = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'whatsapp.proxy_update'").get() as { n: number }).n
    expect(n).toBe(3)
  })

  it('测试连接：连不上时返回失败原因而不是报错', async () => {
    const res = await api('POST', '/api/whatsapp/proxy/test', { proxy: { protocol: 'http', host: '127.0.0.1', port: 9, username: '' } })
    expect(res.status, res.text).toBe(200)
    expect(res.json.ok).toBe(false)
    expect(typeof res.json.error).toBe('string')
  })

  it('已连接时改代理：用新出口重连并回到已连接', async () => {
    expect((await api('POST', '/api/whatsapp/risk-acceptance')).status).toBe(200)
    expect((await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })).status).toBe(200)
    await waitFor(async () => (await api('GET', '/api/whatsapp/status')).json, (s) => s.phase === 'connected')
    const res = await api('PUT', '/api/whatsapp/proxy', { protocol: 'http', host: '10.0.0.9', port: 3128 })
    expect(res.status, res.text).toBe(200)
    expect(res.json.reconnected).toBe(true)
    await waitFor(async () => (await api('GET', '/api/whatsapp/status')).json, (s) => s.phase === 'connected')
    expect((await api('DELETE', '/api/whatsapp/proxy')).json.reconnected).toBe(true)
  })
})
