import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('../../api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/http')>()),
  request: vi.fn(async () => ({ total: 3 })),
}))

import AppSidebar from './AppSidebar.vue'
import { agentSidebar } from '../../lib/agent-sidebar'

async function mountAt(path: string, section: string) {
  const Blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: Blank, meta: { section } }],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppSidebar, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('全局侧栏', () => {
  it('底部只有 6 个主入口：LULUX 第一，工作台指向首页', async () => {
    const w = await mountAt('/', 'workbench')
    const items = w.findAll('.as-nav-item')
    expect(items.map((i) => i.find('.as-nav-label').text())).toEqual([
      'LULUX',
      '工作台',
      '客户',
      '邮箱',
      '工作流',
      '技能',
    ])
    expect(items[0]!.attributes('href')).toBe('/agent')
    expect(items[1]!.attributes('href')).toBe('/')
    expect(items[1]!.classes()).toContain('on')
  })

  it('商机 / 报价 / 订单页都点亮“客户”，定时任务点亮“工作流”', async () => {
    for (const section of ['deals', 'quotation', 'orders']) {
      const w = await mountAt('/x', section)
      expect(w.find('.as-nav-item.on .as-nav-label').text()).toBe('客户')
    }
    const w = await mountAt('/schedules', 'schedules')
    expect(w.find('.as-nav-item.on .as-nav-label').text()).toBe('工作流')
  })

  it('邮箱入口显示未读角标；收起按钮切换侧栏', async () => {
    agentSidebar.collapsed = false
    const w = await mountAt('/', 'workbench')
    expect(w.find('[data-testid=rail-mailbox] .as-badge').text()).toBe('3')
    await w.find('[data-testid=side-toggle]').trigger('click')
    expect(agentSidebar.collapsed).toBe(true)
    expect(w.find('.app-side').classes()).toContain('collapsed')
    await w.find('[data-testid=side-toggle]').trigger('click')
    expect(agentSidebar.collapsed).toBe(false)
  })
})
