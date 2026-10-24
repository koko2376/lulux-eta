import { db } from '../db.js'
import type { McpServer } from '../types.js'
import { newId } from '../utils/id.js'
import { decryptSecret, encryptSecret } from '../security/secrets.js'
import { commandHash } from './mcp/confirm.js'

interface McpRow {
  id: string
  name: string
  command: string
  args: string
  env: string
  enabled: number
  approved_hash: string | null
  created_at: number
  transport?: string | null
  url?: string | null
  headers?: string | null
  created_by?: string | null
}

function decodeHeaders(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const plain = decryptSecret(raw)
    const parsed = JSON.parse(plain) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    }
  } catch {
    // 主密钥变化：头信息不可用，连接时会被服务端拒绝
  }
  return {}
}

function encodeHeaders(headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return ''
  return encryptSecret(JSON.stringify(headers))
}

/** 远程 MCP 的“确认指纹”：地址 + 头部键名（值变化不要求重新确认） */
export function httpSpec(url: string, headers: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } {
  return { command: `http:${url}`, args: [], env: Object.fromEntries(Object.keys(headers).sort().map((k) => [k, ''])) }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toMcpServer(row: McpRow): McpServer {
  const args = parseJson<unknown>(row.args, [])
  const env = parseJson<unknown>(row.env, {})
  const server = {
    id: row.id,
    name: row.name,
    command: row.command,
    args: Array.isArray(args) ? args.map(String) : [],
    env:
      env && typeof env === 'object' && !Array.isArray(env)
        ? Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    enabled: Number(row.enabled) === 1,
    approved: false,
    createdAt: row.created_at,
    transport: (row.transport === 'http' ? 'http' : 'stdio') as 'stdio' | 'http',
    url: row.url ?? '',
    headers: decodeHeaders(row.headers),
    createdBy: (row.created_by === 'agent' ? 'agent' : 'user') as 'user' | 'agent',
  }
  const spec = server.transport === 'http' ? httpSpec(server.url, server.headers) : server
  server.approved = Boolean(row.approved_hash) && row.approved_hash === commandHash(spec)
  return server
}

export interface CreateMcpInput {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  /** 远程 HTTP MCP（与 command 二选一） */
  url?: string
  headers?: Record<string, string>
  createdBy?: 'user' | 'agent'
}

/** 对外结构：不返回 http 头的值 */
export function publicMcpServer(server: McpServer): Omit<McpServer, 'headers'> & { headerKeys: string[] } {
  const { headers, ...rest } = server
  return { ...rest, headerKeys: Object.keys(headers) }
}

export const mcpService = {
  list(): McpServer[] {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as unknown as McpRow[]
    return rows.map(toMcpServer)
  },

  get(id: string): McpServer | undefined {
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as McpRow | undefined
    return row ? toMcpServer(row) : undefined
  },

  /** 只在命令已确认后调用；approved_hash 记录确认时的命令指纹 */
  create(input: CreateMcpInput): McpServer {
    const http = Boolean(input.url)
    const spec = http
      ? { command: '', args: [] as string[], env: {} as Record<string, string> }
      : { command: (input.command ?? '').trim(), args: input.args ?? [], env: input.env ?? {} }
    const headers = http ? (input.headers ?? {}) : {}
    const approvedHash = http ? commandHash(httpSpec(input.url!.trim(), headers)) : commandHash(spec)
    const id = newId('mcp')
    db.prepare(
      `INSERT INTO mcp_servers (id, name, command, args, env, enabled, approved_hash, created_at, transport, url, headers, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      spec.command,
      JSON.stringify(spec.args),
      JSON.stringify(spec.env),
      (input.enabled ?? true) ? 1 : 0,
      approvedHash,
      Date.now(),
      http ? 'http' : 'stdio',
      http ? input.url!.trim() : '',
      encodeHeaders(headers),
      input.createdBy ?? 'user',
    )
    return mcpService.get(id)!
  },

  /** 计算补丁后的配置（不写库），用于判断是否需要重新确认 */
  preview(id: string, patch: Partial<CreateMcpInput>): McpServer | undefined {
    const current = mcpService.get(id)
    if (!current) return undefined
    return {
      ...current,
      name: patch.name?.trim() || current.name,
      command: current.transport === 'http' ? '' : patch.command?.trim() || current.command,
      args: current.transport === 'http' ? [] : (patch.args ?? current.args),
      env: current.transport === 'http' ? {} : (patch.env ?? current.env),
      enabled: patch.enabled ?? current.enabled,
      url: current.transport === 'http' ? patch.url?.trim() || current.url : '',
      headers: current.transport === 'http' ? (patch.headers ?? current.headers) : {},
    }
  },

  update(id: string, patch: Partial<CreateMcpInput>, approve: boolean): McpServer | undefined {
    const next = mcpService.preview(id, patch)
    if (!next) return undefined
    const row = db.prepare('SELECT approved_hash FROM mcp_servers WHERE id = ?').get(id) as unknown as {
      approved_hash: string | null
    }
    const spec = next.transport === 'http' ? httpSpec(next.url, next.headers) : next
    db.prepare(
      `UPDATE mcp_servers
       SET name = ?, command = ?, args = ?, env = ?, enabled = ?, approved_hash = ?, url = ?, headers = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.command,
      JSON.stringify(next.args),
      JSON.stringify(next.env),
      next.enabled ? 1 : 0,
      approve ? commandHash(spec) : row.approved_hash,
      next.url,
      encodeHeaders(next.headers),
      id,
    )
    return mcpService.get(id)
  },

  approve(id: string): McpServer | undefined {
    const current = mcpService.get(id)
    if (!current) return undefined
    const spec = current.transport === 'http' ? httpSpec(current.url, current.headers) : current
    db.prepare('UPDATE mcp_servers SET approved_hash = ? WHERE id = ?').run(commandHash(spec), id)
    return mcpService.get(id)
  },

  remove(id: string): boolean {
    const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return Number(result.changes) > 0
  },
}
