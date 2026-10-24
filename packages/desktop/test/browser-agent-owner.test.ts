import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

describe('BrowserAgent 会话占用（P1 审查 #3）', () => {
  it('另一个会话持有浏览器时返回 BUSY，租约过期后可接手', async () => {
    const { BrowserAgent, OWNER_LEASE_MS } = await import('../src/browser-agent')
    const agent = new BrowserAgent(() => null)
    await expect(agent.execute({ action: 'snapshot', sessionId: 'a' })).rejects.toMatchObject({ code: 'NO_WINDOW' })
    await expect(agent.execute({ action: 'snapshot', sessionId: 'b' })).rejects.toMatchObject({ code: 'BUSY' })
    // status 不占用
    await expect(agent.execute({ action: 'status', sessionId: 'b' })).rejects.toMatchObject({ code: 'NO_WINDOW' })
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + OWNER_LEASE_MS + 1)
    await expect(agent.execute({ action: 'snapshot', sessionId: 'b' })).rejects.toMatchObject({ code: 'NO_WINDOW' })
    vi.useRealTimers()
  })
})

describe('Agent 期间的导航黑名单（P1 审查 #4）', () => {
  it('命令带 deniedDomains 时给 controller 装导航拦截，子域名也拦；租约过期后放行', async () => {
    const { BrowserAgent, OWNER_LEASE_MS, isHostDenied } = await import('../src/browser-agent')
    expect(isHostDenied('https://a.bank.example.com/x', ['bank.example.com'])).toBe(true)
    expect(isHostDenied('https://notbank.example.com/', ['bank.example.com'])).toBe(false)
    const controller: any = { navigationGuard: null, ensureTab: () => null, activeContents: () => null, state: () => null }
    const agent = new BrowserAgent(() => controller)
    await agent.execute({ action: 'snapshot', sessionId: 'a', deniedDomains: ['bank.example.com'] }).catch(() => undefined)
    expect(controller.navigationGuard('https://bank.example.com/pay')).toBe(true)
    expect(controller.navigationGuard('https://shop.example.com/')).toBe(false)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + OWNER_LEASE_MS + 1)
    expect(controller.navigationGuard('https://bank.example.com/pay')).toBe(false)
    vi.useRealTimers()
    await agent.execute({ action: 'snapshot', sessionId: 'a' }).catch(() => undefined)
    expect(controller.navigationGuard).toBeNull()
  })
})
