import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { config } from './config.js'
import { resolveApiToken } from './security/api-token.js'
import { mcpRuntime } from './services/mcp/runtime.js'
import { emailScheduler } from './services/email/scheduler.js'
import { skillService } from './services/skills/skill-service.js'
import { backupService } from './services/backup-service.js'
import { taskReminders } from './services/task-service.js'
import { trashPurger } from './services/trash-service.js'
import { scheduler } from './services/schedule/scheduler.js'
import { logger } from './services/logger.js'
import { shutdownRuns } from './services/chat/run-registry.js'

// 必须在任何子进程（MCP / 内核）启动前读取并清除敏感环境变量
// server 模式用账号会话鉴权，不生成 / 不落盘本机 API token
const tokenInfo =
  config.mode === 'server'
    ? (delete process.env.LULUX_API_TOKEN, { token: randomBytes(32).toString('hex'), source: 'env' as const, file: null })
    : resolveApiToken(config.home)

// console 输出同时写入 <dataDir>/logs/（JSON、按天轮转、脱敏）
logger.captureConsole()

let listeningPort = config.port
const app = createApp({
  token: tokenInfo.token,
  getPort: () => listeningPort,
  isProduction: config.isProduction,
  clientDist: config.clientDist,
})

let closing = false

function shutdown(): void {
  if (closing) return
  closing = true
  // 先中止进行中的会话运行（已输出部分按 interrupted 落库），再关其它服务
  void shutdownRuns(2000)
    .catch(() => undefined)
    .finally(closeServices)
}

function closeServices(): void {
  mcpRuntime.closeAll()
  emailScheduler.stop()
  backupService.stop()
  taskReminders.stop()
  trashPurger.stop()
  scheduler.stop()
  // 兜底：连接迟迟不释放时强制退出
  setTimeout(() => process.exit(0), 3000).unref()
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
}

const server = app.listen(config.port, config.host, () => {
  listeningPort = (server.address() as AddressInfo).port
  console.log(`[lulux-eta] server listening on http://${config.host}:${listeningPort}`)
  console.log(`[lulux-eta] data directory: ${config.home}`)
  if (tokenInfo.file) console.log(`[lulux-eta] dev API token written to: ${tokenInfo.file}`)
  if (config.clientDist) console.log(`[lulux-eta] serving client from: ${config.clientDist}`)
  // 内置 skill 同步（只更新未被用户修改的内置副本）与目录对齐
  skillService.ensureReady()
  // 启动时按配置拉起启用且已确认的 MCP Server
  mcpRuntime.sync()
  // 邮箱后台同步（间隔见设置 emailSyncIntervalMinutes；可选 IMAP IDLE）
  emailScheduler.start()
  backupService.start()
  taskReminders.start()
  // 回收站超过保留天数（设置 trashRetentionDays）自动彻底删除
  trashPurger.start()
  scheduler.start()
  console.log(`[lulux-eta] mode: ${config.mode}`)
})
// 端口被占用等监听失败：单独一行写明原因再退出（桌面壳据此换端口重试）
server.on('error', (error: NodeJS.ErrnoException) => {
  if (server.listening) {
    console.error(`[lulux-eta] server error: ${error.message}`)
    return
  }
  console.error(`[lulux-eta] listen failed: ${error.code ?? ''} ${error.message}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown)
}

// 由桌面端托管时，父进程退出会关闭 stdin 管道 / IPC 通道，据此收尾子进程
if (process.env.LULUX_ETA_PARENT_PIPE === '1') {
  process.stdin.resume()
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('disconnect', shutdown)
}
