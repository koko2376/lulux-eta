import { config } from '../../config.js'
import { settingsService } from '../settings-service.js'

export const DEFAULT_KERNEL_REGISTRY = 'https://registry.npmmirror.com'
export const FALLBACK_KERNEL_REGISTRY = 'https://registry.npmjs.org'

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** 校验并规范化 registry 地址（设置项 kernelRegistry）；空串表示使用默认 */
export function normalizeRegistryUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('必须是 http(s) 地址，例如 https://registry.npmmirror.com')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 地址')
  if (parsed.username || parsed.password) throw new Error('不要在地址里包含账号密码')
  return normalize(parsed.toString())
}

/**
 * 内核安装源（按顺序尝试）：
 * 1. 设置 `kernelRegistry`（用户在界面里填的）> 环境变量 LULUX_KERNEL_REGISTRY > 默认 npmmirror；
 * 2. 回退源：环境变量 LULUX_KERNEL_REGISTRY_FALLBACK（`off` 关闭）> 默认 registry.npmjs.org。
 * 首选与回退相同时只有一个。
 */
export function kernelRegistries(): string[] {
  let primary = ''
  try {
    primary = settingsService.get('kernelRegistry') ?? ''
  } catch {
    primary = ''
  }
  primary = normalize(primary || config.kernelRegistry || DEFAULT_KERNEL_REGISTRY)
  const fallbackEnv = process.env.LULUX_KERNEL_REGISTRY_FALLBACK?.trim()
  const list = [primary]
  if (fallbackEnv?.toLowerCase() !== 'off') {
    const fallback = normalize(fallbackEnv || FALLBACK_KERNEL_REGISTRY)
    if (fallback && fallback !== primary) list.push(fallback)
  }
  return list
}
