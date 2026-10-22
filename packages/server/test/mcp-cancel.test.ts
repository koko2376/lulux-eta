import { afterEach, describe, expect, it } from 'vitest'
import { McpCancelledError, McpConnection } from '../src/services/mcp/client.js'

/**
 * MCP 取消：调用中止/超时时向 Server 发送 notifications/cancelled（MCP 规范 “Cancellation”）。
 * 最小 MCP server：slow 工具永不回应；log 工具返回目前收到的全部消息。
 */
const SERVER = `
  const seen = []
  const rl = require('readline').createInterface({ input: process.stdin })
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
  rl.on('line', (line) => {
    const msg = JSON.parse(line)
    seen.push(msg)
    if (msg.id === undefined) return
    if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } } })
    if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow', inputSchema: { type: 'object' } }, { name: 'log', inputSchema: { type: 'object' } }] } })
    if (msg.method === 'tools/call' && msg.params.name === 'log') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(seen) }] } })
    }
    // slow：不回应
  })`

let connection: McpConnection | null = null

afterEach(() => {
  connection?.close()
  connection = null
})

async function connect(): Promise<McpConnection> {
  connection = new McpConnection({
    id: 'm',
    name: 'cancel-test',
    command: process.execPath,
    args: ['-e', SERVER],
    env: {},
    enabled: true,
    approved: true,
    createdAt: 0,
  })
  await connection.connect()
  return connection
}

async function seen(conn: McpConnection): Promise<Array<{ id?: number; method?: string; params?: any }>> {
  return JSON.parse((await conn.callTool('log', {})).text)
}

describe('MCP 取消', () => {
  it('signal 中止时立即结束调用，并发送 notifications/cancelled（requestId 对应 tools/call 的 id）', async () => {
    const conn = await connect()
    const controller = new AbortController()
    const pending = conn.callTool('slow', {}, 60_000, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(McpCancelledError)
    expect(Date.now() - started).toBeLessThan(1000)

    const messages = await seen(conn)
    const call = messages.find((m) => m.method === 'tools/call' && m.params?.name === 'slow')
    const cancelled = messages.find((m) => m.method === 'notifications/cancelled')
    expect(call?.id).toBeTypeOf('number')
    expect(cancelled).toMatchObject({ params: { requestId: call!.id } })
    expect(cancelled!.id).toBeUndefined()
    expect(typeof cancelled!.params.reason).toBe('string')
  })

  it('超时也发送 notifications/cancelled', async () => {
    const conn = await connect()
    await expect(conn.callTool('slow', {}, 150)).rejects.toThrow(/超时/)
    const messages = await seen(conn)
    const call = messages.find((m) => m.method === 'tools/call' && m.params?.name === 'slow')
    expect(messages.filter((m) => m.method === 'notifications/cancelled')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ requestId: call!.id }) }),
    ])
  })

  it('已中止的 signal 不发请求；正常完成的调用不发 cancelled', async () => {
    const conn = await connect()
    const controller = new AbortController()
    controller.abort()
    await expect(conn.callTool('slow', {}, 60_000, controller.signal)).rejects.toBeInstanceOf(McpCancelledError)
    const late = new AbortController()
    await conn.callTool('log', {}, 5000, late.signal)
    late.abort()
    const messages = await seen(conn)
    expect(messages.some((m) => m.method === 'tools/call' && m.params?.name === 'slow')).toBe(false)
    expect(messages.some((m) => m.method === 'notifications/cancelled')).toBe(false)
  })
})
