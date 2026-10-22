import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'

/**
 * 结束子进程及其子孙进程。
 * Windows 上 cross-spawn 会把 npx / npm 这类 .cmd 包装器包成 `cmd.exe /d /s /c …`，`child.kill()` 只结束 cmd.exe，
 * 真正干活的 node / CLI 进程会被留下（孤儿进程继续占用文件和端口）。这里用 `taskkill /t /f` 结束整棵进程树。
 * 其他平台照常发信号。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {
        try {
          child.kill(signal)
        } catch {
          // 已退出
        }
      })
      killer.unref()
      return
    } catch {
      // 退回普通 kill
    }
  }
  try {
    child.kill(signal)
  } catch {
    // 已退出
  }
}
