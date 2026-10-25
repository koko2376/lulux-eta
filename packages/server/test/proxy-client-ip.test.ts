import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseProxyHops, parseTrustedProxies, resolveClientIp } from '../src/security/client-ip.js'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：信任反向代理时，客户端地址取代理追加的那一跳（最右侧不可信地址之前 / 按配置的代理跳数），
 * 不取客户端可以随意伪造的 X-Forwarded-For 最左值。
 */
describe('resolveClientIp', () => {
  const none = { hops: 0, trusted: null }
  const oneHop = { hops: 1, trusted: null }

  it('不信任代理时只用 socket 地址', () => {
    expect(resolveClientIp('198.51.100.1', '1.2.3.4', none)).toBe('198.51.100.1')
  })

  it('一层代理：取代理追加的最右值，忽略客户端伪造的左侧值', () => {
    expect(resolveClientIp('10.0.0.2', '6.6.6.6, 203.0.113.9', oneHop)).toBe('203.0.113.9')
    expect(resolveClientIp('10.0.0.2', '203.0.113.9', oneHop)).toBe('203.0.113.9')
    expect(resolveClientIp('10.0.0.2', '', oneHop)).toBe('10.0.0.2')
  })

  it('两层代理：取倒数第二个', () => {
    expect(resolveClientIp('10.0.0.2', '6.6.6.6, 203.0.113.9, 10.0.0.1', { hops: 2, trusted: null })).toBe('203.0.113.9')
  })

  it('可信代理列表：从右往左跳过可信代理', () => {
    const trusted = parseTrustedProxies('10.0.0.0/8, 127.0.0.1')
    expect(resolveClientIp('127.0.0.1', '6.6.6.6, 203.0.113.9, 10.1.2.3', { hops: 1, trusted })).toBe('203.0.113.9')
    // socket 对端不是可信代理：转发头一概不信
    expect(resolveClientIp('198.51.100.7', '6.6.6.6', { hops: 1, trusted })).toBe('198.51.100.7')
  })

  it('去端口、还原 IPv4 映射地址，不合法的值不采信', () => {
    expect(resolveClientIp('::ffff:10.0.0.2', '203.0.113.9:4711', oneHop)).toBe('203.0.113.9')
    expect(resolveClientIp('10.0.0.2', '[2001:db8::1]:443', oneHop)).toBe('2001:db8::1')
    expect(resolveClientIp('10.0.0.2', 'unknown', oneHop)).toBe('10.0.0.2')
  })

  it('配置解析', () => {
    expect(parseProxyHops('1')).toBe(1)
    expect(parseProxyHops('2')).toBe(2)
    expect(parseProxyHops('')).toBe(0)
    expect(parseProxyHops('yes')).toBe(0)
    expect(() => parseTrustedProxies('10.0.0.0/99')).toThrow()
  })
})

describe('登录限流按真实来源计数', () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com', LULUX_TRUST_PROXY: '1' })
    const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
    await server.request('POST', '/api/auth/setup', { token: null, body: { setupToken, email: 'owner@acme.com', password: 'correct horse battery', name: 'O', orgName: 'Acme' } })
  }, 30_000)
  afterAll(async () => server?.close())

  it('每次伪造不同的最左值，同一真实来源第 11 次失败仍被限流', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      const res = await server.request('POST', '/api/auth/login', {
        token: null,
        headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` },
        body: { email: `user${i}@acme.com`, password: 'wrong-password' },
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  }, 60_000)
})
