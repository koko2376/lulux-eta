import { ProxyAgent } from 'undici'
import { settingsService } from './settings-service.js'

/**
 * 代理地址规范化：允许省略协议，统一补成 http://。
 * 仅支持 HTTP/HTTPS 代理（undici ProxyAgent 不支持 SOCKS）。
 */
export function normalizeProxyUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error('代理地址格式不正确，示例：http://127.0.0.1:7890')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('代理地址只支持 http:// 或 https://')
  }
  if (!url.hostname) {
    throw new Error('代理地址缺少主机名')
  }
  return url.toString().replace(/\/$/, '')
}

let cached: { url: string; agent: ProxyAgent | null } | null = null

function proxyDispatcher(): ProxyAgent | undefined {
  let url = ''
  try {
    url = normalizeProxyUrl(settingsService.get('proxyUrl') ?? '')
  } catch {
    // 设置里存了非法地址时退回直连，避免所有请求都失败
    return undefined
  }
  if (!url) return undefined
  if (cached?.url === url) return cached.agent ?? undefined

  let agent: ProxyAgent | null = null
  try {
    agent = new ProxyAgent(url)
  } catch {
    agent = null
  }
  // 地址变化时释放旧连接池
  void cached?.agent?.close().catch(() => undefined)
  cached = { url, agent }
  return agent ?? undefined
}

/** 所有出站请求（模型、模型发现、Webhook）统一从这里走，自动套用代理设置。 */
export function fetchWithProxy(
  url: string,
  init: RequestInit = {},
  /** 未配置代理时使用的 dispatcher（如 publicOnlyDispatcher：连接时校验解析地址） */
  directDispatcher?: unknown,
): Promise<Response> {
  // 出站请求只允许 http/https，防止 file:、data: 等协议被当作跳板
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    return Promise.reject(new Error(`地址格式不正确：${url.slice(0, 200)}`))
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return Promise.reject(new Error('出站请求只支持 http:// 或 https://'))
  }
  const dispatcher = proxyDispatcher()
  if (!dispatcher) return directDispatcher ? fetch(url, { ...init, dispatcher: directDispatcher } as RequestInit) : fetch(url, init)
  return fetch(url, { ...init, dispatcher } as RequestInit)
}
