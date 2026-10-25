import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeZip, type ZipInput } from './zip'

/**
 * 诊断包：最近几天的日志 + 版本 / 系统信息，导出前逐行脱敏。
 * 不读取数据库、密钥文件（master.key*）和连接会话（connection.json），只看日志与少量非敏感设置。
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]'],
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{6,}/g, '$1…[REDACTED]'],
  [/\b(lulux-(?:mcp|gw)-)[A-Za-z0-9_-]{6,}/g, '$1[REDACTED]'],
  // 团队服务器会话 lxs_ 与本机账户会话 lls_（前面常是 JSON 引号、冒号或空格，不依赖单词边界）
  [/(lxs_|lls_)[0-9a-f]{8,}/gi, '$1[REDACTED]'],
  [/\b(lxsetup_)[a-f0-9]{8,}/g, '$1[REDACTED]'],
  [/(--lulux-api-token=)\S+/g, '$1[REDACTED]'],
  [/([?&](?:token|code|access_token|refresh_token|api_key|apikey|key|password|secret)=)[^&\s"]+/gi, '$1[REDACTED]'],
  [/("(?:[A-Za-z_-]*(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)[A-Za-z_-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"'],
  // URL 里的用户名密码（https://user:pass@host）
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  // 常见的第三方密钥形态（固定前缀 + 定长 / 长随机串）
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'AIza[REDACTED]'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1[REDACTED]'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1[REDACTED]'],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, '$1[REDACTED]'],
  // 64 位十六进制（API token / 主密钥形态），大小写都算；前后不能紧挨着别的十六进制字符
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi, '[REDACTED-HEX]'],
]

export function redactLine(line: string): string {
  let out = line
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export function redactText(text: string): string {
  return text.split('\n').map(redactLine).join('\n')
}

/** 单个文件只取末尾这么多字节 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 40 * 1024 * 1024

export function readTail(file: string, maxBytes = MAX_FILE_BYTES): string {
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
}

export interface LogSource {
  /** zip 里的目录名，例如 server / desktop */
  label: string
  dir: string
}

export interface CollectOptions {
  sources: LogSource[]
  /** 最近几天修改过的日志 */
  days: number
  info: Record<string, unknown>
  /** 额外附带的小文件（例如偏好设置 JSON），同样脱敏 */
  extraFiles?: Array<{ path: string; file: string }>
  now?: number
}

export function recentLogs(dir: string, days: number, now = Date.now()): Array<{ name: string; mtime: number }> {
  if (!existsSync(dir)) return []
  const cutoff = now - days * 86_400_000
  const out: Array<{ name: string; mtime: number }> = []
  for (const name of readdirSync(dir)) {
    if (!/\.log(\.\d+)?$/.test(name)) continue
    try {
      const stat = statSync(join(dir, name))
      if (stat.isFile() && stat.mtimeMs >= cutoff) out.push({ name, mtime: stat.mtimeMs })
    } catch {
      // 刚被轮转删除
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function buildDiagnosticsZip(options: CollectOptions): { zip: Buffer; files: string[] } {
  const entries: ZipInput[] = []
  const files: string[] = []
  let total = 0
  for (const source of options.sources) {
    for (const log of recentLogs(source.dir, options.days, options.now)) {
      if (total >= MAX_TOTAL_BYTES) break
      const text = redactText(readTail(join(source.dir, log.name), Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)))
      const data = Buffer.from(text, 'utf8')
      total += data.length
      const path = `logs/${source.label}/${log.name}`
      entries.push({ path, data, mtime: new Date(log.mtime) })
      files.push(path)
    }
  }
  for (const extra of options.extraFiles ?? []) {
    try {
      if (!existsSync(extra.file)) continue
      const text = redactText(readFileSync(extra.file, 'utf8').slice(0, 64 * 1024))
      entries.push({ path: extra.path, data: Buffer.from(text, 'utf8') })
      files.push(extra.path)
    } catch {
      // 读不到就跳过
    }
  }
  const info = { ...options.info, logDays: options.days, files }
  entries.unshift({ path: 'info.json', data: Buffer.from(redactText(JSON.stringify(info, null, 2)), 'utf8') })
  return { zip: writeZip(entries), files }
}

export function diagnosticsFileName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `lulux-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
}

