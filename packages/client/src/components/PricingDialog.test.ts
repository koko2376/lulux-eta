import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import PricingDialog from './PricingDialog.vue'

const result: api.PricingResult = {
  incoterm: 'CIF',
  quoteCurrency: 'USD',
  items: [
    { productId: null, name: 'Gate valve', qty: 100, unit: 'pcs', unitCost: 11, unitPrice: 13.75, marginPct: 20, amount: 1375, ladderCost: { EXW: 10, FOB: 10.5, CFR: 10.9, CIF: 11 }, ladder: { EXW: 12.5, FOB: 13.13, CFR: 13.63, CIF: 13.75 } },
    { productId: null, name: 'Ball valve', qty: 50, unit: 'pcs', unitCost: 3, unitPrice: 3.1, marginPct: 3.23, amount: 155, ladderCost: { EXW: 2.8, FOB: 2.9, CFR: 2.98, CIF: 3 }, ladder: { EXW: 2.89, FOB: 3, CFR: 3.08, CIF: 3.1 } },
  ],
  totals: { cost: 1250, revenue: 1530, profit: 280, marginPct: 18.3, cbm: 2, kg: 0 },
  container: { type: 'LCL', count: 1, cbmUsed: 2, fillPct: 13.33 },
  freight: { source: 'manual', amount: 200, currency: 'USD' },
  fx: [{ pair: 'CNY/USD', rate: 0.142857, source: 'locked', asOf: '', locked: true, stale: false }],
  breakdown: [],
  warnings: ['「Ball valve」毛利低于 5%（3.23%）'],
  quoteItems: [],
}

const items: api.QuoteItem[] = [
  { productId: null, name: 'Gate valve', spec: '', qty: 100, unit: 'pcs', unitPrice: 0 },
  { productId: null, name: 'Ball valve', spec: '', qty: 50, unit: 'pcs', unitPrice: 0 },
]

function mountDialog() {
  return mount(PricingDialog, {
    props: { items, currency: 'USD', incoterm: 'CIF', port: '' },
    attachTo: document.body,
    global: { directives: { perm: () => undefined } },
  })
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('PricingDialog', () => {
  it('成本没填完不能计算；计算后显示阶梯、汇率和提示，填入时带回单价和术语', async () => {
    const calc = vi.spyOn(api, 'calculatePricing').mockResolvedValue(result)
    const wrapper = mountDialog()
    await flushPromises()
    const run = () => document.querySelector<HTMLButtonElement>('[data-testid="pricing-run"]')!
    expect(run().disabled).toBe(true)
    const cost0 = document.querySelector<HTMLInputElement>('[data-testid="pricing-cost-0"]')!
    const cost1 = document.querySelector<HTMLInputElement>('[data-testid="pricing-cost-1"]')!
    cost0.value = '70'
    cost0.dispatchEvent(new Event('input'))
    cost1.value = '20'
    cost1.dispatchEvent(new Event('input'))
    const freight = document.querySelector<HTMLInputElement>('[data-testid="pricing-freight"]')!
    freight.value = '200'
    freight.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(run().disabled).toBe(false)
    run().click()
    await flushPromises()
    expect(calc).toHaveBeenCalledTimes(1)
    const body = calc.mock.calls[0]![0]
    expect(body.incoterm).toBe('CIF')
    expect(body.items.map((i) => i.unitCost)).toEqual([70, 20])
    expect(body.costs?.freight).toEqual({ amount: 200, currency: 'USD', per: 'shipment' })
    const panel = document.querySelector('[data-testid="pricing-result"]')!
    expect(panel.textContent).toContain('CNY/USD')
    expect(panel.textContent).toContain('3.23%')
    expect(panel.querySelectorAll('thead th').length).toBe(1 + 4 + 2)
    document.querySelector<HTMLButtonElement>('[data-testid="pricing-apply"]')!.click()
    expect(wrapper.emitted('apply')![0]![0]).toEqual({ unitPrices: [13.75, 3.1], incoterm: 'CIF' })
    wrapper.unmount()
  })

  it('改了参数后旧结果作废，必须重新计算才能填入', async () => {
    vi.spyOn(api, 'calculatePricing').mockResolvedValue(result)
    const wrapper = mountDialog()
    for (const [i, v] of [[0, '70'], [1, '20']] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="pricing-cost-${i}"]`)!
      input.value = v
      input.dispatchEvent(new Event('input'))
    }
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="pricing-run"]')!.click()
    await flushPromises()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="pricing-apply"]')!.disabled).toBe(false)
    const margin = document.querySelector<HTMLInputElement>('[data-testid="pricing-margin"]')!
    margin.value = '30'
    margin.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(document.querySelector('[data-testid="pricing-result"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="pricing-apply"]')!.disabled).toBe(true)
    wrapper.unmount()
  })

  it('后端报错显示在对话框里', async () => {
    vi.spyOn(api, 'calculatePricing').mockRejectedValue(new Error('CIF 报价需要海运费'))
    const wrapper = mountDialog()
    for (const i of [0, 1]) {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="pricing-cost-${i}"]`)!
      input.value = '1'
      input.dispatchEvent(new Event('input'))
    }
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="pricing-run"]')!.click()
    await flushPromises()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('海运费')
    wrapper.unmount()
  })
})
