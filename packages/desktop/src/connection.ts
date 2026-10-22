import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * “连接团队服务器”的本地配置（契约 5.10）。保存在 userData/connection.json：
 * 模式、服务器地址、最近使用的服务器，以及每个服务器的会话 token（safeStorage 加密）。
 * safeStorage 不可用时会话只保存在内存里（重启后需重新登录），绝不明文落盘。
 */
export interface SessionUser {
  id: string
  email: string
  name: string
  role: string
  [key: string]: unknown
}

interface StoredSession {
  token: string // base64(safeStorage 密文)
  user: SessionUser | null
}

interface ConnectionFile {
  mode: 'local' | 'remote'
  serverUrl: string | null
  recentServers: string[]
  sessions: Record<string, StoredSession>
}

const DEFAULT: ConnectionFile = { mode: 'local', serverUrl: null, recentServers: [], sessions: {} }
const memorySessions = new Map<string, { token: string; user: SessionUser | null }>()

function file(): string {
  return join(app.getPath('userData'), 'connection.json')
}

function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

function read(): ConnectionFile {
  try {
    if (!existsSync(file())) return { ...DEFAULT, sessions: {} }
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ConnectionFile>
    return {
      mode: parsed.mode === 'remote' && typeof parsed.serverUrl === 'string' ? 'remote' : 'local',
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : null,
      recentServers: Array.isArray(parsed.recentServers) ? parsed.recentServers.filter((s) => typeof s === 'string').slice(0, 10) : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    }
  } catch {
    return { ...DEFAULT, sessions: {} }
  }
}

function write(data: ConnectionFile): void {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

/** 规范化并校验服务器地址：必须 https；http 只允许本机（测试 / 本机反代） */
export function normalizeServerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('服务器地址格式不正确')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('团队服务器必须使用 https://（http 只允许 localhost / 127.0.0.1）')
  }
  if (url.username || url.password) throw new Error('服务器地址不能包含用户名或密码')
  return url.origin
}

export const connectionStore = {
  get(): { mode: 'local' | 'remote'; serverUrl: string | null; recentServers: string[] } {
    const data = read()
    return { mode: data.mode, serverUrl: data.serverUrl, recentServers: data.recentServers }
  },

  remoteOrigin(): string | null {
    const data = read()
    return data.mode === 'remote' && data.serverUrl ? data.serverUrl : null
  },

  useRemote(serverUrl: string): void {
    const data = read()
    data.mode = 'remote'
    data.serverUrl = serverUrl
    data.recentServers = [serverUrl, ...data.recentServers.filter((item) => item !== serverUrl)].slice(0, 10)
    write(data)
  },

  useLocal(): void {
    const data = read()
    data.mode = 'local'
    write(data)
  },

  session(serverUrl: string): { token: string; user: SessionUser | null } | null {
    const memory = memorySessions.get(serverUrl)
    if (memory) return memory
    const stored = read().sessions[serverUrl]
    if (!stored || !canEncrypt()) return null
    try {
      return { token: safeStorage.decryptString(Buffer.from(stored.token, 'base64')), user: stored.user }
    } catch {
      return null
    }
  },

  /** persist=false（没勾“记住这台服务器”）：只放内存，删掉磁盘上这台服务器的旧会话 */
  setSession(
    serverUrl: string,
    session: { token: string; user: SessionUser | null } | null,
    options: { persist?: boolean } = {},
  ): void {
    const data = read()
    if (!session) {
      memorySessions.delete(serverUrl)
      delete data.sessions[serverUrl]
      write(data)
      return
    }
    memorySessions.set(serverUrl, session)
    if (options.persist === false) {
      if (data.sessions[serverUrl]) {
        delete data.sessions[serverUrl]
        write(data)
      }
      return
    }
    if (canEncrypt()) {
      data.sessions[serverUrl] = { token: safeStorage.encryptString(session.token).toString('base64'), user: session.user }
      write(data)
    }
  },
}
