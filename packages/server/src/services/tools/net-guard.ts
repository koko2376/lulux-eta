import { lookup as dnsLookup } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { ToolError } from './tool-error.js'

/**
 * fetch_url 的出站校验：只允许 http/https，拒绝本机、内网、链路本地、组播等地址
 * （防止模型被网页内容诱导去访问本机 API、路由器后台或云元数据服务）。
 * 测试/特殊部署可用环境变量 LULUX_FETCH_ALLOW_PRIVATE=1 放开（不提供界面开关）。
 */
function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    const value = ipv4ToInt(ip)
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (value & mask) === (ipv4ToInt(base) & mask)
    })
  }
  if (version === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (lower === '::' || lower === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped) return isPrivateAddress(mapped[1]!)
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
    if (mappedHex) {
      const hi = Number.parseInt(mappedHex[1]!, 16)
      const lo = Number.parseInt(mappedHex[2]!, 16)
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    const first = Number.parseInt(lower.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
    if ((first & 0xff00) === 0xff00) return true // 组播
    if (lower.startsWith('64:ff9b:')) return true // NAT64，可能映射内网
    return false
  }
  return true
}

function allowPrivate(): boolean {
  return process.env.LULUX_FETCH_ALLOW_PRIVATE === '1'
}

/** 校验 URL；hostname 会做 DNS 解析，任一地址落在私有网段即拒绝 */
export async function assertPublicHttpUrl(raw: string, options: { viaProxy?: boolean } = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError(`网址格式不正确：${raw.slice(0, 200)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`只支持 http:// 和 https:// 网址（收到 ${url.protocol}）`)
  }
  if (url.username || url.password) throw new ToolError('网址不能包含用户名或密码')
  if (allowPrivate()) return url
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new ToolError('网址缺少主机名')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new ToolError('不允许访问本机或内网地址')
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ToolError('不允许访问本机或内网地址')
    return url
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch (error) {
    // 只能经代理上网的环境本地可能解析不了：交给代理
    if (options.viaProxy) return url
    throw new ToolError(`无法解析域名 ${host}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ToolError(`域名 ${host} 指向本机或内网地址，已拒绝`)
  }
  return url
}

/**
 * 连接时再校验一次解析结果（防 DNS rebinding：assertPublicHttpUrl 解析时是公网地址，真正连接时域名已改指向内网）。
 * 直连（未配置代理）的出站抓取用这个 dispatcher；任一解析地址是私有网段即拒绝连接。
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as unknown as Array<{ address: string; family: number }>
    if (!allowPrivate() && list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error(`域名 ${hostname} 指向本机或内网地址，已拒绝`), { code: 'EPRIVATEADDR' }), '', 0)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    const first = list[0]
    if (!first) return callback(Object.assign(new Error(`无法解析域名 ${hostname}`), { code: 'ENOTFOUND' }), '', 0)
    callback(null, first.address, first.family)
  })
}

let guardedAgent: Agent | null = null
export function publicOnlyDispatcher(): Agent {
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup } })
  return guardedAgent
}
