import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 登录态持久化（userData/auth-state.json），由主进程保管、不依赖页面的 localStorage：
 *
 * - 本地服务每次启动端口可能不同（被占用时退回系统分配），页面 origin 一变 localStorage 就是全新的，
 *   以前“记住这台机器”的会话和登录偏好都存在 localStorage 里，重启后全部丢失。
 * - 本机账户会话 token：勾“记住这台机器”时用 safeStorage（Windows DPAPI / macOS Keychain / libsecret）加密落盘；
 *   不勾只放内存（本次运行内重载窗口仍在，退出即失效）。safeStorage 不可用时绝不明文落盘，返回 persisted=false。
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

interface AuthStateFile {
  localSession?: { token: string; username: string; savedAt: number }
  loginPrefs?: LoginPrefs
  localPort?: number
}

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

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  private read(): AuthStateFile {
    try {
      if (!existsSync(this.file)) return {}
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AuthStateFile) : {}
    } catch {
      return {}
    }
  }

  private write(data: AuthStateFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  /** 本机账户会话：先内存（本次运行），再磁盘（记住这台机器） */
  getLocalSession(): LocalSession | null {
    if (this.memorySession) return this.memorySession
    const stored = this.read().localSession
    if (!stored || typeof stored.token !== 'string' || !this.cipher.available()) return null
    try {
      const token = this.cipher.decrypt(stored.token)
      if (!LOCAL_TOKEN_RE.test(token)) return null
      this.memorySession = { token, username: typeof stored.username === 'string' ? stored.username : '' }
      return this.memorySession
    } catch {
      // 换了系统账户 / 钥匙串被清空：当作没有记住
      return null
    }
  }

  /**
   * 保存 / 清除本机账户会话。persist=false 只放内存并删掉磁盘上的旧会话。
   * 返回是否已加密落盘（safeStorage 不可用时为 false，由页面决定退路）。
   */
  setLocalSession(session: unknown, options: { persist?: boolean } = {}): { persisted: boolean } {
    const data = this.read()
    if (session === null) {
      this.memorySession = null
      if (data.localSession) {
        delete data.localSession
        this.write(data)
      }
      return { persisted: false }
    }
    if (!session || typeof session !== 'object') throw new Error('会话格式不正确')
    const { token, username } = session as { token?: unknown; username?: unknown }
    if (typeof token !== 'string' || !LOCAL_TOKEN_RE.test(token)) throw new Error('会话 token 格式不正确')
    const name = typeof username === 'string' ? username.slice(0, 64) : ''
    this.memorySession = { token, username: name }
    if (options.persist !== true || !this.cipher.available()) {
      if (data.localSession) {
        delete data.localSession
        this.write(data)
      }
      return { persisted: false }
    }
    data.localSession = { token: this.cipher.encrypt(token), username: name, savedAt: Date.now() }
    this.write(data)
    return { persisted: true }
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
