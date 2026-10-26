import { describe, expect, it } from 'vitest'
import { groupKeyFor, groupSessions } from './session-groups'

const now = new Date(2026, 9, 24, 15, 0).getTime()
const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()

describe('会话按时间分组', () => {
  it('今天 / 昨天 / 7 天内 / 更早按自然日切', () => {
    expect(groupKeyFor(at(24, 0), now)).toBe('today')
    expect(groupKeyFor(at(23, 23), now)).toBe('yesterday')
    expect(groupKeyFor(at(18), now)).toBe('week')
    expect(groupKeyFor(at(17, 23), now)).toBe('older')
  })
  it('保持顺序、空组不出现', () => {
    const groups = groupSessions(
      [
        { id: 1, updatedAt: at(24) },
        { id: 2, updatedAt: at(10) },
      ],
      now,
    )
    expect(groups.map((g) => g.key)).toEqual(['today', 'older'])
    expect(groups[1]!.items[0]!.id).toBe(2)
  })
})
