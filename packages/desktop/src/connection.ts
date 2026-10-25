import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-file'

/**
 * “连接团队服务器”的本地配置（契约 5.10）。保存在 userData/connection.json：
 * 模式、服务器地址、最近使用的服务器，以及每个服务器的会话 token（safeStorage 加密）。
 * 系统没有安全存储（Linux 没有密钥环）时，“记住这台服务器”退回到本机文件方式保存
 * （connection.json 权限 0600，仅当前用户可读），并把 storage='file' 返回给界面如实提示。
 * 安全存储暂时解不开时不删磁盘上的会话，下次再试。写入走临时文件 + rename，不会写出半截 JSON。
 */
export interface SessionUser {
  id: string
  email: string
  name: string
  role: string
  [key: string]: unknown
}

interface StoredSession {
  /** protection=secure：base64(safeStorage 密文)；protection=file：会话 token 本身 */
  token: string
  user: SessionUser | null
  /** 缺省为 secure（旧版写的都是加密的） */
  protection?: 'secure' | 'file'
}

export interface SetSessionResult {
  persisted: boolean
  storage: 'secure' | 'file' | 'memory'
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

export function canEncrypt(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

function read(): ConnectionFile {
  const parsed = readJsonFile<Partial<ConnectionFile>>(file()).value
  if (!parsed) return { ...DEFAULT, sessions: {} }
  return {
    mode: parsed.mode === 'remote' && typeof parsed.serverUrl === 'string' ? 'remote' : 'local',
    serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : null,
    recentServers: Array.isArray(parsed.recentServers) ? parsed.recentServers.filter((s) => typeof s === 'string').slice(0, 10) : [],
    sessions: parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions) ? parsed.sessions : {},
  }
}

function write(data: ConnectionFile): void {
  writeJsonFile(file(), data, { mode: 0o600 })
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
    if (!stored || typeof stored.token !== 'string') return null
    if (stored.protection === 'file') return { token: stored.token, user: stored.user ?? null }
    // 安全存储暂时不可用 / 解不开：当作这次没有会话，但磁盘上的保留，下次再试
    if (!canEncrypt()) return null
    try {
      return { token: safeStorage.decryptString(Buffer.from(stored.token, 'base64')), user: stored.user ?? null }
    } catch {
      return null
    }
  },

  /** 现在“记住这台服务器”会怎样落盘（设置页据此提示） */
  storageKind(): 'secure' | 'file' {
    return canEncrypt() ? 'secure' : 'file'
  },

  /** persist=false（没勾“记住这台服务器”）：只放内存，删掉磁盘上这台服务器的旧会话 */
  setSession(
    serverUrl: string,
    session: { token: string; user: SessionUser | null } | null,
    options: { persist?: boolean } = {},
  ): SetSessionResult {
    const data = read()
    if (!session) {
      memorySessions.delete(serverUrl)
      if (data.sessions[serverUrl]) {
        delete data.sessions[serverUrl]
        write(data)
      }
      return { persisted: false, storage: 'memory' }
    }
    memorySessions.set(serverUrl, session)
    if (options.persist === false) {
      if (data.sessions[serverUrl]) {
        delete data.sessions[serverUrl]
        write(data)
      }
      return { persisted: false, storage: 'memory' }
    }
    try {
      if (canEncrypt()) {
        data.sessions[serverUrl] = {
          token: safeStorage.encryptString(session.token).toString('base64'),
          user: session.user,
          protection: 'secure',
        }
        write(data)
        return { persisted: true, storage: 'secure' }
      }
      // 系统没有安全存储：以本机文件方式保存（connection.json 0600），界面会如实提示
      data.sessions[serverUrl] = { token: session.token, user: session.user, protection: 'file' }
      write(data)
      return { persisted: true, storage: 'file' }
    } catch {
      return { persisted: false, storage: 'memory' }
    }
  },
}
