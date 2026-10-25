import type Router from '@koa/router'
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { config } from '../config.js'
import { currentActor } from '../context.js'
import { AppError } from '../errors.js'
import { requirePermission } from '../security/access.js'
import { auditService } from '../services/audit-service.js'
import { logger, redactString } from '../services/logger.js'
import { writeZip, type ZipInput } from '../services/skills/zip.js'

/** 单个日志文件最多带上末尾这么多字节（排障看最近的就够） */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 整个诊断包里日志总量上限 */
const MAX_TOTAL_BYTES = 40 * 1024 * 1024

export interface LogFileInfo {
  name: string
  size: number
  mtime: number
}

/** 日志目录里最近 days 天的文件，新的在前 */
export function recentLogFiles(dir: string, days: number, now = Date.now()): LogFileInfo[] {
  const cutoff = now - days * 86_400_000
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: LogFileInfo[] = []
  for (const name of names) {
    if (!/^lulux-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/.test(name)) continue
    try {
      const stat = statSync(join(dir, name))
      if (stat.isFile() && stat.mtimeMs >= cutoff) files.push({ name, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // 文件刚被轮转删除
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

/** 读文件末尾 maxBytes 字节（从下一整行开始），逐行再脱敏一遍 */
export function readLogTail(file: string, maxBytes = MAX_FILE_BYTES): string {
  const size = statSync(file).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  let text = buffer.toString('utf8')
  if (start > 0) {
    const newline = text.indexOf('\n')
    text = newline >= 0 ? text.slice(newline + 1) : ''
  }
  return text
    .split('\n')
    .map((line) => redactString(line))
    .join('\n')
}

export function systemInfo(): Record<string, unknown> {
  return {
    app: 'LULUX ETA',
    version: config.version,
    mode: config.mode,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    cpus: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    uptimeSeconds: Math.round(process.uptime()),
    generatedAt: new Date().toISOString(),
  }
}

/** 服务器日志诊断包（zip：info.json + 最近几天的日志），日志里的密钥形态已打码 */
export function buildServerDiagnostics(days: number): { zip: Buffer; files: number } {
  const dir = logger.dir()
  const entries: ZipInput[] = []
  let total = 0
  const included: string[] = []
  for (const file of recentLogFiles(dir, days)) {
    if (total >= MAX_TOTAL_BYTES) break
    const text = readLogTail(join(dir, file.name), Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total))
    const data = Buffer.from(text, 'utf8')
    total += data.length
    entries.push({ path: `logs/${file.name}`, data, mtime: new Date(file.mtime) })
    included.push(file.name)
  }
  const info = { ...systemInfo(), logDays: days, logFiles: included }
  entries.unshift({ path: 'info.json', data: Buffer.from(JSON.stringify(info, null, 2), 'utf8') })
  return { zip: writeZip(entries), files: included.length }
}

export function diagnosticsRoutes(router: Router): void {
  // 下载服务器日志（只给所有者 / 管理员：audit:read 只跟随角色，不能单独授予）
  router.get('/api/diagnostics/logs', (ctx) => {
    requirePermission('audit:read')
    const raw = Number(ctx.query.days ?? 3)
    if (!Number.isFinite(raw)) throw new AppError(400, 'VALIDATION_ERROR', 'days 必须是数字')
    const days = Math.max(1, Math.min(14, Math.trunc(raw)))
    const { zip, files } = buildServerDiagnostics(days)
    auditService.record({
      action: 'diagnostics.logs',
      entityType: 'server',
      entityId: currentActor().orgId,
      summary: `下载服务器日志（最近 ${days} 天，${files} 个文件）`,
      meta: { days, files },
    })
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    ctx.set('Content-Type', 'application/zip')
    ctx.set('Content-Disposition', `attachment; filename="lulux-server-logs-${stamp}.zip"`)
    ctx.set('Cache-Control', 'no-store')
    ctx.body = zip
  })
}
