import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { MemoryEntry, MemoryState } from '../api/memory'

const apiMock = vi.hoisted(() => ({
  getMemory: vi.fn(),
  updateMemorySettings: vi.fn(),
  addMemoryEntry: vi.fn(),
  updateMemoryEntry: vi.fn(),
  deleteMemoryEntry: vi.fn(),
  clearMemory: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), ...apiMock }))

const uiMock = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('../stores/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stores/ui')>()),
  ...uiMock,
}))

import SettingsMemoryView from './SettingsMemoryView.vue'
import ToolTrace from '../components/ToolTrace.vue'

function entry(
  id: string,
  section: 'profile' | 'notes',
  content: string,
  source: MemoryEntry['source'] = 'user',
): MemoryEntry {
  return {
    id,
    section,
    content,
    source,
    sourceSessionId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function state(patch: Partial<MemoryState> = {}): MemoryState {
  const profile = [entry('m1', 'profile', '主营阀门出口到中东', 'agent')]
  const notes = [entry('m2', 'notes', '报价默认 FOB Ningbo，美元')]
  return {
    enabled: true,
    autoExtract: true,
    groupMemory: false,
    entryMax: 500,
    profile: { entries: profile, used: profile[0]!.content.length, limit: 2000 },
    notes: { entries: notes, used: 1900 * 2, limit: 4000 },
    ...patch,
  }
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/memory', component: SettingsMemoryView },
      { path: '/:p(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push('/settings/memory')
  await router.isReady()
  const wrapper = mount(SettingsMemoryView, { global: { plugins: [router, createPinia()] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset())
  uiMock.confirmDialog.mockReset()
  uiMock.toast.success.mockReset()
  apiMock.getMemory.mockResolvedValue(state())
})

describe('设置 → 记忆', () => {
  it('两个分区：条目、来源、用量文字与进度条（≥90% 标红）', async () => {
    const wrapper = await mountView()
    const profile = wrapper.get('[data-testid="memory-section-profile"]')
    expect(profile.text()).toContain('用户画像')
    expect(profile.text()).toContain('主营阀门出口到中东')
    expect(profile.text()).toContain('Agent 保存')
    expect(profile.get('[data-testid="memory-usage"]').text()).toBe('已用 9 / 2,000 字')
    const notes = wrapper.get('[data-testid="memory-section-notes"]')
    expect(notes.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('95')
    expect(notes.get('.usage-bar').classes()).toContain('bad')
    expect(wrapper.findAll('[data-testid="memory-entry"]')).toHaveLength(2)
  })

  it('开关：关闭长期记忆后自动提取不可用并显示提示', async () => {
    apiMock.updateMemorySettings.mockResolvedValue(state({ enabled: false }))
    const wrapper = await mountView()
    await wrapper.get('[data-testid="memory-enabled"]').trigger('click')
    await flushPromises()
    expect(apiMock.updateMemorySettings).toHaveBeenCalledWith({ enabled: false })
    expect(wrapper.get('[data-testid="memory-auto-extract"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('长期记忆已关闭')
  })

  it('群聊中使用我的记忆：默认关，点击后 PATCH groupMemory=true；记忆关闭时不可用', async () => {
    apiMock.updateMemorySettings.mockResolvedValue(state({ groupMemory: true }))
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('群聊中使用我的记忆')
    const toggle = wrapper.get('[data-testid="memory-group"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(apiMock.updateMemorySettings).toHaveBeenCalledWith({ groupMemory: true })
    expect(wrapper.get('[data-testid="memory-group"]').attributes('aria-checked')).toBe('true')
    apiMock.getMemory.mockResolvedValue(state({ enabled: false }))
    const off = await mountView()
    expect(off.get('[data-testid="memory-group"]').attributes('disabled')).toBeDefined()
  })

  it('添加 / 编辑 / 删除 / 清空', async () => {
    apiMock.addMemoryEntry.mockResolvedValue({ entry: entry('m3', 'profile', '偏好简洁的英文邮件'), duplicate: false })
    apiMock.updateMemoryEntry.mockResolvedValue({ entry: entry('m1', 'profile', '主营阀门，出口中东与北非') })
    apiMock.deleteMemoryEntry.mockResolvedValue(undefined)
    apiMock.clearMemory.mockResolvedValue({ removed: 2 })
    uiMock.confirmDialog.mockResolvedValue(true)
    const wrapper = await mountView()

    await wrapper.get('[data-testid="memory-add-profile"]').setValue('  偏好简洁的英文邮件 ')
    await wrapper.get('[data-testid="memory-section-profile"] form').trigger('submit')
    await flushPromises()
    expect(apiMock.addMemoryEntry).toHaveBeenCalledWith('profile', '偏好简洁的英文邮件')
    expect(uiMock.toast.success).toHaveBeenCalledWith('已添加')

    const first = wrapper.findAll('[data-testid="memory-entry"]')[0]!
    await first
      .findAll('button')
      .find((b) => b.text() === '编辑')!
      .trigger('click')
    await first.get('textarea').setValue('主营阀门，出口中东与北非')
    await first
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click')
    await flushPromises()
    expect(apiMock.updateMemoryEntry).toHaveBeenCalledWith('m1', '主营阀门，出口中东与北非')

    const second = wrapper.findAll('[data-testid="memory-entry"]')[1]!
    await second
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click')
    await flushPromises()
    expect(uiMock.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(apiMock.deleteMemoryEntry).toHaveBeenCalledWith('m2')

    await wrapper.get('[data-testid="memory-clear"]').trigger('click')
    await flushPromises()
    expect(uiMock.confirmDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '将删除 2 条记忆，无法撤销。' }),
    )
    expect(apiMock.clearMemory).toHaveBeenCalledWith()
  })

  it('取消确认不删除；空条目时显示引导文案、清空按钮不可用', async () => {
    uiMock.confirmDialog.mockResolvedValue(false)
    const wrapper = await mountView()
    await wrapper
      .findAll('[data-testid="memory-entry"]')[0]!
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click')
    await flushPromises()
    expect(apiMock.deleteMemoryEntry).not.toHaveBeenCalled()

    apiMock.getMemory.mockResolvedValue(
      state({ profile: { entries: [], used: 0, limit: 2000 }, notes: { entries: [], used: 0, limit: 4000 } }),
    )
    const empty = await mountView()
    expect(empty.text()).toContain('还没有条目')
    expect(empty.get('[data-testid="memory-clear"]').attributes('disabled')).toBeDefined()
  })

  it('英文界面', async () => {
    const { setLanguage } = await import('../i18n')
    setLanguage('en')
    try {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain('Profile')
      expect(wrapper.text()).toContain('9 / 2,000 characters used')
      expect(wrapper.text()).toContain('Saved by agent')
      expect(wrapper.text()).toContain('Use my memory in group chats')
    } finally {
      setLanguage('zh-CN')
    }
  })
})

describe('对话里的“已更新记忆”', () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }],
  })

  it('记忆工具成功：显示友好标题与“已更新记忆”，不显示“写入”标记', () => {
    const wrapper = mount(ToolTrace, {
      global: { plugins: [router] },
      props: {
        name: 'memory_add',
        server: 'LULUX',
        args: '{"section":"profile","content":"主营阀门"}',
        status: 'done',
        result: '已保存',
        durationMs: 3,
        risk: 'write',
      },
    })
    expect(wrapper.text()).toContain('保存记忆')
    expect(wrapper.get('[data-testid="memory-updated"]').text()).toContain('已更新记忆')
    expect(wrapper.get('[data-testid="memory-updated"] a').attributes('href')).toContain('/settings/memory')
    expect(wrapper.find('.tool-risk').exists()).toBe(false)
  })

  it('失败或其他工具：不显示', () => {
    const failed = mount(ToolTrace, {
      global: { plugins: [router] },
      props: { name: 'memory_add', server: 'LULUX', args: '{}', status: 'error', result: 'x', durationMs: 0 },
    })
    expect(failed.find('[data-testid="memory-updated"]').exists()).toBe(false)
    const other = mount(ToolTrace, {
      global: { plugins: [router] },
      props: {
        name: 'create_customer',
        server: 'LULUX',
        args: '{}',
        status: 'done',
        result: 'ok',
        durationMs: 0,
        risk: 'write',
      },
    })
    expect(other.find('[data-testid="memory-updated"]').exists()).toBe(false)
    expect(other.find('.tool-risk').exists()).toBe(true)
  })
})
