import { randomUUID } from 'node:crypto'
import { ToolError } from '../tools/tool-error.js'

/**
 * 与桌面主进程之间的电脑操作通道（docs/computer-use.md「IPC 协议」）。
 * 与内置浏览器复用同一条 process IPC：
 * 发 `{ type: 'lulux:computer-cmd', id, cmd }`，主进程回 `{ type: 'lulux:computer-result', id, ok, result|error }`。
 *
 * 主进程还会主动发无 id 的通知 `{ type: 'lulux:computer-event', event: 'stop'|'pause', reason }`：
 * 这里只负责转给监听方（control 记录“当前持有电脑操作的会话”并据此暂停 / 停止），
 * 通道本身不关心是哪个会话。
 *
 * 所有异常都以 ToolError 结束（runTool 会把它转成给模型的文本结果）：
 * - 超时 / abort / 断开 → 清理 pending 并给出原因；
 * - 主进程返回 ok:false → 带上错误码（USER_INTERRUPT、STOPPED、PERMISSION 等，由 tools 映射成中文提示）。
 */

export interface ComputerCommandError {
  code: string
  message: string
}

export interface ComputerRequestOptions {
  /** 本次调用最长等待时间（毫秒），默认 45 秒（截屏可能慢一些，调用方可单独放宽） */
  timeoutMs?: number
  /** 运行被停止 / 对话取消时中止等待 */
  signal?: AbortSignal
}

/** 主进程主动通知（无 id） */
export interface ComputerEvent {
  event: 'stop' | 'pause'
  reason?: string
}

export interface ComputerChannel {
  available(): boolean
  request<T = unknown>(cmd: Record<string, unknown>, options?: ComputerRequestOptions): Promise<T>
}

export const DEFAULT_COMPUTER_TIMEOUT_MS = 45_000

type ComputerEventListener = (event: ComputerEvent) => void

const listeners = new Set<ComputerEventListener>()

/** 监听主进程的 stop / pause 通知；返回取消订阅 */
export function onComputerEvent(listener: ComputerEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 把通知交给监听方（IPC 通道收到消息时调用；测试也可直接调用） */
export function notifyComputerEvent(event: ComputerEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // 监听方自己处理异常，不能影响其它监听者
    }
  }
}

interface IpcMessage {
  type?: string
  id?: string
  ok?: boolean
  result?: unknown
  error?: ComputerCommandError
  event?: unknown
  reason?: unknown
}

export function createIpcComputerChannel(proc: NodeJS.Process = process): ComputerChannel {
  type Settle = (error: ComputerCommandError | null, value?: unknown) => void
  const pending = new Map<string, Settle>()
  let listening = false

  const failAll = (error: ComputerCommandError): void => {
    for (const [id, settle] of pending) {
      pending.delete(id)
      settle(error)
    }
  }

  const listen = (): void => {
    if (listening) return
    listening = true
    proc.on('message', (raw: unknown) => {
      const message = raw as IpcMessage
      if (message?.type === 'lulux:computer-event') {
        if (message.event === 'stop' || message.event === 'pause') {
          notifyComputerEvent({ event: message.event, reason: typeof message.reason === 'string' ? message.reason : undefined })
        }
        return
      }
      if (message?.type !== 'lulux:computer-result' || !message.id) return
      const settle = pending.get(message.id)
      if (!settle) return
      pending.delete(message.id)
      if (message.ok) settle(null, message.result)
      else settle({ code: message.error?.code || 'FAILED', message: message.error?.message || '电脑操作失败' })
    })
    proc.on('disconnect', () => {
      failAll({ code: 'DISCONNECTED', message: '与桌面端的连接已断开，电脑操作不可用' })
    })
  }

  return {
    available() {
      return typeof proc.send === 'function' && proc.connected === true
    },
    request<T = unknown>(cmd: Record<string, unknown>, options: ComputerRequestOptions = {}): Promise<T> {
      listen()
      const id = randomUUID()
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMPUTER_TIMEOUT_MS
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (error: ComputerCommandError | null, value?: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          if (error) reject(new ToolError(error.code === 'FAILED' ? error.message : `${error.code}：${error.message}`))
          else resolve(value as T)
        }
        const onAbort = (): void => {
          pending.delete(id)
          finish({ code: 'ABORTED', message: '已取消' })
        }
        const timer = setTimeout(() => {
          pending.delete(id)
          finish({ code: 'TIMEOUT', message: `电脑操作超时（${Math.round(timeoutMs / 1000)} 秒）` })
        }, timeoutMs)
        timer.unref?.()
        if (options.signal?.aborted) {
          finish({ code: 'ABORTED', message: '已取消' })
          return
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, (error, value) => finish(error, value))
        try {
          proc.send!({ type: 'lulux:computer-cmd', id, cmd })
        } catch {
          pending.delete(id)
          finish({ code: 'DISCONNECTED', message: '无法与桌面端通信，电脑操作不可用' })
        }
      })
    },
  }
}

let channel: ComputerChannel = createIpcComputerChannel()

/** 测试注入（以及将来转发到发起人的桌面端）时替换 */
export function setComputerChannel(next: ComputerChannel): void {
  channel = next
}

export function computerChannel(): ComputerChannel {
  return channel
}

/** 工具可用性：只判断通道（设置开关与“本会话已开启”由 tools 判断） */
export function computerChannelAvailable(): boolean {
  return channel.available()
}
