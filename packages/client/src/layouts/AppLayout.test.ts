import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { shortcutUi } from '../lib/shortcuts'
import { useAppStore } from '../stores/app'
import AppLayout from './AppLayout.vue'

const push = vi.fn(async () => undefined)
const current = { value: { name: 'customers' as string } }
vi.mock('vue-router', () => ({ useRouter: () => ({ push, replace: vi.fn(), currentRoute: current }) }))
vi.mock('../stores/events', () => ({ startEvents: vi.fn(), stopEvents: vi.fn(), onServerEvent: () => () => undefined }))
vi.mock('../stores/automation-events', () => ({ startScheduleNotices: () => () => undefined }))
vi.mock('../stores/group-live', () => ({ startGroupLive: () => () => undefined }))

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

let mounted: Array<{ unmount: () => void }> = []
async function mountLayout() {
  const w = mount(AppLayout, {
    attachTo: document.body,
    global: { stubs: { AppSidebar: true, RouterView: true, CommandPalette: { template: '<div data-testid="palette-stub" />' }, teleport: true } },
  })
  mounted.push(w)
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(api, 'request').mockResolvedValue({} as never)
  current.value = { name: 'customers' }
  push.mockClear()
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.restoreAllMocks()
  shortcutUi.palette = false
  shortcutUi.help = false
  document.body.innerHTML = ''
})

describe('全局快捷键', () => {
  it('Ctrl+K 打开 / 关闭命令面板，并阻止浏览器默认行为', async () => {
    const w = await mountLayout()
    const event = press({ key: 'k', ctrlKey: true })
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(w.find('[data-testid="palette-stub"]').exists()).toBe(true)
    press({ key: 'k', ctrlKey: true })
    await flushPromises()
    expect(w.find('[data-testid="palette-stub"]').exists()).toBe(false)
  })

  it('? 打开快捷键帮助（中文）；在输入框里打 ? 不触发', async () => {
    const w = await mountLayout()
    const input = document.createElement('input')
    document.body.appendChild(input)
    const typed = press({ key: '?' }, input)
    await flushPromises()
    expect(typed.defaultPrevented).toBe(false)
    expect(shortcutUi.help).toBe(false)
    press({ key: '?' })
    await flushPromises()
    expect(document.querySelector('[data-testid="shortcuts-help"]')?.textContent).toContain('搜索 / 命令面板')
    expect(w.exists()).toBe(true)
  })

  it('Ctrl+Shift+O 新对话：跳到对话页并新建会话', async () => {
    await mountLayout()
    const store = useAppStore()
    const create = vi.spyOn(store, 'newSession').mockResolvedValue('s-new')
    press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(push).toHaveBeenCalledWith({ name: 'agent' })
    expect(create).toHaveBeenCalled()
  })

  it('/ 聚焦消息输入框；输入框里打 / 不拦截', async () => {
    await mountLayout()
    const ta = document.createElement('textarea')
    ta.setAttribute('data-composer-input', '')
    document.body.appendChild(ta)
    const event = press({ key: '/' })
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(ta)
    const again = press({ key: '/' }, ta)
    expect(again.defaultPrevented).toBe(false)
  })

  it('有别的对话框打开时不抢快捷键', async () => {
    await mountLayout()
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop'
    document.body.appendChild(backdrop)
    const event = press({ key: 'k', ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(shortcutUi.palette).toBe(false)
  })
})
