import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Session, SessionParticipant } from '../api'
import { groupAvatarCells, groupAvatarLayout, groupAvatarMembers } from '../lib/group-avatar'
import { auth } from '../lib/session'
import { useAppStore } from '../stores/app'
import GroupAvatar from './GroupAvatar.vue'

const agent = (id: string, name: string, kernelId: string | null, available = true): Agent =>
  ({
    id,
    name,
    description: '',
    avatar: '',
    accent: '',
    kind: kernelId ? 'kernel' : 'builtin',
    kernelId,
    available,
    unavailableReason: available ? null : 'not installed',
  }) as Agent

const AGENTS = [
  agent('builtin', 'LULUX', null),
  agent('kernel-claude-code', 'Claude Code', 'claude-code'),
  agent('kernel-codex', 'Codex', 'codex', false),
  agent('kernel-hermes', 'Hermes Agent', 'hermes'),
  agent('kernel-gemini-cli', 'Gemini CLI', 'gemini-cli'),
  agent('kernel-pi', 'Pi', 'pi'),
]

const person = (userId: string, name: string, role: SessionParticipant['role'] = 'member'): SessionParticipant => ({
  userId,
  name,
  role,
  joinedAt: 0,
})

type GroupInput = Pick<Session, 'agentIds' | 'supervisorId' | 'participants'>

function mountGroup(session: GroupInput, size = 34) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAppStore().agents = AGENTS
  return mount(GroupAvatar, { props: { session, size }, global: { plugins: [pinia] } })
}

const kinds = (w: ReturnType<typeof mountGroup>) =>
  w.findAll('.group-avatar-cell').map((c) => c.attributes('data-kind'))
const alts = (w: ReturnType<typeof mountGroup>) => w.findAll('.group-avatar-cell img').map((i) => i.attributes('alt'))

beforeEach(() => {
  auth.me = null
})

describe('群头像成员顺序', () => {
  it('主管在最前，其余 Agent 按会话顺序，同一个 Agent 不重复', () => {
    const members = groupAvatarMembers({
      agentIds: ['kernel-claude-code', 'kernel-codex', 'kernel-hermes'],
      supervisorId: 'kernel-codex',
    })
    expect(members.map((m) => (m.type === 'agent' ? m.id : m.type))).toEqual([
      'kernel-codex',
      'kernel-claude-code',
      'kernel-hermes',
    ])
    expect(members[0]).toMatchObject({ supervisor: true })
  })

  it('没有 supervisorId 时按内置 LULUX 当主管；none 表示没有主管', () => {
    expect(
      groupAvatarMembers({ agentIds: ['kernel-claude-code', 'builtin'] }).map((m) => (m.type === 'agent' ? m.id : '')),
    ).toEqual(['builtin', 'kernel-claude-code'])
    expect(
      groupAvatarMembers({ agentIds: ['kernel-claude-code', 'kernel-hermes'], supervisorId: 'none' }).map((m) =>
        m.type === 'agent' ? m.id : '',
      ),
    ).toEqual(['kernel-claude-code', 'kernel-hermes'])
  })

  it('多人群聊：同事排在 Agent 后面，不含自己；只有自己一人时不画真人', () => {
    const participants = [person('u-me', '我自己', 'owner'), person('u-1', '王芳'), person('u-2', 'Anna Weber')]
    const members = groupAvatarMembers({ agentIds: ['builtin'], participants }, 'u-me')
    expect(members.map((m) => (m.type === 'human' ? m.name : m.type === 'agent' ? m.id : ''))).toEqual([
      'builtin',
      '王芳',
      'Anna Weber',
    ])
    expect(groupAvatarMembers({ agentIds: ['builtin'], participants: [person('u-me', '我', 'owner')] }, 'u-me')).toHaveLength(1)
  })

  it('超过 4 个成员：前 3 个 + “+N”', () => {
    const members = groupAvatarMembers({
      agentIds: ['builtin', 'kernel-claude-code', 'kernel-codex', 'kernel-hermes', 'kernel-gemini-cli', 'kernel-pi'],
    })
    const cells = groupAvatarCells(members)
    expect(cells).toHaveLength(4)
    expect(cells[3]).toEqual({ type: 'more', count: 3 })
    expect(groupAvatarCells(members.slice(0, 4))).toHaveLength(4)
  })
})

describe('群头像布局', () => {
  it('格子数与排布：2 并排、3 上一下二、4 为 2×2', () => {
    expect(groupAvatarLayout(0)).toEqual([])
    expect(groupAvatarLayout(1)).toHaveLength(1)
    const two = groupAvatarLayout(2)
    expect(two[0].top).toBe(two[1].top)
    expect(two[0].left).toBeLessThan(two[1].left)
    const three = groupAvatarLayout(3)
    expect(three[0].top).toBeLessThan(three[1].top)
    expect(three[1].top).toBe(three[2].top)
    expect(three[0].left + three[0].size / 2).toBeCloseTo(50)
    const four = groupAvatarLayout(4)
    expect(new Set(four.map((s) => s.left)).size).toBe(2)
    expect(new Set(four.map((s) => s.top)).size).toBe(2)
    expect(groupAvatarLayout(9)).toHaveLength(4)
  })

  it('格子都在方块里且互不重叠', () => {
    for (const n of [1, 2, 3, 4]) {
      const slots = groupAvatarLayout(n)
      for (const s of slots) {
        expect(s.left).toBeGreaterThanOrEqual(0)
        expect(s.top).toBeGreaterThanOrEqual(0)
        expect(s.left + s.size).toBeLessThanOrEqual(100)
        expect(s.top + s.size).toBeLessThanOrEqual(100)
      }
      for (let i = 0; i < slots.length; i++)
        for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i]
          const b = slots[j]
          const apart = a.left + a.size <= b.left || b.left + b.size <= a.left || a.top + a.size <= b.top || b.top + b.size <= a.top
          expect(apart).toBe(true)
        }
    }
  })
})

describe('GroupAvatar 组件', () => {
  it('2 个成员：两个格子、主管在前、没有数字角标', () => {
    const w = mountGroup({ agentIds: ['builtin', 'kernel-claude-code'], supervisorId: 'builtin' })
    expect(w.attributes('data-count')).toBe('2')
    expect(kinds(w)).toEqual(['agent', 'agent'])
    expect(alts(w)).toEqual(['LULUX', 'Claude Code'])
    expect(w.find('.agent-avatar-badge').exists()).toBe(false)
    expect(w.attributes('style')).toContain('--avatar-size: 34px')
  })

  it('3 个成员：主管是成员 Agent 时排第一，未安装的成员置灰', () => {
    const w = mountGroup({ agentIds: ['builtin', 'kernel-claude-code', 'kernel-codex'], supervisorId: 'kernel-claude-code' })
    expect(alts(w)).toEqual(['Claude Code', 'LULUX', 'Codex'])
    const cells = w.findAll('.group-avatar-cell')
    expect(cells[2].classes()).toContain('unavailable')
    expect(cells[0].classes()).not.toContain('unavailable')
  })

  it('4 个成员 2×2；svg 标志内核放在小方块里', () => {
    const w = mountGroup({ agentIds: ['builtin', 'kernel-claude-code', 'kernel-hermes', 'kernel-gemini-cli'] })
    expect(kinds(w)).toEqual(['agent', 'agent', 'agent', 'agent'])
    expect(w.findAll('.group-avatar-cell')[3].classes()).toContain('kernel-logo')
  })

  it('5 个成员：前 3 个 + “+2”', () => {
    const w = mountGroup({
      agentIds: ['kernel-claude-code', 'builtin', 'kernel-codex', 'kernel-hermes', 'kernel-pi'],
    })
    expect(w.attributes('data-count')).toBe('5')
    expect(kinds(w)).toEqual(['agent', 'agent', 'agent', 'more'])
    expect(alts(w)).toEqual(['LULUX', 'Claude Code', 'Codex'])
    expect(w.find('.group-avatar-cell.is-more').text()).toBe('+2')
  })

  it('多人群聊：同事用名字的字，排在 Agent 后面', () => {
    auth.me = { user: { id: 'u-me' } } as unknown as typeof auth.me
    const w = mountGroup({
      agentIds: ['builtin', 'kernel-claude-code'],
      participants: [person('u-me', 'koko', 'owner'), person('u-1', '王芳')],
    })
    expect(kinds(w)).toEqual(['agent', 'agent', 'human'])
    expect(w.find('.group-avatar-cell.is-human').text()).toBe('芳')
  })
})
