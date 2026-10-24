import type { McpServer, ToolDefinition } from '../../types.js'
import { mcpService } from '../mcp-service.js'
import { serverSecurity } from '../auth-service.js'
import { McpConnection, type McpTool } from './client.js'
import { McpHttpConnection } from './http-client.js'

type AnyConnection = McpConnection | McpHttpConnection

export type McpServerStatus = 'stopped' | 'connecting' | 'connected' | 'error'

export interface McpServerState {
  status: McpServerStatus
  error: string
  tools: string[]
}

export interface ResolvedMcpTool extends ToolDefinition {
  /** 暴露给模型的名字 */
  name: string
  serverId: string
  serverName: string
  originalName: string
  /** 服务名的安全短名（LULUX MCP 桥用它给工具加 `<slug>__` 前缀） */
  serverSlug?: string
}

interface RuntimeEntry {
  status: McpServerStatus
  error: string
  tools: McpTool[]
  connection: AnyConnection | null
  attempt: Promise<void> | null
}

const MAX_RESULT_CHARS = 12_000
export const UNAPPROVED_MESSAGE = '该命令尚未经过确认，请点击“重新连接”并在确认对话框中允许后才会启动'

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

function serverSlug(server: McpServer): string {
  const slug = sanitize(server.name.toLowerCase()).replace(/^_+|_+$/g, '')
  return slug || server.id.slice(-6)
}

/**
 * MCP Server 子进程的运行时注册表：负责按需连接、缓存工具列表、
 * 把工具名加上服务前缀，并在进程退出后记录错误。
 */
class McpRuntime {
  private entries = new Map<string, RuntimeEntry>()

  private slot(id: string): RuntimeEntry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        status: 'stopped',
        error: '',
        tools: [],
        connection: null,
        attempt: null,
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  /** 与数据库里的配置对齐：删除的断开，禁用的停止，新增的连接 */
  sync(): void {
    // server 模式默认禁用 MCP：不启动任何子进程
    const servers = serverSecurity.mcpAllowed() ? mcpService.list() : []
    const alive = new Set(servers.map((server) => server.id))

    for (const [id, entry] of this.entries) {
      if (!alive.has(id)) {
        entry.connection?.close()
        this.entries.delete(id)
      }
    }

    for (const server of servers) {
      const entry = this.slot(server.id)
      if (server.enabled && !server.approved) {
        // 未经确认的命令（旧版本数据或被篡改）不启动
        entry.connection?.close()
        entry.connection = null
        entry.status = 'error'
        entry.error = UNAPPROVED_MESSAGE
        entry.tools = []
        continue
      }
      if (!server.enabled) {
        entry.connection?.close()
        entry.connection = null
        entry.status = 'stopped'
        entry.error = ''
        entry.tools = []
        continue
      }
      if (entry.status === 'stopped' || entry.status === 'error') {
        void this.ensureConnected(server).catch(() => undefined)
      }
    }
  }

  states(): Map<string, McpServerState> {
    const result = new Map<string, McpServerState>()
    for (const [id, entry] of this.entries) {
      result.set(id, {
        status: entry.status,
        error: entry.error,
        tools: entry.tools.map((tool) => tool.name),
      })
    }
    return result
  }

  async refresh(id: string): Promise<McpServerState | undefined> {
    const server = mcpService.get(id)
    if (!server) return undefined

    const entry = this.slot(id)
    // 先等正在进行的连接（例如刚 sync() 触发的）结束，再关闭重连；
    // 否则关闭会中止它的握手（HTTP 报 “This operation was aborted”），而重连又复用这次失败的 attempt。
    while (entry.attempt) await entry.attempt.catch(() => undefined)
    entry.connection?.close()
    entry.connection = null
    entry.tools = []
    entry.status = 'stopped'
    entry.error = ''

    if (server.enabled) {
      await this.ensureConnected(server).catch(() => undefined)
    }
    return this.states().get(id)
  }

  disconnect(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.connection?.close()
    entry.connection = null
    entry.status = 'stopped'
    entry.error = ''
    entry.tools = []
  }

  closeAll(): void {
    for (const entry of this.entries.values()) entry.connection?.close()
    this.entries.clear()
  }

  /** 汇总所有已连接 Server 的工具，供当前这一轮对话使用 */
  async toolDefinitions(): Promise<ResolvedMcpTool[]> {
    if (!serverSecurity.mcpAllowed()) return []
    const servers = mcpService
      .list()
      .filter((server) => server.enabled && server.approved)
      .sort((a, b) => a.createdAt - b.createdAt)

    const connected: Array<{ server: McpServer; tools: McpTool[] }> = []
    await Promise.all(
      servers.map(async (server) => {
        const entry = await this.ensureConnected(server).catch(() => null)
        if (entry?.status === 'connected') {
          connected.push({ server, tools: entry.tools })
        }
      }),
    )
    connected.sort((a, b) => a.server.createdAt - b.server.createdAt)

    const used = new Set<string>()
    const tools: ResolvedMcpTool[] = []
    for (const { server, tools: serverTools } of connected) {
      for (const tool of serverTools) {
        const base = `mcp_${serverSlug(server)}_${sanitize(tool.name)}`.slice(0, 60)
        let name = base
        let suffix = 2
        while (used.has(name)) {
          name = `${base.slice(0, 56)}_${suffix}`
          suffix += 1
        }
        used.add(name)

        tools.push({
          name,
          serverId: server.id,
          serverName: server.name,
          serverSlug: serverSlug(server),
          originalName: tool.name,
          description: tool.description ?? `${server.name} 提供的工具`,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {} },
        })
      }
    }
    return tools
  }

  async call(
    fullName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    text: string
    serverName: string
    toolName: string
  }> {
    const tools = await this.toolDefinitions()
    const target = tools.find((tool) => tool.name === fullName)
    if (!target) {
      throw new Error(`找不到工具 ${fullName}，MCP Server 可能已断开`)
    }

    const server = mcpService.get(target.serverId)
    const entry = server ? this.entries.get(server.id) : undefined
    if (!entry?.connection?.running) {
      throw new Error(`MCP Server「${target.serverName}」未连接`)
    }

    const result = await entry.connection.callTool(target.originalName, args, undefined, signal)
    const text =
      result.text.length > MAX_RESULT_CHARS
        ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n…（结果过长，已截断）`
        : result.text

    return {
      ok: result.ok,
      text,
      serverName: target.serverName,
      toolName: target.originalName,
    }
  }

  private async ensureConnected(server: McpServer): Promise<RuntimeEntry> {
    const entry = this.slot(server.id)
    if (!server.approved) {
      entry.status = 'error'
      entry.error = UNAPPROVED_MESSAGE
      return entry
    }
    if (entry.status === 'connected' && entry.connection?.running) {
      return entry
    }
    if (entry.attempt) {
      await entry.attempt
      return entry
    }

    entry.status = 'connecting'
    entry.error = ''

    const onExit = (error: Error): void => {
      if (entry.connection !== connection) return
      entry.status = 'error'
      entry.error = error.message
      entry.tools = []
      entry.connection = null
    }
    const connection: AnyConnection = server.transport === 'http' ? new McpHttpConnection(server, onExit) : new McpConnection(server, onExit)
    entry.connection = connection
    const attempt = (async () => {
      try {
        await connection.connect()
        if (entry.connection !== connection) {
          connection.close()
          return
        }
        entry.status = 'connected'
        entry.tools = connection.tools
        entry.error = ''
      } catch (error) {
        connection.close()
        // 连接已被替换（refresh/disconnect）时不要覆盖新状态
        if (entry.connection !== connection) return
        entry.status = 'error'
        entry.error = error instanceof Error ? error.message : String(error)
        entry.tools = []
        entry.connection = null
      }
    })()
    entry.attempt = attempt
    try {
      await attempt
    } finally {
      if (entry.attempt === attempt) entry.attempt = null
    }
    return entry
  }
}

export const mcpRuntime = new McpRuntime()
