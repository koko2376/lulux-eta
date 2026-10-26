import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import ShippingDocsModal from './ShippingDocsModal.vue'

const bundle = (): api.DocBundle => ({
  orderId: 'ord1',
  orderNumber: 'SO-1',
  currency: 'USD',
  incoterm: 'FOB',
  paymentTerms: 'T/T',
  info: {
    invoiceNo: 'SO-1',
    invoiceDate: '2026-10-24',
    shipper: { name: 'Koko Valve', address: 'Wenzhou', contact: '' },
    consignee: { name: 'Nordic Tools AB', address: 'SE', contact: '' },
    notifyParty: 'SAME AS CONSIGNEE',
    marks: 'N/M',
    origin: 'CHINA',
    portOfLoading: 'NINGBO',
    portOfDischarge: 'GOTHENBURG',
    vessel: '',
    packageUnit: 'CTNS',
    lines: [{ itemIndex: 0, description: 'Brass ball valve', hsCode: '', cartons: 0, netKg: 0, grossKg: 0, cbm: 0 }],
    updatedAt: null,
  },
  lines: [{ itemIndex: 0, description: 'Brass ball valve', hsCode: '', cartons: 0, netKg: 0, grossKg: 0, cbm: 0, name: 'Brass ball valve', spec: '', qty: 2000, unit: 'pcs', unitPrice: 3.2, amount: 6400 }],
  totals: { qty: 2000, amount: 6400, cartons: 0, netKg: 0, grossKg: 0, cbm: 0 },
  issues: [],
})

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T | null
function type(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input'))
}

describe('ShippingDocsModal', () => {
  it('缺项即时提示并禁用下载；补齐后可下载；HS 建议点选填入', async () => {
    vi.spyOn(api, 'getOrderDocs').mockResolvedValue(bundle())
    const update = vi.spyOn(api, 'updateOrderDocs').mockImplementation(async (_id, body) => {
      const b = bundle()
      b.info = { ...b.info, ...(body as object), lines: body.lines as api.DocLine[] } as api.DocInfo
      return b
    })
    const pdf = vi.spyOn(api, 'orderDocPdf').mockResolvedValue(new Blob(['%PDF']))
    vi.spyOn(api, 'suggestHs').mockResolvedValue({
      query: 'Brass ball valve',
      candidates: [{ code: '8481804090', hs6: '848180', description: 'Brass ball valve', source: 'product', detail: '' }],
      tariffError: null,
      note: '',
    })
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const wrapper = mount(ShippingDocsModal, { props: { orderId: 'ord1', canWrite: true }, attachTo: document.body })
    await flushPromises()
    expect(q('[data-testid="docs-issues"]')!.textContent).toContain('HS')
    expect(q<HTMLButtonElement>('[data-testid="docs-dl-ci"]')!.disabled).toBe(true)

    q<HTMLButtonElement>('[data-testid="hs-suggest-0"]')!.click()
    await flushPromises()
    q<HTMLButtonElement>('[data-testid="hs-panel"] .cand')!.click()
    await flushPromises()
    expect(q<HTMLInputElement>('[data-testid="hs-0"]')!.value).toBe('8481804090')

    const nums = document.querySelectorAll<HTMLInputElement>('[data-testid="docs-lines"] input.num')
    type(nums[0]!, '40')
    type(nums[1]!, '600')
    type(nums[2]!, '500')
    await flushPromises()
    expect(q('[data-testid="docs-issues"]')!.textContent).toMatch(/毛重小于净重|less than net/)
    type(nums[2]!, '640')
    await flushPromises()
    expect(q<HTMLButtonElement>('[data-testid="docs-dl-ci"]')!.disabled).toBe(false)

    // 有未保存的修改：下载前先保存
    q<HTMLButtonElement>('[data-testid="docs-dl-pl"]')!.click()
    await flushPromises()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![1].lines![0]).toMatchObject({ itemIndex: 0, hsCode: '8481804090', cartons: 40, netKg: 600, grossKg: 640 })
    expect(pdf).toHaveBeenCalledWith('ord1', 'pl')
    wrapper.unmount()
  })
})
