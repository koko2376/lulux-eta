import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * “记住这台机器”：本机会话存在数据库里（只存哈希），与每次启动随机生成的 API token、端口无关。
 * 桌面端每次启动都会换 API token，端口也可能变；会话必须照样有效（重启后直接进入）。
 */

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
})

const DAY = 24 * 60 * 60_000

/** 同一个数据目录，换一个 API token / 端口再起一个服务（模拟桌面端重启） */
async function restartWith(token: string): Promise<{ get: (path: string, session?: string) => Promise<{ status: number; json: any }>; close: () => Promise<void> }> {
  const { createApp } = await import('../src/app.js')
  let port = 0
  const app = createApp({ token, getPort: () => port, isProduction: true })
  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  port = (http.address() as AddressInfo).port
  const get = (path: string, session?: string) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` }
      if (session) headers['X-Lulux-Session'] = session
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined })
        })
      })
      req.on('error', reject)
      req.end()
    })
  return {
    get,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.()
        http.close(() => resolve())
      }),
  }
}

describe('本机账户：记住这台机器', () => {
  let remembered = ''
  let oneOff = ''

  it('remember=true 的会话 30 天空闲有效；remember=false 12 小时', async () => {
    const created = await server.request('POST', '/api/auth/local/accounts', {
      body: { username: 'Koko', password: 'correct horse', remember: true },
    })
    expect(created.status).toBe(201)
    expect(created.json.persistent).toBe(true)
    remembered = created.json.token
    expect(created.json.expiresAt - Date.now()).toBeGreaterThan(29 * DAY)

    const login = await server.request('POST', '/api/auth/local/login', {
      body: { username: 'koko', password: 'correct horse', remember: false },
    })
    expect(login.status).toBe(200)
    expect(login.json.persistent).toBe(false)
    oneOff = login.json.token
    expect(login.json.expiresAt - Date.now()).toBeLessThan(13 * 60 * 60_000)
  })

  it('会话写进数据目录里的数据库（只存哈希），不随进程丢失', () => {
    const file = new DatabaseSync(join(server.home, 'lulux-eta.db'), { readOnly: true })
    try {
      const rows = file.prepare('SELECT token_hash, persistent FROM local_sessions WHERE revoked_at IS NULL').all() as Array<{
        token_hash: string
        persistent: number
      }>
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.some((r) => r.persistent === 1)).toBe(true)
      expect(rows.every((r) => r.token_hash !== remembered && r.token_hash.length === 64)).toBe(true)
    } finally {
      file.close()
    }
  })

  it('“重启”：新的 API token、新端口，记住的会话照样有效（直接进入）', async () => {
    const next = await restartWith('b2'.repeat(32))
    try {
      const status = await next.get('/api/auth/local/status', remembered)
      expect(status.status).toBe(200)
      expect(status.json).toMatchObject({ hasAccount: true, signedIn: true, username: 'Koko' })
      expect((await next.get('/api/sessions', remembered)).status).toBe(200)
      // 不带会话：仍要求登录（有账户）
      const anon = await next.get('/api/auth/local/status')
      expect(anon.json).toMatchObject({ hasAccount: true, signedIn: false })
    } finally {
      await next.close()
    }
  })

  it('登出只作废当前会话；记住的会话过期后 → SESSION_EXPIRED', async () => {
    expect((await server.request('POST', '/api/auth/local/logout', { headers: { 'X-Lulux-Session': oneOff } })).status).toBe(204)
    expect((await server.request('GET', '/api/sessions', { headers: { 'X-Lulux-Session': oneOff } })).status).toBe(401)
    expect((await server.request('GET', '/api/sessions', { headers: { 'X-Lulux-Session': remembered } })).status).toBe(200)
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE local_sessions SET expires_at = ? WHERE persistent = 1').run(Date.now() - 1000)
    const res = await server.request('GET', '/api/sessions', { headers: { 'X-Lulux-Session': remembered } })
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('SESSION_EXPIRED')
  })
})
