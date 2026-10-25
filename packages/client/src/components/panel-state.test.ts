import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SESSIONS, loadPanel, panelKey, savePanel } from '../lib/panel-state'
import { auth } from '../lib/session'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getCustomer: vi.fn(async () => null), getQuote: vi.fn(async () => null) }
})

function session(id: string) {
  return {
    id,
    title: id,
    kind: 'single',
    groupName: null,
    providerId: null,
    agentIds: ['builtin'],
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    myRole: 'owner',
  }
}

beforeEach(() => {
  window.localStorage.clear()
  // 宽屏（停靠模式）
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as never
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('右侧面板状态（lib）', () => {
  it('按会话读写；没记过默认详情；none = 收起；非法值按默认', () => {
    expect(loadPanel('s1')).toBe('detail')
    savePanel('s1', null)
    expect(window.localStorage.getItem(panelKey('s1'))).toBe('none')
    expect(loadPanel('s1')).toBeNull()
    savePanel('s1', 'artifacts')
    expect(loadPanel('s1')).toBe('artifacts')
    window.localStorage.setItem(panelKey('s2'), 'bogus')
    expect(loadPanel('s2')).toBe('detail')
    expect(loadPanel(null)).toBe('detail')
  })

  it('键按账号区分（同一浏览器多个账号互不影响）；旧格式键会被清掉；每个账号最多保留最近 MAX_SESSIONS 个', () => {
    const prev = auth.me
    try {
      auth.me = { user: { id: 'usr_alice' } } as never
      expect(panelKey('s1')).toBe('lulux.panel.usr_alice.s1')
      window.localStorage.setItem('lulux.panel.s1', 'browser')
      savePanel('s1', null)
      expect(window.localStorage.getItem('lulux.panel.s1')).toBeNull()
      expect(loadPanel('s1')).toBeNull()
      auth.me = { user: { id: 'usr_bob' } } as never
      expect(loadPanel('s1')).toBe('detail')
      savePanel('s1', 'artifacts')
      auth.me = { user: { id: 'usr_alice' } } as never
      expect(loadPanel('s1')).toBeNull()
      for (let i = 0; i < MAX_SESSIONS + 5; i += 1) savePanel(`x${i}`, 'browser')
      expect(window.localStorage.getItem(panelKey('s1'))).toBeNull()
      expect(window.localStorage.getItem(panelKey('x0'))).toBeNull()
      expect(loadPanel(`x${MAX_SESSIONS + 4}`)).toBe('browser')
      expect(window.localStorage.getItem(panelKey('s1', 'usr_bob'))).toBe('artifacts')
    } finally {
      auth.me = prev
    }
  })
})

describe('ChatView：面板展开状态按会话记住', () => {
  it('收起 → 切到别的会话（仍展开）→ 切回来仍收起', { timeout: 30_000 }, async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAppStore } = await import('../stores/app')
    const store = useAppStore()
    store.sessions = [session('a'), session('b')] as never
    store.currentSessionId = 'a'
    const ChatView = (await import('./ChatView.vue')).default
    const w = mount(ChatView, {
      global: {
        plugins: [pinia],
        stubs: {
          MessageList: true,
          Composer: true,
          KernelMenu: true,
          ContextBindingModal: true,
          AgentAvatar: true,
          ArtifactPanel: true,
          BrowserPanel: true,
          RouterLink: true,
          DetailPanel: { template: '<aside class="detail-stub" @click="$emit(\'close\')" />', emits: ['close'] },
        },
      },
    })
    await flushPromises()
    expect(w.find('.detail-stub').exists()).toBe(true)
    await w.get('.detail-stub').trigger('click')
    await flushPromises()
    expect(w.find('.detail-stub').exists()).toBe(false)
    expect(window.localStorage.getItem(panelKey('a'))).toBe('none')

    store.currentSessionId = 'b'
    await flushPromises()
    expect(w.find('.detail-stub').exists()).toBe(true)
    // 切换会话本身不写状态
    expect(window.localStorage.getItem(panelKey('b'))).toBeNull()

    store.currentSessionId = 'a'
    await flushPromises()
    expect(w.find('.detail-stub').exists()).toBe(false)
    w.unmount()
  })
})
