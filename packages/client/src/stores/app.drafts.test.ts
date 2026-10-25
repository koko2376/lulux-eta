/**
 * 回归：发送失败退回草稿、新对话创建、删除生成中的会话（stores/app.ts）。
 */
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDraft } from '../lib/composer-draft'

const ctl: {
  createSession: () => Promise<unknown>
  stream: (req: unknown, handlers: unknown, signal?: AbortSignal) => Promise<void>
} = {
  createSession: async () => ({ id: 'new', title: '', agentIds: ['builtin'], kind: 'single' }),
  stream: async () => undefined,
}

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    createSession: vi.fn((...a: unknown[]) => (ctl.createSession as (...x: unknown[]) => Promise<unknown>)(...a)),
    streamChatRequest: vi.fn((req: unknown, h: unknown, s?: AbortSignal) => ctl.stream(req, h, s)),
    getSession: vi.fn(async (id: string) => ({ session: { id, running: false }, messages: [] })),
    listSessions: vi.fn(async () => [
      { id: 's1', title: 'a', agentIds: ['builtin'], updatedAt: 0 },
      { id: 's2', title: 'b', agentIds: ['builtin'], updatedAt: 0 },
    ]),
    getSessionContext: vi.fn(async () => ({ customerId: null, quoteId: null })),
    cancelRun: vi.fn(async () => ({ stopped: false })),
    deleteSession: vi.fn(async () => undefined),
  }
})

async function setup() {
  setActivePinia(createPinia())
  const { useAppStore } = await import('./app')
  const s = useAppStore()
  // 模块级状态（已删除的会话等）不跨用例残留
  s.resetForAccountSwitch()
  s.sessions = [
    { id: 's1', title: 'a', agentIds: ['builtin'], updatedAt: 0 } as never,
    { id: 's2', title: 'b', agentIds: ['builtin'], updatedAt: 0 } as never,
  ]
  return s
}

const image = { kind: 'image', path: 'uploads/a.png', name: 'a.png', mime: 'image/png', size: 68 } as const
const original = (): SessionDraft => ({
  text: '你好',
  attachments: [{ path: 'uploads/a.png', name: 'a.png', size: 68, status: 'done', image: true, preview: 'data:x' }],
  refs: [{ kind: 'customer', id: 'c1', label: '客户甲', summary: '客户资料' }],
})

beforeEach(() => {
  ctl.createSession = async () => ({ id: 'new', title: '', agentIds: ['builtin'], kind: 'single' })
  ctl.stream = async () => undefined
})
afterEach(() => vi.clearAllMocks())

describe('发送失败：草稿退回', () => {
  it('没有当前会话、新建会话失败：原文退回输入框，不抛出未处理的拒绝', async () => {
    const s = await setup()
    s.currentSessionId = null
    const { ApiError } = await import('../api')
    ctl.createSession = async () => {
      throw new ApiError('HTTP_500', '服务器内部错误', 500)
    }
    await expect(s.send('一段很长的询盘回复草稿')).resolves.toBeUndefined()
    expect(s.failedDraft).toMatchObject({ sessionId: null, text: '一段很长的询盘回复草稿' })
    expect(s.error).toContain('服务器内部错误')
  })

  it('请求被拒时用户已切到另一个会话：草稿回到原会话的草稿表，不进当前会话的输入框', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    const { ApiError } = await import('../api')
    let reject!: (e: unknown) => void
    ctl.stream = () => new Promise((_, r) => (reject = r))
    const p = s.send('发给 s1 的话')
    await flushPromises()
    s.currentSessionId = 's2'
    reject(new ApiError('NO_PROVIDER', 'no provider', 400))
    await p
    expect(s.failedDraft).toBeNull()
    expect(s.drafts.s1?.text).toBe('发给 s1 的话')
  })

  it('退回的是用户原文和原附件、一次性引用，不是展开后的整条消息', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    const { ApiError } = await import('../api')
    ctl.stream = async () => {
      throw new ApiError('NO_PROVIDER', 'no provider', 400)
    }
    const { withAttachmentNote } = await import('../lib/attachments')
    const message = withAttachmentNote('你好', ['uploads/a.png'])
    await s.send(message, { attachments: [image as never], draft: original() })
    expect(s.failedDraft?.sessionId).toBe('s1')
    expect(s.failedDraft?.text).toBe('你好')
    expect(s.failedDraft?.text).not.toContain('uploads/a.png')
    expect(s.failedDraft?.attachments.map((a) => a.path)).toEqual(['uploads/a.png'])
    expect(s.failedDraft?.refs.map((r) => r.id)).toEqual(['c1'])
    expect(s.messages).toHaveLength(0)
  })

  it('没有会话时连发两条：只建一个会话，后一条退回输入框', async () => {
    const s = await setup()
    s.currentSessionId = null
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ctl.createSession = async () => {
      n++
      const id = `new${n}`
      await gate
      return { id, title: '', agentIds: ['builtin'], kind: 'single' }
    }
    ctl.stream = () => new Promise(() => undefined)
    const a = s.send('一')
    const b = s.send('二')
    release()
    await b
    await flushPromises()
    const api = await import('../api')
    expect(vi.mocked(api.createSession)).toHaveBeenCalledTimes(1)
    expect(s.currentSessionId).toBe('new1')
    expect(s.failedDraft).toMatchObject({ sessionId: 'new1', text: '二' })
    void a
  })
})

describe('删除生成中的会话', () => {
  it('流收尾时迟到的会话列表不会把已删会话写回侧栏', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    const api = await import('../api')
    ctl.stream = (_req, h, signal) =>
      new Promise<void>((resolve) => {
        ;(h as { onStart: (x: unknown) => void }).onStart({})
        signal?.addEventListener('abort', () => resolve())
      })
    let releaseList!: () => void
    const listGate = new Promise<void>((r) => (releaseList = r))
    vi.mocked(api.listSessions).mockImplementation(async () => {
      await listGate
      return [
        { id: 's1', title: 'a', agentIds: ['builtin'], updatedAt: 0 },
        { id: 's2', title: 'b', agentIds: ['builtin'], updatedAt: 0 },
      ] as never
    })
    void s.send('hi')
    await flushPromises()
    expect(s.runs.s1).toBeTruthy()
    await s.removeSession('s1')
    expect(s.sessions.map((x) => x.id)).toEqual(['s2'])
    releaseList()
    await flushPromises()
    expect(s.sessions.map((x) => x.id)).toEqual(['s2'])
  })

  it('删除失败时会话照常留在列表里', async () => {
    const s = await setup()
    const api = await import('../api')
    vi.mocked(api.deleteSession).mockRejectedValueOnce(new api.ApiError('HTTP_500', 'boom', 500))
    await expect(s.removeSession('s2')).rejects.toBeTruthy()
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: 's1', title: 'a', agentIds: ['builtin'], updatedAt: 0 },
      { id: 's2', title: 'b', agentIds: ['builtin'], updatedAt: 0 },
    ] as never)
    await s.refreshSessions()
    expect(s.sessions.map((x) => x.id)).toEqual(['s1', 's2'])
  })
})
