import { contextBridge, ipcRenderer } from 'electron'

interface BrowserState {
  visible: boolean
  activeTabId: string | null
  tabs: Array<{
    id: string
    url: string
    title: string
    loading: boolean
    canGoBack: boolean
    canGoForward: boolean
  }>
}

const browserListeners = new Set<(state: BrowserState) => void>()

ipcRenderer.on('browser:state', (_event, state: BrowserState) => {
  for (const listener of browserListeners) listener(state)
})

/** Agent 操作内置浏览器的每一步（主进程在每个可见动作完成后推送，带发起的会话 id） */
interface BrowserAgentActivity {
  action: string
  url: string
  sessionId: string
}
const agentActivityListeners = new Set<(activity: BrowserAgentActivity) => void>()
ipcRenderer.on('browser:agent-activity', (_event, activity: BrowserAgentActivity) => {
  for (const listener of agentActivityListeners) listener(activity)
})

/** Agent 操作本机桌面的每一步 / 急停与用户接管（docs/computer-use.md） */
interface ComputerAgentActivity {
  action: string
  x?: number
  y?: number
}
const computerActivityListeners = new Set<(activity: ComputerAgentActivity) => void>()
ipcRenderer.on('computer:agent-activity', (_event, activity: ComputerAgentActivity) => {
  for (const listener of computerActivityListeners) listener(activity)
})
interface ComputerAgentEvent {
  event: 'stop' | 'pause'
  reason: 'hotkey' | 'user-moved-mouse' | 'overlay'
}
const computerEventListeners = new Set<(event: ComputerAgentEvent) => void>()
ipcRenderer.on('computer:agent-event', (_event, event: ComputerAgentEvent) => {
  for (const listener of computerEventListeners) listener(event)
})

/** 自动更新（docs/AUTO-UPDATE.md）：状态推送 + 设置；新页面加载时先取消上一页的订阅 */
const updaterListeners = new Set<(state: unknown) => void>()
ipcRenderer.on('updater:state', (_event, state: unknown) => {
  for (const listener of updaterListeners) listener(state)
})
ipcRenderer.send('updater:subscribe', false)

const updater = {
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  getState: () => ipcRenderer.invoke('updater:get-state'),
  /** 订阅状态变化；有订阅时主进程不再弹原生“重启并安装”提示，由界面负责。返回取消函数 */
  onState: (listener: (state: unknown) => void) => {
    if (typeof listener !== 'function') return () => undefined
    updaterListeners.add(listener)
    if (updaterListeners.size === 1) ipcRenderer.send('updater:subscribe', true)
    return () => {
      updaterListeners.delete(listener)
      if (updaterListeners.size === 0) ipcRenderer.send('updater:subscribe', false)
    }
  },
  getSettings: () => ipcRenderer.invoke('updater:get-settings'),
  setSettings: (patch: { autoCheck?: boolean; autoDownload?: boolean; channel?: 'stable' | 'beta'; skippedVersion?: string | null; feedUrl?: string | null }) =>
    ipcRenderer.invoke('updater:set-settings', patch),
}

/**
 * 桌面壳偏好与支持工具：关闭到托盘、开机自启动、日志目录、诊断包；
 * 以及主进程推给界面的命令（托盘“新建对话”）和通知（本地服务自动重启）。
 */
const commandListeners = new Set<(command: string) => void>()
ipcRenderer.on('app:command', (_event, command: unknown) => {
  if (typeof command !== 'string') return
  for (const listener of commandListeners) listener(command)
})
const noticeListeners = new Set<(notice: unknown) => void>()
ipcRenderer.on('app:notice', (_event, notice: unknown) => {
  for (const listener of noticeListeners) listener(notice)
})
const desktop = {
  getPrefs: () => ipcRenderer.invoke('desktop:get-prefs'),
  setPrefs: (patch: { closeToTray?: boolean; launchAtLogin?: boolean }) => ipcRenderer.invoke('desktop:set-prefs', patch),
  openLogsDir: () => ipcRenderer.invoke('desktop:open-logs'),
  exportDiagnostics: () => ipcRenderer.invoke('desktop:export-diagnostics'),
  onCommand: (listener: (command: string) => void) => {
    if (typeof listener !== 'function') return () => undefined
    commandListeners.add(listener)
    return () => {
      commandListeners.delete(listener)
    }
  },
  onNotice: (listener: (notice: unknown) => void) => {
    if (typeof listener !== 'function') return () => undefined
    noticeListeners.add(listener)
    return () => {
      noticeListeners.delete(listener)
    }
  },
}

/** 窗口控制（契约 §9.1）：Windows / Linux 自绘右上角按钮用；macOS 用原生红绿灯 */
const maximizeListeners = new Set<(maximized: boolean) => void>()
ipcRenderer.on('window:maximized', (_event, maximized: boolean) => {
  for (const listener of maximizeListeners) listener(Boolean(maximized))
})
const win = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizeChange: (listener: (maximized: boolean) => void) => {
    if (typeof listener !== 'function') return () => undefined
    maximizeListeners.add(listener)
    return () => {
      maximizeListeners.delete(listener)
    }
  },
}

/**
 * 标题栏形态：
 *  - mac：原生红绿灯在左上（hiddenInset），界面在左侧留出约 80px，不画窗口按钮；双击标题栏由系统处理
 *  - windows / linux：无边框，界面在右上角自绘 最小化 / 最大化(还原) / 关闭（关闭悬停红色）
 *  doubleClickMaximizeNative：系统是否已处理拖拽区域的双击最大化；为 false 时界面在拖拽区域 dblclick 调 toggleMaximize
 */
const titleBar =
  process.platform === 'darwin'
    ? { style: 'mac-native' as const, controls: 'left' as const, trafficLightInset: 80, doubleClickMaximizeNative: true }
    : { style: 'custom' as const, controls: 'right' as const, trafficLightInset: 0, doubleClickMaximizeNative: process.platform === 'win32' }

/** 外观主题同步到原生窗口 */
const setTheme = (theme: 'light' | 'dark' | 'system'): void => ipcRenderer.send('window:set-theme', theme)

/** 界面语言同步到原生菜单 / 对话框 */
const setLanguage = (language: 'zh-CN' | 'en' | 'system'): void => ipcRenderer.send('app:set-language', language)
/** 保存过的界面语言偏好（主进程 userData/ui-language.json）；没有保存过为 null */
const languagePref = ipcRenderer.sendSync('app:get-language') as 'zh-CN' | 'en' | 'system' | null

/** 原生文件夹选择框，返回绝对路径或 null（取消） */
const pickFolder = (options: { title?: string; defaultPath?: string } = {}): Promise<string | null> =>
  ipcRenderer.invoke('dialog:pick-folder', options)

contextBridge.exposeInMainWorld('lulux', {
  platform: process.platform,
  titleBar,
  win,
  updater,
  desktop,
  setTheme,
  setLanguage,
  languagePref,
  pickFolder,
})

/** 主进程经 additionalArguments 传入本次启动的 API token */
const TOKEN_ARG = '--lulux-api-token='
const localToken = process.argv.find((arg) => arg.startsWith(TOKEN_ARG))?.slice(TOKEN_ARG.length) ?? ''

/** 本地 / 远程模式（契约 5.10）：每次加载页面时同步读取；切换模式会重新加载窗口 */
const connection = ipcRenderer.sendSync('connection:bootstrap') as { mode: 'local' | 'remote'; baseUrl: string }
const mode: 'local' | 'remote' = connection?.mode === 'remote' ? 'remote' : 'local'
const baseUrl = mode === 'remote' ? connection.baseUrl : ''
// 远程模式不把本机服务的 token 交给页面
const apiToken = mode === 'local' ? localToken : ''

contextBridge.exposeInMainWorld('luluxAgent', {
  apiToken,
  api: {
    mode,
    baseUrl,
    getSession: () => ipcRenderer.invoke('connection:get-session'),
    setSession: (session: { token: string; user: unknown } | null, options?: { persist?: boolean }) =>
      ipcRenderer.invoke('connection:set-session', session, options ?? null),
    /** 本机账户会话（“记住这台机器”）：主进程保管，勾选时 safeStorage 加密落盘，不随页面 origin 变化丢失 */
    getLocalSession: () => ipcRenderer.invoke('auth:get-local-session'),
    setLocalSession: (session: { token: string; username: string } | null, options?: { persist?: boolean }) =>
      ipcRenderer.invoke('auth:set-local-session', session, options ?? null),
    /** 登录偏好（登录方式、本机用户名、每台服务器的邮箱与“记住”勾选；不含密码 / token） */
    getLoginPrefs: () => ipcRenderer.invoke('auth:get-login-prefs'),
    setLoginPrefs: (prefs: unknown) => ipcRenderer.invoke('auth:set-login-prefs', prefs),
    getConnection: () => ipcRenderer.invoke('connection:get'),
    connectRemote: (serverUrl: string) => ipcRenderer.invoke('connection:connect-remote', serverUrl),
    useLocal: () => ipcRenderer.invoke('connection:use-local'),
  },
  platform: process.platform,
  /** 同 window.lulux.updater */
  updater,
  /** 同 window.lulux.desktop */
  desktop,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },
  browser: {
    getState: () => ipcRenderer.invoke('browser:get-state'),
    newTab: (url?: string) => ipcRenderer.invoke('browser:new-tab', url),
    closeTab: (id: string) => ipcRenderer.invoke('browser:close-tab', id),
    activateTab: (id: string) => ipcRenderer.invoke('browser:activate-tab', id),
    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    setBounds: (bounds: {
      x: number
      y: number
      width: number
      height: number
    }) => ipcRenderer.send('browser:set-bounds', bounds),
    setVisible: (visible: boolean) =>
      ipcRenderer.send('browser:set-visible', visible),
    openExternal: (url: string) =>
      ipcRenderer.invoke('browser:open-external', url),
    /** 框选区域 / 点选元素并截图；取消时 resolve(null) */
    pick: (mode: 'region' | 'element') => ipcRenderer.invoke('browser:pick', mode),
    cancelPick: () => ipcRenderer.invoke('browser:cancel-pick'),
    /** 清除内置浏览器的登录数据与缓存 */
    clearData: (): Promise<void> => ipcRenderer.invoke('browser:clear-data'),
    onState: (listener: (state: BrowserState) => void) => {
      browserListeners.add(listener)
      return () => browserListeners.delete(listener)
    },
    /** Agent 操作活动（动作名 + 页面 URL）；返回取消订阅函数 */
    onAgentActivity: (listener: (activity: BrowserAgentActivity) => void) => {
      if (typeof listener !== 'function') return () => undefined
      agentActivityListeners.add(listener)
      return () => {
        agentActivityListeners.delete(listener)
      }
    },
  },
  /** 电脑操作（docs/computer-use.md）：Agent 每一步活动 + 急停 / 用户接管事件 */
  computer: {
    onActivity: (listener: (activity: ComputerAgentActivity) => void) => {
      if (typeof listener !== 'function') return () => undefined
      computerActivityListeners.add(listener)
      return () => {
        computerActivityListeners.delete(listener)
      }
    },
    onEvent: (listener: (event: ComputerAgentEvent) => void) => {
      if (typeof listener !== 'function') return () => undefined
      computerEventListeners.add(listener)
      return () => {
        computerEventListeners.delete(listener)
      }
    },
    /** macOS 缺权限时打开系统设置（仅 darwin；其他平台返回 false） */
    openMacPrivacySettings: (kind: 'screen' | 'accessibility') =>
      ipcRenderer.invoke('computer:open-privacy-settings', kind) as Promise<boolean>,
  },
})
