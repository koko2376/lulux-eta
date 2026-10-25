import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { setLanguage } from '../i18n'
import { auth } from '../lib/session'
import { trashConfirmMessage, trashNotice, trashRetentionDays } from '../lib/trash'
import { uiState } from '../stores/ui'
import SettingsTrashView from './SettingsTrashView.vue'

const item = (over: Partial<api.TrashItem> = {}): api.TrashItem => ({
  entity: 'customer',
  id: 'c1',
  title: 'Acme Valves',
  subtitle: 'US',
  customerId: 'c1',
  ownerId: 'u1',
  ownerName: 'Alice',
  deletedAt: new Date(2026, 9, 20, 9, 5).getTime(),
  deletedBy: 'u2',
  deletedByName: 'Bob',
  purgeAt: new Date(2026, 10, 19, 9, 5).getTime(),
  cascadedTasks: 2,
  ...over,
})

function me(role: string, permissions: string[]) {
  return { user: { id: 'u1', role }, permissions } as unknown as typeof auth.me
}

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/trash', component: SettingsTrashView },
      { path: '/:p(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push('/settings/trash')
  await router.isReady()
  const wrapper = mount(SettingsTrashView, {
    global: {
      plugins: [router, createPinia()],
      stubs: { SettingsSidebar: true, PageTopbar: { template: '<div><slot /></div>' }, teleport: true },
    },
  })
  await flushPromises()
  return wrapper
}

let list: ReturnType<typeof vi.fn>

beforeEach(() => {
  setLanguage('zh-CN')
  list = vi.fn().mockResolvedValue({
    items: [
      item(),
      item({ entity: 'quote', id: 'q1', title: 'Q-2026-001', subtitle: 'Acme Valves', cascadedTasks: undefined }),
    ],
    total: 2,
    retentionDays: 30,
  })
  vi.spyOn(api.trashApi, 'list').mockImplementation(list)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uiState.toasts.splice(0)
  uiState.confirm = null
  auth.me = null
  auth.mode = 'desktop'
  trashRetentionDays.value = 30
})

describe('回收站页面', () => {
  it('列出记录：类型、名称、负责人、删除时间与删除人', async () => {
    const wrapper = await mountView()
    const rows = wrapper.findAll('[data-testid="trash-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('客户')
    expect(rows[0]!.text()).toContain('Acme Valves')
    expect(rows[0]!.text()).toContain('含 2 个任务')
    expect(rows[0]!.text()).toContain('Alice')
    expect(rows[0]!.text()).toContain('Bob')
    expect(rows[0]!.text()).toContain('2026-10-20 09:05')
    expect(rows[1]!.text()).toContain('Q-2026-001')
    expect(wrapper.get('[data-testid="trash-retention"]').text()).toContain('30 天')
  })

  it('按类型筛选与搜索会带上参数重新加载', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await mountView()
    await wrapper.get('[data-testid="trash-type-order"]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ entity: 'order', page: 1 }))
    await wrapper.get('[data-testid="trash-search"]').setValue('acme')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ entity: 'order', query: 'acme' }))
    await wrapper.get('[data-testid="trash-type-all"]').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ entity: undefined, query: 'acme' }))
  })

  it('恢复：调用接口并刷新列表', async () => {
    const restore = vi.spyOn(api.trashApi, 'restore').mockResolvedValue({ entity: 'customer', id: 'c1', restored: 3 })
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="trash-restore"]')[0]!.trigger('click')
    await flushPromises()
    expect(restore).toHaveBeenCalledWith('customer', 'c1')
    expect(list).toHaveBeenCalledTimes(2)
    expect(uiState.toasts.some((x) => x.message.includes('Acme Valves'))).toBe(true)
  })

  it('恢复的客户有疑似重复时额外提示', async () => {
    vi.spyOn(api.trashApi, 'restore').mockResolvedValue({
      entity: 'customer',
      id: 'c1',
      restored: 1,
      duplicates: [{ company: 'ACME Valves Ltd', ownerName: 'Carol', matchedBy: ['company'] }],
    })
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="trash-restore"]')[0]!.trigger('click')
    await flushPromises()
    expect(
      uiState.toasts.some(
        (x) => x.kind === 'info' && x.message.includes('ACME Valves Ltd') && x.message.includes('Carol'),
      ),
    ).toBe(true)
  })

  it('恢复失败（所属客户也在回收站）时提示原因', async () => {
    vi.spyOn(api.trashApi, 'restore').mockRejectedValue(
      new api.ApiError('CUSTOMER_IN_TRASH', '所属客户也在回收站里，请先恢复客户', 409),
    )
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="trash-restore"]')[1]!.trigger('click')
    await flushPromises()
    expect(uiState.toasts.some((x) => x.message.includes('请先恢复客户'))).toBe(true)
  })

  it('彻底删除需要确认，取消则不调用接口', async () => {
    const purge = vi.spyOn(api.trashApi, 'purge').mockResolvedValue(undefined)
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="trash-purge"]')[1]!.trigger('click')
    await flushPromises()
    expect(uiState.confirm?.title).toContain('Q-2026-001')
    uiState.confirm!.resolve(false)
    await flushPromises()
    expect(purge).not.toHaveBeenCalled()

    await wrapper.findAll('[data-testid="trash-purge"]')[1]!.trigger('click')
    await flushPromises()
    uiState.confirm!.resolve(true)
    await flushPromises()
    expect(purge).toHaveBeenCalledWith('quote', 'q1')
  })

  it('服务器模式：member 有恢复、没有彻底删除；admin 两者都有', async () => {
    auth.mode = 'server'
    auth.me = me('member', ['data:read', 'data:write', 'customer:delete', 'quote:delete'])
    let wrapper = await mountView()
    expect(wrapper.findAll('[data-testid="trash-restore"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="trash-purge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="trash-retention-input"]').exists()).toBe(false)
    wrapper.unmount()

    auth.me = me('admin', ['data:read', 'data:write', 'customer:delete', 'settings:write'])
    wrapper = await mountView()
    // 没有 quote:delete 时报价那一行不显示彻底删除
    expect(wrapper.findAll('[data-testid="trash-purge"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="trash-retention-input"]').exists()).toBe(true)
  })

  it('viewer 只能查看', async () => {
    auth.mode = 'server'
    auth.me = me('viewer', ['data:read'])
    const wrapper = await mountView()
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="trash-restore"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="trash-purge"]').exists()).toBe(false)
  })

  it('修改保留天数：保存设置并更新删除确认文案', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({ trashRetentionDays: '7' })
    const wrapper = await mountView()
    const save = wrapper.get('[data-testid="trash-retention-save"]')
    expect(save.attributes('disabled')).toBeDefined()
    list.mockResolvedValue({ items: [], total: 0, retentionDays: 7 })
    await wrapper.get('[data-testid="trash-retention-input"]').setValue('7')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(update).toHaveBeenCalledWith({ trashRetentionDays: '7' })
    expect(trashRetentionDays.value).toBe(7)
    expect(trashConfirmMessage('crm.deleteDealMsg')).toBe('商机将移入回收站，7 天内可恢复，已生成的订单不受影响。')
  })

  it('空回收站显示说明', async () => {
    list.mockResolvedValue({ items: [], total: 0, retentionDays: 0 })
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('回收站是空的')
    expect(wrapper.text()).toContain('不自动清理')
  })
})

describe('删除确认文案', () => {
  it('按保留天数生成，0 天为可随时恢复', () => {
    expect(trashNotice(30)).toBe('将移入回收站，30 天内可恢复')
    expect(trashNotice(0)).toBe('将移入回收站，可随时恢复')
    expect(trashConfirmMessage('quotation.deleteMsg', 14)).toContain('14 天内可恢复')
    expect(trashConfirmMessage('custx.deleteMsg', 30)).not.toContain('无法恢复')
  })

  it('英文单复数', () => {
    setLanguage('en')
    expect(trashNotice(1)).toBe('will be moved to the recycle bin and can be restored within 1 day')
    expect(trashConfirmMessage('crm.deleteOrderMsg', 30)).toBe(
      'The order (with its payment records) will be moved to the recycle bin and can be restored within 30 days.',
    )
    setLanguage('zh-CN')
  })
})
