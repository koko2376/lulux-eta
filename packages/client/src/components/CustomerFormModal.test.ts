import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { ApiError, onApiError } from '../api/http'
import { setLanguage } from '../i18n'
import { uiState } from '../stores/ui'
import CustomerFormModal from './CustomerFormModal.vue'

const DUP = new ApiError('CUSTOMER_DUPLICATE', '可能与已有客户重复', 409, '', {
  duplicates: [
    { company: 'Hooli Trading Co., Ltd.', ownerName: 'alice', matchedBy: ['company', 'emailDomain'] },
    { id: 'cus_1', company: 'Hooli GmbH', ownerName: 'bob', matchedBy: ['phone'] },
  ],
})

async function mountModal() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div />' } }] })
  await router.push('/')
  return mount(CustomerFormModal, { global: { plugins: [router], stubs: { teleport: true } } })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  uiState.toasts.splice(0)
  setLanguage('zh-CN')
})

describe('新建客户：查重命中', () => {
  it('显示已有客户的公司名与负责人，“仍然创建”带 force 重新提交', async () => {
    const saved = { id: 'cus_new', company: 'Hooli' } as api.Customer
    const create = vi.spyOn(api, 'createCustomer').mockRejectedValueOnce(DUP).mockResolvedValueOnce(saved)
    const wrapper = await mountModal()
    await wrapper.get('input.input').setValue('Hooli')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const notice = wrapper.get('[data-test="customer-duplicate"]')
    expect(notice.text()).toContain('Hooli Trading Co., Ltd.')
    expect(notice.text()).toContain('负责人：alice')
    expect(notice.text()).toContain('公司名 / 邮箱域名')
    // 看得见的客户给链接，看不见的不给
    expect(notice.findAll('a')).toHaveLength(1)
    expect(notice.get('a').attributes('href')).toContain('/customers/cus_1')
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'Hooli' }), { force: false })

    await wrapper.get('[data-test="force-create"]').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'Hooli' }), { force: true })
    expect(wrapper.emitted('saved')?.[0]).toEqual([saved])
  })

  it('返回修改时收起提示；英文界面文案', async () => {
    setLanguage('en')
    vi.spyOn(api, 'createCustomer').mockRejectedValueOnce(DUP)
    const wrapper = await mountModal()
    await wrapper.get('input.input').setValue('Hooli')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('This customer may already exist')
    expect(wrapper.text()).toContain('Owner: alice')
    expect(wrapper.text()).toContain('Create anyway')
    const back = wrapper.findAll('button').find((b) => b.text() === 'Go back')!
    await back.trigger('click')
    expect(wrapper.find('[data-test="customer-duplicate"]').exists()).toBe(false)
  })
})

describe('api.createCustomer', () => {
  it('查重 409 不弹全局提示并带出 details；force 写进请求体', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (body.force) return new Response(JSON.stringify({ id: 'cus_2', company: body.company }), { status: 201 })
      return new Response(JSON.stringify({ error: { code: 'CUSTOMER_DUPLICATE', message: 'dup', details: DUP.details } }), { status: 409 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen: string[] = []
    const off = onApiError((e) => seen.push(e.code))
    const error = await api.createCustomer({ company: 'Hooli' } as api.CustomerInput).catch((e) => e)
    expect(api.customerDuplicatesOf(error)).toHaveLength(2)
    expect(seen).toEqual([])
    off()
    const created = await api.createCustomer({ company: 'Hooli' } as api.CustomerInput, { force: true })
    expect(created.id).toBe('cus_2')
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).force).toBe(true)
  })

  it('其它错误照常弹全局提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no' } }), { status: 403 })))
    const seen: string[] = []
    const off = onApiError((e) => seen.push(e.code))
    await api.createCustomer({ company: 'X' } as api.CustomerInput).catch(() => undefined)
    off()
    expect(seen).toEqual(['FORBIDDEN'])
  })
})
