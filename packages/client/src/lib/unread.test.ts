import { beforeEach, describe, expect, it } from 'vitest'
import { isUnread, seenAt, syncSeen } from './unread'

describe('会话未读小圆点', () => {
  beforeEach(() => {
    localStorage.clear()
    seenAt.value = {}
  })

  it('第一次见到的会话建基线，不显示小圆点', () => {
    syncSeen([{ id: 'a', updatedAt: 10 }], null)
    expect(isUnread({ id: 'a', updatedAt: 10 }, null)).toBe(false)
    expect(JSON.parse(localStorage.getItem('lulux.sessionSeen')!)).toEqual({ a: 10 })
  })

  it('不在看的会话有更新 → 小圆点；切过去后消失', () => {
    syncSeen(
      [
        { id: 'a', updatedAt: 10 },
        { id: 'b', updatedAt: 10 },
      ],
      'a',
    )
    const later = [
      { id: 'a', updatedAt: 20 },
      { id: 'b', updatedAt: 30 },
    ]
    syncSeen(later, 'a')
    expect(isUnread(later[0], 'a')).toBe(false)
    expect(isUnread(later[1], 'a')).toBe(true)
    syncSeen(later, 'b')
    expect(isUnread(later[1], 'b')).toBe(false)
    expect(isUnread(later[1], 'a')).toBe(false)
  })

  it('删除的会话从记录里移除', () => {
    syncSeen(
      [
        { id: 'a', updatedAt: 1 },
        { id: 'b', updatedAt: 1 },
      ],
      null,
    )
    syncSeen([{ id: 'a', updatedAt: 1 }], null)
    expect(Object.keys(seenAt.value)).toEqual(['a'])
  })
})
