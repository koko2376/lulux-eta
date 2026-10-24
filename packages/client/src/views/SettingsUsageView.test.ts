import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'

const EMPTY_TOTALS = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  estimatedCalls: 0,
  cost: {},
  unpricedCalls: 0,
}

function signIn(role: api.Role): void {
  auth.mode = 'server'
  auth.me = {
    mode: 'server',
    user: {
      id: 'me',
      email: 'me@acme.example.com',
      name: 'Me',
      role,
      disabled: false,
      createdAt: 0,
      lastLoginAt: null,
    },
    org: { id: 'o', name: 'Acme', createdAt: 0 },
    teams: [],
    permissions: role === 'member' ? ['data:read', 'data:write'] : [...api.ALL_PERMISSIONS],
    session: null,
  } as never
}

async function mountView(settings: Record<string, string> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const builtin = await import('../api/builtin')
  const getUsage = vi.spyOn(builtin, 'getUsage').mockImplementation(async (_filter, groupBy) => ({
    totals: { ...EMPTY_TOTALS, calls: 3 },
    groups:
      groupBy === 'member'
        ? [
            { ...EMPTY_TOTALS, key: 'me', label: 'Me', calls: 2 },
            { ...EMPTY_TOTALS, key: 'u2', label: 'Alice', calls: 1 },
          ]
        : [],
  }))
  vi.spyOn(builtin, 'getUsageRecords').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(api, 'listSettings').mockResolvedValue(settings as never)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.settings = { ...settings }
  const View = (await import('./SettingsUsageView.vue')).default
  const wrapper = mount(View, {
    global: {
      plugins: [pinia],
      directives: { perm: () => undefined },
      stubs: { SettingsSidebar: true, PageTopbar: true, RouterLink: true, teleport: true },
    },
  })
  await flushPromises()
  return { wrapper, getUsage, store }
}

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  vi.restoreAllMocks()
})

describe('用量：按成员', () => {
  it('管理员能按成员分组（自动全组织口径），并标出自己', async () => {
    signIn('admin')
    const { wrapper, getUsage } = await mountView()
    const tab = wrapper.findAll('button[role="tab"]').find((b) => b.text() === '按成员')
    expect(tab).toBeTruthy()
    await tab!.trigger('click')
    await flushPromises()
    const call = getUsage.mock.calls.at(-1)!
    expect(call[1]).toBe('member')
    expect(call[0].scope).toBe('all')
    const rows = wrapper.findAll('tbody tr').map((r) => r.find('td').text())
    expect(rows).toEqual(['Me（我）', 'Alice'])
  })

  it('普通成员没有按成员分组，也看不到限流设置', async () => {
    signIn('member')
    const { wrapper } = await mountView()
    expect(wrapper.findAll('button[role="tab"]').some((b) => b.text() === '按成员')).toBe(false)
    expect(wrapper.find('[data-testid="chat-rate-limits"]').exists()).toBe(false)
  })

  it('管理员修改限流：校验范围并保存为设置项', async () => {
    signIn('owner')
    const { wrapper, store } = await mountView({ chatMaxConcurrentRunsPerUser: '3', chatRunsPerMinutePerUser: '20' })
    const save = vi.spyOn(store, 'saveSettings').mockResolvedValue()
    const panel = wrapper.get('[data-testid="chat-rate-limits"]')
    const concurrent = panel.get('input[name="chatMaxConcurrentRunsPerUser"]')
    const perMinute = panel.get('input[name="chatRunsPerMinutePerUser"]')
    expect((concurrent.element as HTMLInputElement).value).toBe('3')
    await perMinute.setValue('9999')
    await panel.get('button.primary').trigger('click')
    expect(save).not.toHaveBeenCalled()
    expect(panel.find('[role="alert"]').exists()).toBe(true)
    await concurrent.setValue('2')
    await perMinute.setValue('0')
    await panel.get('button.primary').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith({ chatMaxConcurrentRunsPerUser: '2', chatRunsPerMinutePerUser: '0' })
  })
})
