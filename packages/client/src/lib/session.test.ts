import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, withDirectives } from 'vue'
import { ALL_PERMISSIONS, type Me, type Permission, type Role } from '../api'
import PermNote from '../components/ui/PermNote.vue'
import { vPerm } from './perm-directive'
import { transport } from '../api/http'
import {
  auth,
  can,
  canEditOwned,
  clearSession,
  hasPermission,
  initAuth,
  readLocalSession,
  readStoredSession,
  saveLocalSession,
  saveSession,
  signOut,
  validateServerUrl,
} from './session'

const ROLE_PERMS: Record<Role, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  admin: ALL_PERMISSIONS.filter((p) => p !== 'security:manage'),
  member: ['data:read', 'data:write', 'catalog:write', 'email:send'],
  viewer: ['data:read'],
}
function login(role: Role, id = `u-${role}`): void {
  auth.mode = 'server'
  auth.me = {
    mode: 'server',
    user: { id, email: `${role}@x.example.com`, name: role, role, disabled: false, createdAt: 0, lastLoginAt: null },
    org: { id: 'o', name: 'Org', createdAt: 0 },
    teams: [],
    permissions: ROLE_PERMS[role],
    session: { expiresAt: 0 },
  } as Me
}

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
})

describe('角色与权限', () => {
  it('desktop 模式没有登录信息时拥有全部权限；server 模式未登录没有权限', () => {
    expect(hasPermission(null, 'data:write', 'desktop')).toBe(true)
    expect(hasPermission(null, 'data:write', 'server')).toBe(false)
  })
  it('viewer 只读，member 只能改自己的，admin 全部', () => {
    login('viewer')
    expect(can('data:read')).toBe(true)
    expect(can('data:write')).toBe(false)
    expect(can('email:send')).toBe(false)
    expect(canEditOwned('u-viewer')).toBe(false)
    login('member')
    expect(canEditOwned('u-member')).toBe(true)
    expect(canEditOwned('someone-else')).toBe(false)
    expect(can('members:manage')).toBe(false)
    login('admin')
    expect(canEditOwned('someone-else')).toBe(true)
    expect(can('security:manage')).toBe(false)
  })
  it('v-perm 禁用无权限按钮并给出原因；v-perm:hide 隐藏', () => {
    login('viewer')
    const Comp = defineComponent({
      render: () =>
        h('div', [
          withDirectives(h('button', { id: 'w' }, '新建'), [[vPerm, 'data:write']]),
          withDirectives(h('button', { id: 'r' }, '查看'), [[vPerm, 'data:read']]),
          withDirectives(h('a', { id: 'l' }, '导入'), [[vPerm, 'data:write', 'hide']]),
        ]),
    })
    const w = mount(Comp)
    const write = w.get('#w').element as HTMLButtonElement
    expect(write.disabled).toBe(true)
    expect(write.title).toContain('只读')
    expect((w.get('#r').element as HTMLButtonElement).disabled).toBe(false)
    expect((w.get('#l').element as HTMLElement).style.display).toBe('none')
  })
  it('PermNote 只在缺少权限时显示', () => {
    login('member')
    expect(
      mount(PermNote, { props: { perm: 'data:write' } })
        .find('[data-testid=perm-note]')
        .exists(),
    ).toBe(false)
    expect(mount(PermNote, { props: { perm: 'providers:write' } }).text()).toContain('管理模型密钥')
  })
  it('读取 localStorage 会话：丢弃旧版假登录值', () => {
    localStorage.setItem('lulux.session', '1')
    expect(readStoredSession()).toBeNull()
    expect(localStorage.getItem('lulux.session')).toBeNull()
    localStorage.setItem('lulux.session', JSON.stringify({ token: 'lxs_abc', user: null, baseUrl: '' }))
    expect(readStoredSession()?.token).toBe('lxs_abc')
  })
  it('不记住时会话只进 sessionStorage，读取时回退到它；记住时进 localStorage 并清掉 sessionStorage', async () => {
    localStorage.clear()
    sessionStorage.clear()
    // initAuth(true) 会去请求服务端：这里只关心存储位置，请求失败无所谓
    const result = { token: 'lxs_tmp', user: null, expiresAt: 0 } as never
    await saveSession(result, { persist: false }).catch(() => undefined)
    expect(localStorage.getItem('lulux.session')).toBeNull()
    expect(JSON.parse(sessionStorage.getItem('lulux.session') || '{}').token).toBe('lxs_tmp')
    expect(readStoredSession()?.token).toBe('lxs_tmp')
    await saveSession({ token: 'lxs_keep', user: null, expiresAt: 0 } as never).catch(() => undefined)
    expect(sessionStorage.getItem('lulux.session')).toBeNull()
    expect(readStoredSession()?.token).toBe('lxs_keep')
    localStorage.clear()
  })
})

describe('本机账户会话', () => {
  const routes = (status: { hasAccount: boolean; signedIn: boolean; username: string | null }) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/auth/mode')
        return json({ mode: 'desktop', setupRequired: false, version: 't', publicOrigin: null })
      if (url === '/api/auth/local/status') return json(status)
      if (url === '/api/auth/local/logout') return new Response(null, { status: 204 })
      if (url === '/api/auth/me') {
        const signed = (init?.headers as Record<string, string>)['X-Lulux-Session']
        if (!signed) return json({ error: { code: 'LOCAL_LOGIN_REQUIRED', message: 'x' } }, 401)
        return json({
          mode: 'desktop',
          user: {
            id: 'local',
            email: '',
            name: status.username,
            role: 'owner',
            disabled: false,
            createdAt: 0,
            lastLoginAt: null,
          },
          org: { id: 'local', name: '本机', createdAt: 0 },
          teams: [],
          permissions: [...ALL_PERMISSIONS],
          session: null,
        })
      }
      return json({ error: { code: 'NOT_FOUND', message: url } }, 404)
    })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    sessionStorage.clear()
    transport.localSession = null
    auth.local = { hasAccount: false, username: '' }
  })

  it('没有本机账户（全新安装 / 早期测试版的数据）：me 为空，路由会转到登录页的“创建本机账户”', async () => {
    localStorage.setItem('lulux.localSession', JSON.stringify({ token: 'lls_old', username: 'k' }))
    vi.stubGlobal('fetch', routes({ hasAccount: false, signedIn: false, username: null }))
    await initAuth(true)
    expect(auth.local.hasAccount).toBe(false)
    expect(auth.me).toBeNull()
    expect(readLocalSession()).toBeNull()
  })

  it('旧本机服务没有本机账户接口（404）：照旧进入（本机用户）', async () => {
    const base = routes({ hasAccount: false, signedIn: false, username: null })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/local/status')
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      if (url === '/api/auth/me')
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      return base(url, init)
    })
    await initAuth(true)
    expect(auth.me?.user.id).toBe('local')
  })

  it('有账户但没有会话：me 为空（路由会转到登录页），残留的本机会话被清掉', async () => {
    localStorage.setItem('lulux.localSession', JSON.stringify({ token: 'lls_stale', username: 'k' }))
    vi.stubGlobal('fetch', routes({ hasAccount: true, signedIn: false, username: null }))
    await initAuth(true)
    expect(auth.local.hasAccount).toBe(true)
    expect(auth.me).toBeNull()
    expect(readLocalSession()).toBeNull()
    expect(transport.localSession).toBeNull()
  })

  it('保存会话：记住 → localStorage，否则 sessionStorage；带上 X-Lulux-Session 后登录态恢复', async () => {
    const fetchFn = routes({ hasAccount: true, signedIn: true, username: 'Koko' })
    vi.stubGlobal('fetch', fetchFn)
    const result = {
      token: 'lls_tmp',
      expiresAt: 1,
      persistent: false,
      account: { id: 'a', username: 'Koko', createdAt: 0, lastLoginAt: 0 },
    }
    await saveLocalSession(result, { persist: false })
    expect(localStorage.getItem('lulux.localSession')).toBeNull()
    expect(readLocalSession()).toEqual({ token: 'lls_tmp', username: 'Koko' })
    expect(auth.me?.user.name).toBe('Koko')
    expect(auth.local).toEqual({ hasAccount: true, username: 'Koko' })
    await saveLocalSession({ ...result, token: 'lls_keep' })
    expect(sessionStorage.getItem('lulux.localSession')).toBeNull()
    expect(readLocalSession()?.token).toBe('lls_keep')

    await signOut()
    expect(fetchFn.mock.calls.some(([url]) => url === '/api/auth/local/logout')).toBe(true)
    expect(readLocalSession()).toBeNull()
    expect(auth.me).toBeNull()
  })

  it('会话失效（clearSession）时清掉本机会话', async () => {
    auth.mode = 'desktop'
    auth.local = { hasAccount: true, username: 'Koko' }
    localStorage.setItem('lulux.localSession', JSON.stringify({ token: 'lls_x', username: 'Koko' }))
    transport.localSession = 'lls_x'
    await clearSession()
    expect(readLocalSession()).toBeNull()
    expect(transport.localSession).toBeNull()
    expect(auth.me).toBeNull()
  })
})

describe('桌面端“记住这台机器”：会话由主进程保管，重启（页面 origin 变化）后仍在', () => {
  /** 模拟主进程 AuthStore：内存 + “磁盘”（只有 persist 时写） */
  function fakeDesktop() {
    const state = {
      memory: null as { token: string; username: string } | null,
      disk: null as { token: string; username: string } | null,
      remote: { memory: null as unknown, disk: null as unknown },
      prefs: {} as unknown,
    }
    const api = {
      mode: 'local' as const,
      baseUrl: '',
      getSession: vi.fn(async () => ({ mode: 'local' as const, baseUrl: '', token: 'api-token', user: null })),
      setSession: vi.fn(async () => undefined),
      getConnection: vi.fn(),
      connectRemote: vi.fn(),
      useLocal: vi.fn(),
      getLocalSession: vi.fn(async (): Promise<{ token: string; username: string } | { locked: true } | null> => state.memory ?? state.disk),
      setLocalSession: vi.fn(
        async (session: { token: string; username: string } | null, options?: { persist?: boolean; forget?: boolean }) => {
          state.memory = session
          // 与主进程一致：session=null 时只有 forget 才删磁盘
          if (session || options?.forget) state.disk = session && options?.persist ? session : null
          return { persisted: Boolean(session && options?.persist) }
        },
      ),
      getLoginPrefs: vi.fn(async () => state.prefs),
      setLoginPrefs: vi.fn(async (prefs: unknown) => {
        state.prefs = prefs
        return prefs
      }),
    }
    ;(window as { luluxAgent?: unknown }).luluxAgent = { api, platform: 'win32', versions: {} }
    /** 退出再打开：主进程内存清空；本地端口换了 → 页面存储整个是新的 */
    const restart = () => {
      state.memory = null
      localStorage.clear()
      sessionStorage.clear()
      transport.localSession = null
    }
    return { state, api, restart }
  }

  /** 服务端：有账户；X-Lulux-Session 是有效会话时 signedIn */
  const valid = new Set<string>()
  const server = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } })
    const token = (init?.headers as Record<string, string> | undefined)?.['X-Lulux-Session']
    const signed = Boolean(token && valid.has(token))
    if (url === '/api/auth/mode') return json({ mode: 'desktop', setupRequired: false, version: 't', publicOrigin: null })
    if (url === '/api/auth/local/status') return json({ hasAccount: true, signedIn: signed, username: signed ? 'Koko' : null })
    if (url === '/api/auth/local/logout') {
      if (token) valid.delete(token)
      return new Response(null, { status: 204 })
    }
    if (url === '/api/auth/me') {
      if (!signed) return json({ error: { code: 'LOCAL_LOGIN_REQUIRED', message: 'x' } }, 401)
      return json({
        mode: 'desktop',
        user: { id: 'local', email: '', name: 'Koko', role: 'owner', disabled: false, createdAt: 0, lastLoginAt: null },
        org: { id: 'local', name: '本机', createdAt: 0 },
        teams: [],
        permissions: [...ALL_PERMISSIONS],
        session: null,
      })
    }
    return json({ error: { code: 'NOT_FOUND', message: url } }, 404)
  })
  const result = (token: string) => ({
    token,
    expiresAt: 1,
    persistent: true,
    account: { id: 'a', username: 'Koko', createdAt: 0, lastLoginAt: 0 },
  })

  afterEach(() => {
    delete (window as { luluxAgent?: unknown }).luluxAgent
    vi.unstubAllGlobals()
    localStorage.clear()
    sessionStorage.clear()
    transport.localSession = null
    valid.clear()
    auth.local = { hasAccount: false, username: '' }
    auth.connection = 'local'
  })

  it('勾选：会话交给主进程加密落盘，不写页面存储；重启后直接登录', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', server)
    valid.add('lls_keep')
    await saveLocalSession(result('lls_keep'), { persist: true })
    expect(desk.api.setLocalSession).toHaveBeenLastCalledWith({ token: 'lls_keep', username: 'Koko' }, { persist: true })
    expect(localStorage.getItem('lulux.localSession')).toBeNull()
    expect(auth.me?.user.name).toBe('Koko')

    desk.restart()
    auth.me = null
    await initAuth(true)
    expect(transport.localSession).toBe('lls_keep')
    expect((auth.me as Me | null)?.user.name).toBe('Koko')
  })

  it('不勾：只在主进程内存，本次运行内重载仍在，重启后回到登录页', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', server)
    valid.add('lls_tmp')
    await saveLocalSession(result('lls_tmp'), { persist: false })
    expect(desk.state.disk).toBeNull()
    expect(sessionStorage.getItem('lulux.localSession')).toBeNull()
    // 窗口重载（同一次运行）
    sessionStorage.clear()
    transport.localSession = null
    await initAuth(true)
    expect(auth.me?.user.name).toBe('Koko')
    // 退出再打开
    desk.restart()
    auth.me = null
    await initAuth(true)
    expect(auth.me).toBeNull()
    expect(auth.local.hasAccount).toBe(true)
  })

  it('记住的会话已过期：清掉主进程里的会话，回到登录页', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', server)
    desk.state.disk = { token: 'lls_expired', username: 'Koko' }
    await initAuth(true)
    expect(auth.me).toBeNull()
    expect(desk.api.setLocalSession).toHaveBeenCalledWith(null, { forget: true })
    expect(desk.state.disk).toBeNull()
  })

  it('系统钥匙串暂时解不开（locked）：停在登录页并提示，但绝不让主进程清除记住的会话', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', server)
    valid.add('lls_keep')
    desk.state.disk = { token: 'lls_keep', username: 'Koko' }
    desk.api.getLocalSession.mockImplementationOnce(async () => ({ locked: true }) as never)
    await initAuth(true)
    expect(auth.me).toBeNull()
    expect(auth.localSessionLocked).toBe(true)
    expect(desk.api.setLocalSession).not.toHaveBeenCalledWith(null, { forget: true })
    expect(desk.state.disk).toEqual({ token: 'lls_keep', username: 'Koko' })
    // 下次启动钥匙串恢复：直接登录
    desk.restart()
    await initAuth(true)
    expect(auth.localSessionLocked).toBe(false)
    expect((auth.me as Me | null)?.user.name).toBe('Koko')
  })

  it('主动登出：清掉记住的会话（用户名偏好保留，由登录页预填）', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', server)
    valid.add('lls_keep')
    desk.state.prefs = { tab: 'local', local: { username: 'Koko', remember: true } }
    await saveLocalSession(result('lls_keep'), { persist: true })
    auth.connection = 'local'
    await signOut()
    expect(desk.state.disk).toBeNull()
    expect(desk.state.memory).toBeNull()
    expect(desk.state.prefs).toEqual({ tab: 'local', local: { username: 'Koko', remember: true } })
    desk.restart()
    await initAuth(true)
    expect(auth.me).toBeNull()
  })

  it('系统没有安全存储（persisted=false）：勾选时退回 localStorage', async () => {
    const desk = fakeDesktop()
    desk.api.setLocalSession.mockImplementation(async () => ({ persisted: false }))
    vi.stubGlobal('fetch', server)
    valid.add('lls_fallback')
    await saveLocalSession(result('lls_fallback'), { persist: true })
    expect(JSON.parse(localStorage.getItem('lulux.localSession')!).token).toBe('lls_fallback')
  })

  it('云端（远程）会话：把“记住这台服务器”的勾选交给主进程', async () => {
    const desk = fakeDesktop()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await saveSession({ token: 'lxs_a', user: null, expiresAt: 0 } as never, { persist: false }).catch(() => undefined)
    expect(desk.api.setSession).toHaveBeenLastCalledWith({ token: 'lxs_a', user: null }, { persist: false })
    await saveSession({ token: 'lxs_b', user: null, expiresAt: 0 } as never, { persist: true }).catch(() => undefined)
    expect(desk.api.setSession).toHaveBeenLastCalledWith({ token: 'lxs_b', user: null }, { persist: true })
  })
})

describe('团队服务器地址校验', () => {
  it('https 通过并去掉结尾斜杠；http 只允许本机回环地址', () => {
    expect(validateServerUrl(' https://eta.example.com/ ')).toEqual({ url: 'https://eta.example.com' })
    expect(validateServerUrl('http://localhost:53891').url).toBe('http://localhost:53891')
    expect(validateServerUrl('http://127.0.0.1:8080').url).toBe('http://127.0.0.1:8080')
    expect(validateServerUrl('http://eta.example.com').error).toContain('https')
    expect(validateServerUrl('http://192.168.1.10:51789').error).toContain('https')
  })
  it('不是完整的源（缺协议、带路径、带账号）时报格式错误', () => {
    for (const bad of [
      'eta.example.com',
      'https://eta.example.com/app',
      'https://u:p@eta.example.com',
      'ftp://x.com',
      '',
    ])
      expect(validateServerUrl(bad).error).toContain('完整的服务器地址')
  })
})
