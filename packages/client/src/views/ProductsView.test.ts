import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import * as api from '../api'
import { vPerm } from '../lib/perm-directive'
import { auth } from '../lib/session'
import { uiState } from '../stores/ui'
import ProductsView from './ProductsView.vue'

const product = (over: Partial<api.Product>): api.Product => ({
  id: 'p1',
  sku: 'BV-50',
  name: 'Ball Valve DN50',
  spec: '',
  unit: 'pcs',
  price: 12.5,
  currency: 'USD',
  moq: 100,
  hsCode: '8481.80',
  category: '阀门',
  ...over,
})

async function mountView(items: api.Product[]) {
  vi.spyOn(api, 'listProducts').mockResolvedValue(items)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: ProductsView }] })
  await router.push('/products')
  const wrapper = mount(ProductsView, {
    global: { plugins: [router], directives: { perm: vPerm }, stubs: { PageTopbar: { template: '<div><slot /></div>' }, teleport: true } },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.restoreAllMocks()
  uiState.toasts.splice(0)
  uiState.confirm = null
  auth.me = null
  auth.mode = 'desktop'
})

describe('产品库页面', () => {
  it('列表、搜索与按分类筛选', async () => {
    const wrapper = await mountView([
      product({}),
      product({ id: 'p2', sku: 'PM-1', name: 'Pump', category: '泵', price: 0, hsCode: '8413' }),
      product({ id: 'p3', sku: 'BT', name: 'Bolt', category: '', hsCode: '' }),
    ])
    expect(wrapper.findAll('tbody tr')).toHaveLength(3)
    const cats = wrapper.findAll('[data-testid="product-category"]')
    expect(cats.map((c) => c.text()).sort()).toEqual(['泵1', '阀门1'].sort())
    await cats.find((c) => c.text().startsWith('泵'))!.trigger('click')
    expect(wrapper.findAll('tbody tr').map((r) => r.text())).toEqual([expect.stringContaining('Pump')])
    await wrapper.findAll('.nav-row')[0]!.trigger('click')
    await wrapper.get('[data-testid="product-search"]').setValue('8481')
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  })

  it('新建产品：名称必填，提交字段完整', async () => {
    const saved = product({ id: 'new', name: 'Check Valve', sku: 'CV-25', price: 3, moq: 10, category: '阀门' })
    const create = vi.spyOn(api, 'createProduct').mockResolvedValue(saved)
    const wrapper = await mountView([])
    await wrapper.get('[data-testid="product-new"]').trigger('click')
    await wrapper.get('#product-form').trigger('submit')
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请填写产品名称')
    await wrapper.get('[data-testid="product-name"]').setValue('Check Valve')
    await wrapper.get('[data-testid="product-sku"]').setValue('CV-25')
    await wrapper.get('[data-testid="product-cat"]').setValue('阀门')
    await wrapper.get('[data-testid="product-price"]').setValue('3')
    await wrapper.get('[data-testid="product-moq"]').setValue('10')
    await wrapper.get('#product-form').trigger('submit')
    await flushPromises()
    expect(create).toHaveBeenCalledWith({
      sku: 'CV-25',
      name: 'Check Valve',
      category: '阀门',
      spec: '',
      unit: 'pcs',
      price: 3,
      currency: 'USD',
      moq: 10,
      hsCode: '',
    })
    expect(wrapper.findAll('tbody tr')).toHaveLength(1)
  })

  it('编辑与删除（删除前确认）', async () => {
    const update = vi.spyOn(api, 'updateProduct').mockImplementation(async (id, input) => product({ id, ...input }))
    const del = vi.spyOn(api, 'deleteProduct').mockResolvedValue(undefined)
    const wrapper = await mountView([product({})])
    await wrapper.findAll('.acts .link')[0]!.trigger('click')
    await wrapper.get('[data-testid="product-price"]').setValue('15')
    await wrapper.get('#product-form').trigger('submit')
    await flushPromises()
    expect(update).toHaveBeenCalledWith('p1', expect.objectContaining({ price: 15 }))
    expect(wrapper.get('tbody').text()).toContain('15.00')
    await wrapper.findAll('.acts .link')[1]!.trigger('click')
    await flushPromises()
    uiState.confirm!.resolve(true)
    await flushPromises()
    expect(del).toHaveBeenCalledWith('p1')
    expect(wrapper.find('[data-testid="product-table"]').exists()).toBe(false)
  })

  it('没有 catalog:write 时只读：不显示新建 / 导入 / 编辑，显示提示', async () => {
    auth.mode = 'server'
    auth.me = { id: 'u', role: 'viewer', permissions: ['data:read'] } as unknown as typeof auth.me
    const wrapper = await mountView([product({})])
    expect(wrapper.find('[data-testid="product-new"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="product-import"]').exists()).toBe(false)
    expect(wrapper.find('.acts').exists()).toBe(false)
    expect(wrapper.find('[data-testid="perm-note"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="product-export"]').exists()).toBe(true)
  })

  it('CSV 导入：识别表头后调用导入接口并显示结果', async () => {
    const importer = vi.spyOn(api, 'importProducts').mockResolvedValue({ created: 1, updated: 1, skipped: 0, errors: [{ row: 3, message: 'name：产品名不能为空' }] })
    const wrapper = await mountView([])
    await wrapper.get('[data-testid="product-import"]').trigger('click')
    const input = wrapper.get('[data-testid="product-import-file"]')
    const csv = '型号,品名,单价\nBV-50,Ball Valve,13.8\nCV-25,Check Valve,2\n,,\n'
    const file = { name: 'p.csv', arrayBuffer: async () => new TextEncoder().encode(csv).buffer }
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.text()).toContain('读到 2 行')
    await wrapper.get('[data-testid="product-import-run"]').trigger('click')
    await flushPromises()
    expect(importer).toHaveBeenCalledWith(
      [
        { sku: 'BV-50', name: 'Ball Valve', price: '13.8' },
        { sku: 'CV-25', name: 'Check Valve', price: '2' },
      ],
      'update',
    )
    expect(wrapper.get('[data-testid="product-import-result"]').text()).toContain('新建 1 个，更新 1 个')
    expect(wrapper.text()).toContain('第 3 行')
  })
})
