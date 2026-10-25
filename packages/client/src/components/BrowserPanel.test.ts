import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/** desktopBrowser 在模块加载时读取 window.luluxAgent，所以每个用例重新加载组件 */
async function load(browser: Partial<LuluxDesktopBrowser> | null) {
  vi.resetModules()
  ;(window as unknown as { luluxAgent?: unknown }).luluxAgent = browser ? { browser } : undefined
  setActivePinia(createPinia())
  const Panel = (await import('./BrowserPanel.vue')).default
  const capture = await import('../lib/browser-capture')
  return { Panel, capture }
}

function bridge(over: Partial<LuluxDesktopBrowser> = {}): LuluxDesktopBrowser {
  const state: LuluxBrowserState = {
    visible: true,
    activeTabId: 't1',
    tabs: [
      {
        id: 't1',
        url: 'https://example.com/',
        title: 'Example',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  }
  return {
    getState: vi.fn(async () => state),
    newTab: vi.fn(async () => 't1'),
    closeTab: vi.fn(async () => undefined),
    activateTab: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    onState: vi.fn(() => () => undefined),
    ...over,
  }
}

class NoopObserver {
  observe(): void {}
  disconnect(): void {}
}

afterEach(() => {
  delete (window as unknown as { luluxAgent?: unknown }).luluxAgent
})

describe('内置浏览器面板：框选 / 元素', () => {
  vi.stubGlobal('ResizeObserver', NoopObserver)

  it('网页版（无桌面桥）不显示框选按钮', async () => {
    const { Panel } = await load(null)
    const w = mount(Panel)
    expect(w.find('[data-testid="browser-pick-region"]').exists()).toBe(false)
    expect(w.find('.browser-fallback').exists()).toBe(true)
  })

  it('旧版桌面端（没有 pick）也不显示', async () => {
    const { Panel } = await load(bridge())
    const w = mount(Panel)
    await flushPromises()
    expect(w.find('.browser-toolbar').exists()).toBe(true)
    expect(w.find('[data-testid="browser-pick-region"]').exists()).toBe(false)
  })

  it('框选：调用 pick(region)，结果进入输入框队列；Esc 取消进行中的拾取', async () => {
    const result: LuluxBrowserPickResult = {
      mode: 'region',
      image: 'data:image/png;base64,QUJD',
      width: 10,
      height: 10,
      url: 'https://example.com/',
      title: 'Example',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      zoomFactor: 1,
      element: null,
    }
    const pick = vi.fn(async () => result)
    const { Panel, capture } = await load(bridge({ pick, cancelPick: vi.fn(async () => undefined) }))
    capture.pendingCaptures.value = []
    const w = mount(Panel)
    await flushPromises()
    await w.get('[data-testid="browser-pick-region"]').trigger('click')
    await flushPromises()
    expect(pick).toHaveBeenCalledWith('region')
    expect(capture.pendingCaptures.value).toHaveLength(1)
    expect(capture.pendingCaptures.value[0]).toMatchObject({ url: 'https://example.com/', mode: 'region' })

    // 进行中：按钮高亮，Esc 通知主进程取消，结果被丢弃
    let release: (v: LuluxBrowserPickResult | null) => void = () => undefined
    const slow = vi.fn(() => new Promise<LuluxBrowserPickResult | null>((r) => (release = r)))
    const cancelPick = vi.fn(async () => undefined)
    const again = await load(bridge({ pick: slow, cancelPick }))
    again.capture.pendingCaptures.value = []
    const w2 = mount(again.Panel)
    await flushPromises()
    await w2.get('[data-testid="browser-pick-element"]').trigger('click')
    expect(w2.get('[data-testid="browser-pick-element"]').classes()).toContain('active')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(cancelPick).toHaveBeenCalled()
    release(result)
    await flushPromises()
    expect(again.capture.pendingCaptures.value).toHaveLength(0)
    expect(w2.get('[data-testid="browser-pick-element"]').classes()).not.toContain('active')
    w.unmount()
    w2.unmount()
  })
})

describe('内置浏览器面板：Agent 状态条', () => {
  vi.stubGlobal('ResizeObserver', NoopObserver)

  async function setup() {
    const loaded = await load(bridge())
    const api = await import('../api')
    const control = vi.spyOn(api, 'browserControl').mockResolvedValue({ state: 'paused' })
    const agent = await import('../stores/browser-agent')
    const { useAppStore } = await import('../stores/app')
    const store = useAppStore()
    store.currentSessionId = 'sess_1'
    agent.resetBrowserAgent()
    const w = mount(loaded.Panel)
    await flushPromises()
    return { w, agent, control, store }
  }

  it('没有 Agent 活动时不显示状态条', async () => {
    const { w } = await setup()
    expect(w.find('[data-testid="browser-agent-bar"]').exists()).toBe(false)
  })

  it('当前会话的活动显示“第 N 步 + 动作”，别的会话不显示', async () => {
    const { w, agent } = await setup()
    agent.recordBrowserActivity({ action: 'open', url: 'https://example.com/', sessionId: 'sess_other' })
    await flushPromises()
    expect(w.find('[data-testid="browser-agent-bar"]').exists()).toBe(false)
    agent.recordBrowserActivity({ action: 'open', url: 'https://example.com/', sessionId: 'sess_1' })
    agent.recordBrowserActivity({ action: 'click', url: 'https://example.com/a', sessionId: 'sess_1' })
    await flushPromises()
    const bar = w.find('[data-testid="browser-agent-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('2')
    expect(bar.text()).toMatch(/点击|Clicking/)
  })

  it('我来接管 → pause，显示“继续”；继续 → resume；停止 → stop 后 3 秒隐藏', async () => {
    vi.useFakeTimers()
    try {
      const { w, agent, control } = await setup()
      agent.recordBrowserActivity({ action: 'snapshot', url: 'https://example.com/', sessionId: 'sess_1' })
      await flushPromises()
      await w.find('[data-testid="browser-agent-pause"]').trigger('click')
      await flushPromises()
      expect(control).toHaveBeenLastCalledWith('sess_1', 'pause')
      expect(w.find('[data-testid="browser-agent-resume"]').exists()).toBe(true)
      await w.find('[data-testid="browser-agent-resume"]').trigger('click')
      await flushPromises()
      expect(control).toHaveBeenLastCalledWith('sess_1', 'resume')
      await w.find('[data-testid="browser-agent-stop"]').trigger('click')
      await flushPromises()
      expect(control).toHaveBeenLastCalledWith('sess_1', 'stop')
      expect(w.find('[data-testid="browser-agent-stop"]').exists()).toBe(false)
      vi.advanceTimersByTime(3100)
      await flushPromises()
      expect(w.find('[data-testid="browser-agent-bar"]').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行结束 5 秒后收起，下一次活动步数从 1 开始', async () => {
    vi.useFakeTimers()
    try {
      const { w, agent } = await setup()
      agent.recordBrowserActivity({ action: 'open', url: 'https://example.com/', sessionId: 'sess_1' })
      agent.recordBrowserActivity({ action: 'click', url: 'https://example.com/', sessionId: 'sess_1' })
      agent.browserRunEnded('sess_1')
      vi.advanceTimersByTime(5100)
      await flushPromises()
      expect(w.find('[data-testid="browser-agent-bar"]').exists()).toBe(false)
      agent.recordBrowserActivity({ action: 'open', url: 'https://example.com/', sessionId: 'sess_1' })
      expect(agent.browserAgent.step).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
