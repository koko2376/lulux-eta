import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import Router from '@koa/router'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createAuthMiddleware, isApiPath } from './middleware/auth.js'
import { errorMiddleware } from './middleware/errors.js'
import { requestLogMiddleware } from './services/logger.js'
import { policyMiddleware } from './middleware/policy.js'
import { agentRoutes } from './routes/agents.js'
import { chatRoutes } from './routes/chat.js'
import { customerRoutes } from './routes/customers.js'
import { dataRoutes } from './routes/data.js'
import { diagnosticsRoutes } from './routes/diagnostics.js'
import { healthRoutes } from './routes/health.js'
import { inquiryRuleRoutes, quoteTemplateRoutes } from './routes/inquiry-rules.js'
import { kernelRoutes } from './routes/kernels.js'
import { lockRoutes } from './routes/lock.js'
import { mcpRoutes } from './routes/mcp.js'
import { networkRoutes } from './routes/network.js'
import { productRoutes } from './routes/products.js'
import { trashRoutes } from './routes/trash.js'
import { providerRoutes } from './routes/providers.js'
import { quoteRoutes } from './routes/quotes.js'
import { sessionRoutes } from './routes/sessions.js'
import { modelRoutes } from './routes/models.js'
import { permissionRoutes } from './routes/permissions.js'
import { settingsRoutes } from './routes/settings.js'
import { workbenchRoutes } from './routes/workbench.js'
import { authRoutes, teamRoutes } from './routes/auth.js'
import { eventRoutes } from './routes/events.js'
import { emailRoutes, oauthCallbackRoutes } from './routes/email.js'
import { gatewayRoutes } from './routes/gateway.js'
import { taskRoutes } from './routes/tasks.js'
import { orderRoutes } from './routes/orders.js'
import { luluxMcpRoutes } from './routes/lulux-mcp.js'
import { skillRoutes } from './routes/skills.js'
import { workflowRoutes } from './routes/workflows.js'
import { memoryRoutes } from './routes/memory.js'
import { config, runtimeInfo, type RunMode } from './config.js'
import { recoverInterruptedMessages } from './services/chat/run-registry.js'
import { authService } from './services/auth-service.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 界面页面的 CSP（与桌面主进程注入的一致）。注意 srcdoc iframe 会继承它，内联脚本不会执行 */
export const CLIENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * 页面 CSP 以响应头为准（桌面主进程在远程模式下会放行团队服务器的 connect-src）。
 * index.html 里的 <meta http-equiv="Content-Security-Policy"> 会与响应头叠加生效、且无法按模式变化，这里去掉。
 */
export function stripMetaCsp(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, '')
}

function serveClientBuild(clientDist: string): Koa.Middleware {
  return async (ctx, next) => {
    await next()

    if (ctx.status !== 404 || ctx.body !== undefined) return
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return
    if (!clientDist || isApiPath(ctx.path)) return

    const root = resolve(clientDist)
    let requestPath = ''
    try {
      requestPath = decodeURIComponent(ctx.path)
    } catch {
      ctx.status = 400
      return
    }
    const candidate = resolve(
      join(root, requestPath === '/' ? 'index.html' : requestPath),
    )

    if (
      (candidate === root || candidate.startsWith(root + sep)) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const ext = extname(candidate).toLowerCase()
      ctx.type = MIME_TYPES[ext] ?? 'application/octet-stream'
      ctx.set('X-Content-Type-Options', 'nosniff')
      if (ext === '.html') {
        ctx.set('Content-Security-Policy', CLIENT_CSP)
        ctx.body = stripMetaCsp(readFileSync(candidate, 'utf8'))
        return
      }
      ctx.body = createReadStream(candidate)
      return
    }

    // Single-page application fallback.
    const indexFile = join(root, 'index.html')
    if (existsSync(indexFile)) {
      ctx.type = 'text/html; charset=utf-8'
      ctx.set('Content-Security-Policy', CLIENT_CSP)
      ctx.body = stripMetaCsp(readFileSync(indexFile, 'utf8'))
    }
  }
}

export interface AppOptions {
  token: string
  getPort: () => number
  isProduction: boolean
  clientDist?: string
  mode?: RunMode
  publicOrigins?: string[]
}

export function createApp(options: AppOptions): Koa {
  const app = new Koa()
  runtimeInfo.getPort = options.getPort
  const mode = options.mode ?? config.mode
  const publicOrigins = options.publicOrigins ?? config.publicOrigins
  if (mode === 'server') {
    if (publicOrigins.length === 0) {
      throw new Error('LULUX_MODE=server 时必须设置 LULUX_PUBLIC_ORIGIN（如 https://lulux.example.com）')
    }
    authService.ensureSetupToken()
  }
  app.proxy = mode === 'server' && config.trustProxy
  // 上次进程退出时还在生成的草稿消息标记为 interrupted（契约 §6.9）
  recoverInterruptedMessages()

  app.use(requestLogMiddleware())
  app.use(errorMiddleware())
  app.use(
    createAuthMiddleware({
      token: options.token,
      getPort: options.getPort,
      isProduction: options.isProduction,
      mode,
      publicOrigins,
      allowDesktopOrigins: config.allowDesktopOrigins,
      trustProxy: config.trustProxy,
    }),
  )
  // 只解析 JSON；表单 / 文本请求体在鉴权中间件里已被 415 拒绝
  app.use(
    bodyParser({
      enableTypes: ['json'],
      jsonLimit: '20mb',
      encoding: 'utf-8',
    }),
  )
  app.use(policyMiddleware())

  const router = new Router()
  healthRoutes(router)
  diagnosticsRoutes(router)
  providerRoutes(router)
  agentRoutes(router)
  sessionRoutes(router)
  permissionRoutes(router)
  modelRoutes(router)
  chatRoutes(router)
  settingsRoutes(router)
  memoryRoutes(router)
  networkRoutes(router)
  dataRoutes(router)
  mcpRoutes(router)
  kernelRoutes(router)
  customerRoutes(router)
  taskRoutes(router)
  orderRoutes(router)
  productRoutes(router)
  trashRoutes(router)
  quoteRoutes(router)
  inquiryRuleRoutes(router)
  quoteTemplateRoutes(router)
  workbenchRoutes(router)
  lockRoutes(router)
  authRoutes(router)
  teamRoutes(router)
  eventRoutes(router)
  emailRoutes(router)
  oauthCallbackRoutes(router)
  luluxMcpRoutes(router)
  gatewayRoutes(router)
  skillRoutes(router)
  workflowRoutes(router)

  app.use(router.routes())
  app.use(router.allowedMethods())
  app.use(serveClientBuild(options.clientDist ?? ''))

  return app
}
