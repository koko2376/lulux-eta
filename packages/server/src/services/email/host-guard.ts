import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config } from '../../config.js'
import { AppError } from '../../errors.js'
import { isPrivateAddress } from '../tools/net-guard.js'

/**
 * 邮件服务器出站地址校验（团队服务器模式）。
 *
 * 任何有 data:write 的成员都能填 IMAP/SMTP 主机并让服务器去连，所以 server 模式下：
 * - 主机解析后的地址落在本机 / 内网 / 链路本地 / 保留网段，一律拒绝（防止把服务器当跳板探测内网、读云元数据）；
 * - 解析一次后把连接钉在校验过的 IP 上（TLS 仍按原主机名做 SNI 与证书校验），
 *   避免“校验时解析到公网、连接时又解析到内网”的 DNS 重绑定；
 * - 确需连接内网邮件服务器的部署，由运维在环境变量 LULUX_EMAIL_ALLOW_PRIVATE_HOSTS 里显式列出主机名或 IP（逗号分隔）。
 * desktop 模式是用户自己的电脑，不做限制（本机邮件网关、内网邮件服务器都是正常用法）。
 */

export interface PinnedHost {
  /** 实际连接的地址（server 模式下是校验过的 IP） */
  address: string
  /** 地址被钉成 IP 时，TLS 用来做 SNI 与证书校验的原主机名 */
  servername?: string
  /** 是否在白名单里（白名单里的回环地址保留桌面端的放宽规则） */
  allowlisted: boolean
}

function stripBrackets(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '')
}

export function allowlistedMailHosts(): Set<string> {
  return new Set(
    (process.env.LULUX_EMAIL_ALLOW_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((item) => stripBrackets(item).toLowerCase())
      .filter(Boolean),
  )
}

function forbidden(): AppError {
  return new AppError(
    400,
    'EMAIL_HOST_FORBIDDEN',
    '邮件服务器地址指向本机或内网，团队服务器不允许连接（如确需连接内网邮件服务器，请由运维在部署配置中加入白名单）',
  )
}

/** 名字本身就表明是本机 / 内网的主机，不必解析直接拒绝 */
function obviouslyInternal(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
}

export async function pinMailHost(rawHost: string, protocol: 'IMAP' | 'SMTP'): Promise<PinnedHost> {
  const host = stripBrackets(rawHost)
  if (config.mode !== 'server') return { address: host, allowlisted: false }
  const lower = host.toLowerCase()
  if (allowlistedMailHosts().has(lower)) return { address: host, allowlisted: true }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw forbidden()
    return { address: host, allowlisted: false }
  }
  if (obviouslyInternal(lower)) throw forbidden()
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new AppError(502, 'EMAIL_CONNECT_FAILED', `${protocol} 连接失败：无法解析主机名`)
  }
  // 任一解析结果是内网地址就拒绝（不挑一个公网地址放行：攻击者可以让同一个名字同时解析到公网和内网）
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) throw forbidden()
  return { address: addresses[0]!.address, servername: host, allowlisted: false }
}
