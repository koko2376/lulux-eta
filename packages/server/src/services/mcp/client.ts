import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'cross-spawn'
import { killTree } from '../../utils/kill-tree.js'
import { APP_VERSION } from '../../config.js'
import type { McpServer } from '../../types.js'
import { buildMcpEnv, unsafeMcpCommandReason } from './spawn-env.js'

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'

/** 调用被调用方（对话停止）取消；已向 Server 发送 notifications/cancelled */
export class McpCancelledError extends Error {
  constructor(method: string) {
    super(`MCP 请求已取消：${method}`)
    this.name = 'McpCancelledError'
  }
}
const STDERR_LIMIT = 4000

/**
 * 不走 shell：cross-spawn 在 Windows 上负责解析 npx / uvx 这类 .cmd 包装器并做正确转义，
 * 参数不会被当成 shell 语法执行。环境变量只传白名单 + 用户为该 Server 配置的 env。
 */
function spawnServer(server: McpServer): ChildProcessWithoutNullStreams {
  // 已保存的配置也在每次启动前再查一遍（早期版本保存的、或被直接改库的）
  const unsafe = unsafeMcpCommandReason(server)
  if (unsafe) throw new Error(`MCP 命令不安全：${unsafe}`)
  return spawn(server.command, server.args, {
    cwd: process.cwd(),
    env: buildMcpEnv(server.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams
}

/**
 * 单个 MCP Server 的 stdio 连接：换行分隔的 JSON-RPC 2.0。
 * 只实现工具发现与调用所需的最小协议面。
 */
export class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stderrTail = ''

  tools: McpTool[] = []

  constructor(
    private readonly server: McpServer,
    /** 进程意外退出时通知上层更新状态 */
    private readonly onExit?: (error: Error) => void,
  ) {}

  get running(): boolean {
    return Boolean(
      this.child && this.child.exitCode === null && !this.child.killed,
    )
  }

  get stderr(): string {
    return this.stderrTail.trim()
  }

  async connect(): Promise<void> {
    if (this.running) return

    const child = spawnServer(this.server)
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_LIMIT)
    })
    child.on('error', (error) => {
      this.failAll(new Error(`无法启动 MCP Server「${this.server.name}」：${error.message}`))
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      const detail = this.stderrTail.trim()
      this.child = null
      const error = new Error(
        `MCP Server「${this.server.name}」已退出（code ${code ?? 'unknown'}）${
          detail ? `：${detail.split('\n').slice(-3).join(' | ')}` : ''
        }`,
      )
      this.failAll(error)
      this.onExit?.(error)
    })

    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lulux-eta', version: APP_VERSION },
      },
      10_000,
    )
    this.notify('notifications/initialized')
    await this.reloadTools()
  }

  async reloadTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {}, 15_000)) as {
      tools?: McpTool[]
    }
    this.tools = Array.isArray(result?.tools) ? result.tools : []
    return this.tools
  }

  /**
   * 调用工具。`signal` 中止（用户停止对话）或超时时，按 MCP 规范向 Server 发送
   * `notifications/cancelled { requestId, reason }`，并立即以错误结束本次调用；之后到达的响应被忽略。
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; text: string }> {
    const raw = (await this.request(
      'tools/call',
      { name, arguments: args },
      timeoutMs,
      signal,
    )) as {
      content?: Array<{ type?: string; text?: string }>
      structuredContent?: unknown
      isError?: boolean
    }

    const parts: string[] = []
    for (const item of raw.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if (item.type === 'image') {
        parts.push('[图片结果已省略]')
      } else if (item.type === 'resource') {
        parts.push('[资源结果已省略]')
      } else {
        parts.push(`[${item.type ?? 'unknown'} 结果]`)
      }
    }
    if (parts.length === 0 && raw.structuredContent !== undefined) {
      try {
        parts.push(JSON.stringify(raw.structuredContent, null, 2))
      } catch {
        parts.push(String(raw.structuredContent))
      }
    }

    return {
      ok: !raw.isError,
      text: parts.join('\n').trim() || '（工具没有返回文本内容）',
    }
  }

  close(): void {
    const child = this.child
    this.child = null
    this.failAll(new Error('MCP 连接已关闭'))
    if (!child || child.exitCode !== null) return

    killTree(child)
    const timer = setTimeout(() => {
      if (child.exitCode === null) killTree(child, 'SIGKILL')
    }, 1500)
    timer.unref()
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child?.stdin.writable) return
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.child
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('MCP 进程未运行'))
    }
    if (signal?.aborted) {
      return Promise.reject(new McpCancelledError(method))
    }

    const id = this.nextId
    this.nextId += 1

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      // initialize 不可取消（规范）；其余请求超时/中止时通知 Server 停止处理
      const cancel = (reason: string): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        if (method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason })
      }
      const onAbort = (): void => {
        cancel('用户已取消')
        reject(new McpCancelledError(method))
      }
      const timer = setTimeout(() => {
        cancel('请求超时')
        reject(new Error(`MCP 请求超时：${method}`))
      }, timeoutMs)
      timer.unref()

      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let boundary = this.buffer.indexOf('\n')
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary).trim()
      this.buffer = this.buffer.slice(boundary + 1)
      if (line) this.handleLine(line)
      boundary = this.buffer.indexOf('\n')
    }
    // 防止异常输出把内存撑大
    if (this.buffer.length > 4_000_000) this.buffer = ''
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    // Server 主动发起的请求：本轮不支持，明确拒绝，避免对方一直等待
    if (message.method && message.id !== undefined) {
      const reply = {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported by client' },
      }
      this.child?.stdin.write(`${JSON.stringify(reply)}\n`)
      return
    }

    const id = typeof message.id === 'number' ? message.id : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return

    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(
        new Error(message.error.message || `JSON-RPC error ${message.error.code}`),
      )
      return
    }
    pending.resolve(message.result)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
