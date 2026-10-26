/**
 * 回归：退出登录 / 会话失效 / 换账号时清空上一个账号的数据；对话流 401 回登录页；
 * 启动时本机账户状态接口偶发失败要重试，且不把失败结果缓存下来。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { onPasswordChangeRequired, onUnauthorized } from '../api/http'
import { t } from '../i18n'
import { auth, clearSession, initAuth, signOut } from './session'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  sessionStorage.clear()
  delete (window as { luluxAgent?: unknown }).luluxAgent
  auth.mode = 'desktop'
  auth.connection = 'local'
  auth.me = null
  auth.error = ''
  auth.local = { hasAccount: false, username: '' }
  api.setTransport({ baseUrl: '', sessionToken: null, localSession: null })
})

const me = (id: string): api.Me =>
  ({
    mode: 'desktop',
    user: { id, email: '', name: id, role: 'owner', disabled: false, createdAt: 0, lastLoginAt: null },
    org: { id: 'o', name: 'o', createdAt: 0 },
    teams: [],
    permissions: [...api.ALL_PERMISSIONS],
    session: null,
  }) as api.Me

async function storeWithData() {
  setActivePinia(createPinia())
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.ready = true
  store.sessions = [{ id: 'a-secret', title: 'A 的客户谈判', agentIds: ['builtin'] } as never]
  store.currentSessionId = 'a-secret'
  store.messages = [{ id: 'm', content: 'A 的报价底线' } as never]
  store.drafts = { other: { text: 'A 没发出的草稿', attachments: [], refs: [] } }
  store.settings = { defaultAgentId: 'builtin' }
  return store
}

describe('换账号清空数据', () => {
  it('退出登录：store 回到初始状态（下一个账号重新 bootstrap），后台流断开、轮询停止', async () => {
    vi.useFakeTimers()
    const store = await storeWithData()
    let signal: AbortSignal | undefined
    vi.spyOn(api, 'streamChatRequest').mockImplementation(
      (_req, handlers, s) =>
        new Promise<void>((resolve) => {
          signal = s
          handlers.onStart?.({} as never)
          s?.addEventListener('abort', () => resolve())
        }),
    )
    vi.spyOn(api, 'getSession').mockResolvedValue({
      session: { id: 'a-secret', running: false },
      messages: [],
    } as never)
    vi.spyOn(api, 'listSessions').mockResolvedValue([{ id: 'a-secret', title: 'A 的客户谈判' }] as never)
    const pending = vi.spyOn(api, 'getChatPending').mockResolvedValue({ running: true, requests: [] } as never)
    void store.send('A 的问题')
    store.startPolling('a-other')
    auth.mode = 'server'
    auth.connection = 'remote'
    vi.spyOn(api, 'logout').mockResolvedValue(undefined as never)
    await signOut()
    expect(signal?.aborted).toBe(true)
    expect(store.ready).toBe(false)
    expect(store.sessions).toEqual([])
    expect(store.currentSessionId).toBeNull()
    expect(store.messages).toEqual([])
    expect(store.drafts).toEqual({})
    expect(store.settings).toEqual({})
    expect(store.accountEpoch).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(pending).not.toHaveBeenCalled()
    // 流收尾里迟到的列表请求也不会把上一个账号的会话写回来
    expect(store.sessions).toEqual([])
  })

  it('会话失效（401 → clearSession）同样清空', async () => {
    const store = await storeWithData()
    auth.mode = 'server'
    await clearSession()
    expect(store.ready).toBe(false)
    expect(store.sessions).toEqual([])
    expect(store.messages).toEqual([])
  })

  it('同一窗口换成另一个账号登录（用户 id 变了）：清空上一个账号的数据', async () => {
    vi.spyOn(api, 'getAuthMode').mockResolvedValue({ mode: 'desktop', setupRequired: false, version: '1' } as never)
    vi.spyOn(api, 'getLocalAuthStatus').mockResolvedValue({ hasAccount: true, signedIn: true, username: 'a' } as never)
    const getMe = vi.spyOn(api, 'getMe').mockResolvedValue(me('user-a'))
    await initAuth(true)
    const store = await storeWithData()
    await initAuth(true)
    expect(store.sessions).toHaveLength(1)
    getMe.mockResolvedValue(me('user-b'))
    await initAuth(true)
    expect(auth.me?.user.id).toBe('user-b')
    expect(store.sessions).toEqual([])
    expect(store.ready).toBe(false)
  })
})

describe('对话流的登录失效', () => {
  const res = (status: number, code: string) => () =>
    new Response(JSON.stringify({ error: { code, message: code } }), { status })
  const handlers = { onDelta: () => {}, onDone: () => {}, onError: () => {} }

  it('对话流 / 续接流返回 401 SESSION_EXPIRED：和普通请求一样触发回登录页', async () => {
    api.setTransport({ baseUrl: '', sessionToken: 'tok', localSession: null })
    const hits: string[] = []
    const off = onUnauthorized((e) => hits.push(e.code))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(401, 'SESSION_EXPIRED')()),
    )
    await expect(
      api.streamChatRequest({ kind: 'send', sessionId: 's1', content: 'hi' }, handlers),
    ).rejects.toMatchObject({
      status: 401,
    })
    expect(hits).toEqual(['SESSION_EXPIRED'])
    await expect(api.attachRunStream('s1', 3, handlers)).rejects.toMatchObject({ status: 401 })
    expect(hits).toEqual(['SESSION_EXPIRED', 'SESSION_EXPIRED'])
    off()
  })

  it('对话流返回 403 PASSWORD_CHANGE_REQUIRED：跳改密页', async () => {
    api.setTransport({ baseUrl: '', sessionToken: 'tok', localSession: null })
    const hits: string[] = []
    const off = onPasswordChangeRequired((e) => hits.push(e.code))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(403, 'PASSWORD_CHANGE_REQUIRED')()),
    )
    await expect(api.streamChatRequest({ kind: 'send', sessionId: 's1', content: 'hi' }, handlers)).rejects.toBeTruthy()
    expect(hits).toEqual(['PASSWORD_CHANGE_REQUIRED'])
    off()
  })
})

describe('启动时本机账户状态接口偶发失败', () => {
  function desktopBridge(): void {
    window.luluxAgent = {
      api: {
        getSession: async () => ({ mode: 'local', baseUrl: '', token: null }),
        getLocalSession: async () => ({ token: 'lls_' + 'a'.repeat(64), username: 'koko' }),
        setLocalSession: async () => ({ persisted: true }),
        getLoginPrefs: async () => ({ local: { username: 'koko', remember: true }, tab: 'local' }),
        setLoginPrefs: async () => ({}),
      },
    } as never
    vi.spyOn(api, 'getAuthMode').mockResolvedValue({ mode: 'desktop', setupRequired: false, version: '1' } as never)
  }

  it('重试几次；仍失败时不当成“没有账户”，提示连不上，且下一次 initAuth 重新检查', async () => {
    desktopBridge()
    const status = vi.spyOn(api, 'getLocalAuthStatus').mockRejectedValue(new api.ApiError('HTTP_500', 'boom', 500))
    vi.spyOn(api, 'getMe').mockRejectedValue(new api.ApiError('NETWORK', 'net', 0))
    await initAuth(true)
    expect(status.mock.calls.length).toBeGreaterThan(1)
    expect(auth.local.hasAccount).toBe(true)
    expect(auth.error).toBe(t('session.localStatusFailed'))
    expect(auth.me).toBeNull()
    // 服务恢复：路由守卫的下一次 initAuth() 会重新检查，用上记住的会话
    status.mockResolvedValue({ hasAccount: true, signedIn: true, username: 'koko' } as never)
    vi.mocked(api.getMe).mockResolvedValue(me('local'))
    const before = status.mock.calls.length
    await initAuth()
    expect(status.mock.calls.length).toBe(before + 1)
    expect(auth.error).toBe('')
    expect(auth.me?.user.id).toBe('local')
  })

  it('偶发失败后一次就恢复：不报错，正常登录', async () => {
    desktopBridge()
    vi.spyOn(api, 'getLocalAuthStatus')
      .mockRejectedValueOnce(new api.ApiError('NETWORK', 'net', 0))
      .mockResolvedValue({ hasAccount: true, signedIn: true, username: 'koko' } as never)
    vi.spyOn(api, 'getMe').mockResolvedValue(me('local'))
    await initAuth(true)
    expect(auth.error).toBe('')
    expect(auth.local).toEqual({ hasAccount: true, username: 'koko' })
    expect(auth.me?.user.id).toBe('local')
  })

  it('真的没有账户（接口正常返回）：照常进入创建本机账户', async () => {
    desktopBridge()
    vi.spyOn(api, 'getLocalAuthStatus').mockResolvedValue({
      hasAccount: false,
      signedIn: false,
      username: null,
    } as never)
    await initAuth(true)
    expect(auth.local.hasAccount).toBe(false)
    expect(auth.error).toBe('')
  })
})
