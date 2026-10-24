import { APP_VERSION } from '../../config.js'
import type { McpServer } from '../../types.js'
import { fetchWithProxy } from '../http-client.js'
import { McpCancelledError, type McpTool } from './client.js'

/**
 * 远程 MCP Server 的 Streamable HTTP 传输（MCP 2025-03-26）：
 * 每个 JSON-RPC 请求一次 POST，响应为 application/json 或 text/event-stream（取与请求 id 对应的那条消息）；
 * 服务端返回的 Mcp-Session-Id 在后续请求中带上；关闭时 DELETE 结束会话。
 * 只实现工具发现与调用；不支持服务端主动推送（GET 流）。
 */
const PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcMessage {
  id?: number | string
  method?: string
  result?: unknown
  error?: { code?: number; message?: string }
}

export class McpHttpConnection {
  private sessionId: string | null = null
  private nextId = 1
  private connected = false
  private controllers = new Set<AbortController>()
  tools: McpTool[] = []

  constructor(
    private readonly server: McpServer,
    private readonly onExit?: (error: Error) => void,
  ) {}

  get running(): boolean {
    return this.connected
  }

  get stderr(): string {
    return ''
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.server.headers,
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    return headers
  }

  async connect(): Promise<void> {
    if (this.connected) return
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'lulux-eta', version: APP_VERSION } }, 15_000)
    this.connected = true
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 10_000).catch(() => undefined)
    await this.reloadTools()
  }

  async reloadTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {}, 20_000)) as { tools?: McpTool[] }
    this.tools = Array.isArray(result?.tools) ? result.tools : []
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const raw = (await this.request('tools/call', { name, arguments: args }, timeoutMs, signal)) as {
      content?: Array<{ type?: string; text?: string }>
      structuredContent?: unknown
      isError?: boolean
    }
    const parts: string[] = []
    for (const item of raw?.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      else parts.push(`[${item.type ?? 'unknown'} 结果已省略]`)
    }
    if (parts.length === 0 && raw?.structuredContent !== undefined) parts.push(JSON.stringify(raw.structuredContent, null, 2))
    return { ok: !raw?.isError, text: parts.join('\n').trim() || '（工具没有返回文本内容）' }
  }

  close(): void {
    const wasConnected = this.connected
    this.connected = false
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    if (wasConnected && this.sessionId) {
      void fetchWithProxy(this.server.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => undefined)
    }
    this.sessionId = null
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const onAbort = (): void => controller.abort(new McpCancelledError('request'))
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await fetchWithProxy(this.server.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.controllers.delete(controller)
    }
  }

  private async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new McpCancelledError(method)
    const id = this.nextId
    this.nextId += 1
    let res: Response
    try {
      res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal)
    } catch (error) {
      if (signal?.aborted) {
        if (method !== 'initialize') void this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: '用户已取消' } }, 5000).catch(() => undefined)
        throw new McpCancelledError(method)
      }
      const message = error instanceof Error && error.message === 'timeout' ? `MCP 请求超时：${method}` : `无法连接远程 MCP「${this.server.name}」：${error instanceof Error ? error.message : String(error)}`
      throw new Error(message)
    }
    const session = res.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (res.status === 404 && this.sessionId && method !== 'initialize') {
      // 会话过期：标记断开，交给运行时下次重连
      this.connected = false
      const error = new Error(`远程 MCP「${this.server.name}」会话已失效，请重新连接`)
      this.onExit?.(error)
      throw error
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`远程 MCP「${this.server.name}」返回 HTTP ${res.status}${text ? `：${text}` : ''}`)
    }
    const type = res.headers.get('content-type') ?? ''
    let message: JsonRpcMessage | null = null
    if (type.includes('text/event-stream')) {
      const text = await res.text()
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        try {
          const parsed = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[]
          const list = Array.isArray(parsed) ? parsed : [parsed]
          const hit = list.find((item) => item.id === id)
          if (hit) {
            message = hit
            break
          }
        } catch {
          // 忽略非 JSON 事件
        }
      }
    } else {
      const parsed = (await res.json().catch(() => null)) as JsonRpcMessage | JsonRpcMessage[] | null
      const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      message = list.find((item) => item.id === id) ?? null
    }
    if (!message) throw new Error(`远程 MCP「${this.server.name}」没有返回 ${method} 的结果`)
    if (message.error) throw new Error(message.error.message || `JSON-RPC error ${message.error.code}`)
    return message.result
  }
}
