import { describe, expect, it } from 'vitest'
import { dueLabel } from './due'

describe('dueLabel', () => {
  const now = new Date(2026, 9, 21, 9, 0).getTime()
  it('逾期 N 天 / 今天 / 明天 / 无到期', () => {
    expect(dueLabel(new Date(2026, 9, 19, 15, 0).getTime(), now)).toEqual({ text: '逾期 2 天', cls: 'over' })
    expect(dueLabel(new Date(2026, 9, 21, 10, 0).getTime(), now).cls).toBe('today')
    expect(dueLabel(new Date(2026, 9, 21, 10, 0).getTime(), now).text).toContain('今天')
    expect(dueLabel(new Date(2026, 9, 21, 8, 0).getTime(), now).cls).toBe('over')
    expect(dueLabel(new Date(2026, 9, 22, 8, 0).getTime(), now).text).toBe('明天')
    expect(dueLabel(null, now).text).toBe('未设到期')
  })
})
