import { readJsonFile, writeJsonFile } from './json-file'

/**
 * 登录态持久化（userData/auth-state.json），由主进程保管、不依赖页面的 localStorage：
 *
 * - 本地服务每次启动端口可能不同（被占用时退回系统分配），页面 origin 一变 localStorage 就是全新的，
 *   以前“记住这台机器”的会话和登录偏好都存在 localStorage 里，重启后全部丢失。
 * - 本机账户会话 token：勾“记住这台机器”时用 safeStorage（Windows DPAPI / macOS Keychain / libsecret）加密落盘；
 *   不勾只放内存（本次运行内重载窗口仍在，退出即失效）。
 *   系统没有安全存储（Linux 没有密钥环）时，退回到本文件里以本机文件方式保存（文件权限 0600，仅当前用户可读），
 *   返回 storage='file'，由设置页如实提示，而不是假装加密保存成功。
 * - 安全存储暂时解不开（钥匙串拒绝、开机时密钥环尚未解锁）：状态为 locked，磁盘上的会话原样保留，下次再试；
 *   只有用户主动退出登录、或服务端明确判定会话失效（forget=true）时才删除磁盘会话。
 * - 同一台机器上可能有多份数据目录（例如安装版与免安装版共用 userData）：会话按数据目录分开保存，
 *   一份数据目录校验失败不会删掉另一份的会话。
 * - 登录偏好（登录方式、本机用户名、每台团队服务器的邮箱与“记住”勾选）：不含密码与 token，明文 JSON。
 * - 上次使用的本地端口：下次优先沿用，让页面 origin 尽量保持不变。
 *
 * 只依赖 node:fs 与注入的加密器，便于单元测试。
 */

export interface Cipher {
  /** 能否安全加密（Linux basic_text 明文后端视为不可用） */
  available(): boolean
  encrypt(plain: string): string
  decrypt(encoded: string): string
}

export interface LocalSession {
  token: string
  username: string
}

export interface LoginPrefs {
  tab?: 'local' | 'server'
  local?: { username?: string; remember?: boolean }
  servers?: Record<string, { email?: string; remember?: boolean }>
  lastServer?: string
}

/** 会话落盘方式：secure = 系统安全存储加密；file = 本机文件（0600，系统没有安全存储时） */
export type SessionStorageKind = 'secure' | 'file'

interface StoredLocalSession {
  token: string
  username: string
  savedAt: number
  /** 缺省为 secure（旧版写的都是加密的） */
  protection?: SessionStorageKind
}

interface AuthStateFile {
  /** 旧版：不分数据目录的单个会话。读取时作为后备，新写入放到 localSessions */
  localSession?: StoredLocalSession
  /** 按数据目录分开保存的会话 */
  localSessions?: Record<string, StoredLocalSession>
  loginPrefs?: LoginPrefs
  localPort?: number
}

/** none：没有记住的会话；ok：读到了；locked：磁盘上有会话但安全存储暂时解不开（保留，下次再试） */
export type LocalSessionState =
  | { state: 'none' }
  | { state: 'ok'; session: LocalSession; storage: SessionStorageKind | 'memory' }
  | { state: 'locked' }

export interface SetLocalSessionResult {
  persisted: boolean
  /** memory：只在本次运行的内存里 */
  storage: SessionStorageKind | 'memory'
}

export interface AuthStoreOptions {
  /** 数据目录标识（本地服务的数据目录路径）；不传时用 default */
  scope?: string
  /** 文件损坏等情况的日志 */
  onWarn?: (message: string) => void
}

const MAX_SCOPES = 5

const LOCAL_TOKEN_RE = /^lls_[0-9a-f]{64}$/
const MAX_TEXT = 320
const MAX_SERVERS = 10

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined
}

/** 校验渲染进程传来的登录偏好：只保留已知字段，不接受密码 / token 之类的额外内容 */
export function sanitizeLoginPrefs(input: unknown): LoginPrefs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const raw = input as Record<string, unknown>
  const out: LoginPrefs = {}
  if (raw.tab === 'local' || raw.tab === 'server') out.tab = raw.tab
  const local = raw.local
  if (local && typeof local === 'object' && !Array.isArray(local)) {
    const l = local as Record<string, unknown>
    const entry: NonNullable<LoginPrefs['local']> = {}
    const username = text(l.username)
    if (username) entry.username = username
    if (typeof l.remember === 'boolean') entry.remember = l.remember
    if (Object.keys(entry).length) out.local = entry
  }
  const servers = raw.servers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const entries: NonNullable<LoginPrefs['servers']> = {}
    for (const [url, value] of Object.entries(servers as Record<string, unknown>).slice(0, MAX_SERVERS)) {
      if (!/^https?:\/\/[^/\s?#@]+$/i.test(url) || url.length > MAX_TEXT) continue
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const v = value as Record<string, unknown>
      const entry: { email?: string; remember?: boolean } = {}
      const email = text(v.email)
      if (email) entry.email = email
      if (typeof v.remember === 'boolean') entry.remember = v.remember
      entries[url] = entry
    }
    if (Object.keys(entries).length) out.servers = entries
  }
  const lastServer = text(raw.lastServer)
  if (lastServer && /^https?:\/\/[^/\s?#@]+$/i.test(lastServer)) out.lastServer = lastServer
  return out
}

export class AuthStore {
  private memorySession: LocalSession | null = null
  /** 本次读到的会话来自旧版的 localSession 字段（清除时一并删掉） */
  private loadedFromLegacy = false
  private readonly scope: string

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly options: AuthStoreOptions = {},
  ) {
    this.scope = options.scope || 'default'
  }

  private read(): AuthStateFile {
    return readJsonFile<AuthStateFile>(this.file, this.options.onWarn).value ?? {}
  }

  private write(data: AuthStateFile): void {
    writeJsonFile(this.file, data, { mode: 0o600 })
  }

  private safeAvailable(): boolean {
    try {
      return this.cipher.available()
    } catch {
      return false
    }
  }

  /** 当前这份数据目录的会话记录（没有时退回旧版字段） */
  private record(data: AuthStateFile): { stored: StoredLocalSession | undefined; legacy: boolean } {
    const own = data.localSessions && typeof data.localSessions === 'object' ? data.localSessions[this.scope] : undefined
    if (own) return { stored: own, legacy: false }
    return { stored: data.localSession, legacy: Boolean(data.localSession) }
  }

  /** 删掉这份数据目录在磁盘上的会话；返回是否有改动 */
  private dropRecord(data: AuthStateFile): boolean {
    let changed = false
    if (data.localSessions?.[this.scope]) {
      delete data.localSessions[this.scope]
      if (!Object.keys(data.localSessions).length) delete data.localSessions
      changed = true
    }
    if (this.loadedFromLegacy && data.localSession) {
      delete data.localSession
      changed = true
    }
    this.loadedFromLegacy = false
    return changed
  }

  /** 本机账户会话的三种状态：先内存（本次运行），再磁盘（记住这台机器） */
  getLocalSessionState(): LocalSessionState {
    if (this.memorySession) return { state: 'ok', session: this.memorySession, storage: 'memory' }
    const { stored, legacy } = this.record(this.read())
    if (!stored || typeof stored.token !== 'string') return { state: 'none' }
    const username = typeof stored.username === 'string' ? stored.username : ''
    let token: string
    let storage: SessionStorageKind
    if (stored.protection === 'file') {
      token = stored.token
      storage = 'file'
    } else {
      // 安全存储暂时不可用 / 解不开：保留磁盘上的会话，下次再试
      if (!this.safeAvailable()) return { state: 'locked' }
      try {
        token = this.cipher.decrypt(stored.token)
      } catch {
        return { state: 'locked' }
      }
      storage = 'secure'
    }
    if (!LOCAL_TOKEN_RE.test(token)) return { state: 'none' }
    this.loadedFromLegacy = legacy
    this.memorySession = { token, username }
    return { state: 'ok', session: this.memorySession, storage }
  }

  getLocalSession(): LocalSession | null {
    const state = this.getLocalSessionState()
    return state.state === 'ok' ? state.session : null
  }

  /** 现在“记住这台机器”会怎样落盘（设置页据此提示） */
  storageKind(): SessionStorageKind {
    return this.safeAvailable() ? 'secure' : 'file'
  }

  /**
   * 保存 / 清除本机账户会话。
   * - session=null：清掉内存；只有 forget=true（主动退出登录 / 服务端明确判定失效）才删磁盘会话。
   * - persist=false：只放内存，并删掉磁盘上这份数据目录的旧会话（用户这次选择了不记住）。
   * - persist=true：有安全存储时加密落盘，否则以本机文件方式保存（0600）。
   */
  setLocalSession(session: unknown, options: { persist?: boolean; forget?: boolean } = {}): SetLocalSessionResult {
    if (session === null) {
      this.memorySession = null
      if (options.forget === true) {
        const data = this.read()
        if (this.dropRecord(data)) this.write(data)
      }
      return { persisted: false, storage: 'memory' }
    }
    if (!session || typeof session !== 'object') throw new Error('会话格式不正确')
    const { token, username } = session as { token?: unknown; username?: unknown }
    if (typeof token !== 'string' || !LOCAL_TOKEN_RE.test(token)) throw new Error('会话 token 格式不正确')
    const name = typeof username === 'string' ? username.slice(0, 64) : ''
    this.memorySession = { token, username: name }
    const data = this.read()
    if (options.persist !== true) {
      if (this.dropRecord(data)) this.write(data)
      return { persisted: false, storage: 'memory' }
    }
    const secure = this.safeAvailable()
    let record: StoredLocalSession
    try {
      record = secure
        ? { token: this.cipher.encrypt(token), username: name, savedAt: Date.now(), protection: 'secure' }
        : { token, username: name, savedAt: Date.now(), protection: 'file' }
    } catch (error) {
      this.options.onWarn?.(`加密本机会话失败：${error instanceof Error ? error.message : String(error)}`)
      return { persisted: false, storage: 'memory' }
    }
    // 旧版字段属于本数据目录时迁移过来，其余数据目录的会话不动
    if (this.loadedFromLegacy) delete data.localSession
    this.loadedFromLegacy = false
    const sessions = { ...(data.localSessions ?? {}) }
    delete sessions[this.scope]
    const kept = Object.entries(sessions)
      .sort((a, b) => (b[1]?.savedAt ?? 0) - (a[1]?.savedAt ?? 0))
      .slice(0, MAX_SCOPES - 1)
    data.localSessions = Object.fromEntries([[this.scope, record], ...kept])
    try {
      this.write(data)
    } catch (error) {
      this.options.onWarn?.(`保存本机会话失败：${error instanceof Error ? error.message : String(error)}`)
      return { persisted: false, storage: 'memory' }
    }
    return { persisted: true, storage: secure ? 'secure' : 'file' }
  }

  getLoginPrefs(): LoginPrefs {
    return sanitizeLoginPrefs(this.read().loginPrefs)
  }

  setLoginPrefs(input: unknown): LoginPrefs {
    const data = this.read()
    const prefs = sanitizeLoginPrefs(input)
    if (Object.keys(prefs).length) data.loginPrefs = prefs
    else delete data.loginPrefs
    this.write(data)
    return prefs
  }

  /** 上次使用的本地服务端口（1024–65535），没有则 null */
  getLocalPort(): number | null {
    const port = this.read().localPort
    return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
  }

  setLocalPort(port: number): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return
    const data = this.read()
    if (data.localPort === port) return
    data.localPort = port
    this.write(data)
  }
}
