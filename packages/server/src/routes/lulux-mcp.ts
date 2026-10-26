import type Router from '@koa/router'
import type Koa from 'koa'
import { runtimeInfo } from '../config.js'
import { handleMcpMessage, luluxMcpTokens } from '../services/lulux-mcp/server.js'

const LOOPBACK_ADDRESS = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

function reject(ctx: Koa.Context, status: number, message: string): void {
  ctx.status = status
  ctx.body = { jsonrpc: '2.0', id: null, error: { code: -32001, message } }
}

/**
 * 内置 LULUX MCP（Streamable HTTP）：`POST /gateway/mcp`。与内核网关同样的访问控制：
 * 只接受本机回环 + Host=127.0.0.1/localhost:<port>，拒绝浏览器（Origin / Sec-Fetch-Site）与反向代理转发，
 * 必须带本次内核运行签发的一次性 MCP 令牌（Authorization: Bearer）。
 * 必须在 gatewayRoutes 之前注册（后者末尾有 /gateway/(.*) 兜底 404）。
 */
export function luluxMcpRoutes(router: Router): void {
  const guard = (ctx: Koa.Context) => {
    const port = runtimeInfo.getPort()
    const host = (ctx.get('host') || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reject(ctx, 403, 'LULUX MCP 只接受本机请求（Host 不允许）')
    if (!LOOPBACK_ADDRESS.test(ctx.req.socket.remoteAddress ?? '')) return reject(ctx, 403, 'LULUX MCP 只接受本机回环连接')
    if (ctx.get('origin') || ctx.get('sec-fetch-site')) return reject(ctx, 403, 'LULUX MCP 拒绝浏览器请求')
    if (ctx.get('x-forwarded-for') || ctx.get('forwarded')) return reject(ctx, 403, 'LULUX MCP 不接受经代理转发的请求')
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(ctx.get('authorization'))
    const target = luluxMcpTokens.resolve(bearer?.[1])
    if (!target) return reject(ctx, 401, 'LULUX MCP 令牌缺失或无效（令牌只在内核运行期间有效）')
    return target
  }

  router.post('/gateway/mcp', async (ctx) => {
    const target = guard(ctx)
    if (!target) return
    if (!ctx.is('application/json')) return reject(ctx, 415, '请求体只接受 application/json')
    const body = (ctx.request as unknown as { body?: unknown }).body
    const messages = Array.isArray(body) ? body : [body]
    if (messages.length === 0 || messages.length > 50) return reject(ctx, 400, 'Invalid Request')
    // 调用方（CLI）断开连接（它那边的工具超时 / 进程退出）：请求级信号中止，等待中的审批卡片随之作废
    const disconnected = new AbortController()
    const onClose = (): void => {
      if (!ctx.res.writableFinished) disconnected.abort()
    }
    ctx.res.once('close', onClose)
    const responses = []
    try {
      for (const message of messages) {
        const response = await handleMcpMessage(target, message as Record<string, never>, disconnected.signal)
        if (response) responses.push(response)
      }
    } finally {
      ctx.res.off('close', onClose)
    }
    if (responses.length === 0) {
      ctx.status = 202
      ctx.body = ''
      return
    }
    ctx.set('Cache-Control', 'no-store')
    ctx.body = Array.isArray(body) ? responses : responses[0]
  })
  // 不提供服务端主动推送流；会话无状态，DELETE 直接成功
  router.get('/gateway/mcp', (ctx) => {
    if (!guard(ctx)) return
    ctx.status = 405
    ctx.set('Allow', 'POST, DELETE')
    ctx.body = null
  })
  router.delete('/gateway/mcp', (ctx) => {
    if (!guard(ctx)) return
    ctx.status = 200
    ctx.body = null
  })
}
