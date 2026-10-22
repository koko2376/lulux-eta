import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** desktopBrowser 在模块加载时读取 window.luluxAgent，所以每个用例重新加载组件 */
async function load(browser: Partial<LuluxDesktopBrowser> | null) {
  vi.resetModules()
  ;(window as unknown as { luluxAgent?: unknown }).luluxAgent = browser ? { browser } : undefined
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
