import { describe, expect, it } from 'vitest'
import { activeMention, filterMembers, insertMention } from './mention'

describe('@成员', () => {
  it('只在开头或空白后识别 @，邮箱里的 @ 不算', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMention('请 @洞', 4)).toEqual({ start: 2, query: '洞' })
    expect(activeMention('mail a@b', 8)).toBeNull()
    expect(activeMention('@Pi 已完成', 6)).toBeNull()
  })
  it('按名字或 id 过滤，插入 @名字 并把光标放在其后', () => {
    const members = [
      { id: 'builtin', name: 'LULUX' },
      { id: 'kernel-claude-code', name: 'Claude Code' },
    ]
    expect(filterMembers(members, 'lulux').map((m) => m.id)).toEqual(['builtin'])
    expect(filterMembers(members, 'KERNEL-CLAUDE').map((m) => m.id)).toEqual(['kernel-claude-code'])
    expect(filterMembers(members, '')).toHaveLength(2)
    const text = '请 @P 看看'
    const res = insertMention(text, { start: 2, query: 'P' }, 'Pi')
    expect(res.text).toBe('请 @Pi 看看')
    expect(res.caret).toBe(6)
  })
})
