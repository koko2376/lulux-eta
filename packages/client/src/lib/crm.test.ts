import { describe, expect, it } from 'vitest'
import { DEFAULT_PROBABILITY, formatMoneyMap, nextOrderStatus, orderSteps, parseAmount, todayIso } from './crm'

describe('lib/crm', () => {
  it('多币种金额按金额降序、跳过 0，不做汇率折算', () => {
    expect(formatMoneyMap({ EUR: 100, USD: 0, CAD: 2500.5 })).toEqual(['CAD 2,500.50', 'EUR 100.00'])
    expect(formatMoneyMap(undefined)).toEqual([])
  })

  it('订单步骤：当前步 / 已完成 / 已取消', () => {
    expect(orderSteps('in_production').map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo'])
    expect(orderSteps('completed').map((s) => s.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(orderSteps('cancelled').every((s) => s.state === 'todo')).toBe(true)
  })

  it('一次只推进一步，已完成 / 已取消没有下一步', () => {
    expect(nextOrderStatus('pending_production')).toBe('in_production')
    expect(nextOrderStatus('shipped')).toBe('completed')
    expect(nextOrderStatus('completed')).toBeNull()
    expect(nextOrderStatus('cancelled')).toBeNull()
  })

  it('金额输入去千分位，非法为 NaN', () => {
    expect(parseAmount('12,180.50')).toBe(12180.5)
    expect(parseAmount(' 7 700 ')).toBe(7700)
    expect(parseAmount('abc')).toBeNaN()
    expect(parseAmount('')).toBeNaN()
  })

  it('默认赢单概率与契约一致', () => {
    expect(DEFAULT_PROBABILITY).toEqual({
      prospecting: 10,
      qualified: 25,
      proposal: 50,
      negotiation: 75,
      won: 100,
      lost: 0,
    })
  })

  it('todayIso 用本地日期', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})
