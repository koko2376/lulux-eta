import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { shortcutUi } from '../lib/shortcuts'
import { useAppStore } from '../stores/app'
import CommandPalette from './CommandPalette.vue'

const push = vi.fn()
const current = { value: { name: 'workbench' as string } }
vi.mock('vue-router', () => ({ useRouter: () => ({ push, currentRoute: current }) }))

function respond(path: string, opts?: { query?: Record<string, unknown> }): unknown {
  if (path === '/api/customers') {
    const q = String(opts?.query?.query ?? '').toLowerCase()
    return { items: [{ id: 'c1', company: 'Acme Valves', country: 'DE' }].filter((c) => c.company.toLowerCase().includes(q)), total: 1 }
  }
  if (path === '/api/quotes') return { quotes: [{ id: 'q1', number: 'Q-2026-001' }] }
  if (path === '/api/orders') return { items: [{ id: 'o1', number: 'SO-77', customerName: 'Acme Valves' }], total: 1 }
  return {}
}

async function mountPalette() {
  const w = mount(CommandPalette, { attachTo: document.body, global: { stubs: { teleport: true } } })
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.spyOn(api, 'request').mockImplementation(async (path: string, opts?: { query?: Record<string, unknown> }) => respond(path, opts) as never)
  push.mockReset()
  current.value = { name: 'workbench' }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  shortcutUi.help = false
  document.body.innerHTML = ''
})

describe('命令面板', () => {
  it('没输入时列出操作和页面；输入框自动获得焦点', async () => {
    const w = await mountPalette()
    expect(document.activeElement).toBe(w.get('[data-testid="command-input"]').element)
    expect(w.find('[data-item="a:new-chat"]').exists()).toBe(true)
    expect(w.find('[data-item="p:/customers"]').exists()).toBe(true)
  })

  it('搜索客户 / 报价 / 订单 / 会话，回车跳转到第一个结果', async () => {
    const store = useAppStore()
    store.sessions = [{ id: 's1', title: 'Acme 报价讨论', groupName: null } as api.Session]
    const w = await mountPalette()
    await w.get('[data-testid="command-input"]').setValue('acme')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(w.find('[data-item="c:c1"]').exists()).toBe(true)
    expect(w.find('[data-item="o:o1"]').exists()).toBe(true)
    expect(w.find('[data-item="s:s1"]').exists()).toBe(true)
    // 方向键选到客户再回车
    const ids = w.findAll('.cp-item').map((el) => el.attributes('data-item'))
    const target = ids.indexOf('c:c1')
    const input = w.get('[data-testid="command-input"]')
    for (let i = 0; i < target; i += 1) await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/customers/c1')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('按报价单号搜索', async () => {
    const w = await mountPalette()
    await w.get('[data-testid="command-input"]').setValue('Q-2026')
    await flushPromises()
    await w.get('[data-item="q:q1"]').trigger('click')
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/quotation/q1')
  })

  it('“新对话”操作：去对话页并新建会话', async () => {
    const store = useAppStore()
    const create = vi.spyOn(store, 'newSession').mockResolvedValue(undefined)
    const w = await mountPalette()
    await w.get('[data-item="a:new-chat"]').trigger('click')
    await flushPromises()
    expect(push).toHaveBeenCalledWith({ name: 'agent' })
    expect(create).toHaveBeenCalled()
  })

  it('没有匹配时显示提示；“快捷键帮助”打开帮助', async () => {
    const w = await mountPalette()
    await w.get('[data-testid="command-input"]').setValue('zzzz-nothing')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(w.text()).toContain('没有匹配的结果')
    await w.get('[data-testid="command-input"]').setValue('快捷键')
    await flushPromises()
    await w.get('[data-item="a:help"]').trigger('click')
    expect(shortcutUi.help).toBe(true)
  })
})
