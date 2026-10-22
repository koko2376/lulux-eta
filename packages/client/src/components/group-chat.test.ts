import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Session } from '../api'
import { subscribeSessionEvents } from '../api'
import {
  avatarHue,
  canManageGroup,
  canRemoveMember,
  initialsOf,
  isGroupOwner,
  isMultiHuman,
  mergeMessage,
  messageSender,
} from '../lib/group-members'
import { auth } from '../lib/session'
import { useAppStore } from '../stores/app'
import MessageList from './MessageList.vue'
import NewGroupDialog from './NewGroupDialog.vue'
import SessionContextMenu from './SessionContextMenu.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

/** 多人群聊（契约 §6.10）：同事选择、成员管理、发言人显示、实时并入 */
const agents = [
  { id: 'builtin', name: 'LULUX', description: '', avatar: '', accent: '', kind: 'builtin', available: true },
  { id: 'lux-analyst', name: '洞见', description: '', avatar: '', accent: '', kind: 'builtin', available: true },
] as Agent[]

const ALICE = { userId: 'usr_alice', name: 'Alice Wang', role: 'owner' as const, joinedAt: 1 }
const BOB = { userId: 'usr_bob', name: '陈小波', role: 'member' as const, joinedAt: 2 }
const CAROL = { userId: 'usr_carol', name: 'Carol', role: 'admin' as const, joinedAt: 3 }

const group: Session = {
  id: 'g1',
  title: '欧洲线报价',
  kind: 'group',
  groupName: '欧洲线报价群',
  providerId: null,
  agentIds: ['builtin', 'lux-analyst'],
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  preview: '',
  supervisorId: 'builtin',
  participants: [ALICE, BOB, CAROL],
  myRole: 'owner',
}

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    sessionId: 'g1',
    role: 'user',
    content: 'hi',
    senderAgentId: null,
    toolTrace: [],
    createdAt: 1,
    ...over,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function stubFetch(
  handler: (
    url: string,
    body: Record<string, unknown> | undefined,
    method: string,
  ) => { status?: number; body: unknown },
) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = handler(String(url), body, init?.method ?? 'GET')
    const status = out.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(out.body), { status })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function signIn(userId: string, mode: 'server' | 'desktop' = 'server'): void {
  auth.mode = mode
  auth.me = mode === 'server' ? ({ user: { id: userId, name: userId } } as never) : null
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  auth.mode = 'desktop'
  auth.me = null
})

describe('group-members 纯函数', () => {
  it('多人群聊 / 角色 / 能否移出', () => {
    expect(isMultiHuman(group)).toBe(true)
    expect(isMultiHuman({ ...group, participants: [ALICE] })).toBe(false)
    expect(isMultiHuman({ ...group, participants: undefined })).toBe(false)
    expect(canManageGroup({ myRole: 'admin' })).toBe(true)
    expect(canManageGroup({ myRole: 'member' })).toBe(false)
    // 旧服务端没有 myRole：按群主（单人使用不受影响）
    expect(canManageGroup({})).toBe(true)
    expect(isGroupOwner({ myRole: 'admin' })).toBe(false)

    expect(canRemoveMember({ myRole: 'owner' }, BOB, ALICE.userId)).toBe(true)
    expect(canRemoveMember({ myRole: 'owner' }, CAROL, ALICE.userId)).toBe(true)
    expect(canRemoveMember({ myRole: 'owner' }, ALICE, ALICE.userId)).toBe(false)
    expect(canRemoveMember({ myRole: 'admin' }, BOB, CAROL.userId)).toBe(true)
    expect(canRemoveMember({ myRole: 'admin' }, { ...CAROL, userId: 'usr_x' }, CAROL.userId)).toBe(false)
    expect(canRemoveMember({ myRole: 'admin' }, ALICE, CAROL.userId)).toBe(false)
    expect(canRemoveMember({ myRole: 'member' }, CAROL, BOB.userId)).toBe(false)
  })

  it('头像文字与底色稳定', () => {
    expect(initialsOf('Alice Wang')).toBe('AW')
    expect(initialsOf('carol')).toBe('C')
    expect(initialsOf('陈小波')).toBe('波')
    expect(initialsOf('  ')).toBe('?')
    expect(avatarHue('usr_bob')).toBe(avatarHue('usr_bob'))
  })

  it('发言人只在多人群聊里显示；名字优先用成员表', () => {
    expect(messageSender(msg({ senderUserId: 'usr_bob', senderName: '旧名' }), group)).toEqual({
      userId: 'usr_bob',
      name: '陈小波',
    })
    // 已退群的人：用消息里的名字
    expect(messageSender(msg({ senderUserId: 'usr_gone', senderName: 'Dan' }), group)).toEqual({
      userId: 'usr_gone',
      name: 'Dan',
    })
    expect(messageSender(msg({ role: 'assistant', senderUserId: null }), group)).toBeNull()
    expect(messageSender(msg({ senderUserId: 'usr_bob' }), { ...group, participants: [ALICE] })).toBeNull()
  })

  it('mergeMessage：同 id 不重复，按时间插入', () => {
    const list = [msg({ id: 'a', createdAt: 1 }), msg({ id: 'c', createdAt: 3 })]
    expect(mergeMessage(list, msg({ id: 'a', createdAt: 1 }))).toBe(list)
    expect(mergeMessage(list, msg({ id: 'b', createdAt: 2 })).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('store：实时并入别人的消息', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('当前会话：并入并更新侧栏；别人的提问 → 查询运行状态（显示正在回复）', async () => {
    const store = useAppStore()
    store.sessions = [{ ...group }]
    store.currentSessionId = 'g1'
    store.messages = [msg({ id: 'm0', createdAt: 1, senderUserId: 'usr_alice' })]
    const fetchFn = stubFetch((url) =>
      url.includes('/api/chat/pending') ? { body: { running: true, requests: [], allowedTools: [] } } : { body: {} },
    )
    store.applyRemoteMessage(
      'g1',
      msg({ id: 'm1', createdAt: 2, senderUserId: 'usr_bob', content: '运费多少' }),
      'usr_alice',
    )
    expect(store.messages.map((m) => m.id)).toEqual(['m0', 'm1'])
    expect(store.sessions[0]).toMatchObject({ preview: '运费多少', messageCount: 1 })
    await tick()
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/chat/pending?sessionId=g1'))).toBe(true)
    expect(store.runs.g1).toMatchObject({ local: false })
    store.stopPolling('g1')
    // 重复推送不重复插入、不重复计数
    store.applyRemoteMessage('g1', msg({ id: 'm1', createdAt: 2, senderUserId: 'usr_bob' }), 'usr_alice')
    expect(store.messages).toHaveLength(2)
    expect(store.sessions[0].messageCount).toBe(1)
  })

  it('新服务端（会话带 running）：别人的提问不轮询 pending；会话事件流的 run → 接上运行流（重复推送只接一次）', async () => {
    const store = useAppStore()
    store.sessions = [{ ...group, running: false, activeRunId: null }]
    store.currentSessionId = 'g1'
    store.messages = []
    const fetchFn = stubFetch((url) =>
      url.includes('/stream')
        ? { body: '' }
        : url.includes('/api/sessions/g1')
          ? { body: { session: { ...group, running: true }, messages: [] } }
          : { body: {} },
    )
    store.applyRemoteMessage(
      'g1',
      msg({ id: 'm1', createdAt: 2, senderUserId: 'usr_bob', content: '运费多少' }),
      'usr_alice',
    )
    await tick()
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/chat/pending'))).toBe(false)
    // 全局 session.run 与会话事件流 run 推同一次变化
    void store.applyRunState('g1', true, 'run_1')
    expect(store.sessions[0]).toMatchObject({ running: true, activeRunId: 'run_1' })
    void store.applyRunState('g1', true, 'run_1')
    await tick()
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes('/api/sessions/g1/stream')).length).toBe(1)
  })

  it('本窗口正持有流：不插入（流结束后整体刷新）；不是当前会话：只更新侧栏', () => {
    const store = useAppStore()
    store.sessions = [{ ...group }, { ...group, id: 'g2' }]
    store.currentSessionId = 'g1'
    store.messages = []
    store.runs.g1 = { local: true } as never
    store.applyRemoteMessage('g1', msg({ id: 'x', senderUserId: 'usr_alice' }), 'usr_alice')
    expect(store.messages).toHaveLength(0)
    store.applyRemoteMessage('g2', msg({ id: 'y', sessionId: 'g2', content: '别的群' }), 'usr_alice')
    expect(store.messages).toHaveLength(0)
    expect(store.sessions[1].preview).toBe('别的群')
  })

  it('被移出 / 退出群聊：从侧栏去掉并清空当前会话', async () => {
    const store = useAppStore()
    store.sessions = [{ ...group }]
    store.currentSessionId = 'g1'
    store.messages = [msg({})]
    const fetchFn = stubFetch(() => ({ status: 204, body: null }))
    await store.leaveGroup('g1')
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/sessions/g1/participants/me')
    expect(fetchFn.mock.calls[0][1]?.method).toBe('DELETE')
    expect(store.sessions).toHaveLength(0)
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toHaveLength(0)
  })
})

describe('新建群聊：邀请同事', () => {
  beforeEach(() => setActivePinia(createPinia()))

  async function openDialog(colleagues: unknown[]) {
    const store = useAppStore()
    store.agents = agents
    const fetchFn = stubFetch((url, body, method) => {
      if (url.includes('/api/sessions/colleagues')) return { body: { users: colleagues } }
      if (url.endsWith('/api/sessions') && method === 'POST')
        return { status: 201, body: { session: { ...group, ...body } } }
      return { body: {} }
    })
    const w = mount(NewGroupDialog, { props: { x: 10, y: 10 }, attachTo: document.body })
    await tick()
    await tick()
    return { w, fetchFn, dialog: document.body.querySelector('[role="dialog"]')! }
  }

  it('团队服务器：勾选同事后 POST 带 userIds', async () => {
    signIn('usr_alice')
    const { w, fetchFn, dialog } = await openDialog([
      { id: 'usr_bob', name: '陈小波', email: 'bob@acme.com' },
      { id: 'usr_carol', name: 'Carol', email: 'carol@acme.com' },
    ])
    const picker = dialog.querySelector('[data-testid="colleague-picker"]')!
    expect(picker).not.toBeNull()
    expect(picker.textContent).toContain('陈小波')
    dialog.querySelectorAll<HTMLButtonElement>('.context-agent')[1].click()
    picker.querySelector<HTMLButtonElement>('[data-user-id="usr_bob"]')!.click()
    await tick()
    expect(picker.textContent).toContain('已邀请 1 人')
    dialog.querySelector<HTMLButtonElement>('.context-done')!.click()
    await tick()
    const post = fetchFn.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/sessions') && init?.method === 'POST',
    )!
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({
      kind: 'group',
      agentIds: ['builtin', 'lux-analyst'],
      userIds: ['usr_bob'],
    })
    w.unmount()
  })

  it('组织里只有自己：不显示同事选择；本机模式也不显示、不请求', async () => {
    signIn('usr_alice')
    const alone = await openDialog([])
    expect(alone.dialog.querySelector('[data-testid="colleague-picker"]')).toBeNull()
    alone.w.unmount()
    document.body.innerHTML = ''

    signIn('local', 'desktop')
    const local = await openDialog([{ id: 'x', name: 'X', email: '' }])
    expect(local.dialog.querySelector('[data-testid="colleague-picker"]')).toBeNull()
    expect(local.fetchFn.mock.calls.some(([url]) => String(url).includes('colleagues'))).toBe(false)
    local.w.unmount()
  })
})

describe('群设置（右键菜单）：按角色', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('普通成员：不能改名 / 换 Agent / 删除；能看到成员、退出群聊', async () => {
    signIn('usr_bob')
    const store = useAppStore()
    store.agents = agents
    const mine = { ...group, myRole: 'member' as const }
    store.sessions = [mine]
    stubFetch(() => ({ body: { users: [] } }))
    const w = mount(SessionContextMenu, { props: { session: mine, x: 10, y: 10 }, attachTo: document.body })
    await tick()
    const menu = document.body.querySelector('.context-menu')!
    expect(menu.querySelector<HTMLButtonElement>('.context-rename')!.disabled).toBe(true)
    expect(
      [...menu.querySelectorAll<HTMLButtonElement>('.context-agents .context-agent')].every((b) => b.disabled),
    ).toBe(true)
    expect(menu.querySelector<HTMLSelectElement>('.supervisor-select')!.disabled).toBe(true)
    expect(menu.querySelector('.context-remove')).toBeNull()
    const people = menu.querySelector('[data-testid="group-people"]')!
    expect(people.textContent).toContain('Alice Wang')
    expect(people.textContent).toContain('群主')
    expect(people.textContent).toContain('陈小波（我）')
    expect(people.querySelector('[data-testid="group-invite"]')).toBeNull()
    expect(people.querySelector('[data-testid="group-leave"]')).not.toBeNull()
    expect(people.querySelectorAll('.group-person-action')).toHaveLength(0)
    w.unmount()
  })

  it('群主：可移出成员、设管理员、邀请；没有“退出群聊”', async () => {
    signIn('usr_alice')
    const store = useAppStore()
    store.agents = agents
    store.sessions = [group]
    const fetchFn = stubFetch((url, _body, method) => {
      if (url.includes('/participants/usr_bob') && method === 'DELETE') return { status: 204, body: null }
      if (url.endsWith('/api/sessions/g1'))
        return { body: { session: { ...group, participants: [ALICE, CAROL] }, messages: [] } }
      return { body: { users: [] } }
    })
    const w = mount(SessionContextMenu, { props: { session: group, x: 10, y: 10 }, attachTo: document.body })
    await tick()
    const people = document.body.querySelector('[data-testid="group-people"]')!
    expect(people.querySelector('[data-testid="group-leave"]')).toBeNull()
    expect(document.body.querySelector('.context-remove')).not.toBeNull()
    const bobRow = people.querySelector('[data-user-id="usr_bob"]')!
    const removeBtn = bobRow.querySelector<HTMLButtonElement>('.group-person-action.danger')!
    expect(removeBtn.getAttribute('aria-label')).toBe('把 陈小波 移出群聊')
    removeBtn.click()
    await tick()
    await tick()
    expect(
      fetchFn.mock.calls.some(
        ([url, init]) => String(url).includes('/participants/usr_bob') && init?.method === 'DELETE',
      ),
    ).toBe(true)
    expect(store.sessions[0].participants?.map((p) => p.userId)).toEqual(['usr_alice', 'usr_carol'])
    w.unmount()
  })

  it('本机模式的群聊：不显示同事区域', async () => {
    signIn('local', 'desktop')
    const store = useAppStore()
    store.agents = agents
    const local = { ...group, participants: [{ ...ALICE, userId: 'local' }] }
    store.sessions = [local]
    const w = mount(SessionContextMenu, { props: { session: local, x: 10, y: 10 }, attachTo: document.body })
    await tick()
    expect(document.body.querySelector('[data-testid="group-people"]')).toBeNull()
    expect(document.body.querySelector('.context-remove')).not.toBeNull()
    w.unmount()
  })
})

describe('消息列表：显示发言人', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('别人的消息靠左、带名字和头像、不能编辑；自己的消息照旧', async () => {
    signIn('usr_alice')
    const store = useAppStore()
    store.agents = agents
    store.sessions = [group]
    store.currentSessionId = 'g1'
    store.messages = [
      msg({ id: 'a1', senderUserId: 'usr_alice', senderName: 'Alice Wang', content: '我先问', createdAt: 1 }),
      msg({ id: 'b1', senderUserId: 'usr_bob', senderName: '陈小波', content: '我补充', createdAt: 2 }),
      msg({ id: 'r1', role: 'assistant', senderAgentId: 'builtin', content: '收到', createdAt: 3 }),
    ]
    const w = mount(MessageList, { attachTo: document.body })
    await tick()
    const mine = w.find('[data-message-id="a1"]')
    const other = w.find('[data-message-id="b1"]')
    expect(mine.classes()).toContain('mine-in-group')
    expect(mine.find('[data-testid="message-sender"]').exists()).toBe(false)
    expect(other.classes()).toContain('from-other')
    expect(other.find('[data-testid="message-sender"]').text()).toBe('陈小波')
    expect(other.find('.human-avatar').text()).toBe('波')
    // 别人的消息不能编辑；我的消息之后有别人发言，也不能编辑重发 / 重新生成（会截掉同事的消息）
    const labels = (id: string) =>
      w
        .find(`[data-message-id="${id}"]`)
        .findAll('.msg-action')
        .map((b) => b.attributes('aria-label'))
    expect(labels('b1')).not.toContain('编辑后重发')
    expect(labels('a1')).not.toContain('编辑后重发')
    // 重新生成的锚点是别人的消息：不提供
    expect(labels('r1')).not.toContain('重新生成')
    expect(labels('r1')).toContain('复制')
    // 最后一条是我的：可以编辑重发
    store.messages.push(msg({ id: 'a2', senderUserId: 'usr_alice', content: '再问一句', createdAt: 4 }))
    await tick()
    expect(labels('a2')).toContain('编辑后重发')
    w.unmount()
  })
})

describe('会话事件流', () => {
  it('404（不是成员 / 群已解散）→ 发出 removed 并停止', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchFn)
    const events: string[] = []
    subscribeSessionEvents('g1', (event) => events.push(event.event))
    await tick()
    await tick()
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('/api/sessions/g1/events')
    expect(events).toEqual(['removed'])
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
