import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ApiTokenInfo {
  token: string
  source: 'env' | 'file'
  /** source=file 时写入的文件路径 */
  file: string | null
}

/**
 * 桌面端经 LULUX_API_TOKEN 下发 token；浏览器开发态由服务端自行生成并写入
 * `<dataDir>/api-token`（0600），供 Vite dev proxy 读取。
 * 读取后立即从环境变量里删除，避免被 MCP / 内核子进程继承。
 */
export function resolveApiToken(home: string): ApiTokenInfo {
  const fromEnv = process.env.LULUX_API_TOKEN?.trim()
  delete process.env.LULUX_API_TOKEN
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('LULUX_API_TOKEN 长度不足 32 个字符')
    }
    return { token: fromEnv, source: 'env', file: null }
  }

  mkdirSync(home, { recursive: true })
  const token = randomBytes(32).toString('hex')
  const file = join(home, 'api-token')
  writeFileSync(file, token, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位，忽略
  }
  return { token, source: 'file', file }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** 定长摘要后用 timingSafeEqual 比较，避免长度与时序泄露 */
export function tokensEqual(expected: string, provided: string): boolean {
  return timingSafeEqual(digest(expected), digest(provided))
}
