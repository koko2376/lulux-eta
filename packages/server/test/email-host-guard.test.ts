import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：团队服务器上，成员不能借邮箱「测试连接 / 保存账户」让服务器去连本机、内网、链路本地地址；
 * 地址按解析后的 IP 校验并钉住（防 DNS 重绑定）；错误信息只给固定分类，不回显对端发来的内容。
 */

// 测试用域名解析：rebind.mail.test 同时解析到公网与回环地址，public.mail.test 只解析到公网地址
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  const table: Record<string, Array<{ address: string; family: number }>> = {
    'rebind.mail.test': [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    'meta.mail.test': [{ address: '169.254.169.254', family: 4 }],
    'public.mail.test': [{ address: '93.184.216.34', family: 4 }],
  }
  const lookup = (async (host: string, options?: unknown) => {
    const hit = table[host]
    if (hit) return (options as { all?: boolean })?.all ? hit : hit[0]
    return (actual.lookup as (h: string, o?: unknown) => Promise<unknown>)(host, options)
  }) as typeof actual.lookup
  return { ...actual, lookup, default: { ...actual, lookup } }
})

const PASSWORD = 'correct horse battery'
let server: TestServer
let member = ''
let internal: Server
let internalPort = 0

beforeAll(async () => {
  internal = createServer((socket) => {
    socket.write('SSH-2.0-InternalOnly_SECRET_BANNER\r\n')
    setTimeout(() => socket.end(), 300)
  })
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()))
  internalPort = (internal.address() as { port: number }).port
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await server.request('POST', '/api/auth/setup', { token: null, body: { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' } })
  const inv = await server.request('POST', '/api/team/invites', { token: ok.json.token, body: { role: 'member' } })
  const acc = await server.request('POST', '/api/auth/invites/accept', { token: null, body: { code: inv.json.code, email: 'm@acme.com', password: PASSWORD, name: 'M' } })
  member = acc.json.token
}, 30_000)
afterAll(async () => {
  await server?.close()
  internal?.close()
})

const probe = (host: string, port: number) =>
  server.request('POST', '/api/email/accounts/test', {
    token: member,
    body: { email: 'x@example.com', password: 'x', imap: { host, port, secure: false }, smtp: { host, port, secure: false } },
  })

describe('团队服务器邮箱连接地址校验', () => {
  it('回环地址：开放端口与关闭端口返回同样的拒绝，不读到横幅', async () => {
    const open = await probe('127.0.0.1', internalPort)
    const closed = await probe('127.0.0.1', 1)
    expect(open.status, open.text).toBe(200)
    expect(open.text).not.toContain('SECRET_BANNER')
    expect(open.json.imap.code).toBe('EMAIL_HOST_FORBIDDEN')
    expect(open.json.smtp.code).toBe('EMAIL_HOST_FORBIDDEN')
    expect(open.json.imap.error).toEqual(closed.json.imap.error)
    expect(open.json.smtp.error).toEqual(closed.json.smtp.error)
    expect(closed.text).not.toMatch(/ECONNREFUSED/)
  }, 30_000)

  it.each(['10.0.0.8', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '[::1]', 'localhost', 'mail.internal', 'meta.mail.test', 'rebind.mail.test'])(
    '拒绝 %s',
    async (host) => {
      const res = await probe(host, 25)
      expect(res.status, res.text).toBe(200)
      expect(res.json.imap.code).toBe('EMAIL_HOST_FORBIDDEN')
      expect(res.json.smtp.code).toBe('EMAIL_HOST_FORBIDDEN')
    },
    30_000,
  )

  it('保存账户时同样校验（不跳过连接测试的情况下）', async () => {
    const res = await server.request('POST', '/api/email/accounts', {
      token: member,
      body: { email: 'y@example.com', password: 'x', imap: { host: '127.0.0.1', port: internalPort, secure: false }, smtp: { host: '127.0.0.1', port: internalPort, secure: false } },
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('EMAIL_HOST_FORBIDDEN')
    expect(res.text).not.toContain('SECRET_BANNER')
  }, 30_000)

  it('公网域名解析后钉住 IP，TLS 仍按原主机名校验', async () => {
    const { pinMailHost } = await import('../src/services/email/host-guard.js')
    await expect(pinMailHost('public.mail.test', 'IMAP')).resolves.toEqual({ address: '93.184.216.34', servername: 'public.mail.test', allowlisted: false })
    await expect(pinMailHost('rebind.mail.test', 'SMTP')).rejects.toMatchObject({ code: 'EMAIL_HOST_FORBIDDEN' })
    const { imapClient, smtpTransport } = await import('../src/services/email/account-service.js')
    const endpoint = { host: 'public.mail.test', port: 993, secure: true, username: 'u', pinned: await pinMailHost('public.mail.test', 'IMAP') }
    const conn = { email: 'u@public.mail.test', imap: endpoint, smtp: endpoint, auth: { pass: 'x' } }
    const imap = imapClient(conn) as unknown as { options: { host: string; servername?: string } }
    expect(imap.options.host).toBe('93.184.216.34')
    expect(imap.options.servername).toBe('public.mail.test')
    const smtp = smtpTransport(conn) as unknown as { options: { host: string; servername?: string } }
    expect(smtp.options.host).toBe('93.184.216.34')
    expect(smtp.options.servername).toBe('public.mail.test')
    smtp.close?.()
    // 没经过地址校验的连接在团队服务器上直接拒绝
    expect(() => imapClient({ ...conn, imap: { ...endpoint, pinned: undefined } })).toThrow()
  })

  it('错误信息只给固定分类，不带对端内容', async () => {
    const { classifyMailError } = await import('../src/services/email/account-service.js')
    const banner = Object.assign(new Error('Unexpected greeting: SSH-2.0-InternalOnly_SECRET_BANNER'), { code: 'EPROTOCOL' })
    const mapped = classifyMailError(banner, 'SMTP')
    expect(mapped.code).toBe('EMAIL_CONNECT_FAILED')
    expect(mapped.message).not.toContain('SECRET_BANNER')
    const auth = classifyMailError(Object.assign(new Error('535 5.7.8 secret-detail-from-peer'), { code: 'EAUTH', response: '535 secret-detail-from-peer' }), 'SMTP')
    expect(auth.code).toBe('EMAIL_AUTH_FAILED')
    expect(auth.message).not.toContain('secret-detail-from-peer')
  })
})
