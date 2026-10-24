import { describe, expect, it } from 'vitest'
import { findMemberAgent, memberTag, predictMemberIds, splitMemberId, withMemberTag } from './members'

describe('群聊成员实例', () => {
  it('拆分实例 id；非法后缀按内核 id 处理', () => {
    expect(splitMemberId('kernel-claude-code#2')).toEqual({ base: 'kernel-claude-code', n: 2 })
    expect(splitMemberId('builtin')).toEqual({ base: 'builtin', n: 1 })
    expect(splitMemberId('builtin#1')).toEqual({ base: 'builtin#1', n: 1 })
    expect(splitMemberId('builtin#02')).toEqual({ base: 'builtin#02', n: 1 })
  })

  it('预测实例 id 与服务端同一规则：显式实例先占位，其余取第一个空号', () => {
    expect(predictMemberIds([{ agentId: 'builtin' }, { agentId: 'builtin' }, { agentId: 'kernel-pi' }])).toEqual([
      'builtin',
      'builtin#2',
      'kernel-pi',
    ])
    expect(predictMemberIds([{ agentId: 'builtin#2' }, { agentId: 'builtin' }, { agentId: 'builtin' }])).toEqual([
      'builtin#2',
      'builtin',
      'builtin#3',
    ])
  })

  it('标签：有群头衔显示头衔；同内核多个且没头衔显示序号；只有一个时不显示', () => {
    const session = {
      agentIds: ['builtin', 'builtin#2', 'kernel-pi'],
      memberProfiles: { builtin: { role: '跟单员', instructions: '', model: null } },
    }
    expect(memberTag(session, 'builtin')).toBe('跟单员')
    expect(memberTag(session, 'builtin#2')).toBe('#2')
    expect(memberTag(session, 'kernel-pi')).toBe('')
    expect(withMemberTag('LULUX', '跟单员')).toBe('LULUX（跟单员）')
  })

  it('按实例 id 找 Agent：返回内核 Agent，id 保留实例后缀', () => {
    const agents = [{ id: 'builtin', name: 'LULUX' }] as never
    expect(findMemberAgent(agents, 'builtin#3')).toMatchObject({ id: 'builtin#3', name: 'LULUX' })
    expect(findMemberAgent(agents, 'kernel-x')).toBeNull()
  })
})
