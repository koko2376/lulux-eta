import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeMention, filterMembers, insertMention, mentionPopup } from './mention'

interface MentionFixture {
  members: Array<{ id: string; name: string; role: string }>
  cases: Array<{ why: string; text: string; popover: boolean; mentions: string[] }>
}

/** 与服务端 test/mentions-boundary.test.ts 共用同一份用例表 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../../test-fixtures/mentions.json'), 'utf8'),
) as MentionFixture
/** 输入框能匹配的标签：成员名、id、群头衔（与服务端认的 key 同一组） */
const labels = fixture.members.flatMap((member) => [member.name, member.id, member.role]).filter(Boolean)

describe('@成员', () => {
  it('只在开头或空白后识别 @，邮箱里的 @ 不算', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(activeMention('请 @洞', 4)).toEqual({ start: 2, query: '洞' })
    expect(activeMention('mail a@b', 8)).toBeNull()
    // 名字已经点完（后面跟了空格和正文）：列表不再弹
    expect(mentionPopup('@Pi 已完成', 6, ['Pi'])).toBeNull()
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

describe('客户端 @ 边界与服务端共用用例表', () => {
  it.each(fixture.cases.map((item) => [item.why, item] as const))('%s', (_why, item) => {
    expect(Boolean(mentionPopup(item.text, item.text.length, labels)), item.text).toBe(item.popover)
  })

  it('用例表至少 20 条', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20)
  })
})
