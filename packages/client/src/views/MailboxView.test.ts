import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import MailboxView from './MailboxView.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

function account(extra: Partial<api.EmailAccount>): api.EmailAccount {
  return {
    id: 'acc1',
    name: 'Mine',
    email: 'me@acme.example.com',
    displayName: '',
    status: { state: 'idle', lastSyncAt: null, lastError: null, lastErrorCode: null, idle: false },
    secretError: null,
    ownerId: 'me',
    ownerName: 'Me',
    visibility: 'private',
    teamId: null,
    ...extra,
  } as api.EmailAccount
}

async function mountWith(accounts: api.EmailAccount[]) {
  vi.spyOn(api, 'listEmailAccounts').mockResolvedValue(accounts)
  const list = vi.spyOn(api, 'listEmailMessages').mockResolvedValue({ items: [], total: 0 })
  vi.spyOn(api, 'listEmailDrafts').mockResolvedValue([])
  const w = mount(MailboxView, { global: { stubs: { RouterLink: true, CustomerPicker: true, MailDraftEditor: true, teleport: true } } })
  await flushPromises()
  return { w, list }
}

afterEach(() => vi.restoreAllMocks())

describe('邮箱：管理员可查看成员邮箱的提示', () => {
  it('组织开启后，成员在自己的邮箱里看到“管理员可查看此邮箱”', async () => {
    const { w } = await mountWith([account({ adminCanRead: true, contentAccess: 'own' })])
    expect(w.get('[data-testid="mail-admin-notice"]').text()).toContain('管理员可查看此邮箱')
    expect(w.get('[data-testid="acct-admin-visible"]').text()).toBe('管理员可查看此邮箱')
  })

  it('未开启时不显示提示', async () => {
    const { w } = await mountWith([account({ adminCanRead: false, contentAccess: 'own' })])
    expect(w.find('[data-testid="mail-admin-notice"]').exists()).toBe(false)
  })

  it('管理员不能查看的成员邮箱：标“仅可管理”，选中后不请求内容并说明原因', async () => {
    const { w, list } = await mountWith([
      account({ contentAccess: 'own' }),
      account({ id: 'acc2', email: 'alice@acme.example.com', ownerId: 'alice', ownerName: 'Alice', contentAccess: 'restricted' }),
    ])
    expect(w.get('[data-testid="acct-restricted"]').text()).toContain('仅可管理')
    list.mockClear()
    const rows = w.findAll('.acct-row button')
    await rows[1]!.trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="mail-restricted"]').text()).toContain('不能查看邮件内容')
    expect(list.mock.calls.some(([q]) => q.accountId === 'acc2')).toBe(false)
  })

  it('管理员查看成员邮箱时提示本次查看会记审计', async () => {
    const { w } = await mountWith([account({ id: 'acc2', ownerName: 'Alice', contentAccess: 'admin' })])
    await w.findAll('.acct-row button')[0]!.trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="mail-admin-reading"]').text()).toContain('Alice')
  })
})
