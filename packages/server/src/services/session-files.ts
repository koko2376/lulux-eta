import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { kernelsRoot, sessionHomeSegment } from './kernels/paths.js'
import { workspaceRoot } from './tools/workspace.js'

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/

function removeDir(dir: string, removed: string[]): void {
  if (!existsSync(dir)) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    removed.push(dir)
  } catch (error) {
    // 删除会话本身已成功；目录清不掉（文件被占用等）只记日志，不影响接口
    console.warn(`[lulux-eta] 无法清理会话目录 ${dir}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 删除会话时一并清理它在磁盘上的文件：
 * - 内置工具工作区 `<dataDir>/workspace/<sessionId>/`
 * - scoped 内核为该会话建立的独立 HOME `<kernelsRoot>/<kernelId>/home/<sessionId>/`
 * 返回实际删除的目录（测试用）。
 */
export function removeSessionFiles(sessionId: string): string[] {
  const removed: string[] = []
  if (!SESSION_ID.test(sessionId)) return removed
  removeDir(join(workspaceRoot(), sessionId), removed)
  const root = kernelsRoot()
  let kernels: string[] = []
  try {
    kernels = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    kernels = []
  }
  const segment = sessionHomeSegment(sessionId)
  for (const kernel of kernels) removeDir(join(root, kernel, 'home', segment), removed)
  return removed
}
