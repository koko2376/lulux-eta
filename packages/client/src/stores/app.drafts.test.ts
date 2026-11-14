/**
 * 回归：发送失败退回草稿、新对话创建、删除生成中的会话（stores/app.ts）。
 */
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionDraft } from '../lib/composer-draft'
import { DRAFTS_BASE_KEY } from '../lib/composer-draft'
import { auth } from '../lib/session'
import { scopedKey, storageScopeHash } from '../lib/storage-scope'

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

/* ─────────────── 草稿落盘（刷新 / 切账号后不丢，超限降级，登出清理） ─────────────── */

/** 换一个登录账号（草稿按 mode + baseUrl + userId 分作用域） */
function account(userId: string, baseUrl = ''): void {
  auth.ready = true
  auth.mode = baseUrl ? 'server' : 'desktop'
  auth.connection = baseUrl ? 'remote' : 'local'
  auth.serverUrl = baseUrl
  auth.me = userId ? ({ user: { id: userId, name: userId } } as never) : null
}

const draftsKey = (): string => scopedKey(DRAFTS_BASE_KEY, storageScopeHash.value)

/** 模拟刷新页面：新的 pinia + 重新建 store（state() 从本机存储读回草稿） */
async function reloadStore() {
  setActivePinia(createPinia())
  const { useAppStore } = await import('./app')
  return useAppStore()
}

const imageDraft = (): SessionDraft => ({
  text: '给客户的报价说明',
  attachments: [
    {
      path: 'uploads/a.png',
      name: 'a.png',
      size: 68,
      status: 'done',
      image: true,
      mime: 'image/png',
      // 打包时 preview 必须被剥掉：blob: 关窗失效，data: 会把图片正文写进本机存储
      preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    },
  ],
  refs: [{ kind: 'customer', id: 'c1', label: '客户甲', summary: '客户资料' }],
})

describe('草稿落盘', () => {
  beforeEach(() => {
    localStorage.clear()
    account('u1')
  })

  it('正在写的草稿写进本机存储：刷新后还能读回来', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    s.rememberLiveDraft('s1', imageDraft())

    const key = draftsKey()
    expect(key).toMatch(/^lulux\.composerDrafts:[0-9a-f]{8}$/)
    const stored = JSON.parse(localStorage.getItem(key)!) as { v: number; drafts: Record<string, unknown> }
    expect(stored.v).toBe(1)
    expect(Object.keys(stored.drafts)).toEqual(['s1'])

    // 刷新：新 store 从存储里恢复
    const reloaded = await reloadStore()
    expect(reloaded.drafts.s1?.text).toBe('给客户的报价说明')
    expect(reloaded.drafts.s1?.refs.map((r) => r.id)).toEqual(['c1'])
    expect(reloaded.drafts.s1?.attachments.map((a) => a.path)).toEqual(['uploads/a.png'])
  })

  it('只落元数据：base64 图片正文与 blob: 预览都不进 localStorage', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    s.rememberLiveDraft('s1', {
      ...imageDraft(),
      attachments: [{ ...imageDraft().attachments[0], preview: 'blob:http://localhost/abc' }],
    })
    const raw = localStorage.getItem(draftsKey()!)!
    expect(raw).not.toContain('base64')
    expect(raw).not.toContain('iVBORw0KGgo')
    expect(raw).not.toContain('blob:')
    // 元数据都在
    const stored = JSON.parse(raw) as { drafts: Record<string, { attachments: Array<Record<string, unknown>> }> }
    const meta = stored.drafts.s1.attachments[0]
    expect(meta).toMatchObject({ path: 'uploads/a.png', name: 'a.png', size: 68, status: 'done', image: true })
    expect(meta.preview).toBeUndefined()
  })

  it('框选截图的 PNG data URL 不落盘（只留页面与元素信息）', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    s.rememberLiveDraft('s1', {
      text: '',
      refs: [],
      attachments: [
        {
          path: 'captures/c1.png',
          name: '截图',
          size: 1024,
          status: 'done',
          capture: {
            id: 'cap-1',
            mode: 'element',
            image: 'data:image/png;base64,AAAAAAAA',
            width: 10,
            height: 10,
            url: 'https://example.com/a',
            title: 'A',
            element: { tag: 'button', selector: '#go', text: 'Go' },
          },
        },
      ],
    })
    const raw = localStorage.getItem(draftsKey()!)!
    expect(raw).not.toContain('data:image/png')
    expect(raw).toContain('https://example.com/a')
    expect(raw).toContain('#go')
  })

  it('切会话：各自的那一份都在，落盘也分开', async () => {
    const s = await setup()
    s.rememberLiveDraft('s1', { text: '给 s1 的话', attachments: [], refs: [] })
    s.stashDraft('s1', { text: '给 s1 的话', attachments: [], refs: [] })
    s.rememberLiveDraft('s2', { text: '给 s2 的话', attachments: [], refs: [] })
    const reloaded = await reloadStore()
    expect(reloaded.drafts.s1?.text).toBe('给 s1 的话')
    expect(reloaded.drafts.s2?.text).toBe('给 s2 的话')
  })

  it('切账号：各自的草稿互不串，切回来还在', async () => {
    const s = await setup()
    s.rememberLiveDraft('s1', { text: 'u1 的草稿', attachments: [], refs: [] })

    account('u2')
    const second = await reloadStore()
    second.hydrateDrafts()
    expect(second.drafts.s1).toBeUndefined()

    account('u1')
    const back = await reloadStore()
    back.hydrateDrafts()
    expect(back.drafts.s1?.text).toBe('u1 的草稿')
  })

  it('上传到一半就关窗的附件：恢复时标成失败（可移除的文件 chip），不阻塞发送', async () => {
    const s = await setup()
    s.rememberLiveDraft('s1', {
      text: '带附件的话',
      refs: [],
      attachments: [{ path: 'uploads/half.pdf', name: 'half.pdf', size: 12, status: 'uploading' }],
    })
    const reloaded = await reloadStore()
    const attachment = reloaded.drafts.s1!.attachments[0]
    expect(attachment.status).toBe('error')
    expect(attachment.error).toContain('重新添加')
    expect(attachment.name).toBe('half.pdf')
    // 文字仍在，用户可以只是移除那个 chip 然后照常发送
    expect(reloaded.drafts.s1!.text).toBe('带附件的话')
  })

  it('发送成功：这份草稿从本机存储里清掉', async () => {
    const s = await setup()
    s.currentSessionId = 's1'
    s.rememberLiveDraft('s1', { text: '马上要发的内容', attachments: [], refs: [] })
    expect(JSON.parse(localStorage.getItem(draftsKey()!)!).drafts.s1).toBeTruthy()

    s.clearLiveDraft()
    expect(s.liveDraft).toBeNull()
    const stored = JSON.parse(localStorage.getItem(draftsKey()!)!) as { drafts: Record<string, unknown> }
    expect(stored.drafts.s1).toBeUndefined()
  })

  it('删除会话：它的草稿一起删掉（内存与落盘）', async () => {
    const s = await setup()
    s.rememberLiveDraft('s1', { text: 's1 的草稿', attachments: [], refs: [] })
    s.stashDraft('s2', { text: 's2 的草稿', attachments: [], refs: [] })
    await s.removeSession('s2')
    expect(s.drafts.s2).toBeUndefined()
    const stored = JSON.parse(localStorage.getItem(draftsKey()!)!) as { drafts: Record<string, unknown> }
    expect(stored.drafts.s2).toBeUndefined()
    expect(stored.drafts.s1).toBeTruthy()
  })

  it('退出登录：这个账号留在这台电脑上的草稿被删掉', async () => {
    const s = await setup()
    s.rememberLiveDraft('s1', { text: '共享电脑上的私密草稿', attachments: [], refs: [] })
    const key = draftsKey()!
    expect(localStorage.getItem(key)).toBeTruthy()

    s.purgeDrafts()
    expect(s.liveDraft).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('超过 1 MB 上限：先丢最久没动过的草稿，最新的那份保住', async () => {
    const s = await setup()
    const big = (mark: string): string => `${mark}${'x'.repeat(200_000)}`
    // 6 份 200KB 的草稿 → 总量超过 1 MB
    for (let i = 0; i < 6; i += 1) {
      s.draftAt[`s${i}`] = 1_000 + i
      s.drafts[`s${i}`] = { text: big(`草稿${i}`), attachments: [], refs: [] }
    }
    s.rememberLiveDraft('s9', { text: big('最新的'), attachments: [], refs: [] })

    const raw = localStorage.getItem(draftsKey()!)!
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1024 * 1024)
    const stored = JSON.parse(raw) as { drafts: Record<string, { text: string }> }
    // 最新的在
    expect(stored.drafts.s9?.text.startsWith('最新的')).toBe(true)
    // 最老的被丢掉，不是全部保住（总量超了）
    expect(Object.keys(stored.drafts).length).toBeLessThan(7)
    expect(stored.drafts.s0).toBeUndefined()
  })

  it('本机存储写不进去（隐私模式 / 配额满）：降级为内存并只提示一次', async () => {
    const s = await setup()
    const ui = await import('./ui')
    const info = vi.spyOn(ui.toast, 'info')
    // 换成一个“写不进去”的 Storage：比 spyOn(localStorage) 更稳，
    // 不依赖 localStorage 是实现细节（jsdom / Node 26 的 --localstorage-file 两种口径都成立）
    const throwing = {
      get length() {
        return 0
      },
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    } as unknown as Storage
    const original = globalThis.localStorage
    vi.stubGlobal('localStorage', throwing)
    try {
      s.rememberLiveDraft('s1', { text: '隐私模式里的草稿', attachments: [], refs: [] })
      s.rememberLiveDraft('s1', { text: '隐私模式里的草稿（再改一次）', attachments: [], refs: [] })
      expect(info).toHaveBeenCalledTimes(1)
      expect(s.draftsMemoryOnly).toBe(true)
      // 内存里还在
      expect(s.liveDraftFor('s1')?.text).toBe('隐私模式里的草稿（再改一次）')
    } finally {
      vi.stubGlobal('localStorage', original)
      vi.unstubAllGlobals()
    }
  })

  it('本机存的是坏数据：不影响打开应用，当空处理', async () => {
    localStorage.setItem(scopedKey(DRAFTS_BASE_KEY, 'deadbeef'), '{"v":1,"drafts":')
    const reloaded = await reloadStore()
    expect(reloaded.drafts).toEqual({})
  })

  it('旧版本（v 不匹配）的落盘数据直接忽略，不做错误迁移', async () => {
    localStorage.setItem(scopedKey(DRAFTS_BASE_KEY, 'deadbeef'), JSON.stringify({ v: 0, drafts: { s1: { text: '旧' } } }))
    const reloaded = await reloadStore()
    expect(reloaded.drafts).toEqual({})
  })
})

