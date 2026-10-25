import { app, Menu, nativeImage, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tr } from './menu'

export interface TrayActions {
  open: () => void
  newChat: () => void
  quit: () => void
}

/** 托盘图标：打包后在 <resources>/tray-icon.png（electron-builder extraResources），开发态用 build/icon.png */
function iconPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'tray-icon.png')]
    : [join(__dirname, '..', 'build', 'icon.png')]
  return candidates.find((file) => existsSync(file)) ?? null
}

function trayImage(): Electron.NativeImage {
  const file = iconPath()
  if (!file) return nativeImage.createEmpty()
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) return image
  // macOS 菜单栏 18pt；Windows 16px；Linux 面板一般 22–24px
  const size = process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 24
  return image.resize({ width: size, height: size, quality: 'best' })
}

let tray: Tray | null = null
let actions: TrayActions | null = null

function buildMenu(): Menu {
  const a = actions!
  return Menu.buildFromTemplate([
    { label: tr('trayOpen'), click: () => a.open() },
    { label: tr('trayNewChat'), click: () => a.newChat() },
    { type: 'separator' },
    { label: tr('trayQuit'), click: () => a.quit() },
  ])
}

/** 创建托盘（重复调用返回同一个）；失败（例如 Linux 桌面没有托盘区域）时返回 null */
export function createTray(next: TrayActions): Tray | null {
  actions = next
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildMenu())
    return tray
  }
  try {
    tray = new Tray(trayImage())
  } catch (error) {
    console.error('[desktop] tray unavailable', error)
    tray = null
    return null
  }
  tray.setToolTip(tr('trayTooltip'))
  tray.setContextMenu(buildMenu())
  // Windows / Linux：单击托盘图标打开窗口；macOS 单击弹出菜单（系统习惯）
  if (process.platform !== 'darwin') tray.on('click', () => actions?.open())
  return tray
}

/** 界面语言变化时重建菜单文字 */
export function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed() || !actions) return
  tray.setToolTip(tr('trayTooltip'))
  tray.setContextMenu(buildMenu())
}

/** 第一次最小化到托盘时的提示（只有 Windows 支持气泡；其它平台不打扰） */
export function showTrayHint(title: string, content: string): void {
  if (!tray || tray.isDestroyed() || process.platform !== 'win32') return
  try {
    tray.displayBalloon({ title, content, iconType: 'info' })
  } catch {
    // 旧系统没有通知区域气泡
  }
}

export function hasTray(): boolean {
  return !hostMissing && Boolean(tray && !tray.isDestroyed())
}

/**
 * Linux 托盘走 StatusNotifier 协议：桌面没有托盘宿主时 new Tray() 不会抛错，图标却看不见。
 * 这里在会话总线上查托盘协议的 Watcher 服务名（WATCHER）有没有所有者：
 * true = 有托盘宿主；false = 确定没有；null = 查不了（没有 dbus-send / gdbus），按有处理。
 */
export type ExecText = (file: string, args: string[]) => Promise<string>

const execText: ExecText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })

const WATCHER = 'org.kde.StatusNotifierWatcher'

export function parseNameHasOwner(output: string): boolean | null {
  if (/boolean\s+true|\(true,?\)/.test(output)) return true
  if (/boolean\s+false|\(false,?\)/.test(output)) return false
  return null
}

export async function linuxTrayHostPresent(exec: ExecText = execText): Promise<boolean | null> {
  const attempts: Array<[string, string[]]> = [
    [
      'dbus-send',
      ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER}`],
    ],
    [
      'gdbus',
      ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER],
    ],
  ]
  for (const [file, args] of attempts) {
    try {
      const result = parseNameHasOwner(await exec(file, args))
      if (result !== null) return result
    } catch {
      // 没有这个命令 / 没有会话总线：试下一个
    }
  }
  return null
}

/** 确定没有托盘宿主：之后 hasTray() 为 false，关窗即退出，不会把窗口藏进看不见的托盘 */
let hostMissing = false
export function markTrayHostMissing(): void {
  hostMissing = true
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
