import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StateBlock from './StateBlock.vue'
import UiPager from './UiPager.vue'
import UiSwitch from './UiSwitch.vue'

describe('UI 组件', () => {
  it('StateBlock 错误态可重试', async () => {
    const w = mount(StateBlock, { props: { state: 'error', message: '网络错误' } })
    expect(w.text()).toContain('网络错误')
    await w.get('button').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })
  it('UiPager 边界禁用与翻页', async () => {
    const w = mount(UiPager, { props: { page: 1, pageSize: 20, total: 45 } })
    const buttons = w.findAll('button')
    const prev = buttons[0]
    const next = buttons[buttons.length - 1]
    expect(prev.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('1 / 3')
    expect(buttons.map((b) => b.text())).toEqual(['上一页', '1', '2', '3', '下一页'])
    expect(w.get('[aria-current="page"]').text()).toBe('1')
    await next.trigger('click')
    expect(w.emitted('update:page')?.[0]).toEqual([2])
    await buttons[3].trigger('click')
    expect(w.emitted('update:page')?.[1]).toEqual([3])
  })
  it('UiSwitch 使用 role=switch 并切换', async () => {
    const w = mount(UiSwitch, { props: { modelValue: false, label: '启用' } })
    expect(w.get('button').attributes('role')).toBe('switch')
    await w.get('button').trigger('click')
    expect(w.emitted('update:modelValue')?.[0]).toEqual([true])
  })
})
