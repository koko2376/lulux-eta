import { computed, reactive } from 'vue'
import * as api from '../api'
import { OVERRIDABLE_PERMISSIONS, roleDefault, type DeletePermission } from './fine-permissions'
import type { Me, Permission, Role, User } from '../api'
import { localized, t } from '../i18n'
import { loadLoginPrefs } from './login-prefs'

/**
 * 登录态与运行模式（契约 §5.1、§5.4、§5.10）。
 *
 * - desktop 模式：本机用户 owner，全部权限；每次启动先到登录页（本机账户，没有就先创建），
 *   只有勾了“记住这台机器”的会话才会跳过登录页。桌面端的本机会话由主进程保管
 *   （`window.luluxAgent.api.getLocalSession / setLocalSession`，勾选时 safeStorage 落盘）：
 *   本地服务端口变化会让页面 origin 变化、localStorage 整个换成空的，不能只靠它。
 * - server 模式：需要会话 token。浏览器存在 localStorage `lulux.session`；
 *   桌面端远程模式交给主进程 `window.luluxAgent.api`（safeStorage）。
 * - 浏览器里也可以手动填团队服务器地址（`lulux.server`），用于开发与“非同源部署”。
 */

const SESSION_KEY = 'lulux.session'
const SERVER_KEY = 'lulux.server'
const RECENT_KEY = 'lulux.recentServers'
/** 本机账户会话：勾“记住这台机器”存 localStorage，否则 sessionStorage（关掉窗口即失效） */
const LOCAL_SESSION_KEY = 'lulux.localSession'

interface StoredLocalSession {
  token: string
  username: string
}

export interface StoredSession {
  token: string
  user: User | null
  baseUrl: string
}

export const auth = reactive({
  ready: false,
  /** 服务端运行模式 */
  mode: 'desktop' as 'desktop' | 'server',
  /** 客户端连接方式：本机服务 / 远程团队服务器 */
  connection: 'local' as 'local' | 'remote',
  serverUrl: '',
  setupRequired: false,
  version: '',
  me: null as Me | null,
  /** 连接服务端失败的提示（不阻塞桌面模式） */
  error: '',
  /** 本机账户（desktop 模式）：这台电脑是否已创建本机账户、当前登录的用户名 */
  local: { hasAccount: false, username: '' },
  /** 记住的本机会话还在，但系统安全存储暂时解不开：登录页提示可以重新登录，记住的会话不清除 */
  localSessionLocked: false,
})

const desktopApi = (): LuluxDesktopApi | null =>
  typeof window !== 'undefined' ? (window.luluxAgent?.api ?? null) : null

/** 桌面壳能保管本机会话（新版 preload）；旧版没有时退回 localStorage / sessionStorage */
const localSessionBridge = (): LuluxDesktopApi | null => {
  const bridge = desktopApi()
  return bridge?.getLocalSession && bridge.setLocalSession ? bridge : null
}

/**
 * 读本机账户会话：桌面端先问主进程（重启后仍在），没有再看页面存储（旧版写的）。
 * locked=true：主进程那边有记住的会话，但系统安全存储暂时解不开。
 */
export async function loadLocalSession(): Promise<{ session: StoredLocalSession | null; locked: boolean }> {
  const bridge = localSessionBridge()
  let locked = false
  if (bridge) {
    try {
      const stored = (await bridge.getLocalSession!()) as Record<string, unknown> | null
      if (stored && stored.locked === true) locked = true
      else if (stored && typeof stored.token === 'string' && stored.token) {
        return {
          session: { token: stored.token, username: typeof stored.username === 'string' ? stored.username : '' },
          locked: false,
        }
      }
    } catch {
      // 主进程不可用：看页面存储
    }
  }
  return { session: readLocalSession(), locked }
}

/**
 * 读会话：先 localStorage（“记住这台服务器”），再 sessionStorage（不记住：关掉浏览器即失效）。
 * 传入 storage 时只读这一个（测试用）。
 */
export function readStoredSession(storage?: Storage): StoredSession | null {
  if (storage) return readFrom(storage)
  return readFrom(globalThis.localStorage) ?? readFrom(globalThis.sessionStorage)
}

function readFrom(storage: Storage | undefined): StoredSession | null {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string' || !parsed.token) {
      storage?.removeItem(SESSION_KEY)
      return null
    }
    return { token: parsed.token, user: parsed.user ?? null, baseUrl: parsed.baseUrl ?? '' }
  } catch {
    // 旧版假登录写的是 '1'：丢弃
    storage?.removeItem(SESSION_KEY)
    return null
  }
}

function browserServerUrl(): string {
  try {
    return (localStorage.getItem(SERVER_KEY) || '').replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function recentServers(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 5) : []
  } catch {
    return []
  }
}

export function readLocalSession(): StoredLocalSession | null {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      const raw = storage?.getItem(LOCAL_SESSION_KEY)
      if (!raw) continue
      const parsed = JSON.parse(raw) as Partial<StoredLocalSession>
      if (parsed && typeof parsed.token === 'string' && parsed.token) {
        return { token: parsed.token, username: typeof parsed.username === 'string' ? parsed.username : '' }
      }
      storage.removeItem(LOCAL_SESSION_KEY)
    } catch {
      storage?.removeItem(LOCAL_SESSION_KEY)
    }
  }
  return null
}

/**
 * 清掉本机会话。forget=true（主动退出登录、或带着会话去校验被服务端判定失效）才让主进程删除记住的会话；
 * 启动时根本没拿到会话（例如安全存储暂时解不开）不能删，否则安全存储恢复后会话也回不来了。
 */
function dropLocalSession(options: { forget: boolean }): void {
  api.setTransport({ localSession: null })
  const bridge = localSessionBridge()
  if (bridge) {
    const pending = options.forget ? bridge.setLocalSession!(null, { forget: true }) : bridge.setLocalSession!(null)
    void pending.catch(() => undefined)
  }
  try {
    localStorage.removeItem(LOCAL_SESSION_KEY)
    sessionStorage.removeItem(LOCAL_SESSION_KEY)
  } catch {
    // 存储不可用（隐私模式）：内存里已清掉
  }
}

type AccountResetListener = () => void
const accountResetListeners = new Set<AccountResetListener>()
/** 退出登录 / 会话失效 / 换了一个账号登录时回调：各 store 清掉上一个账号的数据、停掉后台流与轮询 */
export function onAccountReset(listener: AccountResetListener): () => void {
  accountResetListeners.add(listener)
  return () => accountResetListeners.delete(listener)
}
function notifyAccountReset(): void {
  for (const listener of accountResetListeners) {
    try {
      listener()
    } catch (error) {
      console.error(error)
    }
  }
}
/** 上一次登录进来的账号（服务器 + 用户 id）：换了账号时也要清 */
let lastAccountKey: string | null = null
function trackAccount(): void {
  if (!auth.me) return
  const key = `${auth.connection}|${auth.serverUrl}|${auth.me.user.id}`
  if (lastAccountKey !== null && lastAccountKey !== key) notifyAccountReset()
  lastAccountKey = key
}

let initPromise: Promise<void> | null = null
/** 这次启动检查遇到的是偶发错误（服务刚重启 / 网络）：结果不缓存，下次 initAuth() 重试 */
let initTransient = false
/** 连接的本机服务太旧、没有本机账户接口：照旧不登录直接进入 */
let localAuthUnsupported = false

/** 启动时调用一次（路由守卫里 await）；force 用于登录 / 切换服务器后重新加载 */
export function initAuth(force = false): Promise<void> {
  if (!initPromise || force) {
    const pending = doInit().finally(() => {
      // 偶发失败的结果不缓存：路由守卫下一次 initAuth() 会重新检查
      if (initTransient && initPromise === pending) initPromise = null
    })
    initPromise = pending
  }
  return initPromise
}

/** 本机账户状态接口：偶发错误（非 404）时退避重试几次 */
async function localAuthStatusWithRetry(): Promise<Awaited<ReturnType<typeof api.getLocalAuthStatus>>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.getLocalAuthStatus()
    } catch (error) {
      if (error instanceof api.ApiError && error.status === 404) throw error
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw lastError
}

async function doInit(): Promise<void> {
  auth.error = ''
  initTransient = false
  // 登录页预填（上次的登录方式 / 用户名 / 邮箱 / 是否记住）；桌面端在主进程
  await loadLoginPrefs()
  const bridge = desktopApi()
  let token: string | null = null
  /** 这次启动是否带着本机会话去校验（只有带了、又被判定无效，才清掉记住的会话） */
  let localTokenSent = false
  auth.localSessionLocked = false
  if (bridge) {
    try {
      const s = await bridge.getSession()
      auth.connection = s.mode
      auth.serverUrl = s.mode === 'remote' ? s.baseUrl : ''
      api.setTransport({ baseUrl: s.baseUrl || '', sessionToken: s.mode === 'remote' ? s.token : null })
      token = s.mode === 'remote' ? s.token : null
    } catch {
      api.setTransport({ baseUrl: '', sessionToken: null })
    }
    if (auth.connection === 'local') {
      const loaded = await loadLocalSession()
      auth.localSessionLocked = loaded.locked && !loaded.session
      localTokenSent = Boolean(loaded.session)
      api.setTransport({ localSession: loaded.session?.token ?? null })
    } else {
      api.setTransport({ localSession: null })
    }
  } else {
    const server = browserServerUrl()
    auth.connection = server ? 'remote' : 'local'
    auth.serverUrl = server
    const stored = readStoredSession()
    token = stored && stored.baseUrl === server ? stored.token : null
    const localToken = server ? null : (readLocalSession()?.token ?? null)
    localTokenSent = Boolean(localToken)
    api.setTransport({ baseUrl: server, sessionToken: token, localSession: localToken })
  }

  try {
    const mode = await api.getAuthMode()
    auth.mode = mode.mode
    auth.setupRequired = mode.setupRequired
    auth.version = mode.version
  } catch (error) {
    // 旧版本服务端没有 /api/auth/mode：按 desktop 处理
    auth.mode = 'desktop'
    auth.setupRequired = false
    if (!(error instanceof api.ApiError && error.status === 404)) auth.error = (error as Error).message
  }

  if (auth.mode === 'server' && !token) {
    auth.me = null
    auth.ready = true
    return
  }
  if (auth.mode === 'desktop') {
    // 本机账户：桌面端总是先到登录页“LULUX”（本机）栏。
    // 没有账户（全新安装，或早期测试版留下的数据但还没建账户）→ 创建本机账户；有账户但没有有效会话 → 登录。
    // 本机数据都属于同一个本机用户，建账户不会丢数据。
    let legacy = false
    try {
      const status = await localAuthStatusWithRetry()
      auth.local = { hasAccount: status.hasAccount, username: status.username ?? '' }
      if (!status.signedIn) {
        dropLocalSession({ forget: localTokenSent })
        auth.me = null
        auth.ready = true
        return
      }
    } catch (error) {
      // 旧服务端没有本机账户接口（404）：只能照旧直接进入；其他错误交给下面的 /api/auth/me
      legacy = error instanceof api.ApiError && error.status === 404
      if (!legacy) {
        // 偶发失败（服务刚重启 / 500 / 网络）：不知道有没有账户，不能当成“没有账户”去建一个；
        // 保留已知的状态（首次检查时按有账户、显示登录），提示连不上并允许重试
        initTransient = true
        auth.error = t('session.localStatusFailed')
        if (!auth.local.hasAccount) auth.local = { hasAccount: true, username: auth.local.username }
      }
    }
    localAuthUnsupported = legacy
  }
  try {
    auth.me = await api.getMe()
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) {
      await clearSession()
    } else if (!(error instanceof api.ApiError && error.status > 0 && error.status < 500)) {
      // 网络 / 5xx：下次 initAuth() 重试
      initTransient = true
    }
    auth.me = auth.mode === 'desktop' && localAuthUnsupported ? localMe() : null
  }
  trackAccount()
  auth.ready = true
}

/** 旧服务端没有 /api/auth/me 时的本机用户 */
function localMe(): Me {
  return {
    mode: 'desktop',
    user: {
      id: 'local',
      email: '',
      name: t('session.k1i2sdam'),
      role: 'owner',
      disabled: false,
      createdAt: 0,
      lastLoginAt: null,
    },
    org: { id: 'local', name: t('session.k12negyn'), createdAt: 0 },
    teams: [],
    permissions: [...api.ALL_PERMISSIONS],
    session: null,
  }
}

/**
 * 登录 / setup / 接受邀请成功后保存会话。
 * persist=false（登录页没勾“记住这台服务器”）：浏览器里只存 sessionStorage，关掉浏览器即失效；
 * 桌面端交给主进程：记住 → safeStorage 加密落盘，不记住 → 只在内存（退出即失效）。
 */
export async function saveSession(result: api.LoginResult, options: { persist?: boolean } = {}): Promise<void> {
  const persist = options.persist !== false
  api.setTransport({ sessionToken: result.token })
  const bridge = desktopApi()
  if (bridge) await bridge.setSession({ token: result.token, user: result.user }, { persist })
  else {
    const value = JSON.stringify({ token: result.token, user: result.user, baseUrl: auth.serverUrl })
    const keep = persist ? localStorage : sessionStorage
    const drop = persist ? sessionStorage : localStorage
    drop.removeItem(SESSION_KEY)
    keep.setItem(SESSION_KEY, value)
  }
  await initAuth(true)
}

/**
 * 本机账户登录 / 创建成功后保存会话。persist=“记住这台机器”：localStorage（重启后仍登录）或 sessionStorage。
 */
export async function saveLocalSession(
  result: api.LocalLoginResult,
  options: { persist?: boolean } = {},
): Promise<void> {
  const persist = options.persist !== false
  const session = { token: result.token, username: result.account.username }
  const value = JSON.stringify(session)
  const bridge = localSessionBridge()
  let stored = false
  if (bridge) {
    try {
      const res = await bridge.setLocalSession!(session, { persist })
      // 主进程已保管（不记住时在内存，记住时加密落盘）；只有要记住但系统没有安全存储时才退回 localStorage
      stored = !persist || res?.persisted === true
    } catch {
      stored = false
    }
  }
  try {
    localStorage.removeItem(LOCAL_SESSION_KEY)
    sessionStorage.removeItem(LOCAL_SESSION_KEY)
    if (!stored) (persist ? localStorage : sessionStorage).setItem(LOCAL_SESSION_KEY, value)
  } catch {
    // 存储不可用：本次运行仍在内存里
  }
  api.setTransport({ localSession: result.token })
  await initAuth(true)
}

export async function clearSession(): Promise<void> {
  notifyAccountReset()
  api.setTransport({ sessionToken: null })
  if (auth.mode === 'desktop' && auth.local.hasAccount) {
    // 本机账户会话失效（带着会话的请求被拒）：回到“LULUX”（本机）登录
    dropLocalSession({ forget: true })
    auth.me = null
    auth.local.username = ''
    return
  }
  auth.me = auth.mode === 'desktop' ? auth.me : null
  const bridge = desktopApi()
  if (bridge) await bridge.setSession(null).catch(() => undefined)
  else {
    localStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(SESSION_KEY)
  }
}

export async function signOut(): Promise<void> {
  notifyAccountReset()
  if (auth.mode === 'desktop' && auth.connection === 'local') {
    await api.localLogout().catch(() => undefined)
    dropLocalSession({ forget: true })
    auth.local.username = ''
    auth.me = null
    return
  }
  await api.logout().catch(() => undefined)
  await clearSession()
  auth.me = null
}

/**
 * 校验团队服务器地址：必须是完整的源（协议 + 主机 [+ 端口]），https；http 只允许 localhost / 127.0.0.1 / [::1]。
 * 与桌面主进程 normalizeServerUrl 的规则一致。返回规整后的地址或错误文案。
 */
export function validateServerUrl(
  raw: string,
): { url: string; error?: undefined } | { url?: undefined; error: string } {
  const url = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s?#@]+$/i.test(url)) return { error: t('session.kas3y62') }
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url)) {
    return { error: t('session.koat2vu') }
  }
  return { url }
}

/** 当前已连接的团队服务器（远程地址，或同源部署时的本站地址）；本机模式返回空串 */
export function currentServerOrigin(): string {
  if (auth.connection === 'remote') return auth.serverUrl
  if (auth.mode === 'server' && typeof location !== 'undefined') return location.origin
  return ''
}

/** 只探测、不切换：GET {url}/api/auth/mode（登录页“测试连接”） */
export async function probeServer(
  raw: string,
): Promise<{ ok: true; url: string; setupRequired: boolean; version: string } | { ok: false; error: string }> {
  const checked = validateServerUrl(raw)
  if (checked.error !== undefined) return { ok: false, error: checked.error }
  const url = checked.url
  try {
    const res = await fetch(`${url}/api/auth/mode`)
    const info = (await res.json()) as { mode?: string; setupRequired?: boolean; version?: string }
    if (info.mode !== 'server') return { ok: false, error: t('session.k1g2qswo') }
    return { ok: true, url, setupRequired: Boolean(info.setupRequired), version: String(info.version ?? '') }
  } catch {
    return { ok: false, error: t('session.k105hox0', [url]) }
  }
}

/**
 * 切到远程团队服务器。桌面端由主进程校验并重新加载窗口（返回 reloading=true，之后的代码不会再有意义）。
 */
export async function connectServer(url: string): Promise<{ ok: boolean; error?: string; reloading?: boolean }> {
  const checked = validateServerUrl(url)
  if (checked.error !== undefined) return { ok: false, error: checked.error }
  const serverUrl = checked.url
  const bridge = desktopApi()
  if (bridge) {
    const res = await bridge.connectRemote(serverUrl)
    return res.ok ? { ok: true, reloading: true } : { ok: false, error: res.error }
  }
  const probe = await probeServer(serverUrl)
  if (!probe.ok) return { ok: false, error: probe.error }
  localStorage.setItem(SERVER_KEY, serverUrl)
  localStorage.setItem(RECENT_KEY, JSON.stringify([serverUrl, ...recentServers().filter((s) => s !== serverUrl)]))
  await initAuth(true)
  return { ok: true }
}

export async function useLocalServer(): Promise<void> {
  const bridge = desktopApi()
  if (bridge) return bridge.useLocal()
  localStorage.removeItem(SERVER_KEY)
  await initAuth(true)
}

/* ── 权限 ── */

export const isServerMode = computed(() => auth.mode === 'server')
export const currentRole = computed<Role>(() => auth.me?.user.role ?? 'owner')
export const currentUser = computed(() => auth.me?.user ?? null)

export function hasPermission(me: Me | null, permission: Permission, mode: 'desktop' | 'server' = 'desktop'): boolean {
  if (!me) return mode === 'desktop'
  return me.permissions.includes(permission)
}

/** 当前用户是否有某权限（模板里直接用） */
export function can(permission: Permission): boolean {
  return hasPermission(auth.me, permission, auth.mode)
}

/** member 只能改自己的数据；admin/owner 全部；viewer 不能改 */
export function canEditOwned(ownerId: string | undefined | null): boolean {
  if (!can('data:write')) return false
  const role = currentRole.value
  if (role === 'owner' || role === 'admin' || auth.mode === 'desktop') return true
  return !ownerId || ownerId === auth.me?.user.id
}

export const ROLE_LABEL: Record<Role, string> = localized(() => ({
  owner: t('session.k1ytgmmm'),
  admin: t('session.k1ughn51'),
  member: t('session.k1ht4tfl'),
  viewer: t('session.k1yyopd1'),
}))

export const PERMISSION_LABEL: Record<Permission, string> = localized(() => ({
  'data:read': t('session.k2aurzr'),
  'data:write': t('session.kkbnqi6'),
  'data:export': t('session.kiq4yk3'),
  'data:import': t('session.kq3kica'),
  'customer:delete': t('finePerms.customerDelete'),
  'customer:import': t('finePerms.customerImport'),
  'deal:delete': t('finePerms.dealDelete'),
  'quote:delete': t('finePerms.quoteDelete'),
  'order:delete': t('finePerms.orderDelete'),
  'task:delete': t('finePerms.taskDelete'),
  'workflow:manage': t('finePerms.workflowManage'),
  'catalog:write': t('session.k1p9d5z7'),
  'settings:write': t('session.k1uodnun'),
  'providers:write': t('session.kba4875'),
  'members:manage': t('session.k1qrjizw'),
  'audit:read': t('session.kc33siy'),
  'email:send': t('session.kklcc9i'),
  'security:manage': t('session.k2qx1j'),
}))

/** 无权限时给按钮的说明文字：角色本来有、被管理员单独关闭的权限给出不同说明 */
export function denyReason(permission: Permission): string {
  if (OVERRIDABLE_PERMISSIONS.includes(permission) && roleDefault(currentRole.value, permission))
    return t('finePerms.deniedByAdmin', [PERMISSION_LABEL[permission]])
  return t('session.k1j3p6j1', [ROLE_LABEL[currentRole.value], PERMISSION_LABEL[permission]])
}

/** 同时需要多项权限（例如删除 = data:write + customer:delete）；返回第一个缺少的权限 */
export function missingPermission(permissions: Permission | readonly Permission[]): Permission | null {
  const list = typeof permissions === 'string' ? [permissions] : permissions
  return list.find((permission) => !can(permission)) ?? null
}

export function canAll(permissions: Permission | readonly Permission[]): boolean {
  return missingPermission(permissions) === null
}

/** 删除类操作：需要 data:write 与对应的 *:delete */
export function canDelete(permission: DeletePermission): boolean {
  return canAll(['data:write', permission])
}
