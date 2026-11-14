import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { vPerm } from '../lib/perm-directive'
import { uiState } from '../stores/ui'
import CustomersView from './CustomersView.vue'

function row(id: string, company: string) {
  return {
    id,
    company,
    country: 'DE',
    website: '',
    stage: 'new',
    tags: [],
    source: '',
    notes: '',
    contacts: [],
    createdAt: 0,
    updatedAt: 0,
    lastTouchAt: null,
    nextTask: null,
  } as unknown as api.Customer & api.CustomerFollowUp
}

async function mountView(items: ReturnType<typeof row>[], total = items.length) {
  vi.spyOn(api, 'listCustomers').mockResolvedValue({ items, total, nextCursor: null } as never)
  vi.spyOn(api, 'getCustomerFacets').mockResolvedValue({ total: items.length, newThisMonth: 0, countries: [], tags: [], owners: [] } as never)
  vi.spyOn(api, 'getWorkbenchSummary').mockRejectedValue(new Error('skip'))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/customers', component: CustomersView }, { path: '/:p(.*)*', component: CustomersView }] })
  await router.push('/customers')
  const wrapper = mount(CustomersView, {
    global: { plugins: [router], directives: { perm: vPerm }, stubs: { PageTopbar: true, CustomerFormModal: true, FollowUpModal: true, teleport: true } },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.restoreAllMocks()
  uiState.toasts.splice(0)
  uiState.confirm = null
})

describe('客户列表：批量操作走服务端事务', () => {
  it('批量删除一次请求；服务端逐项失败时跳过并在 toast 里写明哪个客户、什么原因', async () => {
    const msg = '该客户名下有 1 个订单、1 条收款，不能删除。请先转移或处理这些记录。'
    const batch = vi.spyOn(api, 'batchCustomers').mockResolvedValue({
      action: 'delete',
      scope: 'page',
      total: 2,
      succeeded: 1,
      failed: [{ id: 'c2', code: 'CUSTOMER_HAS_RECORDS', message: msg }],
    })
    const del = vi.spyOn(api, 'deleteCustomer')
    const wrapper = await mountView([row('c1', 'Clean GmbH'), row('c2', 'Busy GmbH')])
    for (const cb of wrapper.findAll('tbody input[type="checkbox"]')) await cb.setValue(true)
    await wrapper.get('[data-testid="customers-bulk-delete"]').trigger('click')
    await flushPromises()
    uiState.confirm!.resolve(true)
    await flushPromises()

    expect(del).not.toHaveBeenCalled()
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toMatchObject({ action: 'delete', scope: 'page', ids: ['c1', 'c2'] })
    const last = uiState.toasts.at(-1)!
    expect(last.kind).toBe('error')
    expect(last.message).toContain('Busy GmbH')
    expect(last.message).toContain(msg)
  })

  it('本页全选后可以扩到“全部筛选结果”：按当前筛选条件提交，不传 id', async () => {
    const batch = vi.spyOn(api, 'batchCustomers').mockResolvedValue({ action: 'addTag', scope: 'all', total: 120, succeeded: 120, failed: [] })
    const items = [row('c1', 'A GmbH'), row('c2', 'B GmbH')]
    const wrapper = await mountView(items, 120)
    await wrapper.get('thead input[type="checkbox"]').setValue(true)
    await wrapper.get('[data-testid="customers-select-all-matching"]').trigger('click')
    expect(wrapper.get('[data-testid="customers-bulk"]').text()).toContain('120')
    await wrapper.get('[data-testid="customers-bulk-tag"]').setValue('VIP')
    await wrapper.get('[data-testid="customers-bulk-tag"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const req = batch.mock.calls[0]![0]
    expect(req).toMatchObject({ action: 'addTag', scope: 'all', params: { tag: 'VIP' } })
    expect(req.ids).toBeUndefined()
    expect(uiState.toasts.at(-1)!.kind).toBe('success')
  })
})
