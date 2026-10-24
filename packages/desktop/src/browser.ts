import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { tr } from './menu'
import {
  CANCEL_PICK_SCRIPT,
  downscaleWidth,
  pickScript,
  sanitizePickResult,
  toCaptureRect,
  type PickElementInfo,
  type PickMode,
  type PickRect,
} from './pick-script'

/**
 * 内置浏览器：每个标签页一个 WebContentsView，由主进程托管，
 * 渲染进程只负责工具栏与把占位区域的矩形同步过来。
 */

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** 框选 / 元素拾取的结果：截图（PNG data URL）+ 页面与元素信息 */
export interface BrowserPickResult {
  mode: PickMode
  image: string
  width: number
  height: number
  url: string
  title: string
  /** 选区（网页 CSS 像素） */
  rect: PickRect
  zoomFactor: number
  element: PickElementInfo | null
}

export interface BrowserState {
  visible: boolean
  activeTabId: string | null
  tabs: BrowserTabState[]
}

interface Tab {
  id: string
  view: WebContentsView
}

export const BROWSER_PARTITION = 'persist:lulux-browser'
const PARTITION = BROWSER_PARTITION
const CHANNEL = 'browser:state'

const START_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>新标签页</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; background: #f6f7f9; color: #6b7280;
    font: 13px/1.7 "Microsoft YaHei", system-ui, sans-serif;
  }
  .box { text-align: center; }
  .mark { width: 42px; height: 42px; margin: 0 auto 14px; border-radius: 12px;
    background: linear-gradient(145deg, #6fc3f0, #2f9ae2); opacity: .9; }
  strong { display: block; margin-bottom: 4px; color: #374151; font-size: 14px; }
</style>
</head>
<body>
  <div class="box">
    <div class="mark"></div>
    <strong>LULUX ETA 内置浏览器</strong>
    在上方地址栏输入网址或搜索内容
  </div>
</body>
</html>`)}`

let counter = 0

function normalizeInputUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return START_PAGE
  if (/^https?:\/\//i.test(value)) return value
  // 只允许 http/https；file:、javascript: 等其他协议一律回到起始页
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:]+:\d+(\/|$)/.test(value)) return START_PAGE
  // 没有点号、带空格的内容按搜索处理
  if (value.includes(' ') || !value.includes('.')) {
    return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
  }
  return `https://${value}`
}

export class BrowserController {
  private readonly window: BrowserWindow
  private readonly tabs = new Map<string, Tab>()
  private activeTabId: string | null = null
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false

  constructor(window: BrowserWindow) {
    this.window = window
    const tabSession = session.fromPartition(PARTITION)
    tabSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
  }

  /* ── 状态广播 ─────────────────────────────────────────── */

  private tabState(tab: Tab): BrowserTabState {
    const contents = tab.view.webContents
    return {
      id: tab.id,
      url: contents.getURL(),
      title: contents.getTitle() || tr('newTab'),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    }
  }

  state(): BrowserState {
    return {
      visible: this.visible,
      activeTabId: this.activeTabId,
      tabs: [...this.tabs.values()].map((tab) => this.tabState(tab)),
    }
  }

  private broadcast(): void {
    if (this.window.isDestroyed()) return
    this.window.webContents.send(CHANNEL, this.state())
  }

  /* ── 标签页 ───────────────────────────────────────────── */

  private createTab(url?: string): string {
    const id = `tab-${++counter}`
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const tab: Tab = { id, view }
    this.tabs.set(id, tab)

    const contents = view.webContents

    contents.setWindowOpenHandler(({ url: target }) => {
      // 只有 http/https 在内置浏览器里新开标签；其他协议直接拒绝，不交给系统处理
      if (/^https?:/i.test(target) && !this.blockedByGuard(target)) this.createTab(target)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, target) => {
      if (!/^(https?:|about:blank)/i.test(target) || this.blockedByGuard(target)) event.preventDefault()
    })
    // 服务端重定向到禁止域名也拦（点击后 302 到黑名单站点）
    contents.on('will-redirect', (event, target) => {
      if (this.blockedByGuard(target)) event.preventDefault()
    })

    const update = (): void => this.broadcast()
    contents.on('did-start-loading', update)
    contents.on('did-stop-loading', update)
    contents.on('did-navigate', update)
    contents.on('did-navigate-in-page', update)
    contents.on('page-title-updated', update)
    contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) update()
    })

    void contents.loadURL(url ?? START_PAGE).catch(() => undefined)

    this.activate(id)
    return id
  }

  private detachActive(): void {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (!active) return
    try {
      this.window.contentView.removeChildView(active.view)
    } catch {
      // 未挂载时忽略
    }
  }

  private attachActive(): void {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (!active) return
    if (this.window.isDestroyed()) return
    this.window.contentView.addChildView(active.view)
    active.view.setBounds(this.bounds)
  }

  private applyVisibility(): void {
    if (this.visible && this.bounds.width > 0 && this.bounds.height > 0) {
      this.attachActive()
    } else {
      this.detachActive()
    }
    this.broadcast()
  }

  activate(id: string): void {
    if (!this.tabs.has(id)) return
    if (this.activeTabId === id) {
      this.broadcast()
      return
    }
    this.detachActive()
    this.activeTabId = id
    if (this.visible) this.attachActive()
    this.broadcast()
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (this.activeTabId === id) this.detachActive()
    this.tabs.delete(id)
    tab.view.webContents.close()
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs.keys().next().value ?? null
      if (this.visible) this.attachActive()
    }
    this.broadcast()
  }

  newTab(url?: string): string {
    return this.createTab(url ? normalizeInputUrl(url) : undefined)
  }

  navigate(raw: string): void {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (!tab) return
    void tab.view.webContents.loadURL(normalizeInputUrl(raw)).catch(() => undefined)
  }

  back(): void {
    const contents = this.activeContents()
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  forward(): void {
    const contents = this.activeContents()
    if (contents?.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward()
    }
  }

  reload(): void {
    this.activeContents()?.reload()
  }

  /** 当前标签页的 webContents（Agent 也用它取操作目标） */
  activeContents(): Electron.WebContents | null {
    const contents = this.activeTabId
      ? this.tabs.get(this.activeTabId)?.view.webContents
      : undefined
    return contents && !contents.isDestroyed() ? contents : null
  }

  /** 没有可用标签页时新建一个（Agent 用；不改变用户已有的标签页） */
  ensureTab(): Electron.WebContents | null {
    const current = this.activeContents()
    if (current) return current
    if (this.window.isDestroyed()) return null
    this.createTab()
    return this.activeContents()
  }

  /**
   * 等待标签页加载完成（Agent 用）。返回 false 表示超时或主框架加载失败。
   * 已经加载完的页面立即返回 true。
   */
  waitForLoad(contents: Electron.WebContents, timeoutMs = 15_000): Promise<boolean> {
    if (contents.isDestroyed()) return Promise.resolve(false)
    if (!contents.isLoading() && contents.getURL()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const timer = setTimeout(() => finish(false), timeoutMs)
      const finish = (loaded: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', onLoad)
        contents.removeListener('did-fail-load', onFail)
        resolve(loaded)
      }
      const onLoad = (): void => finish(true)
      const onFail = (
        _event: Electron.Event,
        _code: number,
        _description: string,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) finish(false)
      }
      contents.on('did-finish-load', onLoad)
      contents.on('did-fail-load', onFail)
      contents.once('destroyed', () => finish(false))
    })
  }

  /* ── 布局与可见性 ─────────────────────────────────────── */

  /**
   * Agent 操作期间的导航拦截（docs/browser-use.md 域名黑名单）：返回 true 的网址在导航发生前取消。
   * 由 BrowserAgent 设置，只在 Agent 持有浏览器期间生效。
   */
  navigationGuard: ((url: string) => boolean) | null = null

  private blockedByGuard(url: string): boolean {
    try {
      return this.navigationGuard?.(url) === true
    } catch {
      return false
    }
  }

  setBounds(bounds: BrowserBounds): void {
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    }
    const changed =
      next.x !== this.bounds.x ||
      next.y !== this.bounds.y ||
      next.width !== this.bounds.width ||
      next.height !== this.bounds.height
    this.bounds = next
    if (!changed) return
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (active && this.visible) active.view.setBounds(next)
  }

  /** 面板正在显示且有尺寸：视图挂在窗口上，能收到鼠标 / 键盘事件 */
  isShowing(): boolean {
    return this.visible && this.bounds.width > 0 && this.bounds.height > 0
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.applyVisibility()
  }

  /* ── 框选 / 元素拾取 ─────────────────────────────────── */

  /**
   * 在当前标签页注入覆盖层让用户框选区域或点选元素，结束后截取该区域。
   * 用户按 Esc / 右键取消、页面跳转、标签页不可见时返回 null。
   */
  async pick(mode: PickMode): Promise<BrowserPickResult | null> {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (!tab || !this.visible || this.window.isDestroyed()) return null
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return null
    contents.focus()
    let raw: unknown
    try {
      raw = await contents.executeJavaScript(
        pickScript(mode, { region: tr('pickRegionTip'), element: tr('pickElementTip') }),
        true,
      )
    } catch {
      return null
    }
    const result = sanitizePickResult(raw, mode)
    if (!result || contents.isDestroyed()) return null
    const zoomFactor = contents.getZoomFactor()
    const viewBounds = tab.view.getBounds()
    const rect = toCaptureRect(result.rect, zoomFactor, viewBounds)
    if (!rect) return null
    let image = await contents.capturePage(rect)
    if (image.isEmpty()) return null
    const target = downscaleWidth(image.getSize().width)
    if (target) image = image.resize({ width: target, quality: 'good' })
    const size = image.getSize()
    return {
      mode,
      image: image.toDataURL(),
      width: size.width,
      height: size.height,
      url: contents.getURL(),
      title: contents.getTitle(),
      rect: result.rect,
      zoomFactor,
      element: result.element,
    }
  }

  /** 取消进行中的拾取（界面里按 Esc 时，焦点可能不在网页上） */
  cancelPick(): void {
    const contents = this.activeContents()
    if (contents && !contents.isDestroyed()) void contents.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => undefined)
  }

  openExternal(url: string): void {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  }

  dispose(): void {
    this.visible = false
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.activeTabId = null
  }
}
