/// <reference types="vite/client" />

interface LuluxDesktopWindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
}

interface LuluxBrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

interface LuluxBrowserState {
  visible: boolean
  activeTabId: string | null
  tabs: LuluxBrowserTab[]
}

interface LuluxBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 内置浏览器框选 / 元素拾取的结果（desktop/src/browser.ts BrowserPickResult） */
interface LuluxBrowserPickResult {
  mode: 'region' | 'element'
  /** PNG data URL */
  image: string
  width: number
  height: number
  url: string
  title: string
  rect: LuluxBrowserBounds
  zoomFactor: number
  element: { tag: string; id: string; classes: string[]; selector: string; text: string } | null
}

interface LuluxDesktopBrowser {
  getState: () => Promise<LuluxBrowserState | null>
  newTab: (url?: string) => Promise<string | null>
  closeTab: (id: string) => Promise<void>
  activateTab: (id: string) => Promise<void>
  navigate: (url: string) => Promise<void>
  back: () => Promise<void>
  forward: () => Promise<void>
  reload: () => Promise<void>
  setBounds: (bounds: LuluxBrowserBounds) => void
  setVisible: (visible: boolean) => void
  openExternal: (url: string) => Promise<void>
  onState: (listener: (state: LuluxBrowserState) => void) => () => void
  /** Agent 操作内置浏览器（动作名 + 页面 URL + 发起的会话）；旧版桌面端没有 */
  onAgentActivity?: (listener: (activity: { action: string; url: string; sessionId?: string }) => void) => (() => void)
  /** 清除内置浏览器的登录数据（cookie / 缓存）；旧版桌面端没有 */
  clearData?: () => Promise<void>
  /** 旧版桌面端没有 */
  pick?: (mode: 'region' | 'element') => Promise<LuluxBrowserPickResult | null>
  cancelPick?: () => Promise<void>
}

/** 电脑操作（docs/computer-use.md）：Agent 每一步活动 + 急停 / 用户接管事件 */
interface LuluxComputerAgentActivity {
  action: string
  /** 截图坐标（只有点到类动作有） */
  x?: number
  y?: number
}

interface LuluxComputerAgentEvent {
  event: 'stop' | 'pause'
  reason: 'hotkey' | 'user-moved-mouse' | 'overlay'
}

interface LuluxDesktopComputer {
  /** Agent 操作本机桌面的每一步；返回取消订阅函数 */
  onActivity: (listener: (activity: LuluxComputerAgentActivity) => void) => () => void
  /** 急停（快捷键）或用户接管（动了鼠标） */
  onEvent: (listener: (event: LuluxComputerAgentEvent) => void) => () => void
  /** macOS 缺屏幕录制 / 辅助功能权限时打开系统设置；仅 darwin */
  openMacPrivacySettings: (kind: 'screen' | 'accessibility') => Promise<boolean>
}

interface LuluxRemoteUser {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  disabled: boolean
  createdAt: number
  lastLoginAt: number | null
}

/** 契约 §5.10：桌面端连接团队服务器 */
interface LuluxDesktopApi {
  mode: 'local' | 'remote'
  baseUrl: string
  getSession: () => Promise<{
    mode: 'local' | 'remote'
    baseUrl: string
    token: string | null
    user: LuluxRemoteUser | null
  }>
  /** persist=false：只放主进程内存（没勾“记住这台服务器”） */
  setSession: (session: { token: string; user: LuluxRemoteUser } | null, options?: { persist?: boolean }) => Promise<void>
  /** 本机账户会话（“记住这台机器”）：主进程保管；旧版桌面壳没有 */
  getLocalSession?: () => Promise<{ token: string; username: string } | null>
  setLocalSession?: (
    session: { token: string; username: string } | null,
    options?: { persist?: boolean },
  ) => Promise<{ persisted: boolean }>
  /** 登录偏好（不含密码 / token）；旧版桌面壳没有 */
  getLoginPrefs?: () => Promise<unknown>
  setLoginPrefs?: (prefs: unknown) => Promise<unknown>
  getConnection: () => Promise<{ mode: 'local' | 'remote'; serverUrl: string | null; recentServers: string[] }>
  connectRemote: (
    serverUrl: string,
  ) => Promise<
    { ok: true; info: { mode: string; setupRequired: boolean; version: string } } | { ok: false; error: string }
  >
  useLocal: () => Promise<void>
}

interface LuluxDesktopBridge {
  api?: LuluxDesktopApi
  /** 桌面端每次启动随机生成的本地 API token（契约 §1） */
  apiToken?: string
  platform: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
  window?: LuluxDesktopWindowControls
  browser?: LuluxDesktopBrowser
  /** 电脑操作（旧版桌面端没有） */
  computer?: LuluxDesktopComputer
  /** 同 window.lulux.desktop */
  desktop?: unknown
}

/** 新 preload（契约 §9.1）：平台、标题栏形态与窗口控制 */
interface LuluxWindowBridge {
  platform: string
  titleBar?: {
    style: 'mac-native' | 'custom'
    controls: 'left' | 'right'
    trafficLightInset: number
    doubleClickMaximizeNative: boolean
  }
  win?: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChange: (listener: (maximized: boolean) => void) => () => void
  }
  /** 自动更新（契约 §9.2），类型见 src/lib/updater.ts */
  updater?: unknown
  /** 托盘 / 开机自启动 / 日志与诊断包，类型见 src/lib/desktop.ts */
  desktop?: unknown
  /** 界面语言偏好交给主进程（原生菜单 / 对话框，并持久保存） */
  setLanguage?: (language: 'zh-CN' | 'en' | 'system') => void
  /** 主进程保存过的界面语言偏好（启动时同步读出）；没有保存过为 null */
  languagePref?: 'zh-CN' | 'en' | 'system' | null
  /** 原生文件夹选择框（新版 preload），返回绝对路径或 null */
  pickFolder?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
}

interface Window {
  lulux?: LuluxWindowBridge
  luluxAgent?: LuluxDesktopBridge
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

declare const __APP_VERSION__: string
