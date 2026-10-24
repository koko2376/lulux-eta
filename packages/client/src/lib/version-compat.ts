/**
 * 客户端与团队服务器的版本兼容检查。
 *
 * 桌面端会自动更新，公司服务器是手动升级，两边版本可能错开：
 * - 主版本或次版本不同：提示（客户端更新 → 请管理员升级服务器；客户端更旧 → 提示更新客户端），不拦截；
 * - 客户端低于服务端声明的 minClientVersion：接口已不兼容，拦截使用，只能更新或换服务器。
 * 修订号（x.y.Z）不同视为兼容。
 */
import { reactive } from 'vue'
import { t } from '../i18n'

export interface ServerVersionInfo {
  version: string
  /** 旧服务端没有 /api/version 时为空 */
  minClientVersion: string
}

export type CompatStatus = 'ok' | 'client-newer' | 'client-older' | 'blocked' | 'unknown'

export interface CompatResult {
  status: CompatStatus
  clientVersion: string
  serverVersion: string
  minClientVersion: string
}

type Triple = [number, number, number]

export function parseVersion(raw: string | null | undefined): Triple | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** a < b → 负数，相等 → 0，a > b → 正数；无法解析返回 null */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

export function checkCompat(clientVersion: string, server: ServerVersionInfo): CompatResult {
  const base = { clientVersion, serverVersion: server.version, minClientVersion: server.minClientVersion }
  const client = parseVersion(clientVersion)
  const remote = parseVersion(server.version)
  if (server.minClientVersion) {
    const belowMin = compareVersions(clientVersion, server.minClientVersion)
    if (belowMin !== null && belowMin < 0) return { ...base, status: 'blocked' }
  }
  if (!client || !remote) return { ...base, status: 'unknown' }
  if (client[0] === remote[0] && client[1] === remote[1]) return { ...base, status: 'ok' }
  const newer = client[0] > remote[0] || (client[0] === remote[0] && client[1] > remote[1])
  return { ...base, status: newer ? 'client-newer' : 'client-older' }
}

/** 本客户端版本（构建时注入；测试环境没有时为空串） */
export function clientVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  } catch {
    return ''
  }
}

/** 全局状态：当前连接的服务器的兼容结果；dismissed 记住用户关掉提示时的服务器版本 */
export const versionCompat = reactive({
  result: null as CompatResult | null,
  checkedAt: 0,
  dismissedFor: '',
})

/** 版本检查不能拖住登录：超过 5 秒当作无法判断 */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(5_000)
    : undefined
}

/** 旧服务端没有 /api/version 时退回 /api/auth/mode 里的 version（没有 minClientVersion） */
export async function fetchServerVersion(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ServerVersionInfo | null> {
  const root = baseUrl.replace(/\/+$/, '')
  const init = (): RequestInit => ({ headers: { Accept: 'application/json' }, signal: timeoutSignal() })
  try {
    const res = await fetchFn(`${root}/api/version`, init())
    if (res.ok) {
      const info = (await res.json()) as { version?: unknown; minClientVersion?: unknown }
      if (typeof info.version === 'string') {
        return {
          version: info.version,
          minClientVersion: typeof info.minClientVersion === 'string' ? info.minClientVersion : '',
        }
      }
    }
  } catch {
    // 连不上：交给下面的回退
  }
  try {
    const res = await fetchFn(`${root}/api/auth/mode`, init())
    if (!res.ok) return null
    const info = (await res.json()) as { version?: unknown }
    return typeof info.version === 'string' ? { version: info.version, minClientVersion: '' } : null
  } catch {
    return null
  }
}

/** 检查并更新全局状态；连不上服务器时保留上一次结果 */
export async function refreshVersionCompat(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<CompatResult | null> {
  const info = await fetchServerVersion(baseUrl, fetchFn)
  if (!info) return versionCompat.result
  versionCompat.result = checkCompat(clientVersion(), info)
  versionCompat.checkedAt = Date.now()
  return versionCompat.result
}

export function resetVersionCompat(): void {
  versionCompat.result = null
  versionCompat.checkedAt = 0
  versionCompat.dismissedFor = ''
}

/** 每 30 分钟复查一次（服务器可能在使用中被升级） */
export const VERSION_RECHECK_MS = 30 * 60_000

/** 给用户看的说明；兼容 / 无法判断时为空串 */
export function compatMessage(r: CompatResult | null): string {
  if (!r) return ''
  if (r.status === 'blocked') return t('versionCompat.blocked', [r.clientVersion, r.minClientVersion, r.serverVersion])
  if (r.status === 'client-newer') return t('versionCompat.clientNewer', [r.clientVersion, r.serverVersion])
  if (r.status === 'client-older') return t('versionCompat.clientOlder', [r.clientVersion, r.serverVersion])
  return ''
}
