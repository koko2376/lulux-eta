import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

/**
 * computer-use 的边框提示窗（docs/computer-use.md“边框提示窗”）。
 *
 * 每块显示器一个透明、无边框、置顶窗口：4px 橙色内边框 + 顶部居中小条提示急停快捷键。
 * 窗口点击穿透（setIgnoreMouseEvents(true, {forward:true})）且 setContentProtection(true)，
 * 不会出现在 Agent 自己的截图里。小条只做提示（不接收点击），停止用快捷键或应用内状态条。
 */

const ORANGE = '#ff8a00'

/** 只需要 bounds（真实的 Electron Display 结构兼容） */
export interface OverlayDisplay {
  bounds: { x: number; y: number; width: number; height: number }
}

export interface OverlayWindowFactory {
  (options: BrowserWindowConstructorOptions): BrowserWindow
}

/** 小条文字：mac 用 ⌘⌥⇧K，其余 Ctrl+Alt+Shift+K */
export function overlayHint(platform: NodeJS.Platform, hotkey = true): string {
  // 急停快捷键被别的程序占用时不能再提示它（会误导用户以为有急停）
  if (!hotkey) return 'LULUX 正在操作电脑 · 在 LULUX 里点“停止”'
  return platform === 'darwin' ? 'LULUX 正在操作电脑 · ⌘⌥⇧K 停止' : 'LULUX 正在操作电脑 · Ctrl+Alt+Shift+K 停止'
}

/** 提示窗页面的内联 HTML（data: URL） */
export function overlayHtml(platform: NodeJS.Platform, hotkey = true): string {
  const hint = overlayHint(platform, hotkey)
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: ${ORANGE}; overflow: hidden; color: #fff;
    font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    display: flex; align-items: center; justify-content: center; white-space: nowrap; letter-spacing: .2px;
    user-select: none; cursor: default; }
</style></head>
<body>${hint}</body></html>`
}

export const EDGE = 4
export const HINT_WIDTH = 320
export const HINT_HEIGHT = 26

export interface OverlayPiece {
  kind: 'edge' | 'hint'
  rect: { x: number; y: number; width: number; height: number }
}

/** 一块屏上的提示窗：上下左右四条边 + 顶部居中小条（纯函数，便于测试） */
export function overlayPieces(bounds: OverlayDisplay['bounds'], _platform: NodeJS.Platform): OverlayPiece[] {
  const { x, y, width, height } = bounds
  const hintWidth = Math.min(HINT_WIDTH, Math.max(1, width - EDGE * 2))
  return [
    { kind: 'edge', rect: { x, y, width, height: EDGE } },
    { kind: 'edge', rect: { x, y: y + height - EDGE, width, height: EDGE } },
    { kind: 'edge', rect: { x, y: y + EDGE, width: EDGE, height: Math.max(1, height - EDGE * 2) } },
    { kind: 'edge', rect: { x: x + width - EDGE, y: y + EDGE, width: EDGE, height: Math.max(1, height - EDGE * 2) } },
    { kind: 'hint', rect: { x: Math.round(x + (width - hintWidth) / 2), y: y + EDGE, width: hintWidth, height: HINT_HEIGHT } },
  ]
}

export interface ComputerOverlayOptions {
  createWindow: OverlayWindowFactory
  displays: () => OverlayDisplay[]
  platform: NodeJS.Platform
}

export class ComputerOverlay {
  private readonly createWindow: OverlayWindowFactory
  private readonly displays: () => OverlayDisplay[]
  private readonly platform: NodeJS.Platform
  private windows: BrowserWindow[] = []

  constructor(options: ComputerOverlayOptions) {
    this.createWindow = options.createWindow
    this.displays = options.displays
    this.platform = options.platform
  }

  /** 显示边框提示窗：先关掉旧的（显示器可能变了），每块屏一个 */
  show(options: { hotkey?: boolean } = {}): void {
    this.hide()
    let targets: OverlayDisplay[]
    try {
      targets = this.displays()
    } catch {
      return
    }
    // 不用整屏透明窗：Linux 没有合成器时透明窗会变成整块黑屏。改成四条实色细边 + 顶部一个实色小条，
    // 每个都是普通不透明窗口，任何平台都安全；全部点击穿透、不进截图。
    const hintHtml = `data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(this.platform, options.hotkey !== false))}`
    for (const display of targets) {
      for (const piece of overlayPieces(display.bounds, this.platform)) {
        try {
          const window = this.createWindow({
            ...piece.rect,
            frame: false,
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            focusable: false,
            show: false,
            acceptFirstMouse: false,
            backgroundColor: ORANGE,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          })
          window.setAlwaysOnTop(true, 'screen-saver')
          window.setContentProtection(true)
          window.setIgnoreMouseEvents(true)
          window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
          if (piece.kind === 'hint') void window.loadURL(hintHtml)
          window.showInactive()
          this.windows.push(window)
        } catch {
          // 某块屏的提示窗建不出来不影响操作
        }
      }
    }
  }

  hide(): void {
    for (const window of this.windows) {
      try {
        if (!window.isDestroyed()) window.close()
      } catch {
        // 已经关掉了
      }
    }
    this.windows = []
  }

  dispose(): void {
    this.hide()
  }
}
