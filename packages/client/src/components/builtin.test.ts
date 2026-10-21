import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolTrace from './ToolTrace.vue'

describe('内置内核组件', () => {
  it('思考中：扫光“思考中 · N 秒”+ 实时预览，结束后自动折叠为“已思考 N 秒”，展开显示全文', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const w = mount(ReasoningBlock, { props: { text: '先比较 DN25 与 DN32 的价格', live: true, startedAt: start } })
    expect(w.find('.shimmer').text()).toBe('思考中')
    expect(w.find('[data-testid="thinking-elapsed"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(3100)
    expect(w.get('[data-testid="thinking-elapsed"]').text()).toContain('3 秒')
    expect(w.get('.reasoning-preview').text()).toContain('DN32')
    expect(w.get('button').attributes('disabled')).toBeDefined()

    await w.setProps({ live: false, durationMs: 4200 })
    expect(w.find('.reasoning-preview').exists()).toBe(false)
    expect(w.get('[data-testid="thinking-done"]').text()).toBe('已思考 4 秒')
    expect(w.get('.reasoning-collapse').classes()).not.toContain('open')
    await w.get('button').trigger('click')
    expect(w.get('.reasoning-collapse').classes()).toContain('open')
    expect(w.get('.reasoning-body').text()).toBe('先比较 DN25 与 DN32 的价格')
    vi.useRealTimers()
  })

  it('刷新后没有用时：显示“已思考 · N 字”；没有推理文字的“思考中”不可点', () => {
    const done = mount(ReasoningBlock, { props: { text: '一二三四五' } })
    expect(done.get('[data-testid="thinking-done"]').text()).toBe('已思考 · 5 字')
    const empty = mount(ReasoningBlock, { props: { text: '', live: true } })
    expect(empty.text()).toContain('思考中')
    expect(empty.find('.reasoning-preview').exists()).toBe(false)
    expect(empty.find('.reasoning-collapse').exists()).toBe(false)
  })

  it('工具步骤胶囊（原版样式）：执行中 → 已完成，显示来源与简短参数，可展开', async () => {
    const w = mount(ToolTrace, {
      props: {
        name: 'calculator',
        server: 'LULUX',
        args: '{"expression":"12.5*400"}',
        status: 'running',
        result: '',
        durationMs: 0,
      },
    })
    expect(w.classes()).toContain('is-running')
    expect(w.find('.tool-dot').exists()).toBe(true)
    expect(w.get('.tool-state').text()).toBe('执行中')
    expect(w.get('.tool-server').text()).toBe('LULUX')
    expect(w.get('.tool-args').text()).toBe('12.5*400')
    await w.setProps({ status: 'done', result: '5000', durationMs: 12 })
    expect(w.classes()).toContain('is-done')
    expect(w.get('.tool-state').text()).toBe('已完成')
    expect(w.get('.tool-time').text()).toBe('12 ms')
    expect(w.find('.tool-details').exists()).toBe(false)
    await w.get('.tool-head').trigger('click')
    expect(w.get('.tool-details').text()).toContain('5000')
  })

  it('审批卡片：允许 / 本会话始终允许 / 拒绝，写入类工具有标记', async () => {
    const w = mount(ToolTrace, {
      props: {
        name: 'workspace_write',
        server: 'LULUX',
        args: '{}',
        status: 'pending',
        result: '',
        durationMs: 0,
        interactive: true,
        risk: 'write',
      },
    })
    expect(w.text()).toContain('写入')
    const buttons = w.findAll('.tool-actions button')
    expect(buttons.map((b) => b.text())).toEqual(['允许', '本会话始终允许', '拒绝'])
    await buttons[1].trigger('click')
    await buttons[2].trigger('click')
    expect(w.emitted('decide')).toEqual([[true, 'session'], [false]])
  })
})
