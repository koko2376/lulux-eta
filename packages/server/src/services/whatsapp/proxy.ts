import { readFileSync, rmSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { AppError } from '../../errors.js'
import { decryptSecret, encryptSecret } from '../../security/secrets.js'
import { accountDir, writePrivateJson } from './credential-store.js'

/**
 * 每个 WhatsApp 号单独的出口代理。
 *
 * 国内服务器直连不到 WhatsApp，同一个出口 IP 登录多个号也容易被关联，所以每个号可以单独配一个代理
 * （建议固定住宅 IP）。配置存在该号的账号目录里，密码用主密钥加密，不回传给前端。
 */
export type WhatsAppProxyProtocol = 'socks5' | 'http' | 'https'
export const WHATSAPP_PROXY_PROTOCOLS: WhatsAppProxyProtocol[] = ['socks5', 'http', 'https']

export interface WhatsAppProxyInput {
  protocol: WhatsAppProxyProtocol
  host: string
  port: number
  username?: string
  /** 不传 = 保留原密码；空字符串 = 清除密码 */
  password?: string
}

interface StoredProxy {
  protocol: WhatsAppProxyProtocol
  host: string
  port: number
  username: string
  password: string
  updatedAt: string
}

export interface WhatsAppProxyView {
  protocol: WhatsAppProxyProtocol
  host: string
  port: number
  username: string
  hasPassword: boolean
  updatedAt: string
}

export interface WhatsAppProxyTestResult {
  ok: boolean
  ip?: string
  country?: string
  city?: string
  latencyMs?: number
  error?: string
}

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:]{2,45}\]?$/

function proxyFile(accountId: string): string {
  return join(accountDir(accountId), 'proxy.json')
}

function readStored(accountId: string): StoredProxy | null {
  try {
    const raw = JSON.parse(readFileSync(proxyFile(accountId), 'utf8')) as Partial<StoredProxy>
    if (!raw.host || !raw.port || !WHATSAPP_PROXY_PROTOCOLS.includes(raw.protocol as WhatsAppProxyProtocol)) return null
    return {
      protocol: raw.protocol as WhatsAppProxyProtocol,
      host: raw.host,
      port: Number(raw.port),
      username: raw.username ?? '',
      password: raw.password ?? '',
      updatedAt: raw.updatedAt ?? '',
    }
  } catch {
    return null
  }
}

function toView(stored: StoredProxy | null): WhatsAppProxyView | null {
  if (!stored) return null
  return {
    protocol: stored.protocol,
    host: stored.host,
    port: stored.port,
    username: stored.username,
    hasPassword: Boolean(stored.password),
    updatedAt: stored.updatedAt,
  }
}

function validate(input: WhatsAppProxyInput): void {
  if (!WHATSAPP_PROXY_PROTOCOLS.includes(input.protocol))
    throw new AppError(400, 'WHATSAPP_PROXY_INVALID', '代理类型只支持 socks5、http、https')
  if (!HOST_RE.test(input.host.trim()))
    throw new AppError(400, 'WHATSAPP_PROXY_INVALID', '代理地址格式不正确')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw new AppError(400, 'WHATSAPP_PROXY_INVALID', '代理端口应在 1 到 65535 之间')
}

export function readProxy(accountId: string): WhatsAppProxyView | null {
  return toView(readStored(accountId))
}

export function saveProxy(accountId: string, input: WhatsAppProxyInput, now = new Date()): WhatsAppProxyView {
  validate(input)
  const prev = readStored(accountId)
  const password =
    input.password === undefined ? (prev?.password ?? '') : input.password ? encryptSecret(input.password) : ''
  const stored: StoredProxy = {
    protocol: input.protocol,
    host: input.host.trim().replace(/^\[|\]$/g, ''),
    port: input.port,
    username: (input.username ?? '').trim(),
    password,
    updatedAt: now.toISOString(),
  }
  writePrivateJson(proxyFile(accountId), stored)
  return toView(stored)!
}

export function clearProxy(accountId: string): void {
  rmSync(proxyFile(accountId), { force: true })
}

function proxyUrl(stored: StoredProxy, plainPassword: string): string {
  const scheme = stored.protocol === 'socks5' ? 'socks5h' : stored.protocol
  const host = stored.host.includes(':') ? `[${stored.host}]` : stored.host
  const auth = stored.username
    ? `${encodeURIComponent(stored.username)}${plainPassword ? `:${encodeURIComponent(plainPassword)}` : ''}@`
    : ''
  return `${scheme}://${auth}${host}:${stored.port}`
}

function agentFor(stored: StoredProxy): Agent {
  const password = stored.password ? decryptSecret(stored.password) : ''
  const url = proxyUrl(stored, password)
  return (stored.protocol === 'socks5' ? new SocksProxyAgent(url) : new HttpsProxyAgent(url)) as unknown as Agent
}

/** 给引擎用的代理 Agent；没配代理返回 null（直连） */
export function proxyAgent(accountId: string): Agent | null {
  const stored = readStored(accountId)
  return stored ? agentFor(stored) : null
}

/** 经代理访问一个查 IP 的接口，返回出口 IP 与国家 */
export async function testProxy(
  accountId: string,
  input?: WhatsAppProxyInput,
  timeoutMs = 15_000,
): Promise<WhatsAppProxyTestResult> {
  let stored: StoredProxy | null
  if (input) {
    validate(input)
    const prev = readStored(accountId)
    stored = {
      protocol: input.protocol,
      host: input.host.trim().replace(/^\[|\]$/g, ''),
      port: input.port,
      username: (input.username ?? '').trim(),
      password: input.password === undefined ? (prev?.password ?? '') : input.password ? encryptSecret(input.password) : '',
      updatedAt: '',
    }
  } else stored = readStored(accountId)
  if (!stored) throw new AppError(400, 'WHATSAPP_PROXY_INVALID', '还没有配置代理')
  const agent = agentFor(stored)
  const started = Date.now()
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest('https://ipinfo.io/json', { agent, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          data += chunk
          if (data.length > 64_000) req.destroy(new Error('响应过大'))
        })
        res.on('end', () => (res.statusCode && res.statusCode < 400 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`))))
      })
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', reject)
      req.end()
    })
    const info = JSON.parse(body) as { ip?: string; country?: string; city?: string }
    return { ok: true, ip: info.ip, country: info.country, city: info.city, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started }
  } finally {
    agent.destroy?.()
  }
}
