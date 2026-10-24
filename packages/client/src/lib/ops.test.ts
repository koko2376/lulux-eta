import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import ErrorBoundary from '../components/ErrorBoundary.vue'
import { getDesktop, isDesktopNotice } from './desktop'
import { clearFatal, fatalState, isChunkLoadError, isFatalVueError } from './fatal-error'
import { updateErrorText } from './updater'

afterEach(() => {
  clearFatal()
  vi.restoreAllMocks()
})

describe('全局错误兜底', () => {
  it('只把 setup / render / 挂载失败当作致命错误（开发与生产两种 info 形式）', () => {
    expect(isFatalVueError('render function')).toBe(true)
    expect(isFatalVueError('setup function')).toBe(true)
    expect(isFatalVueError('https://vuejs.org/error-reference/#runtime-1')).toBe(true)
    expect(isFatalVueError('https://vuejs.org/error-reference/#runtime-m')).toBe(true)
    expect(isFatalVueError('native event handler')).toBe(false)
    expect(isFatalVueError('https://vuejs.org/error-reference/#runtime-5')).toBe(false)
  })

  it('识别更新后加载不到代码块', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/X.js'))).toBe(true)
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
  })

  it('子组件渲染失败时显示友好错误页与“重新加载”', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const Broken = defineComponent({
      setup() {
        return () => {
          throw new Error('render exploded')
        }
      },
    })
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
    const wrapper = mount(ErrorBoundary, { slots: { default: () => h(Broken) } })
    await flushPromises()
    expect(fatalState.error?.message).toBe('render exploded')
    expect(wrapper.find('[data-testid="error-boundary"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('页面出了点问题')
    await wrapper.get('[data-testid="error-reload"]').trigger('click')
    expect(reload).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('正常时原样渲染内容', () => {
    const wrapper = mount(ErrorBoundary, { slots: { default: () => h('p', 'ok') } })
    expect(wrapper.text()).toBe('ok')
  })
})

describe('桌面桥', () => {
  it('没有 preload 或旧版 preload 时返回 null', () => {
    expect(getDesktop({} as Window)).toBeNull()
    expect(getDesktop({ lulux: { platform: 'win32', desktop: {} } } as unknown as Window)).toBeNull()
    const bridge = { getPrefs: vi.fn(), exportDiagnostics: vi.fn() }
    expect(getDesktop({ lulux: { platform: 'win32', desktop: bridge } } as unknown as Window)).toBe(bridge)
    expect(getDesktop({ luluxAgent: { platform: 'linux', versions: {}, desktop: bridge } } as unknown as Window)).toBe(
      bridge,
    )
  })

  it('通知类型校验', () => {
    expect(isDesktopNotice({ type: 'server-restarted' })).toBe(true)
    expect(isDesktopNotice({ type: 'other' })).toBe(false)
    expect(isDesktopNotice(null)).toBe(false)
  })
})

describe('更新失败提示', () => {
  it('按类别给出明确说明；自定义源有单独的说明；未知类别显示原文', () => {
    expect(updateErrorText({ message: 'getaddrinfo ENOTFOUND', kind: 'network' })).toContain('连不上更新服务器')
    expect(updateErrorText({ message: 'x', kind: 'network' }, true)).toContain('更新源地址')
    expect(updateErrorText({ message: 'x', kind: 'not-found' }, true)).toContain('latest.yml')
    expect(updateErrorText({ message: 'raw message' })).toBe('raw message')
    expect(updateErrorText(null)).toBe('')
  })
})
