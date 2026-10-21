import type { ReasoningEffort } from '../llm/types.js'
import { createHash, randomBytes } from 'node:crypto'

/**
 * 网关一次性令牌。每次内核运行签发一个（随机 32 字节），绑定 Provider 与模型，
 * 只在该进程生命周期内有效（运行结束即吊销）。表里只存令牌的 SHA-256，不存明文。
 * 真实 Provider Key 从不交给 CLI：网关在转发时才从 providerService 读取。
 */
export interface GatewayTarget {
  providerId: string
  /** 会话选定的模型（Provider 的默认模型或会话指定的模型） */
  model: string
  kernelId: string
  sessionId: string
  /** 会话推理强度（契约 §6.13）：转发时给 OpenAI 系推理模型加 reasoning_effort；null = 不改 */
  reasoningEffort?: ReasoningEffort | null
  createdAt: number
  /** 最近一次上游错误，内核失败时用来给出更明确的原因 */
  lastError: string | null
  requests: number
}

export interface IssuedToken {
  token: string
  target: GatewayTarget
  revoke(): void
}

const targets = new Map<string, GatewayTarget>()
/** 兜底：令牌最长存活时间（防止异常路径漏吊销） */
const MAX_TTL_MS = 6 * 3600_000

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function sweep(): void {
  const now = Date.now()
  for (const [key, target] of targets) if (now - target.createdAt > MAX_TTL_MS) targets.delete(key)
}

export const gatewayTokens = {
  issue(input: Omit<GatewayTarget, 'createdAt' | 'lastError' | 'requests'>): IssuedToken {
    sweep()
    const token = `lulux-gw-${randomBytes(32).toString('hex')}`
    const key = digest(token)
    const target: GatewayTarget = { ...input, createdAt: Date.now(), lastError: null, requests: 0 }
    targets.set(key, target)
    return { token, target, revoke: () => void targets.delete(key) }
  },

  /** 查表用摘要做键，比较时间与令牌内容无关 */
  resolve(token: string | null | undefined): GatewayTarget | null {
    if (!token || token.length > 200) return null
    const target = targets.get(digest(token))
    if (!target) return null
    if (Date.now() - target.createdAt > MAX_TTL_MS) {
      targets.delete(digest(token))
      return null
    }
    return target
  },

  size(): number {
    return targets.size
  },

  /** 仅测试用 */
  clear(): void {
    targets.clear()
  },
}
