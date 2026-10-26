import { BlockList, isIP } from 'node:net'

/**
 * 反向代理后的客户端地址。
 *
 * X-Forwarded-For 里每经过一层代理就在末尾追加一个地址，最左边的值是客户端自己填的，可以随意伪造，
 * 所以不能取最左值（否则换一个伪造值就能绕过按 IP 的登录限流，审计里的 IP 也不可信）。两种取法：
 * - 配了可信代理列表（LULUX_TRUSTED_PROXIES，IP 或 CIDR，逗号分隔）：把 socket 对端地址接在链尾，
 *   从右往左跳过可信代理，取第一个不可信的地址；
 * - 只配了跳数（LULUX_TRUST_PROXY=1 表示一层代理，=2 表示两层……）：从右往左数，取紧挨在这几层代理之前的那个地址。
 */

export interface ProxyTrust {
  /** 信任的代理层数（0 = 不信任转发头） */
  hops: number
  /** 可信代理地址列表；设置后按列表判断，忽略 hops */
  trusted: BlockList | null
}

/** 去掉端口与方括号，IPv4 映射的 IPv6 地址还原成 IPv4 */
export function normalizeIp(raw: string): string {
  let value = raw.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed) value = bracketed[1]!
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'))
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)
  if (mapped) value = mapped[1]!
  return value
}

export function parseTrustedProxies(raw: string | undefined): BlockList | null {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (items.length === 0) return null
  const list = new BlockList()
  for (const item of items) {
    const [address, bits] = item.split('/')
    const ip = normalizeIp(address ?? '')
    const family = isIP(ip)
    if (!family) throw new Error(`LULUX_TRUSTED_PROXIES 里的地址不正确：${item}`)
    const type = family === 6 ? 'ipv6' : 'ipv4'
    if (bits === undefined) list.addAddress(ip, type)
    else {
      const prefix = Number(bits)
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`LULUX_TRUSTED_PROXIES 里的网段不正确：${item}`)
      list.addSubnet(ip, prefix, type)
    }
  }
  return list
}

export function parseProxyHops(raw: string | undefined): number {
  const value = (raw ?? '').trim()
  if (!value || value === '0') return 0
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? Math.min(hops, 20) : 0
}

function isTrusted(list: BlockList, ip: string): boolean {
  const family = isIP(ip)
  if (!family) return false
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

export function resolveClientIp(remoteAddress: string, forwardedFor: string, trust: ProxyTrust): string {
  // 不信任代理时原样用 socket 对端地址（与以前一致）
  if (!trust.trusted && trust.hops <= 0) return remoteAddress
  const remote = normalizeIp(remoteAddress)
  const forwarded = forwardedFor
    .split(',')
    .map((item) => normalizeIp(item))
    .filter(Boolean)
  const chain = [...forwarded, remote]
  let candidate: string | undefined
  if (trust.trusted) {
    // 从右往左，第一个不是可信代理的地址；全部可信时取最左边
    candidate = chain[0]
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (!isTrusted(trust.trusted, chain[i]!)) {
        candidate = chain[i]
        break
      }
    }
  } else {
    // 链尾是最后一层代理（socket 对端）；往左数 hops 个
    candidate = chain[Math.max(0, chain.length - 1 - trust.hops)]
  }
  // 转发头里不是合法 IP 的值（如 unknown）不采信
  return candidate && isIP(candidate) ? candidate : remote
}
