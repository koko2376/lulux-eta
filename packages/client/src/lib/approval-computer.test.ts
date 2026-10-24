import { describe, expect, it } from 'vitest'
import { approvalView } from './approval'

describe('审批卡片：电脑操作', () => {
  it('computer-action 显示动作 / 位置 / 文字，带截图与红点；拖动带终点', () => {
    const view = approvalView('computer-action', {
      action: 'drag',
      x: 10,
      y: 20,
      toX: 300,
      toY: 400,
      screenshotUrl: '/api/chat/sessions/s1/files?path=computer%2Fshot-1.jpg',
      screenshotWidth: 1280,
      screenshotHeight: 800,
    })
    expect(view?.title).toMatch(/确认电脑操作|Confirm computer action/)
    expect(view?.rows.map((r) => r.value)).toEqual([expect.stringMatching(/拖动|Drag/), '(10, 20) → (300, 400)'])
    expect(view?.shot).toEqual({
      url: '/api/chat/sessions/s1/files?path=computer%2Fshot-1.jpg',
      width: 1280,
      height: 800,
      marker: { x: 10, y: 20 },
      to: { x: 300, y: 400 },
    })
    expect(view?.warnings).toHaveLength(1)
  })

  it('不是本应用接口的截图地址不显示（防止卡片去加载外部地址）', () => {
    const view = approvalView('computer-action', {
      action: 'click',
      x: 1,
      y: 2,
      screenshotUrl: 'https://evil.example.com/x.jpg',
      screenshotWidth: 100,
      screenshotHeight: 100,
    })
    expect(view?.shot).toBeUndefined()
  })

  it('输入文字与按键显示原文', () => {
    expect(approvalView('computer-action', { action: 'type', text: '你好 hello' })?.rows.map((r) => r.value)).toContain('你好 hello')
    expect(approvalView('computer-action', { action: 'key', keys: 'ctrl+c' })?.rows.map((r) => r.value)).toContain('ctrl+c')
  })
})
