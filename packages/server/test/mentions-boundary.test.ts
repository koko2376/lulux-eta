import { describe, expect, it } from 'vitest'
import { memberLabels } from '../src/services/chat/group-members.js'
import { parseMentions } from '../src/services/chat/mentions.js'

/** @ 点名按完整名称边界匹配（审计 2026-10-24 #11） */
describe('@ 点名的名称边界', () => {
  it('群头衔互为前缀：@销售经理 只点到「销售经理」，@销售 只点到「销售」', () => {
    const members = [
      { id: 'kernel-a', name: 'Alpha（销售）', kernelName: 'Alpha', role: '销售' },
      { id: 'kernel-b', name: 'Beta（销售经理）', kernelName: 'Beta', role: '销售经理' },
    ]
    expect(parseMentions('@销售经理 看下这个报价', members)).toEqual(['kernel-b'])
    expect(parseMentions('@销售 看下这个报价', members)).toEqual(['kernel-a'])
    expect(parseMentions('@销售经理 先看，然后 @销售 跟进', members)).toEqual(['kernel-b', 'kernel-a'])
  })

  it('同内核 10 个以上实例：@X #10 不会同时点到 #1，@X #1 也不会点到 #10 / #11', () => {
    const raw = Array.from({ length: 11 }, (_, i) => ({ id: i === 0 ? 'lux' : `lux#${i + 1}`, name: 'LULUX' })) as any
    const labels = memberLabels(raw, {})
    const members = raw.map((member: any) => ({ ...member, kernelName: 'LULUX', name: labels.get(member.id)! }))
    const byName = (name: string) => members.find((member: any) => member.name === name)!.id
    expect(parseMentions('@LULUX #10 你来', members)).toEqual([byName('LULUX #10')])
    expect(parseMentions('@LULUX #1 你来', members)).toEqual([byName('LULUX #1')])
    expect(parseMentions('@LULUX #11和@LULUX #2', members)).toEqual([byName('LULUX #11'), byName('LULUX #2')])
  })

  it('名字后紧跟中文仍然认；内核原名点到同内核的全部成员', () => {
    const members = [
      { id: 'kernel-a', name: 'Alpha（跟单员）', kernelName: 'Alpha', role: '跟单员' },
      { id: 'kernel-a#2', name: 'Alpha（报价员）', kernelName: 'Alpha', role: '报价员' },
    ]
    expect(parseMentions('@跟单员看一下', members)).toEqual(['kernel-a'])
    expect(parseMentions('@Alpha 你们都看看', members)).toEqual(['kernel-a', 'kernel-a#2'])
    expect(parseMentions('@Alpha（报价员） 你来', members)).toEqual(['kernel-a#2'])
  })
})
