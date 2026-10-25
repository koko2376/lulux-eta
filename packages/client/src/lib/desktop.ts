/**
 * 桌面壳的偏好与支持工具（desktop/src/preload.ts 的 window.lulux.desktop）：
 * 关闭窗口时最小化到托盘、开机自启动、打开日志目录、导出诊断包；
 * 以及主进程推来的命令（托盘“新建对话”）和通知（本地服务自动重启）。
 * 浏览器 / 远程网页以及旧版桌面端没有这个桥，界面隐藏相应入口。
 */

export interface DesktopPrefs {
  closeToTray: boolean
  launchAtLogin: boolean
  platform: string
  /** 托盘是否创建成功（部分 Linux 桌面没有托盘区域） */
  trayAvailable: boolean
  /** 开发态运行时不能设置开机自启动 */
  launchAtLoginSupported: boolean
  /**
   * 系统有没有安全存储（旧版桌面壳没有这一项）：false 时“记住这台机器 / 这台服务器”用本机文件
   * （仅当前用户可读）保存，设置页如实提示
   */
  secureStorage?: boolean
  /** 字段加密主密钥这次解不开：已保存的数据不受影响，但暂时不能保存新的密钥 */
  masterKeyLocked?: boolean
}

export type DesktopNotice =
  | { type: 'server-restarting'; attempt: number; delayMs: number }
  | { type: 'server-restarted' }
  | { type: 'server-failed'; message: string }
  | { type: 'master-key-locked' }
  | { type: 'update-install-failed' }

export interface DesktopBridge {
  getPrefs(): Promise<DesktopPrefs | null>
  setPrefs(patch: Partial<Pick<DesktopPrefs, 'closeToTray' | 'launchAtLogin'>>): Promise<DesktopPrefs>
  openLogsDir(): Promise<boolean>
  /** 退出应用（旧版桌面壳没有） */
  quit?: () => Promise<boolean>
  exportDiagnostics(): Promise<{ ok: boolean; canceled?: boolean; path?: string; files?: number }>
  onCommand(listener: (command: string) => void): () => void
  onNotice(listener: (notice: DesktopNotice) => void): () => void
}

export function getDesktop(
  w: Partial<Window> | undefined = typeof window === 'undefined' ? undefined : window,
): DesktopBridge | null {
  const bridge = (w?.lulux?.desktop ?? w?.luluxAgent?.desktop) as DesktopBridge | undefined
  return bridge && typeof bridge.getPrefs === 'function' && typeof bridge.exportDiagnostics === 'function'
    ? bridge
    : null
}

export function isDesktopNotice(value: unknown): value is DesktopNotice {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'server-restarting' ||
    type === 'server-restarted' ||
    type === 'server-failed' ||
    type === 'master-key-locked' ||
    type === 'update-install-failed'
  )
}
