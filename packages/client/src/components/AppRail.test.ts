import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('../api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/http')>()),
  request: vi.fn(async () => ({ total: 0 })),
}))

import AppRail from './AppRail.vue'

describe('主导航', () => {
  it('“LULUX”（Agent 会话）排第一、在工作台前面；工作台仍指向首页 /', async () => {
    const Blank = { template: '<div />' }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:p(.*)*', component: Blank }],
    })
    await router.push('/')
    await router.isReady()
    const wrapper = mount(AppRail, { global: { plugins: [router] } })
    await flushPromises()
    const items = wrapper.findAll('.rail-item')
    expect(items[0]!.text()).toBe('LULUX')
    expect(items[0]!.attributes('href')).toBe('/agent')
    expect(items[0]!.attributes('title')).toBe('LULUX')
    expect(items[1]!.text()).toBe('工作台')
    expect(items[1]!.attributes('href')).toBe('/')
    expect(wrapper.text()).not.toContain('Agent')
  })
})
