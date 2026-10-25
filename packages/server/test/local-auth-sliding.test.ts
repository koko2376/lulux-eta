import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：「记住本机」会话滑动续期。
 * - 活跃使用时空闲期限与绝对期限一起顺延，天天用不会在登录后第 90 天被登出；
 * - 30 天没用照常过期；
 * - 系统时钟被回拨期间登录，时钟校正后会话不会立即失效；
 * - 最长寿命可用 LULUX_REMEMBER_MAX_DAYS 设定。
 */
const DAY = 86_400_000
let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(async () => server?.close())
afterEach(() => {
  vi.useRealTimers()
  delete process.env.LULUX_REMEMBER_MAX_DAYS
})

const status = (session: string) => server.request('GET', '/api/auth/local/status', { headers: { 'X-Lulux-Session': session } })
const login = async () => {
  const res = await server.request('POST', '/api/auth/local/login', { body: { username: 'daily', password: 'correct horse', remember: true } })
  expect(res.status, res.text).toBe(200)
  return res.json.token as string
}

describe('记住本机：滑动续期', () => {
  it('天天使用，200 天后仍然登录着；之后 31 天不用才过期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.UTC(2026, 0, 1)
    vi.setSystemTime(t0)
    const created = await server.request('POST', '/api/auth/local/accounts', { body: { username: 'daily', password: 'correct horse', remember: true } })
    expect(created.status, created.text).toBe(201)
    const token = created.json.token
    for (let d = 1; d <= 200; d++) {
      vi.setSystemTime(t0 + d * DAY)
      expect((await status(token)).json.signedIn, `day ${d}`).toBe(true)
    }
    const business = await server.request('GET', '/api/sessions', { headers: { 'X-Lulux-Session': token } })
    expect(business.status, business.text).toBe(200)
    vi.setSystemTime(t0 + 231 * DAY)
    expect((await status(token)).json.signedIn).toBe(false)
  })

  it('时钟回拨期间登录，时钟校正后不会立即失效', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const real = Date.UTC(2027, 0, 1)
    vi.setSystemTime(real)
    const before = await login()
    expect((await status(before)).json.signedIn).toBe(true)
    // 主板电池没电：时钟回到一年前，用户这时登录
    vi.setSystemTime(real - 365 * DAY)
    const during = await login()
    expect((await status(during)).json.signedIn).toBe(true)
    expect((await status(before)).json.signedIn).toBe(true)
    // 时钟校正回来（第二天）
    vi.setSystemTime(real + DAY)
    expect((await status(during)).json.signedIn).toBe(true)
    expect((await status(before)).json.signedIn).toBe(true)
  })

  it('LULUX_REMEMBER_MAX_DAYS 限制最长寿命', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    process.env.LULUX_REMEMBER_MAX_DAYS = '60'
    const t0 = Date.UTC(2028, 0, 1)
    vi.setSystemTime(t0)
    const token = await login()
    for (let d = 1; d <= 59; d++) {
      vi.setSystemTime(t0 + d * DAY)
      expect((await status(token)).json.signedIn, `day ${d}`).toBe(true)
    }
    vi.setSystemTime(t0 + 61 * DAY)
    expect((await status(token)).json.signedIn).toBe(false)
  })
})
