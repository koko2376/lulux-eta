/**
 * 登录页偏好（“记住这台机器 / 这台服务器”）：按登录方式分别记，团队服务器按地址分别记。
 *
 * - 本机：{ username, remember }；服务器：servers[url] = { email, remember }；tab = 上次用的登录方式。
 * - 只在勾了“记住”时写入；不勾就删掉对应那一项（不持久）。不含密码与 token。
 * - 桌面端由主进程保存（userData/auth-state.json）：本地服务端口变化会让页面 origin 变化、localStorage 变成空的，
 *   放在 localStorage 里重启后就丢了。浏览器里存 localStorage `lulux.login`。
 * - 兼容旧格式 { tab, username, serverUrl, email, remember }。
 */

export type LoginTab = 'local' | 'server'

export interface LoginPrefs {
  tab?: LoginTab
  local?: { username?: string; remember?: boolean }
  servers?: Record<string, { email?: string; remember?: boolean }>
  lastServer?: string
}

export const LOGIN_PREFS_KEY = 'lulux.login'
const MAX_SERVERS = 10

interface LegacyPrefs {
  tab?: LoginTab
  serverUrl?: string
  email?: string
  username?: string
  remember?: boolean
}

let cache: LoginPrefs | null = null

const prefsBridge = () => {
  const api = typeof window !== 'undefined' ? window.luluxAgent?.api : undefined
  return api?.getLoginPrefs && api.setLoginPrefs ? api : null
}

/** 规整任意来源的偏好（含旧格式） */
export function normalizeLoginPrefs(raw: unknown): LoginPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const input = raw as LoginPrefs & LegacyPrefs
  const out: LoginPrefs = {}
  if (input.tab === 'local' || input.tab === 'server') out.tab = input.tab
  if (input.local && typeof input.local === 'object') {
    const username = typeof input.local.username === 'string' ? input.local.username : ''
    out.local = { ...(username ? { username } : {}), remember: input.local.remember === true }
  }
  if (input.servers && typeof input.servers === 'object') {
    const servers: NonNullable<LoginPrefs['servers']> = {}
    for (const [url, value] of Object.entries(input.servers)) {
      if (!value || typeof value !== 'object') continue
      servers[url] = {
        ...(typeof value.email === 'string' && value.email ? { email: value.email } : {}),
        remember: value.remember === true,
      }
    }
    if (Object.keys(servers).length) out.servers = servers
  }
  if (typeof input.lastServer === 'string' && input.lastServer) out.lastServer = input.lastServer
  // 旧格式：一个“记住”勾选同时管两栏
  if (!out.local && !out.servers && input.remember === true) {
    if (typeof input.username === 'string' && input.username) out.local = { username: input.username, remember: true }
    if (typeof input.serverUrl === 'string' && input.serverUrl) {
      out.servers = {
        [input.serverUrl]: { ...(typeof input.email === 'string' && input.email ? { email: input.email } : {}), remember: true },
      }
      out.lastServer = input.serverUrl
    }
  }
  return out
}

function readBrowser(): LoginPrefs {
  try {
    const raw = localStorage.getItem(LOGIN_PREFS_KEY)
    return raw ? normalizeLoginPrefs(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

/** 启动时（initAuth）读一次：桌面端从主进程，浏览器从 localStorage */
export async function loadLoginPrefs(): Promise<LoginPrefs> {
  const bridge = prefsBridge()
  if (bridge) {
    try {
      cache = normalizeLoginPrefs(await bridge.getLoginPrefs!())
      return cache
    } catch {
      // 主进程不可用：退回 localStorage
    }
  }
  cache = null
  return readBrowser()
}

/** 当前偏好（同步）：桌面端用启动时从主进程读到的；浏览器每次读 localStorage */
export function loginPrefs(): LoginPrefs {
  if (prefsBridge() && cache) return cache
  return readBrowser()
}

function persist(next: LoginPrefs): void {
  const empty = !next.tab && !next.local && !next.servers && !next.lastServer
  const bridge = prefsBridge()
  if (bridge) {
    cache = next
    void bridge.setLoginPrefs!(next).catch(() => undefined)
    return
  }
  try {
    if (empty) localStorage.removeItem(LOGIN_PREFS_KEY)
    else localStorage.setItem(LOGIN_PREFS_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式：只在内存里
  }
}

/** 本机登录成功：勾“记住” → 记下用户名与勾选；不勾 → 删掉本机这一项 */
export function rememberLocalLogin(username: string, remember: boolean): void {
  const current = loginPrefs()
  const next: LoginPrefs = { ...current }
  if (remember) {
    next.local = { username, remember: true }
    next.tab = 'local'
  } else {
    delete next.local
    if (next.tab === 'local') delete next.tab
  }
  persist(next)
}

/** 团队服务器登录成功：按服务器地址记邮箱与勾选；不勾 → 删掉这台服务器 */
export function rememberServerLogin(serverUrl: string, email: string, remember: boolean): void {
  const current = loginPrefs()
  const servers = { ...(current.servers ?? {}) }
  const next: LoginPrefs = { ...current }
  delete servers[serverUrl]
  if (remember) {
    next.servers = Object.fromEntries([[serverUrl, { email, remember: true }], ...Object.entries(servers)].slice(0, MAX_SERVERS))
    next.lastServer = serverUrl
    next.tab = 'server'
  } else {
    if (Object.keys(servers).length) next.servers = servers
    else delete next.servers
    if (next.lastServer === serverUrl) delete next.lastServer
    if (next.tab === 'server' && !next.lastServer) delete next.tab
  }
  persist(next)
}

/** 测试用：清掉内存缓存 */
export function resetLoginPrefsCache(): void {
  cache = null
}
