/**
 * 上游（模型 Provider）错误分类。适配器对非 2xx 响应与网络失败统一抛 UpstreamError，
 * 重试层据 kind 决定是否退避重试，编排层据 code 下发 SSE error。
 * message 仍以 `Provider error: …` 开头，兼容依赖旧文案的调用方。
 */
export type UpstreamErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'bad_request'
  | 'context_length'
  | 'not_found'
  | 'empty'
  | 'aborted'

const CODES: Record<UpstreamErrorKind, string> = {
  rate_limit: 'UPSTREAM_RATE_LIMITED',
  overloaded: 'UPSTREAM_OVERLOADED',
  server: 'UPSTREAM_ERROR',
  network: 'UPSTREAM_UNREACHABLE',
  timeout: 'UPSTREAM_TIMEOUT',
  auth: 'UPSTREAM_AUTH',
  bad_request: 'UPSTREAM_BAD_REQUEST',
  context_length: 'CONTEXT_TOO_LONG',
  not_found: 'UPSTREAM_NOT_FOUND',
  empty: 'EMPTY_REPLY',
  aborted: 'ABORTED',
}

const RETRYABLE = new Set<UpstreamErrorKind>(['rate_limit', 'overloaded', 'server', 'network', 'timeout', 'empty'])

export class UpstreamError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status: number | null = null,
    /** 服务端要求的等待时间（Retry-After） */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'UpstreamError'
    this.code = CODES[kind]
    this.retryable = RETRYABLE.has(kind)
  }
}

const CONTEXT_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /reduce the length/i,
  /token limit/i,
]

/** Retry-After：秒数或 HTTP 日期；另认 retry-after-ms */
export function parseRetryAfter(headers: Headers | null | undefined, now = Date.now()): number | null {
  if (!headers) return null
  const ms = headers.get('retry-after-ms')
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms))
  const raw = headers.get('retry-after')
  if (!raw) return null
  const value = raw.trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

export function classifyStatus(status: number, body: string): UpstreamErrorKind {
  if (status === 429) return 'rate_limit'
  if (status === 529 || status === 503) return 'overloaded'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 408) return 'timeout'
  if (status === 413) return 'context_length'
  if (status >= 500) return 'server'
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(body))) return 'context_length'
  // 部分 Provider 把配额/限流写在 400 里
  if (/rate.?limit|overloaded/i.test(body)) return 'rate_limit'
  return 'bad_request'
}

export function upstreamFromResponse(status: number, body: string, headers?: Headers | null): UpstreamError {
  const kind = classifyStatus(status, body)
  return new UpstreamError(kind, `Provider error: ${body || `HTTP ${status}`}`, status, parseRetryAfter(headers))
}

/** 流内的 error 事件（Anthropic overloaded_error、OpenAI chunk.error） */
export function upstreamFromStreamError(type: string | undefined, message: string): UpstreamError {
  const text = `${type ?? ''} ${message}`
  if (/overloaded/i.test(text)) return new UpstreamError('overloaded', `Provider error: ${message}`)
  if (/rate.?limit/i.test(text)) return new UpstreamError('rate_limit', `Provider error: ${message}`)
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) return new UpstreamError('context_length', `Provider error: ${message}`)
  if (/api_error|server|internal/i.test(text)) return new UpstreamError('server', `Provider error: ${message}`)
  return new UpstreamError('server', `Provider error: ${message}`)
}

/** 把任意异常归类：已是 UpstreamError 原样返回；fetch 网络失败归 network */
export function toUpstreamError(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError') return new UpstreamError('aborted', '已取消')
  const cause = error instanceof Error ? (error as { cause?: { code?: string } }).cause : undefined
  if (
    name === 'TypeError' ||
    /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|terminated|other side closed|UND_ERR/i.test(
      `${message} ${cause?.code ?? ''}`,
    )
  ) {
    return new UpstreamError('network', `无法连接模型服务：${cause?.code ? `${cause.code} ` : ''}${message}`)
  }
  return new UpstreamError('server', message)
}

/** 指数退避：base·2^attempt，封顶 cap，叠加 0–25% 抖动；有 Retry-After 时取其（≤60 秒） */
export function backoffDelay(
  attempt: number,
  retryAfterMs: number | null,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 1000
  const cap = options.capMs ?? 30_000
  if (retryAfterMs !== null && retryAfterMs >= 0) return Math.min(60_000, retryAfterMs)
  const exp = Math.min(cap, base * 2 ** attempt)
  const jitter = exp * 0.25 * (options.random ?? Math.random)()
  return Math.round(Math.min(cap, exp + jitter))
}
