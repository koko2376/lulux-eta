import { describe, expect, it } from 'vitest'
import { chartModel, niceMax } from './mini-chart'

describe('mini-chart', () => {
  it('niceMax 取好看的整数刻度', () => {
    expect(niceMax(0)).toBe(4)
    expect(niceMax(3)).toBe(4)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(42)).toBe(50)
    expect(niceMax(11)).toBe(20)
    expect(niceMax(130)).toBe(200)
  })
  it('坐标：第一天在左边、今天在右边，0 在基线', () => {
    const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${14 + i}`, total: i * 2, inquiry: i }))
    const m = chartModel(days)
    expect(m.mail.split(' ')[0]).toBe('44.0,153.0')
    expect(m.end).toMatchObject({ x: 656, mail: 12, inquiry: 6 })
    expect(m.labels).toHaveLength(7)
    expect(m.labels[0].text).toBe('10/14')
    expect(m.ticks.map((t) => t.v)).toEqual([0, 10, 20].map((v) => (v * m.max) / 20))
  })
  it('30 天每 5 天一个日期标签，最后一个是今天', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      total: 0,
      inquiry: 0,
    }))
    const m = chartModel(days)
    expect(m.labels.at(-1)?.i).toBe(29)
    expect(m.labels).toHaveLength(6)
  })
})
