import { app, Menu, nativeImage, Tray } from 'electron'
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
  return Boolean(tray && !tray.isDestroyed())
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
