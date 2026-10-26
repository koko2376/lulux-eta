import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadLoginPrefs,
  loginPrefs,
  normalizeLoginPrefs,
  rememberLocalLogin,
  rememberServerLogin,
  resetLoginPrefsCache,
} from './login-prefs'

afterEach(() => {
  localStorage.clear()
  delete (window as { luluxAgent?: unknown }).luluxAgent
  resetLoginPrefsCache()
})

describe('登录偏好（记住这台机器 / 这台服务器）', () => {
  it('本机：勾选记下用户名，不勾删掉（不持久）', () => {
    rememberLocalLogin('Koko', true)
    expect(loginPrefs()).toEqual({ tab: 'local', local: { username: 'Koko', remember: true } })
    rememberLocalLogin('Koko', false)
    expect(loginPrefs()).toEqual({})
    expect(localStorage.getItem('lulux.login')).toBeNull()
  })

  it('服务器按地址分别记；不勾只删这台，本机那项不受影响', () => {
    rememberLocalLogin('Koko', true)
    rememberServerLogin('https://a.example.com', 'a@x.co', true)
    rememberServerLogin('https://b.example.com', 'b@x.co', true)
    let prefs = loginPrefs()
    expect(prefs.tab).toBe('server')
    expect(prefs.lastServer).toBe('https://b.example.com')
    expect(prefs.servers).toEqual({
      'https://a.example.com': { email: 'a@x.co', remember: true },
      'https://b.example.com': { email: 'b@x.co', remember: true },
    })
    rememberServerLogin('https://b.example.com', 'b@x.co', false)
    prefs = loginPrefs()
    expect(prefs.servers).toEqual({ 'https://a.example.com': { email: 'a@x.co', remember: true } })
    expect(prefs.lastServer).toBeUndefined()
    expect(prefs.local).toEqual({ username: 'Koko', remember: true })
  })

  it('旧格式迁移：只有勾过“记住”才带出', () => {
    expect(
      normalizeLoginPrefs({ tab: 'server', username: 'K', serverUrl: 'https://s.example.com', email: 'e@x.co', remember: true }),
    ).toEqual({
      tab: 'server',
      local: { username: 'K', remember: true },
      servers: { 'https://s.example.com': { email: 'e@x.co', remember: true } },
      lastServer: 'https://s.example.com',
    })
    expect(normalizeLoginPrefs({ username: 'K', remember: false })).toEqual({})
    expect(normalizeLoginPrefs('garbage')).toEqual({})
  })

  it('桌面端：偏好存在主进程（页面 origin 变了也还在），不写 localStorage', async () => {
    let stored: unknown = { tab: 'local', local: { username: 'Koko', remember: true } }
    const setLoginPrefs = vi.fn(async (next: unknown) => {
      stored = next
      return next
    })
    ;(window as { luluxAgent?: unknown }).luluxAgent = {
      api: { getLoginPrefs: async () => stored, setLoginPrefs },
    }
    expect(await loadLoginPrefs()).toEqual({ tab: 'local', local: { username: 'Koko', remember: true } })
    expect(loginPrefs().local?.username).toBe('Koko')
    rememberServerLogin('https://s.example.com', 'e@x.co', true)
    expect(setLoginPrefs).toHaveBeenCalledTimes(1)
    expect(stored).toMatchObject({ local: { username: 'Koko' }, servers: { 'https://s.example.com': { email: 'e@x.co' } } })
    expect(localStorage.getItem('lulux.login')).toBeNull()
  })
})
