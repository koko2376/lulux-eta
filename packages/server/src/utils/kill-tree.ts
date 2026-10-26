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
    taskkillTree(child.pid, () => {
      try {
        child.kill(signal)
      } catch {
        // 已退出
      }
    })
    return
  }
  try {
    child.kill(signal)
  } catch {
    // 已退出
  }
}

function taskkillTree(pid: number, fallback: () => void): void {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', fallback)
    killer.unref()
  } catch {
    fallback()
  }
}

/** 给整个进程组发信号（POSIX，要求子进程以 detached 启动，组号 = 子进程 pid）；组已不存在时忽略 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** 以独立进程组启动的子进程（detached）：服务退出时统一清理，避免孤儿进程继续运行 */
const groups = new Set<ChildProcess>()

/**
 * spawn 选项：POSIX 上让子进程自成一个进程组（detached），之后能用 killGroup 连同孙进程一起结束；
 * Windows 上不需要（taskkill /t 按进程树结束），detached 在那里会弹出新控制台，所以不设。
 */
export function groupSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== 'win32' }
}

/** 登记一个以 groupSpawnOptions 启动的子进程，服务关闭时 killAllGroups 会结束它 */
export function trackGroup(child: ChildProcess): void {
  groups.add(child)
}

export function untrackGroup(child: ChildProcess): void {
  groups.delete(child)
}

export interface GroupKill {
  /** 等子进程收尾结束（或强杀）后 resolve */
  done: Promise<void>
}

/**
 * 结束子进程所在的整个进程组：先 SIGTERM，graceMs 内没退出就 SIGKILL 整组。
 * CLI 自己已经退出时仍会给组发信号，收掉还占着管道的孙进程（Bash 工具、hooks、MCP、子 Agent）。
 * Windows：taskkill /T /F 结束整棵进程树（本身就是强制结束，不再升级）。
 */
export function killGroup(child: ChildProcess, graceMs = 3000): GroupKill {
  const pid = child.pid
  if (!pid) return { done: Promise.resolve() }
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      taskkillTree(pid, () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      })
    }
    return { done: Promise.resolve() }
  }
  const alive = (): boolean => child.exitCode === null && child.signalCode === null
  const grouped = signalGroup(pid, 'SIGTERM')
  // 组已经不存在、子进程也已退出：没有要收的进程（也避免之后对可能被复用的组号发 SIGKILL）
  if (!grouped && !alive()) return { done: Promise.resolve() }
  if (!grouped) {
    // 不是独立进程组（旧调用方式）：退回只结束子进程本身
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // 宽限期过后无论子进程是否退出都强杀整组：组里可能还有不理 SIGTERM 的孙进程
      if (grouped) signalGroup(pid, 'SIGKILL')
      if (alive()) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      }
      resolve()
    }, graceMs)
    timer.unref()
  })
  return { done }
}

/** 服务关闭：同步强杀所有登记过的进程组（不等宽限期，进程即将退出） */
export function killAllGroups(): number {
  let count = 0
  for (const child of [...groups]) {
    const pid = child.pid
    groups.delete(child)
    if (!pid) continue
    count += 1
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref()
      } catch {
        // 忽略
      }
      continue
    }
    if (!signalGroup(pid, 'SIGKILL')) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
  return count
}

let exitHookInstalled = false
/** 进程退出时兜底清理（同步）：任何退出路径都不留下 detached 的 CLI 进程组 */
export function installGroupExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    killAllGroups()
  })
}
