import type Router from '@koa/router'
import type Koa from 'koa'
import { runtimeInfo } from '../config.js'
import { messageOf } from '../errors.js'
import {
  anthropicError,
  anthropicMessageFrom,
  AnthropicStreamEncoder,
  anthropicToCanonical,
} from '../services/gateway/anthropic.js'
import { geminiError, geminiResponseFrom, GeminiStreamEncoder, geminiToCanonical } from '../services/gateway/gemini.js'
import { chatCompletionFrom, ChatStreamEncoder, chatToCanonical, openAIError } from '../services/gateway/openai-chat.js'
import { responsesFrom, ResponsesStreamEncoder, responsesToCanonical } from '../services/gateway/responses.js'
import { gatewayTokens, type GatewayTarget } from '../services/gateway/tokens.js'
import { estimateRequestTokens, asRecord, type CanonicalRequest, type StreamEvent } from '../services/gateway/types.js'
import {
  ensureChatFinish,
  GatewayError,
  listedModels,
  passthrough,
  resolveRoute,
  streamUpstream,
  type ResolvedRoute,
} from '../services/gateway/upstream.js'

type Protocol = 'anthropic' | 'openai' | 'gemini'

const LOOPBACK_ADDRESS = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

function errorPayload(protocol: Protocol, status: number, message: string): Record<string, unknown> {
  if (protocol === 'anthropic') return anthropicError(status, message)
  if (protocol === 'gemini') return geminiError(status, message)
  return openAIError(status, message)
}

function tokenOf(ctx: Koa.Context): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(ctx.get('authorization'))
  if (bearer) return bearer[1]!
  const header = ctx.get('x-api-key') || ctx.get('x-goog-api-key')
  if (header) return header.trim()
  const key = ctx.query.key
  return typeof key === 'string' ? key : null
}

/**
 * 网关访问控制（契约“内核网关”）：
 * - 只接受本机回环连接，Host 必须是 127.0.0.1:<port> / localhost:<port>（server 模式也一样，不接受公开域名）
 * - 拒绝任何浏览器请求：带 Origin 或 Sec-Fetch-Site 头的一律 403；经反向代理（X-Forwarded-For / Forwarded）的一律 403
 * - 必须带本次内核运行签发的一次性令牌（Authorization: Bearer / x-api-key / x-goog-api-key / ?key=）
 */
function authorize(ctx: Koa.Context): GatewayTarget {
  const port = runtimeInfo.getPort()
  const host = (ctx.get('host') || '').toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new GatewayError(403, '网关只接受本机请求（Host 不允许）')
  const remote = ctx.req.socket.remoteAddress ?? ''
  if (!LOOPBACK_ADDRESS.test(remote)) throw new GatewayError(403, '网关只接受本机回环连接')
  if (ctx.get('origin')) throw new GatewayError(403, '网关拒绝浏览器请求（带 Origin）')
  // 浏览器总会带 Sec-Fetch-Site（Node 的 fetch 只带 Sec-Fetch-Mode，不能用它判断）
  if (ctx.get('sec-fetch-site')) throw new GatewayError(403, '网关拒绝浏览器请求')
  if (ctx.get('x-forwarded-for') || ctx.get('forwarded')) throw new GatewayError(403, '网关不接受经代理转发的请求')
  const target = gatewayTokens.resolve(tokenOf(ctx))
  if (!target) throw new GatewayError(401, '网关令牌缺失或无效（令牌只在内核运行期间有效）')
  return target
}

type Handler = (ctx: Koa.Context, target: GatewayTarget, signal: AbortSignal) => Promise<void> | void

function guarded(protocol: Protocol, handler: Handler): Router.Middleware {
  return async (ctx) => {
    let target: GatewayTarget | null = null
    const controller = new AbortController()
    ctx.res.on('close', () => {
      if (!ctx.res.writableEnded) controller.abort()
    })
    try {
      target = authorize(ctx)
      target.requests += 1
      if (ctx.method === 'POST' && !ctx.is('application/json')) {
        throw new GatewayError(415, '请求体只接受 application/json')
      }
      await handler(ctx, target, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      const status = error instanceof GatewayError ? error.status : 502
      const message =
        error instanceof GatewayError ? error.message : `上游调用失败：${messageOf(error).slice(0, 800)}`
      if (target && status !== 401) target.lastError = message
      if (ctx.respond === false || ctx.headerSent) {
        console.warn('[lulux-eta] gateway error after stream start:', message)
        return
      }
      ctx.status = status
      ctx.body = errorPayload(protocol, status, message)
    }
  }
}

function openStream(ctx: Koa.Context): void {
  ctx.respond = false
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.res.flushHeaders?.()
}

interface Encoder {
  start?(): string
  push(event: StreamEvent): string
  finish(): string
  error(message: string): string
}

/** 跨协议流式：上游事件 → 目标协议 SSE。流开始后的错误以协议自己的错误事件结束 */
async function pumpStream(
  ctx: Koa.Context,
  target: GatewayTarget,
  route: ResolvedRoute,
  request: CanonicalRequest,
  encoder: Encoder,
  signal: AbortSignal,
): Promise<void> {
  const upstream = streamUpstream(route, request, signal)
  // 先取第一个事件：上游一开始就失败时还能以 HTTP 错误码返回，CLI 处理得更好
  let first: IteratorResult<StreamEvent>
  try {
    first = await upstream.next()
  } catch (error) {
    throw new GatewayError(502, `上游 Provider「${route.provider.name}」调用失败：${messageOf(error).slice(0, 800)}`)
  }
  openStream(ctx)
  const write = (chunk: string): void => {
    if (chunk && !ctx.res.writableEnded) ctx.res.write(chunk)
  }
  try {
    if (encoder.start) write(encoder.start())
    if (!first.done) write(encoder.push(first.value))
    for (;;) {
      const next = await upstream.next()
      if (next.done) break
      write(encoder.push(next.value))
    }
    write(encoder.finish())
  } catch (error) {
    if (!signal.aborted) {
      const message = `上游 Provider「${route.provider.name}」调用失败：${messageOf(error).slice(0, 800)}`
      target.lastError = message
      write(encoder.error(message))
    }
  } finally {
    ctx.res.end()
  }
}

async function collect(route: ResolvedRoute, request: CanonicalRequest, signal: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  try {
    for await (const event of streamUpstream(route, request, signal)) events.push(event)
  } catch (error) {
    throw new GatewayError(502, `上游 Provider「${route.provider.name}」调用失败：${messageOf(error).slice(0, 800)}`)
  }
  return events
}

async function sendPassthrough(ctx: Koa.Context, result: Awaited<ReturnType<typeof passthrough>>): Promise<void> {
  ctx.status = result.status
  ctx.type = result.contentType
  ctx.set('Cache-Control', 'no-cache')
  if (typeof result.body !== 'string') {
    // 上游流出错（多半是 CLI 断开后取消了上游请求）：Koa 会结束响应，这里只防止成为未捕获异常
    result.body.on('error', (error) => {
      if (!ctx.res.writableEnded) console.warn('[lulux-eta] gateway passthrough stream error:', messageOf(error))
    })
  }
  ctx.body = result.body
}

function bodyOf(ctx: Koa.Context): Record<string, unknown> {
  return asRecord(ctx.request.body)
}

const isoNow = (): string => new Date().toISOString()

export function gatewayRoutes(router: Router): void {
  // ---------- Anthropic Messages（Claude Code） ----------
  router.get(
    '/gateway/anthropic/v1/models',
    guarded('anthropic', (ctx, target) => {
      const data = listedModels(target).map(({ provider, model, alias }) => ({
        type: 'model',
        id: alias,
        display_name: `${provider.name} / ${model}`,
        created_at: isoNow(),
      }))
      ctx.body = { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }
    }),
  )

  router.post(
    '/gateway/anthropic/v1/messages/count_tokens',
    guarded('anthropic', (ctx) => {
      ctx.body = { input_tokens: estimateRequestTokens(anthropicToCanonical(bodyOf(ctx))) }
    }),
  )

  router.post(
    '/gateway/anthropic/v1/messages',
    guarded('anthropic', async (ctx, target, signal) => {
      const body = bodyOf(ctx)
      const route = resolveRoute(target, typeof body.model === 'string' ? body.model : '')
      if (route.provider.kind === 'anthropic') {
        const extra: Record<string, string> = {}
        if (ctx.get('anthropic-version')) extra['anthropic-version'] = ctx.get('anthropic-version')
        if (ctx.get('anthropic-beta')) extra['anthropic-beta'] = ctx.get('anthropic-beta')
        await sendPassthrough(ctx, await passthrough(route, '/messages', body, signal, extra))
        return
      }
      const request = anthropicToCanonical(body)
      const inputTokens = estimateRequestTokens(request)
      // 回显客户端请求的模型名（别名），CLI 据此匹配
      const echoModel = request.model || route.alias
      if (request.stream) {
        await pumpStream(ctx, target, route, request, new AnthropicStreamEncoder(echoModel, inputTokens), signal)
        return
      }
      ctx.body = anthropicMessageFrom(echoModel, inputTokens, await collect(route, request, signal))
    }),
  )

  // ---------- OpenAI（Codex：Responses；Qwen Code：Chat Completions） ----------
  router.get(
    '/gateway/openai/v1/models',
    guarded('openai', (ctx, target) => {
      const created = Math.floor(Date.now() / 1000)
      const data = listedModels(target).flatMap(({ model, alias }) => [
        { id: model, object: 'model', created, owned_by: 'lulux' },
        { id: alias, object: 'model', created, owned_by: 'lulux' },
      ])
      ctx.body = { object: 'list', data }
    }),
  )

  router.post(
    '/gateway/openai/v1/responses',
    guarded('openai', async (ctx, target, signal) => {
      const request = responsesToCanonical(bodyOf(ctx))
      const route = resolveRoute(target, request.model)
      const inputTokens = estimateRequestTokens(request)
      const echoModel = request.model || route.model
      if (request.stream) {
        await pumpStream(ctx, target, route, request, new ResponsesStreamEncoder(echoModel, inputTokens, request.customTools), signal)
        return
      }
      ctx.body = responsesFrom(echoModel, inputTokens, await collect(route, request, signal), request.customTools)
    }),
  )

  router.post(
    '/gateway/openai/v1/chat/completions',
    guarded('openai', async (ctx, target, signal) => {
      const body = bodyOf(ctx)
      const route = resolveRoute(target, typeof body.model === 'string' ? body.model : '')
      if (route.provider.kind === 'openai') {
        const result = await passthrough(route, '/chat/completions', body, signal)
        if (body.stream === true && typeof result.body !== 'string' && result.contentType.includes('event-stream')) {
          // pipe() 不转发源流的错误：CLI 中途断开时网关取消上游 fetch，源流报 AbortError，没人监听就成了未捕获异常
          const source = result.body
          const finish = ensureChatFinish(route.model)
          source.on('error', (error) => finish.destroy(error))
          result.body = source.pipe(finish)
        }
        await sendPassthrough(ctx, result)
        return
      }
      const request = chatToCanonical(body)
      const inputTokens = estimateRequestTokens(request)
      const echoModel = request.model || route.model
      if (request.stream) {
        const includeUsage = asRecord(body.stream_options).include_usage === true
        await pumpStream(ctx, target, route, request, new ChatStreamEncoder(echoModel, inputTokens, includeUsage), signal)
        return
      }
      ctx.body = chatCompletionFrom(echoModel, inputTokens, await collect(route, request, signal))
    }),
  )

  // ---------- Gemini（Gemini CLI，GOOGLE_GEMINI_BASE_URL） ----------
  router.get(
    '/gateway/gemini/:version/models',
    guarded('gemini', (ctx, target) => {
      ctx.body = {
        models: listedModels(target).map(({ provider, model }) => ({
          name: `models/${model}`,
          displayName: `${provider.name} / ${model}`,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        })),
      }
    }),
  )

  router.post(
    '/gateway/gemini/:version/models/:target',
    guarded('gemini', async (ctx, target, signal) => {
      const raw = String(ctx.params.target ?? '')
      const cut = raw.lastIndexOf(':')
      const action = cut >= 0 ? raw.slice(cut + 1) : ''
      const requested = cut >= 0 ? raw.slice(0, cut) : raw
      const body = bodyOf(ctx)
      if (action === 'countTokens') {
        const inner = asRecord(body.generateContentRequest)
        const request = geminiToCanonical(Object.keys(inner).length ? inner : body, requested, false)
        ctx.body = { totalTokens: estimateRequestTokens(request) }
        return
      }
      if (action !== 'generateContent' && action !== 'streamGenerateContent') {
        throw new GatewayError(404, `网关不支持 ${action || raw}`)
      }
      const request = geminiToCanonical(body, requested, action === 'streamGenerateContent')
      const route = resolveRoute(target, requested)
      const inputTokens = estimateRequestTokens(request)
      // Gemini CLI 按请求的模型名记账，回显它
      const echoModel = requested || route.model
      if (request.stream) {
        await pumpStream(ctx, target, route, request, new GeminiStreamEncoder(echoModel, inputTokens), signal)
        return
      }
      ctx.body = geminiResponseFrom(echoModel, inputTokens, await collect(route, request, signal))
    }),
  )

  router.all(
    '/gateway/(.*)',
    guarded('openai', (ctx) => {
      throw new GatewayError(404, `网关没有这个接口：${ctx.method} ${ctx.path}`)
    }),
  )
}
