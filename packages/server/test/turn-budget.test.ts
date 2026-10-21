import { describe, expect, it } from 'vitest'
import {
  budgetPressure,
  budgetPressureText,
  callSignature,
  RepeatGuard,
  type BudgetLevel,
} from '../src/services/chat/turn-budget.js'

describe('工具轮数预算提醒（Hermes budget pressure）', () => {
  it('90 轮：63 轮起提醒收敛，81 轮起要求立刻作答，每级只一次', () => {
    const sent = new Set<BudgetLevel>()
    const fired: Array<[number, BudgetLevel]> = []
    for (let used = 1; used <= 90; used += 1) {
      const level = budgetPressure(used, 90, sent)
      if (level) {
        fired.push([used, level])
        sent.add(level)
      }
    }
    expect(fired).toEqual([
      [63, 'caution'],
      [81, 'warning'],
    ])
    expect(budgetPressureText('caution', 63, 90)).toContain('[BUDGET: 63/90. 27 iterations left. Start consolidating.]')
    expect(budgetPressureText('warning', 81, 90)).toContain('[BUDGET WARNING: 81/90. Only 9 left. Respond NOW.]')
  })

  it('不限制（0）与已到上限时不提醒；小预算直接跳到 warning 后不再补 caution', () => {
    expect(budgetPressure(400, 0, new Set())).toBeNull()
    expect(budgetPressure(10, 10, new Set())).toBeNull()
    const sent = new Set<BudgetLevel>()
    expect(budgetPressure(1, 2, sent)).toBeNull() // 50%
    expect(budgetPressure(9, 10, sent)).toBe('warning')
    sent.add('warning')
    expect(budgetPressure(9, 10, sent)).toBeNull()
  })
})

describe('重复工具调用保护', () => {
  it('参数规范化：键顺序与空白不同视为同一调用', () => {
    expect(callSignature({ name: 'a', arguments: '{"x":1,"y":[1,{"b":2,"a":1}]}' })).toBe(
      callSignature({ name: 'a', arguments: '{ "y": [1, {"a":1,"b":2}], "x": 1 }' }),
    )
    expect(callSignature({ name: 'a', arguments: '{"x":1}' })).not.toBe(callSignature({ name: 'b', arguments: '{"x":1}' }))
    expect(callSignature({ name: 'a', arguments: '{bad' })).toBe('a\u0000{bad')
  })

  it('同一调用连续第 3 次触发；中间穿插其他调用会重置计数', () => {
    const guard = new RepeatGuard()
    const a = { name: 'web_fetch', arguments: '{"url":"https://x"}' }
    const b = { name: 'web_fetch', arguments: '{"url":"https://y"}' }
    expect([guard.observe(a), guard.observe(a), guard.observe(b), guard.observe(a), guard.observe(a)]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
    expect(guard.observe(a)).toBe(true)
  })
})
