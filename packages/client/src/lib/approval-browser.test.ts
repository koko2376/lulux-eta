import { describe, expect, it } from 'vitest'
import { approvalTitle, approvalView } from './approval'

describe('审批卡片：内置浏览器高风险操作', () => {
  it('browser-action 显示网址 / 目标 / 原因和提醒', () => {
    const view = approvalView('browser-action', {
      url: 'https://shop.example.com/cart',
      element: 'button「提交订单」，表单内',
      reason: '表单内的按钮',
    })
    expect(view?.title).toMatch(/确认浏览器操作|Confirm browser action/)
    expect(view?.rows.map((r) => r.value)).toEqual([
      'https://shop.example.com/cart',
      'button「提交订单」，表单内',
      '表单内的按钮',
    ])
    expect(view?.warnings).toHaveLength(1)
    expect(approvalTitle('browser-action', 'browser_click')).toBe(view?.title)
  })
})
