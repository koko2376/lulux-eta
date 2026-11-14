import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 团队服务器上的单机个人号：整台服务只关联一个 WhatsApp。
 * - 第一个开始绑定的成员拥有它；其他成员不能绑定、读会话或改代理（WHATSAPP_ACCOUNT_BUSY）；
 * - 老板 / 管理员可以设置这个号的出口代理。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
type Who = { token: string; id: string }
let server: TestServer
let owner: Who
let alice: Who
let bob: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) =>
  server.request(method, path, { body, token: who ? who.token : null })

async function invite(role: string, email: string, name: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN, LULUX_WHATSAPP_ENGINE: 'fake' })
  process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS = '20'
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@example.com', password: PASSWORD, name: 'Owner', orgName: 'Example' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@example.com', 'Alice')
  bob = await invite('member', 'bob@example.com', 'Bob')
}, 90_000)

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  await server.close()
})

describe('团队服务器：单机个人号', () => {
  it('第一个绑定的成员拥有账号，其他成员绑定 / 读会话 / 改代理被拒；管理员可设代理', async () => {
    expect((await as(alice, 'POST', '/api/whatsapp/risk-acceptance')).status).toBe(200)
    expect((await as(alice, 'POST', '/api/whatsapp/link/start', { mode: 'qr' })).status).toBe(200)

    expect((await as(bob, 'POST', '/api/whatsapp/risk-acceptance')).status).toBe(200)
    const busy = await as(bob, 'POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(busy.status).toBe(409)
    expect(busy.json.error.code).toBe('WHATSAPP_ACCOUNT_BUSY')
    // 别人绑定的号：状态里不暴露号码 / 二维码
    const bobStatus = (await as(bob, 'GET', '/api/whatsapp/status')).json
    expect(bobStatus).toMatchObject({ phase: 'unbound', account: null, qr: null })
    expect((await as(bob, 'GET', '/api/whatsapp/conversations')).json.error.code).toBe('WHATSAPP_ACCOUNT_BUSY')

    const proxy = { protocol: 'socks5', host: 'proxy.example.com', port: 1080 }
    expect((await as(bob, 'PUT', '/api/whatsapp/proxy', proxy)).json.error.code).toBe('WHATSAPP_ACCOUNT_BUSY')
    expect((await as(alice, 'PUT', '/api/whatsapp/proxy', proxy)).status).toBe(200)
    const byOwner = await as(owner, 'PUT', '/api/whatsapp/proxy', { ...proxy, port: 1081 })
    expect(byOwner.status, byOwner.text).toBe(200)
    expect((await as(alice, 'GET', '/api/whatsapp/proxy')).json.proxy.port).toBe(1081)
  })
})
