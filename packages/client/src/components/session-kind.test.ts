import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '../api'
import { isGroupSession, sessionDisplayName } from '../lib/session-name'
import { useAppStore } from '../stores/app'
import KernelMenu from './KernelMenu.vue'
import NewGroupDialog from './NewGroupDialog.vue'
import SessionContextMenu from './SessionContextMenu.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

/** 群聊总是新建的独立会话，与原会话无关 */
const base: Session = {
  id: 's1',
  title: '询价跟进',
  kind: 'single',
  groupName: null,
  providerId: null,
  agentIds: ['builtin'],
  createdAt: 0,
  updatedAt: 0,
  messageCount: 3,
  preview: '',
}
const agents = [
  { id: 'builtin', name: 'LULUX', description: '', avatar: '', accent: '', kind: 'builtin', available: true },
  {
    id: 'kernel-claude-code',
    name: 'Claude Code',
    description: '',
    avatar: '',
    accent: '',
    kind: 'kernel',
    kernelId: 'claude-code',
    available: true,
  },
  {
    id: 'kernel-pi',
    name: 'Pi',
    description: '',
    avatar: '',
    accent: '',
    kind: 'kernel',
    kernelId: 'pi',
    available: true,
  },
] as Agent[]

const tick = () => new Promise((r) => setTimeout(r, 0))

function stubFetch(handler: (url: string, body: { agentIds?: string[]; members?: Array<{ agentId: string }> }, method: string) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Response(JSON.stringify(handler(url, body, init?.method ?? 'GET')), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('会话类型：群聊看 kind，不看成员数', () => {
  it('isGroupSession / sessionDisplayName', () => {
    expect(isGroupSession(base)).toBe(false)
    expect(isGroupSession({ ...base, kind: 'group', agentIds: ['kernel-pi'] })).toBe(true)
    // 旧服务端没有 kind：按成员数推断
    expect(isGroupSession({ ...base, kind: undefined, agentIds: ['builtin', 'kernel-pi'] })).toBe(true)
    // 单聊即使库里残留群名也不显示群名
    expect(sessionDisplayName({ ...base, groupName: '旧群名' })).toBe('询价跟进')
    expect(sessionDisplayName({ ...base, kind: 'group', groupName: '报价小组' })).toBe('报价小组')
  })

  it('store.isGroupChat 跟随 kind', () => {
    setActivePinia(createPinia())
    const store = useAppStore()
    store.agents = agents
    store.sessions = [{ ...base, kind: 'group', agentIds: ['builtin'] }]
    store.currentSessionId = 's1'
    expect(store.isGroupChat).toBe(true)
    store.sessions = [{ ...base, agentIds: ['builtin'] }]
    expect(store.isGroupChat).toBe(false)
  })
})

describe('单聊右键菜单：只能换内核，不能加成员变成群聊', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('单选：点另一个内核 = 换成它（PATCH 只有一个 id），没有群名 / 主管', async () => {
    const store = useAppStore()
    store.agents = agents
    store.sessions = [base]
    const fetchFn = stubFetch((_url, body) => ({ session: { ...base, agentIds: body.agentIds } }))
    const w = mount(SessionContextMenu, { props: { session: base, x: 10, y: 10 }, attachTo: document.body })
    const menu = document.body.querySelector('.context-menu')!
    expect(menu.querySelector('.context-group')).toBeNull()
    expect(menu.querySelector('.supervisor-picker')).toBeNull()
    expect(menu.querySelector('.context-tag')).toBeNull()
    expect(menu.querySelector('.context-hint')!.textContent).toContain('新建群聊')
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('.context-agent')]
    expect(rows.every((r) => r.getAttribute('role') === 'menuitemradio')).toBe(true)
    rows[2].click()
    await tick()
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({ agentIds: ['kernel-pi'] })
    expect(store.sessions[0]).toMatchObject({ kind: 'single', agentIds: ['kernel-pi'] })
    // 点当前内核：不发请求
    rows[2].click()
    await tick()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('群聊：多选增删成员，群名与主管都在', async () => {
    const store = useAppStore()
    store.agents = agents
    const group: Session = {
      ...base,
      id: 'g1',
      kind: 'group',
      agentIds: ['builtin', 'kernel-pi'],
      supervisorId: 'builtin',
    }
    store.sessions = [group]
    const fetchFn = stubFetch((_url, body) => ({
      session: { ...group, agentIds: body.members ? body.members.map((m: { agentId: string }) => m.agentId) : body.agentIds },
    }))
    const w = mount(SessionContextMenu, { props: { session: group, x: 10, y: 10 }, attachTo: document.body })
    const menu = document.body.querySelector('.context-menu')!
    expect(menu.querySelector('.context-group')).not.toBeNull()
    expect(menu.querySelector('.supervisor-picker')).not.toBeNull()
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('.context-agent')]
    expect(rows[0].getAttribute('role')).toBe('menuitemcheckbox')
    rows[1].click()
    await tick()
    await new Promise((r) => setTimeout(r, 10))
    await tick()
    // 群成员整体保存（members，带群头衔；已有成员保持实例 id）
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      members: [
        { agentId: 'builtin', role: null, instructions: null },
        { agentId: 'kernel-pi', role: null, instructions: null },
        { agentId: 'kernel-claude-code', role: null, instructions: null },
      ],
    })
    w.unmount()
  })
})

describe('新建群聊', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('“+”浮层里有“新建群聊”入口', async () => {
    const w = mount(KernelMenu, { props: { x: 10, y: 10, agents, allowGroup: true }, attachTo: document.body })
    await tick()
    const entry = document.body.querySelector<HTMLButtonElement>('.kernel-new-group')!
    expect(entry.textContent).toContain('新建群聊')
    entry.click()
    expect(w.emitted('new-group')).toHaveLength(1)
    w.unmount()
    // 会话头部的内核切换不提供群聊入口
    const header = mount(KernelMenu, { props: { x: 10, y: 10, agents }, attachTo: document.body })
    await tick()
    expect(document.body.querySelector('.kernel-new-group')).toBeNull()
    header.unmount()
  })

  it('总是 POST 一个新的群聊会话（kind group、成员、群名、主管），不碰当前会话', async () => {
    const store = useAppStore()
    store.agents = agents
    store.sessions = [base]
    store.currentSessionId = 's1'
    store.messages = [{ id: 'm1' } as never]
    const created: Session = {
      ...base,
      id: 'g2',
      kind: 'group',
      groupName: '报价小组',
      agentIds: ['builtin', 'kernel-claude-code'],
      messageCount: 0,
      supervisorId: 'none',
    }
    const fetchFn = stubFetch(() => ({ session: created }))
    const w = mount(NewGroupDialog, { props: { x: 10, y: 10 }, attachTo: document.body })
    await tick()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('新建群聊')
    const createBtn = [...dialog.querySelectorAll<HTMLButtonElement>('.context-done')][0]
    // 默认只勾了 LULUX：不足两个，不能创建
    expect(createBtn.disabled).toBe(true)
    const input = dialog.querySelector<HTMLInputElement>('.context-group-input')!
    input.value = '报价小组'
    input.dispatchEvent(new Event('input'))
    dialog.querySelectorAll<HTMLButtonElement>('.context-agent')[1].click()
    await tick()
    expect(createBtn.disabled).toBe(false)
    const select = dialog.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'LULUX（默认）',
      'Claude Code',
      '无主管（全员按顺序回答）',
    ])
    select.value = 'none'
    select.dispatchEvent(new Event('change'))
    createBtn.click()
    await tick()
    await tick()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe('/api/sessions')
    expect(fetchFn.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      kind: 'group',
      members: [
        { agentId: 'builtin', role: null },
        { agentId: 'kernel-claude-code', role: null },
      ],
      groupName: '报价小组',
      supervisorId: 'none',
    })
    expect(w.emitted('created')?.[0]).toEqual(['g2'])
    expect(store.sessions.map((s) => s.id)).toEqual(['g2', 's1'])
    expect(store.sessions[1]).toEqual(base)
    expect(store.currentSessionId).toBe('g2')
    expect(store.messages).toEqual([])
    w.unmount()
  })

  it('同一内核可以加多个（右侧 ＋），每人一个群头衔；主管下拉带群头衔', async () => {
    const store = useAppStore()
    store.agents = agents
    store.sessions = [base]
    const fetchFn = stubFetch(() => ({ session: { ...base, id: 'g3', kind: 'group', agentIds: ['builtin', 'builtin#2'] } }))
    const w = mount(NewGroupDialog, { props: { x: 10, y: 10 }, attachTo: document.body })
    await tick()
    const dialog = document.body.querySelector('[role="dialog"]')!
    const add = dialog.querySelector<HTMLButtonElement>('.member-add')!
    expect(add).not.toBeNull()
    add.click()
    await tick()
    const roles = [...dialog.querySelectorAll<HTMLInputElement>('.member-role-input')]
    expect(roles).toHaveLength(2)
    roles[0].value = '跟单员'
    roles[0].dispatchEvent(new Event('input'))
    await tick()
    roles[1].value = '写信员'
    roles[1].dispatchEvent(new Event('input'))
    await tick()
    expect(dialog.querySelector('.member-count')!.textContent).toBe('×2')
    expect([...dialog.querySelectorAll('.member-tag')].map((el) => el.textContent)).toEqual(['跟单员', '写信员'])
    const select = dialog.querySelector<HTMLSelectElement>('.supervisor-select')!
    expect([...select.options].map((o) => o.value)).toEqual(['builtin', 'builtin#2', 'none'])
    expect(select.options[1].textContent).toContain('写信员')
    select.value = 'builtin#2'
    select.dispatchEvent(new Event('change'))
    dialog.querySelector<HTMLButtonElement>('.context-done')!.click()
    await tick()
    await tick()
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      kind: 'group',
      members: [
        { agentId: 'builtin', role: '跟单员' },
        { agentId: 'builtin', role: '写信员' },
      ],
      groupName: null,
      supervisorId: 'builtin#2',
    })
    w.unmount()
  })
})
