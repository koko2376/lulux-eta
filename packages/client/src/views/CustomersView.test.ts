import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { ApiError } from '../api/http'
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

async function mountView(items: ReturnType<typeof row>[]) {
  vi.spyOn(api, 'listCustomers').mockResolvedValue({ items, total: items.length } as never)
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

describe('客户列表：批量删除', () => {
  it('名下有业务记录的客户被服务端拒绝（409）时跳过，其余照常删除；toast 显示服务端原因', async () => {
    const msg = '该客户名下有 1 个订单、1 条收款，不能删除。请先转移或处理这些记录。'
    const del = vi.spyOn(api, 'deleteCustomer').mockImplementation(async (id) => {
      if (id === 'c2') throw new ApiError('CUSTOMER_HAS_RECORDS', msg, 409)
    })
    const wrapper = await mountView([row('c1', 'Clean GmbH'), row('c2', 'Busy GmbH')])
    for (const cb of wrapper.findAll('tbody input[type="checkbox"]')) await cb.setValue(true)
    await wrapper.get('[data-testid="customers-bulk-delete"]').trigger('click')
    await flushPromises()
    uiState.confirm!.resolve(true)
    await flushPromises()

    expect(del).toHaveBeenCalledTimes(2)
    expect(del.mock.calls.every((c) => c[1]?.silent === true)).toBe(true)
    const last = uiState.toasts.at(-1)!
    expect(last.kind).toBe('error')
    expect(last.message).toContain('Busy GmbH')
    expect(last.message).toContain(msg)
  })
})
