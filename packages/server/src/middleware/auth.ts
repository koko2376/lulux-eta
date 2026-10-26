import type Koa from 'koa'
import type { BlockList } from 'node:net'
import { DEV_ORIGINS, type RunMode } from '../config.js'
import { LOCAL_ACTOR, runWithContext } from '../context.js'
import { AppError } from '../errors.js'
import { tokensEqual } from '../security/api-token.js'
import { resolveClientIp, type ProxyTrust } from '../security/client-ip.js'
import { authService } from '../services/auth-service.js'
import { LOCAL_SESSION_HEADER, localAuthService } from '../services/local-auth-service.js'

export interface AuthOptions {
  token: string
  /** 服务实际监听的端口（测试中监听 0 时需要动态读取） */
  getPort: () => number
  isProduction: boolean
  mode?: RunMode
  /** server 模式：LULUX_PUBLIC_ORIGIN 白名单（已规范化） */
  publicOrigins?: string[]
  allowDesktopOrigins?: boolean
  trustProxy?: boolean
  /** 信任的代理层数（默认 1） */
  proxyHops?: number
  /** 可信代理地址列表（设置后按列表从右往左找第一个不可信地址） */
  trustedProxies?: BlockList | null
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 不需要 token 的 API（契约 5.1 / 5.3 / 5.7） */
const PUBLIC_API = [
  /^\/api\/auth\/mode$/,
  /^\/api\/version$/,
  /^\/api\/auth\/setup$/,
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/invites\/accept$/,
  /^\/api\/auth\/invites\/[^/]+$/,
]
/** desktop 模式只有 mode 是公开的 */
const DESKTOP_PUBLIC_API = [/^\/api\/auth\/mode$/, /^\/api\/version$/]
/** 必须先修改密码的账号只能调用这些接口（改密 / 登出 / 读自己的资料） */
const PASSWORD_CHANGE_ALLOWED: Array<[string, RegExp]> = [
  ['GET', /^\/api\/auth\/me$/],
  ['POST', /^\/api\/auth\/password$/],
  ['POST', /^\/api\/auth\/logout$/],
  ['POST', /^\/api\/auth\/refresh$/],
]
/**
 * desktop 模式有本机账户后，不需要本机会话的接口（仍需 API token）：
 * 登录页要用的状态 / 登录 / 创建（创建在服务里再判断“没有账户或已登录”）/ 找回密码，健康检查，本机锁状态。
 */
const LOCAL_SESSION_PUBLIC: Array<[string, RegExp]> = [
  ['GET', /^\/api\/auth\/mode$/],
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/version$/],
  ['GET', /^\/api\/lock$/],
  // 桌面主进程关窗前问“还有几个运行”：只返回数量
  ['GET', /^\/api\/chat\/runs\/count$/],
  ['GET', /^\/api\/auth\/local\/status$/],
  ['POST', /^\/api\/auth\/local\/login$/],
  ['POST', /^\/api\/auth\/local\/accounts$/],
  // 忘记密码：恢复码 / 重置文件（服务里各自校验恢复码、文件是否存在，并退避）
  ['GET', /^\/api\/auth\/local\/recovery$/],
  ['POST', /^\/api\/auth\/local\/recover$/],
  ['POST', /^\/api\/auth\/local\/reset-with-file$/],
]

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}

function hasBody(ctx: Koa.Context): boolean {
  if (ctx.get('transfer-encoding')) return true
  const length = Number.parseInt(ctx.get('content-length') || '0', 10)
  return Number.isFinite(length) && length > 0
}

function clientIp(ctx: Koa.Context, trust: ProxyTrust): string {
  return resolveClientIp(ctx.socket.remoteAddress ?? '', ctx.get('x-forwarded-for'), trust)
}

function bearer(ctx: Koa.Context): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(ctx.get('authorization'))
  return match ? match[1]! : null
}

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/

/**
 * 访问控制。
 * desktop（契约第 1 节）：Host 仅 127.0.0.1/localhost:<port>；/api 校验 Origin 与固定 token；JSON-only。
 * server（契约 5.2）：Host/Origin 读 LULUX_PUBLIC_ORIGIN 白名单；精确 CORS；会话 token → 请求上下文。
 */
export function createAuthMiddleware(options: AuthOptions): Koa.Middleware {
  const mode = options.mode ?? 'desktop'
  const publicOrigins = (options.publicOrigins ?? []).map((origin) => origin.toLowerCase())
  const publicHosts = publicOrigins.map((origin) => new URL(origin).host.toLowerCase())
  const allowDesktopOrigins = options.allowDesktopOrigins ?? true
  // 兼容只传 trustProxy=true 的调用方：视为一层代理
  const proxyTrust: ProxyTrust = {
    hops: options.trustProxy ? Math.max(1, options.proxyHops ?? 1) : 0,
    trusted: options.trustProxy ? (options.trustedProxies ?? null) : null,
  }

  if (mode === 'server') {
    return async (ctx, next) => {
      const port = options.getPort()
      const host = (ctx.get('host') || '').toLowerCase()
      if (!publicHosts.includes(host) && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new AppError(403, 'HOST_NOT_ALLOWED', '不允许的 Host')
      }
      const ip = clientIp(ctx, proxyTrust)

      if (!isApiPath(ctx.path)) {
        await runWithContext({ actor: LOCAL_ACTOR, ip }, next)
        return
      }

      const origin = (ctx.get('origin') || '').toLowerCase()
      if (origin) {
        const allowed = publicOrigins.includes(origin) || (allowDesktopOrigins && LOOPBACK_ORIGIN.test(origin))
        if (!allowed) throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '不允许的跨源请求')
        ctx.set('Access-Control-Allow-Origin', ctx.get('origin'))
        ctx.set('Vary', 'Origin')
        ctx.set('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition, X-Lulux-Pdf-Font, X-Request-Id')
        if (ctx.method === 'OPTIONS') {
          ctx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id, X-Lulux-Lang')
          ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE')
          ctx.set('Access-Control-Max-Age', '600')
          ctx.status = 204
          return
        }
      }

      if (BODY_METHODS.has(ctx.method) && hasBody(ctx) && !ctx.is('application/json')) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体只接受 application/json')
      }

      if (PUBLIC_API.some((pattern) => pattern.test(ctx.path))) {
        // 公开接口没有身份，用一个无权限的匿名上下文
        await runWithContext({ actor: { ...LOCAL_ACTOR, id: '', name: '', role: 'viewer', orgId: '' }, ip }, next)
        return
      }

      const token = bearer(ctx)
      if (!token) throw new AppError(401, 'UNAUTHORIZED', '缺少或无效的访问令牌')
      const resolved = authService.resolve(token)
      if (!resolved.ok) {
        if (resolved.code === 'SESSION_EXPIRED') throw new AppError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录')
        if (resolved.code === 'USER_DISABLED') throw new AppError(403, 'USER_DISABLED', '账号已停用，请联系管理员')
        throw new AppError(401, 'UNAUTHORIZED', '缺少或无效的访问令牌')
      }
      if (resolved.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some(([method, pattern]) => method === ctx.method && pattern.test(ctx.path))) {
        throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '管理员为你设置了临时密码，请先修改密码')
      }
      await runWithContext({ actor: resolved.actor, ip }, next)
    }
  }

  return async (ctx, next) => {
    const port = options.getPort()
    const host = (ctx.get('host') || '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new AppError(403, 'HOST_NOT_ALLOWED', '不允许的 Host')
    }
    const ip = ctx.socket.remoteAddress ?? ''

    if (!isApiPath(ctx.path)) {
      await runWithContext({ actor: LOCAL_ACTOR, ip }, next)
      return
    }

    const origin = ctx.get('origin')
    if (origin) {
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
      if (!options.isProduction) allowed.push(...DEV_ORIGINS)
      if (!allowed.includes(origin.toLowerCase())) {
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '不允许的跨源请求')
      }
    }

    if (!DESKTOP_PUBLIC_API.some((pattern) => pattern.test(ctx.path))) {
      const token = bearer(ctx)
      if (!token || !tokensEqual(options.token, token)) {
        throw new AppError(401, 'UNAUTHORIZED', '缺少或无效的访问令牌')
      }
    }

    if (BODY_METHODS.has(ctx.method) && hasBody(ctx) && !ctx.is('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体只接受 application/json')
    }

    // 本机账户：没有任何账户时照旧（升级不锁人）；有账户后要求 X-Lulux-Session 会话
    let actor = LOCAL_ACTOR
    if (localAuthService.hasAccounts()) {
      const sessionToken = ctx.get(LOCAL_SESSION_HEADER).trim()
      const resolved = sessionToken ? localAuthService.resolve(sessionToken) : null
      if (resolved?.ok) actor = resolved.actor
      else if (!LOCAL_SESSION_PUBLIC.some(([method, pattern]) => method === ctx.method && pattern.test(ctx.path))) {
        if (resolved?.code === 'SESSION_EXPIRED') throw new AppError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录')
        throw new AppError(401, 'LOCAL_LOGIN_REQUIRED', '请先登录本机账户')
      }
    }

    await runWithContext({ actor, ip }, next)
  }
}
