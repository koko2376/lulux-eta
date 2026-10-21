import { AppError } from '../../errors.js'

/**
 * 按用户限制 /api/chat 发起的运行（server 模式）：
 * - maxConcurrent：同一用户同时进行中的对话运行数上限；
 * - perMinute：同一用户最近 60 秒内新发起的运行数上限。
 * 任一为 0 表示不限制。计数只在内存里（单进程服务），重启后清零。
 */
export interface ChatRateLimits {
  maxConcurrent: number
  perMinute: number
}

const WINDOW_MS = 60_000

const running = new Map<string, number>()
const started = new Map<string, number[]>()

function recent(key: string, now: number): number[] {
  const list = (started.get(key) ?? []).filter((ts) => now - ts < WINDOW_MS)
  if (list.length > 0) started.set(key, list)
  else started.delete(key)
  return list
}

/**
 * 占用一个运行名额；超限时抛 429 RATE_LIMITED（带 Retry-After）。
 * 返回释放函数（运行结束时调用，重复调用无副作用）。
 */
export function acquireChatSlot(key: string, limits: ChatRateLimits, now = Date.now()): () => void {
  const active = running.get(key) ?? 0
  if (limits.maxConcurrent > 0 && active >= limits.maxConcurrent) {
    const error = new AppError(
      429,
      'RATE_LIMITED',
      `你同时进行中的对话已达上限（${limits.maxConcurrent} 个），请等其中一个完成或先停止后再发送`,
    ) as AppError & { retryAfter?: number }
    error.retryAfter = 5
    throw error
  }
  const list = recent(key, now)
  if (limits.perMinute > 0 && list.length >= limits.perMinute) {
    const waitMs = WINDOW_MS - (now - list[0]!)
    const seconds = Math.max(1, Math.ceil(waitMs / 1000))
    const error = new AppError(
      429,
      'RATE_LIMITED',
      `发送太频繁：每分钟最多发起 ${limits.perMinute} 次对话，请约 ${seconds} 秒后再试`,
    ) as AppError & { retryAfter?: number }
    error.retryAfter = seconds
    throw error
  }
  list.push(now)
  started.set(key, list)
  running.set(key, active + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (running.get(key) ?? 1) - 1
    if (next > 0) running.set(key, next)
    else running.delete(key)
  }
}

/** 测试用：清空计数 */
export function resetChatRateLimits(): void {
  running.clear()
  started.clear()
}
