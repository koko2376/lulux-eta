import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-file'

/**
 * 桌面壳自己的偏好（userData/desktop-prefs.json）：
 * - closeToTray：关闭窗口时最小化到托盘（Windows 默认开；macOS 按系统习惯，关窗只关窗口、应用留在程序坞；
 *   Linux 默认关：不少桌面环境没有托盘宿主，图标看不见时窗口会“藏起来”且找不到退出入口）；
 * - launchAtLogin：开机自启动（启动时只在托盘里运行，不弹窗口）。
 * 只依赖 node:fs，便于单元测试。
 */
export interface DesktopPrefs {
  closeToTray: boolean
  launchAtLogin: boolean
  /** 第一次最小化到托盘时提示过一次 */
  trayHintShown: boolean
}

export function defaultPrefs(platform: NodeJS.Platform): DesktopPrefs {
  return { closeToTray: platform === 'win32', launchAtLogin: false, trayHintShown: false }
}

export function readPrefs(file: string, platform: NodeJS.Platform): DesktopPrefs {
  const defaults = defaultPrefs(platform)
  const raw = readJsonFile<Partial<Record<keyof DesktopPrefs, unknown>>>(file).value
  if (!raw) return defaults
  return {
    closeToTray: typeof raw.closeToTray === 'boolean' ? raw.closeToTray : defaults.closeToTray,
    launchAtLogin: typeof raw.launchAtLogin === 'boolean' ? raw.launchAtLogin : defaults.launchAtLogin,
    trayHintShown: typeof raw.trayHintShown === 'boolean' ? raw.trayHintShown : defaults.trayHintShown,
  }
}

export function writePrefs(file: string, prefs: DesktopPrefs): void {
  writeJsonFile(file, prefs)
}

/** 校验渲染进程传来的补丁；只接受界面可改的两项 */
export function applyPrefsPatch(current: DesktopPrefs, input: unknown): DesktopPrefs {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不正确')
  const next = { ...current }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key !== 'closeToTray' && key !== 'launchAtLogin') throw new Error(`未知设置项：${key}`)
    if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    next[key] = value
  }
  return next
}

/** 开机自启动时带的参数：启动后只在托盘运行 */
export const HIDDEN_ARG = '--lulux-hidden'

/**
 * Linux 没有 app.setLoginItemSettings：按 XDG 规范写 ~/.config/autostart/lulux-eta.desktop。
 * AppImage 运行时用 $APPIMAGE（挂载点每次不同），否则用可执行文件本身。
 */
export function linuxAutostartEntry(execPath: string): string {
  const quoted = /[\s"'\\]/.test(execPath) ? `"${execPath.replace(/(["\\`$])/g, '\\$1')}"` : execPath
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=LULUX ETA',
    `Exec=${quoted} ${HIDDEN_ARG}`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n')
}

export function linuxAutostartFile(configHome: string): string {
  return join(configHome, 'autostart', 'lulux-eta.desktop')
}

export function setLinuxAutostart(configHome: string, execPath: string, enabled: boolean): void {
  const file = linuxAutostartFile(configHome)
  if (enabled) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, linuxAutostartEntry(execPath))
  } else {
    rmSync(file, { force: true })
  }
}
