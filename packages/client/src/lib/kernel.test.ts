import { describe, expect, it } from 'vitest'
import type { Agent } from '../api'
import { REASON_NEED_MODEL, runtimeLabel, unavailableAction } from './kernel'

const agents = [{ id: 'kernel-claude-code', kernelId: 'claude-code', name: 'Claude Code' }] as Agent[]

describe('内核网关显示（契约 §6.4）', () => {
  it('kernel runtime 有 label 时直接显示', () => {
    expect(
      runtimeLabel({
        kind: 'kernel',
        kernelId: 'claude-code',
        version: '2.1.304',
        mode: 'scoped',
        label: 'Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat',
      }),
    ).toBe('Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat')
  })
  it('没有 label 时按 scoped 字段拼出“经由”，旧消息回退旧格式', () => {
    expect(
      runtimeLabel(
        {
          kind: 'kernel',
          kernelId: 'claude-code',
          version: '2.1.304',
          mode: 'scoped',
          providerName: 'DeepSeek',
          model: 'deepseek-chat',
        },
        agents,
      ),
    ).toBe('Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat')
    expect(runtimeLabel({ kind: 'kernel', kernelId: 'claude-code', version: '2.0.1' }, agents)).toBe(
      'Claude Code 内核 v2.0.1',
    )
    expect(runtimeLabel({ kind: 'provider', providerName: 'Mock', model: 'm1' })).toBe('Mock · m1')
    expect(runtimeLabel(null)).toBe('')
  })
  it('不可用原因映射到正确的处理入口', () => {
    expect(unavailableAction({ unavailableReason: REASON_NEED_MODEL })).toEqual({
      text: '去配置模型',
      to: '/settings/models',
    })
    expect(unavailableAction({ unavailableReason: '需要登录' }).text).toBe('查看登录说明')
    expect(unavailableAction({ unavailableReason: '未安装' }).text).toBe('去安装')
    expect(unavailableAction({ unavailableReason: '服务器已禁用内核' }).text).toBe('查看说明')
  })
})
