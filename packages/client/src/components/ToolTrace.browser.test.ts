import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToolTrace from './ToolTrace.vue'

const base = { server: 'LULUX', args: '{"url":"https://example.com/"}', status: 'done' as const, result: '', durationMs: 12 }

describe('工具卡：内置浏览器', () => {
  it('browser_* 显示中文动作名，并保留工具名', () => {
    const w = mount(ToolTrace, { props: { ...base, name: 'browser_open' }, global: { stubs: ['RouterLink'] } })
    expect(w.find('.tool-name').text()).toMatch(/打开网页|Open page/)
    expect(w.find('.tool-server').text()).toBe('browser_open')
    expect(w.find('.tool-args').text()).toContain('https://example.com/')
  })

  it('高风险点击审批卡：标题为确认浏览器操作，没有“本会话始终允许”', () => {
    const w = mount(ToolTrace, {
      props: {
        ...base,
        name: 'browser_click',
        status: 'pending',
        interactive: true,
        approvalKind: 'browser-action',
        canRemember: false,
        detail: { url: 'https://shop.example.com/cart', element: 'button「付款」', reason: '名称包含“付款”' },
      },
      global: { stubs: ['RouterLink'] },
    })
    expect(w.find('.tool-name').text()).toMatch(/确认浏览器操作|Confirm browser action/)
    expect(w.find('.approval-detail').text()).toContain('https://shop.example.com/cart')
    expect(w.find('.tool-btn.remember').exists()).toBe(false)
    expect(w.find('.tool-btn.approve').exists()).toBe(true)
  })
})
