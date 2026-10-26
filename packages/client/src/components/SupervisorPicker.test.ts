import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../api'
import { useAppStore } from '../stores/app'
import SupervisorPicker from './SupervisorPicker.vue'

const group: Session = {
  id: 's1',
  title: 'g',
  groupName: null,
  providerId: null,
  agentIds: ['builtin', 'kernel-claude-code'],
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  preview: '',
}

describe('SupervisorPicker', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('选项：LULUX（默认）、成员内核、无主管；缺省值为 builtin', () => {
    const store = useAppStore()
    store.agents = [
      { id: 'builtin', name: 'LULUX', description: '', avatar: '', accent: '' },
      { id: 'kernel-claude-code', name: 'Claude Code', description: '', avatar: '', accent: '' },
    ]
    const w = mount(SupervisorPicker, { props: { session: group } })
    expect(w.findAll('option').map((o) => o.text())).toEqual([
      'LULUX（默认）',
      'Claude Code',
      '无主管（全员按顺序回答）',
    ])
    expect((w.find('select').element as HTMLSelectElement).value).toBe('builtin')
    expect(w.find('select').attributes('aria-label')).toBe('选择本群主管')
  })

  it('选择后 PATCH supervisorId 并更新会话；失败时回退并报错', async () => {
    const store = useAppStore()
    store.sessions = [group]
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.supervisorId === 'none')
        return new Response(JSON.stringify({ error: { code: 'X', message: '不行' } }), { status: 400 })
      return new Response(JSON.stringify({ session: { ...group, supervisorId: body.supervisorId } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchFn)
    const w = mount(SupervisorPicker, { props: { session: group } })
    await w.find('select').setValue('kernel-claude-code')
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchFn.mock.calls[0][0]).toBe('/api/sessions/s1')
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({ supervisorId: 'kernel-claude-code' })
    expect(store.sessions[0].supervisorId).toBe('kernel-claude-code')

    await w.find('select').setValue('none')
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('error')?.[0]?.[0]).toContain('不行')
    expect((w.find('select').element as HTMLSelectElement).value).toBe('builtin')
  })

  it('会话生成中不能改', () => {
    const store = useAppStore()
    store.runs = { s1: {} as never }
    const w = mount(SupervisorPicker, { props: { session: group } })
    expect(w.find('select').attributes('disabled')).toBeDefined()
  })
})
