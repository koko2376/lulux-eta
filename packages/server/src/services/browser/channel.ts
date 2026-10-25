import { randomUUID } from 'node:crypto'
import { ToolError } from '../tools/tool-error.js'

/**
 * 与桌面主进程之间的内置浏览器通道（docs/browser-use.md「IPC 协议」）。
 * 服务进程由主进程以 `stdio: [..., 'ipc']` 启动，复用与 MCP 原生确认同一条 IPC：
 * 发 `{ type: 'lulux:browser-cmd', id, cmd }`，主进程回 `{ type: 'lulux:browser-result', id, ok, result|error }`。
 * 渲染进程无法接触这条通道。
 *
 * 所有异常都以 ToolError 结束（runTool 会把它转成给模型的文本结果）：
 * - 超时 / abort / 断开 → 清理 pending 并给出原因；
 * - 主进程返回 ok:false → 带上错误码（REF_STALE、PASSWORD_FIELD 等）。
 */

export interface BrowserCommandError {
  code: string
  message: string
}

export interface BrowserRequestOptions {
  /** 本次调用最长等待时间（毫秒），默认 30 秒（主进程侧的等待另有上限） */
  timeoutMs?: number
  /** 运行被停止 / 对话取消时中止等待 */
  signal?: AbortSignal
}

export interface BrowserChannel {
  available(): boolean
  request<T = unknown>(cmd: Record<string, unknown>, options?: BrowserRequestOptions): Promise<T>
}

/** 默认等待：主进程 open 最多等 15s、wait 最多 30s，这里留出余量 */
export const DEFAULT_BROWSER_TIMEOUT_MS = 45_000

interface IpcResult {
  type?: string
  id?: string
  ok?: boolean
  result?: unknown
  error?: BrowserCommandError
}

export function createIpcBrowserChannel(proc: NodeJS.Process = process): BrowserChannel {
  type Settle = (error: BrowserCommandError | null, value?: unknown) => void
  const pending = new Map<string, Settle>()
  let listening = false

  const failAll = (error: BrowserCommandError): void => {
    for (const [id, settle] of pending) {
      pending.delete(id)
      settle(error)
    }
  }

  const listen = (): void => {
    if (listening) return
    listening = true
    proc.on('message', (raw: unknown) => {
      const message = raw as IpcResult
      if (message?.type !== 'lulux:browser-result' || !message.id) return
      const settle = pending.get(message.id)
      if (!settle) return
      pending.delete(message.id)
      if (message.ok) settle(null, message.result)
      else settle({ code: message.error?.code || 'FAILED', message: message.error?.message || '浏览器操作失败' })
    })
    proc.on('disconnect', () => {
      failAll({ code: 'DISCONNECTED', message: '与桌面端的连接已断开，浏览器操作不可用' })
    })
  }

  return {
    available() {
      return typeof proc.send === 'function' && proc.connected === true
    },
    request<T = unknown>(cmd: Record<string, unknown>, options: BrowserRequestOptions = {}): Promise<T> {
      listen()
      const id = randomUUID()
      const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (error: BrowserCommandError | null, value?: unknown): void => {
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
          finish({ code: 'TIMEOUT', message: `浏览器操作超时（${Math.round(timeoutMs / 1000)} 秒）` })
        }, timeoutMs)
        timer.unref?.()
        if (options.signal?.aborted) {
          finish({ code: 'ABORTED', message: '已取消' })
          return
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, (error, value) => finish(error, value))
        try {
          proc.send!({ type: 'lulux:browser-cmd', id, cmd })
        } catch {
          pending.delete(id)
          finish({ code: 'DISCONNECTED', message: '无法与桌面端通信，浏览器操作不可用' })
        }
      })
    },
  }
}

let channel: BrowserChannel = createIpcBrowserChannel()

/** 测试 / 团队服务器模式注入（转发到发起人的桌面端）时替换 */
export function setBrowserChannel(next: BrowserChannel): void {
  channel = next
}

export function browserChannel(): BrowserChannel {
  return channel
}

/** 工具可用性：设置开关 + 通道可用 */
export function browserChannelAvailable(): boolean {
  return channel.available()
}
