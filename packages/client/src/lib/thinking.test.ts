import { describe, expect, it } from 'vitest'
import { formatThinkSeconds, thinkDuration } from './thinking'

describe('thinking', () => {
  it('formatThinkSeconds 取整且至少 1 秒', () => {
    expect(formatThinkSeconds(0)).toBe(1)
    expect(formatThinkSeconds(400)).toBe(1)
    expect(formatThinkSeconds(1499)).toBe(1)
    expect(formatThinkSeconds(1500)).toBe(2)
    expect(formatThinkSeconds(12_300)).toBe(12)
    expect(formatThinkSeconds(Number.NaN)).toBe(1)
  })
  it('thinkDuration', () => {
    expect(thinkDuration(null, null, 10)).toBeNull()
    expect(thinkDuration(1000, 4000, 9999)).toBe(3000)
    expect(thinkDuration(1000, null, 2500)).toBe(1500)
    expect(thinkDuration(5000, null, 1000)).toBe(0)
  })
})
