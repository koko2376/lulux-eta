import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ browserControl: vi.fn() }))

describe('浏览器状态条：运行结束释放', () => {
  it('收到本会话的 release 立即收起并清零步数；别的会话的 release 不影响', async () => {
    const { browserAgent, recordBrowserActivity } = await import('./browser-agent')
    recordBrowserActivity({ action: 'click', url: 'https://a.example', sessionId: 's1' })
    recordBrowserActivity({ action: 'type', url: 'https://a.example', sessionId: 's1' })
    expect(browserAgent.visible).toBe(true)
    expect(browserAgent.step).toBe(2)
    recordBrowserActivity({ action: 'release', url: '', sessionId: 's2' })
    expect(browserAgent.visible).toBe(true)
    recordBrowserActivity({ action: 'release', url: '', sessionId: 's1' })
    expect(browserAgent.visible).toBe(false)
    expect(browserAgent.step).toBe(0)
    // 下一个会话从第 1 步开始
    recordBrowserActivity({ action: 'open', url: 'https://b.example', sessionId: 's2' })
    expect(browserAgent.step).toBe(1)
  })
})
