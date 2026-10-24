import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampLevel,
  defaultLevelFromSettings,
  effectiveLevel,
  levelAllowed,
  readonlyAskKernels,
} from '../lib/permissions'

const patched: Array<{ id: string; patch: Record<string, unknown> }> = []
const created: Array<Record<string, unknown>> = []
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    patchSession: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      patched.push({ id, patch })
      return { ...session(id), ...patch }
    }),
    createSession: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return { ...session('ses_new'), permissionLevel: input.permissionLevel ?? null }
    }),
  }
})

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: 't',
    kind: 'single',
    groupName: null,
    providerId: null,
    agentIds: ['kernel-codex'],
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    permissionLevel: null,
    myRole: 'owner',
    ...extra,
  }
}

const agents = [
  { id: 'kernel-codex', name: 'Codex', kind: 'kernel', kernelId: 'codex', available: true },
  { id: 'kernel-claude-code', name: 'Claude Code', kind: 'kernel', kernelId: 'claude-code', available: true },
]

async function setup(
  options: { cap?: 'read' | 'ask' | 'full'; withSession?: boolean; settings?: Record<string, string> } = {},
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.agents = agents as never
  store.settings = options.settings ?? { defaultPermissionLevel: 'ask' }
  store.permissionInfo = {
    levels: ['read', 'ask', 'full'],
    defaultLevel: 'ask',
    cap: options.cap ?? 'full',
    capsEnabled: options.cap !== undefined,
    kernels: { codex: { ask: 'readonly' }, 'claude-code': { ask: 'card' } },
  }
  if (options.withSession !== false) {
    store.sessions = [session('ses_1') as never]
    store.currentSessionId = 'ses_1'
  }
  const PermissionPicker = (await import('./PermissionPicker.vue')).default
  const w = mount(PermissionPicker, {
    global: { plugins: [pinia], stubs: { RouterLink: true } },
    attachTo: document.body,
  })
  return { w, store }
}

const menu = () => document.body.querySelector<HTMLElement>('[data-testid="permission-menu"]')
const rows = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('.perm-row') ?? [])]

afterEach(() => {
  patched.length = 0
  created.length = 0
  document.body.innerHTML = ''
})

describe('权限级别（lib）', () => {
  it('默认 / 上限 / 截断 / 旧设置换算', () => {
    expect(effectiveLevel(null, 'ask')).toBe('ask')
    expect(effectiveLevel('full', 'ask', 'ask')).toBe('ask')
    expect(effectiveLevel('read', 'full', 'ask')).toBe('read')
    expect(clampLevel('full', 'read')).toBe('read')
    expect(levelAllowed('ask', 'read')).toBe(false)
    expect(defaultLevelFromSettings({ toolApproval: 'auto' })).toBe('full')
    expect(defaultLevelFromSettings({ toolApproval: 'ask' })).toBe('ask')
    expect(defaultLevelFromSettings({ defaultPermissionLevel: 'read', toolApproval: 'auto' })).toBe('read')
    expect(readonlyAskKernels(agents, { codex: { ask: 'readonly' }, 'claude-code': { ask: 'card' } })).toEqual([
      'Codex',
    ])
  })
})

describe('输入框旁的权限选择器', () => {
  it('显示当前会话的级别（跟随默认）；打开后三个级别、当前项打勾；选“仅可查看”保存到会话', async () => {
    const { w, store } = await setup()
    const trigger = w.get('[data-testid="permission-picker"]')
    expect(trigger.attributes('aria-label')).toContain('需审批')
    expect(trigger.attributes('data-level')).toBe('ask')
    await trigger.trigger('click')
    await flushPromises()
    expect(menu()!.querySelector('.kernel-title')!.textContent).toBe('权限')
    expect(rows().map((r) => r.querySelector('strong')!.textContent)).toEqual(['仅可查看', '需审批', '完全权限'])
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(rows()[0].textContent).toContain('不提供写入')
    rows()[0].click()
    await flushPromises()
    expect(patched).toEqual([{ id: 'ses_1', patch: { permissionLevel: 'read' } }])
    expect(store.currentSession!.permissionLevel).toBe('read')
    expect(menu()).toBeNull()
    expect(w.get('[data-testid="permission-picker"]').attributes('aria-label')).toContain('仅可查看')
  })

  it('管理员上限“需审批”：完全权限置灰且不可选', async () => {
    const { w } = await setup({ cap: 'ask' })
    await w.get('[data-testid="permission-picker"]').trigger('click')
    await flushPromises()
    const full = rows()[2]
    expect(full.disabled).toBe(true)
    expect(full.textContent).toContain('管理员已限制')
    expect(rows()[0].disabled).toBe(false)
    full.click()
    await flushPromises()
    expect(patched).toHaveLength(0)
  })

  it('需审批 + 无法交互审批的 CLI 内核：给出“只能查看”的提示', async () => {
    const { w } = await setup()
    await w.get('[data-testid="permission-picker"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="permission-fallback-hint"]')!.textContent).toContain('Codex')
  })

  it('还没有会话：先记下，新建会话时带上', async () => {
    const { w, store } = await setup({ withSession: false, settings: { toolApproval: 'auto' } })
    expect(w.get('[data-testid="permission-picker"]').attributes('data-level')).toBe('full')
    await w.get('[data-testid="permission-picker"]').trigger('click')
    await flushPromises()
    rows()[1].click()
    await flushPromises()
    expect(patched).toHaveLength(0)
    expect(store.pendingPermissionLevel).toBe('ask')
    await store.newSession('kernel-codex')
    expect(created.at(-1)).toMatchObject({ kind: 'single', agentIds: ['kernel-codex'], permissionLevel: 'ask' })
    expect(store.pendingPermissionLevel).toBeNull()
    expect(store.currentPermissionLevel).toBe('ask')
  })

  it('群聊里普通成员不能改（群主 / 管理员才行）', async () => {
    const { w, store } = await setup()
    store.sessions = [session('ses_1', { kind: 'group', myRole: 'member' }) as never]
    await flushPromises()
    expect(w.get('[data-testid="permission-picker"]').attributes('disabled')).toBeDefined()
  })
})
