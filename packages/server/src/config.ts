import { cpSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const LEGACY_DIR = join(homedir(), '.lulux-agent')
const DEFAULT_DIR = join(homedir(), '.lulux-eta')

/** 早期版本使用 lulux-agent 作为数据目录名，首次启动时迁移一次 */
function migrateLegacyHome(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
  }

  const oldDb = join(to, 'lulux-agent.db')
  if (!existsSync(oldDb)) return
  for (const suffix of ['', '-wal', '-shm']) {
    const file = oldDb + suffix
    if (existsSync(file)) renameSync(file, join(to, 'lulux-eta.db') + suffix)
  }
}

function resolveHome(): string {
  const custom = process.env.LULUX_ETA_HOME
  if (custom) return custom

  if (!existsSync(DEFAULT_DIR) && existsSync(LEGACY_DIR)) {
    migrateLegacyHome(LEGACY_DIR, DEFAULT_DIR)
  }
  return DEFAULT_DIR
}

export const APP_VERSION = '0.1.1'

/**
 * 能连接本服务端的最低客户端版本（低于它的客户端接口不兼容，必须先升级）。
 * 可用 LULUX_MIN_CLIENT_VERSION 覆盖；只接受 x.y.z。
 */
export const MIN_CLIENT_VERSION = /^\d+\.\d+\.\d+$/.test(process.env.LULUX_MIN_CLIENT_VERSION ?? '')
  ? process.env.LULUX_MIN_CLIENT_VERSION!
  : '0.1.0'

export type RunMode = 'desktop' | 'server'

function resolveMode(): RunMode {
  const raw = (process.env.LULUX_MODE || 'desktop').trim().toLowerCase()
  if (raw !== 'desktop' && raw !== 'server') {
    throw new Error(`LULUX_MODE 只能是 desktop 或 server（当前：${raw}）`)
  }
  return raw
}

/** LULUX_PUBLIC_ORIGIN：逗号分隔，规范化为 `scheme://host[:port]` */
export function parsePublicOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = new URL(item)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`LULUX_PUBLIC_ORIGIN 只支持 http(s)：${item}`)
      }
      return url.origin.toLowerCase()
    })
}

const mode = resolveMode()

export const config = {
  mode,
  host: process.env.LULUX_ETA_HOST || '127.0.0.1',
  port: envInt('LULUX_ETA_PORT', 51789),
  home: resolveHome(),
  clientDist: process.env.LULUX_ETA_CLIENT_DIST || '',
  version: APP_VERSION,
  isProduction: process.env.NODE_ENV === 'production',
  /** 内核安装源（环境变量默认值；设置项 kernelRegistry 优先，见 services/kernels/registry.ts） */
  kernelRegistry:
    process.env.LULUX_KERNEL_REGISTRY || 'https://registry.npmmirror.com',
  /** server 模式：允许的公开 origin（反向代理之后的 https 地址） */
  publicOrigins: parsePublicOrigins(process.env.LULUX_PUBLIC_ORIGIN),
  /** server 模式：信任 X-Forwarded-For */
  trustProxy: process.env.LULUX_TRUST_PROXY === '1',
  /** server 模式：是否放行桌面端本机界面 origin（http://127.0.0.1:* / http://localhost:*） */
  allowDesktopOrigins: process.env.LULUX_ALLOW_DESKTOP_ORIGINS !== '0',
  sessionIdleMs: envInt('LULUX_SESSION_IDLE_HOURS', 168) * 3600_000,
  sessionMaxMs: envInt('LULUX_SESSION_MAX_DAYS', 30) * 86400_000,
}

/** 开发态 Vite 页面的来源（仅 NODE_ENV!=='production' 时放行） */
export const DEV_ORIGINS = [
  'http://localhost:51790',
  'http://127.0.0.1:51790',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

/** 运行时信息：实际监听端口（测试里监听 0），由 createApp 注入 */
export const runtimeInfo = {
  getPort: (): number => config.port,
}
