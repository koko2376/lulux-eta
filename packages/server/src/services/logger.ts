import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import type Koa from 'koa'
import { config } from '../config.js'
import { currentActor } from '../context.js'

/**
 * 结构化日志（契约 §10.9）：
 * - 每行一个 JSON：`{ ts, level, msg, requestId?, actorId?, ...fields }`，写 `<dataDir>/logs/lulux-YYYY-MM-DD.log`；
 * - 按天轮转 + 单文件超过 LULUX_LOG_MAX_MB（默认 50）时切分 `.1 .2…`；保留 LULUX_LOG_KEEP_DAYS 天（默认 14）；
 * - 脱敏：键名命中 password/token/secret/apiKey/authorization/cookie… 的值替换为 "[REDACTED]"；
 *   字符串里的 Bearer 令牌、sk-/lulux-/lxsetup_ 等密钥形态、邮箱 query 里的 code/token 一并打码；
 * - 请求日志：每个 /api、/gateway 请求一行 `http`（method、路径（query 已脱敏）、status、耗时、requestId、actorId、ip）；
 *   响应头 `X-Request-Id`（接受客户端传入的安全值，否则生成）；
 * - console.log/warn/error 同时写入日志文件（captureConsole，index.ts 启动时调用）。
 * LULUX_LOG_LEVEL=debug|info|warn|error（默认 info）；LULUX_LOG_FILE=0 关闭文件输出。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SENSITIVE_KEY = /pass(word)?|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|pin$|^code$|setup[-_]?token|session[-_]?id/i
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]'],
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, '$1…[REDACTED]'],
  [/\b(lulux-(?:mcp|gw)-)[A-Za-z0-9_-]{6,}/g, '$1[REDACTED]'],
  [/\b(lxsetup_)[a-f0-9]{8,}/g, '$1[REDACTED]'],
  [/([?&](?:token|code|access_token|refresh_token|api_key|apikey|key|password|secret)=)[^&\s"]+/gi, '$1[REDACTED]'],
]

export function redactString(value: string): string {
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** 递归脱敏（深度 ≤ 6，字符串 ≤ 2000 字，数组 ≤ 50 项） */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value.length > 2000 ? `${value.slice(0, 2000)}…` : value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 6) return '[…]'
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack.split('\n').slice(0, 8).join('\n')) : undefined }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) && item !== null && item !== undefined && item !== '' ? '[REDACTED]' : redact(item, depth + 1)
  }
  return out
}

const requestStore = new AsyncLocalStorage<{ requestId: string }>()

export function currentRequestId(): string | null {
  return requestStore.getStore()?.requestId ?? null
}

function envLevel(): LogLevel {
  const raw = (process.env.LULUX_LOG_LEVEL ?? '').toLowerCase()
  return raw in LEVELS ? (raw as LogLevel) : 'info'
}

function dayStamp(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

let lastPrune = 0
let originalConsole: Pick<Console, 'log' | 'warn' | 'error' | 'info'> | null = null
let writing = false

export const logger = {
  dir(): string {
    return join(config.home, 'logs')
  },

  /** 当前写入的文件（按天；超过上限切分 .1 .2…） */
  currentFile(now = new Date()): string {
    const dir = logger.dir()
    const base = join(dir, `lulux-${dayStamp(now)}.log`)
    const maxBytes = Math.max(1, Number(process.env.LULUX_LOG_MAX_MB || 50)) * 1024 * 1024
    let file = base
    for (let index = 1; index < 1000; index += 1) {
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        return file
      }
      if (size < maxBytes) return file
      file = `${base}.${index}`
    }
    return file
  },

  /** 删除超过保留天数的日志（按文件名里的日期） */
  prune(now = Date.now()): number {
    const keepDays = Math.max(1, Number(process.env.LULUX_LOG_KEEP_DAYS || 14))
    const cutoff = dayStamp(new Date(now - keepDays * 86_400_000))
    let removed = 0
    try {
      for (const name of readdirSync(logger.dir())) {
        const match = /^lulux-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?$/.exec(name)
        if (match && match[1]! < cutoff) {
          rmSync(join(logger.dir(), name), { force: true })
          removed += 1
        }
      }
    } catch {
      // 目录不存在
    }
    return removed
  },

  write(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[envLevel()]) return
    if (process.env.LULUX_LOG_FILE === '0') return
    if (writing) return // console 捕获时防重入
    writing = true
    try {
      const now = new Date()
      const requestId = currentRequestId()
      const entry: Record<string, unknown> = { ts: now.toISOString(), level, msg: redactString(msg) }
      if (requestId) entry.requestId = requestId
      Object.assign(entry, redact(fields) as Record<string, unknown>)
      mkdirSync(logger.dir(), { recursive: true })
      appendFileSync(logger.currentFile(now), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      if (now.getTime() - lastPrune > 3600_000) {
        lastPrune = now.getTime()
        logger.prune(now.getTime())
      }
    } catch {
      // 日志失败不能影响业务
    } finally {
      writing = false
    }
  },

  debug: (msg: string, fields?: Record<string, unknown>) => logger.write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => logger.write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => logger.write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => logger.write('error', msg, fields),

  /** console.* 照常输出，同时以 JSON 写入日志文件（错误对象带脱敏后的 stack） */
  captureConsole(): void {
    if (originalConsole) return
    originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info }
    const wrap = (level: LogLevel, original: (...args: unknown[]) => void) =>
      (...args: unknown[]): void => {
        original.apply(console, args)
        const error = args.find((arg) => arg instanceof Error) as Error | undefined
        const text = format(...args.map((arg) => (arg instanceof Error ? arg.message : arg)))
        logger.write(level, text.replace(/^\[lulux-eta\]\s*/, ''), error ? { source: 'console', error } : { source: 'console' })
      }
    console.log = wrap('info', originalConsole.log)
    console.info = wrap('info', originalConsole.info)
    console.warn = wrap('warn', originalConsole.warn)
    console.error = wrap('error', originalConsole.error)
  },

  restoreConsole(): void {
    if (!originalConsole) return
    Object.assign(console, originalConsole)
    originalConsole = null
  },
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/

function safePath(ctx: Koa.Context): string {
  return ctx.querystring ? `${ctx.path}?${redactString(`?${ctx.querystring}`).slice(1)}` : ctx.path
}

/**
 * 请求 ID + 访问日志（放在最外层）。只记录 /api 与 /gateway（静态资源不记）；
 * SSE / 流式响应在响应结束时记录。actorId 由 policy 中间件写入 ctx.state.actorId。
 */
export function requestLogMiddleware(): Koa.Middleware {
  return async (ctx, next) => {
    const incoming = ctx.get('X-Request-Id')
    const requestId = SAFE_REQUEST_ID.test(incoming) ? incoming : `req_${randomBytes(8).toString('hex')}`
    ctx.state.requestId = requestId
    ctx.set('X-Request-Id', requestId)
    const logged = ctx.path.startsWith('/api/') || ctx.path.startsWith('/gateway/') || ctx.path === '/api'
    const started = process.hrtime.bigint()
    const done = (): void => {
      if (!logged) return
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      const status = ctx.status
      requestStore.run({ requestId }, () =>
        logger.write(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'http', {
          method: ctx.method,
          path: safePath(ctx),
          status,
          ms: Math.round(ms * 10) / 10,
          actorId: ctx.state.actorId ?? null,
          ip: ctx.ip,
          errorCode: status >= 400 && ctx.body && typeof ctx.body === 'object' ? ((ctx.body as { error?: { code?: string } }).error?.code ?? undefined) : undefined,
        }),
      )
    }
    await requestStore.run({ requestId }, async () => {
      try {
        await next()
      } finally {
        // SSE 等手动写入的响应（respond=false）：连接关闭时再记，耗时才准确
        if (ctx.respond === false && !ctx.res.writableEnded) ctx.res.once('close', done)
        else done()
      }
    })
  }
}

/** policy 中间件在鉴权之后调用：把操作者 id 记到 ctx.state，供访问日志使用 */
export function rememberActor(ctx: Koa.Context): void {
  try {
    ctx.state.actorId = currentActor().id || null
  } catch {
    ctx.state.actorId = null
  }
}
