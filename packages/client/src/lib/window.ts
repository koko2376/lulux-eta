/**
 * 桌面端窗口与标题栏（契约 §9.1）。
 * - window.lulux（新 preload）：platform、titleBar、win { minimize, toggleMaximize, close, isMaximized, onMaximizeChange }
 * - window.luluxAgent.window（旧 preload）：同名方法但没有 onMaximizeChange，降级为 resize 时查询
 * - 浏览器 / 远程网页：两者都不存在，chrome='none'，不显示任何窗口按钮，所有调用都是空操作
 */
export type WindowChrome = 'mac' | 'win' | 'none'

interface WinControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized?: () => Promise<boolean>
  onMaximizeChange?: (listener: (maximized: boolean) => void) => () => void
}

function controls(): WinControls | null {
  if (typeof window === 'undefined') return null
  return (
    (window.lulux?.win as WinControls | undefined) ?? (window.luluxAgent?.window as WinControls | undefined) ?? null
  )
}

export function detectPlatform(
  w: Partial<Window> | undefined = typeof window === 'undefined' ? undefined : window,
): string {
  return w?.lulux?.platform ?? w?.luluxAgent?.platform ?? ''
}

/** 平台 → 标题栏形态：mac 用原生红绿灯（左上留位），windows / linux 右上角自绘按钮，非桌面不画 */
export function chromeFor(platform: string, desktop: boolean): WindowChrome {
  if (!desktop) return 'none'
  return platform === 'darwin' ? 'mac' : 'win'
}

export const isDesktop = typeof window !== 'undefined' && Boolean(window.lulux?.win || window.luluxAgent?.window)
export const platform = detectPlatform()
export const windowChrome: WindowChrome = chromeFor(platform, isDesktop)
/** macOS 原生红绿灯占用的左侧宽度（preload 给出，默认 80px） */
export const trafficLightInset =
  windowChrome === 'mac' ? (typeof window === 'undefined' ? 80 : (window.lulux?.titleBar?.trafficLightInset ?? 80)) : 0

/** 内置浏览器只在桌面端提供；浏览器模式下为 null */
export const desktopBrowser = typeof window !== 'undefined' ? (window.luluxAgent?.browser ?? null) : null

export function minimizeWindow(): void {
  controls()?.minimize()
}

export function toggleMaximizeWindow(): void {
  controls()?.toggleMaximize()
}

/**
 * 标题栏拖拽区域的 dblclick（契约 §9.1 第 4 条）：只有 preload 声明 doubleClickMaximizeNative=false（linux）
 * 时界面才自己切换最大化；mac / windows 由系统处理，旧 preload 或浏览器没有该字段时不处理。
 */
export function shouldHandleTitleBarDoubleClick(
  w: Partial<Window> | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  return w?.lulux?.titleBar?.doubleClickMaximizeNative === false && Boolean(w?.lulux?.win)
}

export function onTitleBarDoubleClick(): void {
  if (shouldHandleTitleBarDoubleClick()) toggleMaximizeWindow()
}

export function closeWindow(): void {
  controls()?.close()
}

export async function isWindowMaximized(): Promise<boolean> {
  try {
    return Boolean(await controls()?.isMaximized?.())
  } catch {
    return false
  }
}

/** 订阅最大化状态；旧 preload 没有 onMaximizeChange 时在 resize 后查询 isMaximized */
export function onMaximizeChange(listener: (maximized: boolean) => void): () => void {
  const c = controls()
  if (!c) return () => undefined
  if (typeof c.onMaximizeChange === 'function') return c.onMaximizeChange(listener)
  let timer = 0
  const onResize = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void isWindowMaximized().then(listener), 120)
  }
  window.addEventListener('resize', onResize)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('resize', onResize)
  }
}

/** 外链：桌面端交给系统浏览器（仅 http/https），浏览器中新标签打开 */
export function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  const browser = window.luluxAgent?.browser
  if (browser?.openExternal) void browser.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
