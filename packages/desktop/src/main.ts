import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { AuthStore } from './auth-store'
import { initialLocalPort } from './local-port'
import { UiStorageStore } from './ui-storage'
import { BROWSER_PARTITION, BrowserController, type BrowserBounds } from './browser'
import { BrowserAgent } from './browser-agent'
import { ComputerAgent } from './computer-agent'
import { canEncrypt, connectionStore, normalizeServerUrl, type SessionUser } from './connection'
import {
  applyPrefsPatch,
  HIDDEN_ARG,
  readPrefs,
  setLinuxAutostart,
  writePrefs,
  type DesktopPrefs,
} from './desktop-prefs'
import { buildDiagnosticsZip, diagnosticsFileName } from './diagnostics'
import {
  generateApiToken,
  resolveDataHome,
  startLocalServer,
  type LocalServer,
  type McpConfirmRequest,
} from './server'
import { applyAppMenu, attachContextMenu, onLanguageChange, setLanguagePref, storedLanguagePref, tr } from './menu'
import { RestartPolicy } from './supervisor'
import {
  createTray,
  destroyTray,
  hasTray,
  linuxTrayHostPresent,
  markTrayHostMissing,
  refreshTrayMenu,
  showTrayHint,
} from './tray'
import { initUpdater, markInstallFailed } from './updater'

const APP_NAME = 'LULUX ETA'
const EXTERNAL_URL = process.env.LULUX_ETA_URL?.trim() || ''
const SMOKE = process.env.LULUX_ETA_SMOKE === '1'

app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null
let browserController: BrowserController | null = null
/** Agent 操作内置浏览器（docs/browser-use.md）：经 IPC 由本地服务驱动 */
const browserAgent = new BrowserAgent(
  () => browserController,
  (activity) => {
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('browser:agent-activity', activity)
  },
)
/** Agent 操作本机桌面（docs/computer-use.md）：同样经 IPC 由本地服务驱动；robotjs 懒加载 */
const computerAgent = new ComputerAgent({
  screen,
  desktopCapturer,
  globalShortcut,
  systemPreferences,
  clipboard,
  createWindow: (options) => new BrowserWindow(options),
  onActivity: (activity) => {
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('computer:agent-activity', activity)
  },
  onEvent: (event) => {
    // 急停 / 用户接管：服务进程据此停止后续工具调用，界面据此显示状态条
    localServer?.sendComputerEvent(event)
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send('computer:agent-event', event)
  },
})
let localServer: LocalServer | null = null
let appUrl = EXTERNAL_URL || 'http://127.0.0.1:31789'
/**
 * 本次启动的 API token：经 env 交给服务；preload 经同步 IPC（app:get-api-token）向主进程要，
 * 不放进渲染进程的命令行参数（同机其他用户能从进程列表读到命令行）。
 */
const apiToken = process.env.LULUX_API_TOKEN?.trim() || generateApiToken()
/** 最近一次成功启动的本地服务端口：崩溃重启、安装失败恢复都沿用它，不依赖 localServer 是否还在 */
let lastLocalPort: number | null = null
/** 字段加密主密钥这次解不开（服务以“密钥只读”方式运行），设置页与启动提示据此说明 */
let masterKeyLocked = false

/** 远程模式下团队服务器的 origin（契约 5.10）；本地模式为 null */
let remoteOrigin: string | null = null

/** 桌面壳偏好（关闭到托盘 / 开机自启动），app ready 后读取 */
let prefs: DesktopPrefs = { closeToTray: process.platform !== 'darwin', launchAtLogin: false, trayHintShown: false }
function prefsFile(): string {
  return join(app.getPath('userData'), 'desktop-prefs.json')
}
/**
 * 登录态（本机账户会话、登录偏好、上次端口）由主进程保管：本地端口一变页面 origin 就变，
 * localStorage 会整个换成空的，“记住这台机器”不能只靠它（见 auth-store.ts）。
 */
let authStoreInstance: AuthStore | null = null
function authStore(): AuthStore {
  if (!authStoreInstance) {
    authStoreInstance = new AuthStore(
      join(app.getPath('userData'), 'auth-state.json'),
      {
        available: canEncrypt,
        encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
      },
      // 按数据目录分开保存会话：安装版与免安装版共用 userData 时互不删除
      { scope: EXTERNAL_URL ? 'external' : resolveDataHome(), onWarn: (message) => desktopLog(message) },
    )
  }
  return authStoreInstance
}
let uiStorageInstance: UiStorageStore | null = null
function uiStorage(): UiStorageStore {
  if (!uiStorageInstance) uiStorageInstance = new UiStorageStore(join(app.getPath('userData'), 'ui-storage.json'))
  return uiStorageInstance
}
/**
 * 开机自启动拉起时只在托盘运行。Windows / Linux 的登录项带 --lulux-hidden 参数；
 * macOS 登录项不带参数，改看系统给的“是否由登录项打开”。
 */
function wasLaunchedHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true
  if (process.platform !== 'darwin') return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true
  } catch {
    return false
  }
}
/** 只有本次启动的第一个窗口按“开机自启动”隐藏；之后（例如从托盘重新打开）一律显示 */
let hiddenLaunchConsumed = false
function launchedHidden(): boolean {
  if (hiddenLaunchConsumed) return false
  hiddenLaunchConsumed = true
  return wasLaunchedHidden()
}
/** 已确认退出（托盘 / 菜单退出、安装更新、系统关机）：之后的关窗与 before-quit 不再拦截 */
let quitConfirmed = false
let quitPrompting = false

/** 主进程自己的事件日志（服务重启、界面崩溃），随诊断包导出 */
function desktopLog(message: string): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'desktop.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 日志失败不影响运行
  }
}

/** 主窗口 CSP（与服务端返回的一致）；srcdoc 产物 iframe 会继承它。远程模式额外放行团队服务器的 connect-src */
function clientCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    remoteOrigin ? `connect-src 'self' ${remoteOrigin}` : "connect-src 'self'",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** 只有本服务的精确 origin 才算应用内页面 */
function isAppUrl(url: string): boolean {
  const target = originOf(url)
  return target !== null && target === originOf(appUrl)
}

/** 外链只允许 http/https，交给系统浏览器 */
function openExternalSafe(url: string): void {
  if (originOf(url)) void shell.openExternal(url)
}

/** 新建/修改 MCP 命令时由主进程弹出原生确认框，渲染进程无法绕过 */
async function confirmMcpCommand(request: McpConfirmRequest): Promise<boolean> {
  const quote = (value: string): string => (/[\s"']/.test(value) ? JSON.stringify(value) : value)
  const commandLine = [request.command, ...request.args].map(quote).join(' ')
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: APP_NAME,
    message: tr('mcpMessage', request.name),
    detail:
      tr('mcpDetail', commandLine) +
      (request.env.length > 0 ? tr('mcpEnv', request.env.join(', ')) : '') +
      tr('mcpTrust'),
    buttons: [tr('deny'), tr('allowRun')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

function installSecurityPolicies(): void {
  const defaultSession = session.defaultSession
  // 应用页面统一注入 CSP（内置浏览器使用独立分区，不受影响）
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    if (isAppUrl(details.url) && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') delete headers[key]
      }
      headers['Content-Security-Policy'] = [clientCsp()]
    }
    callback({ responseHeaders: headers })
  })
  // 主界面不需要摄像头、定位等权限
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
}

function windowFrom(event: Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * 窗口控制（契约 §9.1）。macOS 用原生红绿灯（titleBarStyle hiddenInset），这些 IPC 在 macOS 上同样可用但界面不需要；
 * Windows / Linux 无边框，由界面在右上角自绘 最小化 / 最大化(还原) / 关闭。只接受主窗口里本应用页面的调用。
 */
function registerWindowControls(): void {
  const target = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    fromAppPage(event) ? BrowserWindow.fromWebContents(event.sender) : null

  ipcMain.on('window:minimize', (event) => {
    target(event)?.minimize()
  })

  ipcMain.on('window:toggle-maximize', (event) => {
    const window = target(event)
    if (!window) return
    if (process.platform === 'darwin' && window.isFullScreen()) {
      window.setFullScreen(false)
    } else if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    target(event)?.close()
  })

  // 外观：界面选择的浅色 / 深色 / 跟随系统同步给原生窗口（标题栏、滚动条、系统弹窗）
  ipcMain.on('window:set-theme', (event, theme: unknown) => {
    if (!fromAppPage(event)) return
    if (theme === 'light' || theme === 'dark' || theme === 'system') nativeTheme.themeSource = theme
  })

  // 界面语言同步给原生菜单 / 右键菜单 / 原生对话框
  // preload 启动时同步读取保存过的界面语言（页面 origin 变化、localStorage 为空时界面用它）
  ipcMain.on('app:get-language', (event) => {
    event.returnValue = fromAppPage(event) ? storedLanguagePref() : null
  })
  ipcMain.on('app:set-language', (event, language: unknown) => {
    if (!fromAppPage(event)) return
    setLanguagePref(language)
  })
  // preload 启动时同步要本次的 API token：只给主窗口里的本应用页面，远程模式不给
  ipcMain.on('app:get-api-token', (event) => {
    event.returnValue = fromAppPage(event) && !remoteOrigin ? apiToken : ''
  })
  // 界面偏好快照（lulux.* 键，不含会话）：端口变化后在新 origin 里还原，见 ui-storage.ts
  ipcMain.on('app:get-ui-storage', (event) => {
    event.returnValue = fromAppPage(event) ? uiStorage().get() : null
  })
  ipcMain.on('app:save-ui-storage', (event, snapshot: unknown) => {
    if (!fromAppPage(event)) return
    try {
      uiStorage().save(snapshot)
    } catch (error) {
      desktopLog(`save ui storage failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ipcMain.handle('window:is-maximized', (event) => {
    const window = target(event)
    return window ? window.isMaximized() || window.isFullScreen() : false
  })

  // 选择文件夹（备份目录等）：只在本机模式由界面调用，返回绝对路径或 null（取消）
  ipcMain.handle('dialog:pick-folder', async (event, options: unknown) => {
    const window = target(event)
    if (!window) return null
    const opts = (options && typeof options === 'object' ? options : {}) as { title?: unknown; defaultPath?: unknown }
    const result = await dialog.showOpenDialog(window, {
      title: typeof opts.title === 'string' ? opts.title.slice(0, 200) : undefined,
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}

/** 最大化 / 还原 / 全屏变化推送给界面（切换“最大化”与“还原”图标） */
function watchMaximize(window: BrowserWindow): void {
  const send = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('window:maximized', window.isMaximized() || window.isFullScreen())
  }
  for (const name of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    window.on(name as 'maximize', send)
  }
}

/** 按平台区分的标题栏：macOS 原生红绿灯；Windows / Linux 无边框 + 界面自绘右上角按钮 */
function titleBarOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
  }
  return { frame: false }
}

function registerBrowserControls(): void {
  const controller = (): BrowserController | null => browserController

  // 只接受主窗口里应用页面发来的调用（与 pick / clear-data 一致），参数逐个校验类型
  const str = (value: unknown, max = 4000): string | null =>
    typeof value === 'string' && value.length <= max ? value : null
  ipcMain.handle('browser:get-state', (event) => (fromAppPage(event) ? controller()?.state() ?? null : null))
  ipcMain.handle('browser:new-tab', (event, url?: unknown) => {
    if (!fromAppPage(event)) return null
    return controller()?.newTab(url === undefined || url === null ? undefined : str(url) ?? undefined) ?? null
  })
  ipcMain.handle('browser:close-tab', (event, id: unknown) => {
    const tab = str(id, 200)
    if (fromAppPage(event) && tab) controller()?.closeTab(tab)
  })
  ipcMain.handle('browser:activate-tab', (event, id: unknown) => {
    const tab = str(id, 200)
    if (fromAppPage(event) && tab) controller()?.activate(tab)
  })
  ipcMain.handle('browser:navigate', (event, url: unknown) => {
    const target = str(url)
    if (fromAppPage(event) && target !== null) controller()?.navigate(target)
  })
  ipcMain.handle('browser:back', (event) => (fromAppPage(event) ? controller()?.back() : undefined))
  ipcMain.handle('browser:forward', (event) => (fromAppPage(event) ? controller()?.forward() : undefined))
  ipcMain.handle('browser:reload', (event) => (fromAppPage(event) ? controller()?.reload() : undefined))
  ipcMain.on('browser:set-bounds', (event, bounds: BrowserBounds) => {
    if (!fromAppPage(event) || !bounds || typeof bounds !== 'object') return
    const finite = [bounds.x, bounds.y, bounds.width, bounds.height].every((v) => typeof v === 'number' && Number.isFinite(v))
    if (!finite || bounds.width < 0 || bounds.height < 0) return
    controller()?.setBounds(bounds)
  })
  ipcMain.on('browser:set-visible', (event, visible: boolean) => {
    if (fromAppPage(event)) controller()?.setVisible(Boolean(visible))
  })
  ipcMain.handle('browser:pick', (event, mode: unknown) => {
    if (!fromAppPage(event) || (mode !== 'region' && mode !== 'element')) return null
    return controller()?.pick(mode) ?? null
  })
  ipcMain.handle('browser:cancel-pick', (event) => {
    if (fromAppPage(event)) controller()?.cancelPick()
  })
  // 设置 → 内置浏览器 → 清除登录数据（docs/browser-use.md）：清 cookie / 存储 / 缓存，所有网站需要重新登录
  ipcMain.handle('browser:clear-data', async (event) => {
    if (!fromAppPage(event)) return
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    await browserSession.clearStorageData()
    await browserSession.clearCache()
  })
  ipcMain.handle('browser:open-external', (event, url: string) => {
    if (fromAppPage(event) && typeof url === 'string') openExternalSafe(url)
  })
}

/** 只接受主窗口里本应用页面发来的连接类 IPC */
function fromAppPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false
  const url = event.senderFrame?.url ?? ''
  return url === '' || isAppUrl(url)
}

interface ModeInfo {
  mode: 'local' | 'remote'
  setupRequired: boolean
  version: string
}

async function probeServer(serverUrl: string): Promise<ModeInfo> {
  const response = await fetch(`${serverUrl}/api/auth/mode`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`)
  const body = (await response.json()) as { mode?: string; setupRequired?: boolean; version?: string }
  if (body.mode !== 'server') throw new Error('该地址不是 LULUX 团队服务器（mode 不是 server）')
  return { mode: 'remote', setupRequired: Boolean(body.setupRequired), version: String(body.version ?? '') }
}

/** 切换模式后重新加载窗口：preload 重新读取模式，CSP 随之更新 */
function reloadForMode(): void {
  remoteOrigin = connectionStore.remoteOrigin()
  loadApp()
}

function registerConnectionControls(): void {
  // preload 启动时同步读取（契约 5.10 的 api.mode / api.baseUrl）
  ipcMain.on('connection:bootstrap', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      event.returnValue = { mode: 'local', baseUrl: '' }
      return
    }
    event.returnValue = remoteOrigin ? { mode: 'remote', baseUrl: remoteOrigin } : { mode: 'local', baseUrl: '' }
  })

  ipcMain.handle('connection:get', (event) => {
    if (!fromAppPage(event)) return null
    return connectionStore.get()
  })

  ipcMain.handle('connection:get-session', (event) => {
    if (!fromAppPage(event)) return null
    if (!remoteOrigin) return { mode: 'local', baseUrl: '', token: apiToken, user: null }
    const session = connectionStore.session(remoteOrigin)
    return { mode: 'remote', baseUrl: remoteOrigin, token: session?.token ?? null, user: session?.user ?? null }
  })

  ipcMain.handle(
    'connection:set-session',
    (event, session: { token?: unknown; user?: unknown } | null, options?: { persist?: unknown } | null) => {
      if (!fromAppPage(event) || !remoteOrigin) return { persisted: false, storage: 'memory' }
      if (session === null) return connectionStore.setSession(remoteOrigin, null)
      if (!session || typeof session.token !== 'string' || !/^lxs_[0-9a-f]{64}$/.test(session.token)) {
        throw new Error('会话 token 格式不正确')
      }
      const user = session.user && typeof session.user === 'object' ? (session.user as SessionUser) : null
      // 没勾“记住这台服务器”：只放内存（本次运行），不落盘；旧版页面不传 options 时照旧持久
      const persist = options?.persist !== false
      // 返回实际落盘方式（secure / file / memory），界面据此如实提示
      return connectionStore.setSession(remoteOrigin, { token: session.token, user }, { persist })
    },
  )

  /* 本机账户会话（“记住这台机器”）与登录偏好：由主进程保管，见 auth-store.ts */
  ipcMain.handle('auth:get-local-session', (event) => {
    if (!fromAppPage(event)) return null
    const state = authStore().getLocalSessionState()
    // locked：磁盘上有会话但安全存储暂时解不开，页面显示登录页但不能清盘
    if (state.state === 'locked') return { locked: true }
    return state.state === 'ok' ? state.session : null
  })
  ipcMain.handle(
    'auth:set-local-session',
    (event, session: unknown, options?: { persist?: unknown; forget?: unknown } | null) => {
      if (!fromAppPage(event)) return { persisted: false, storage: 'memory' }
      return authStore().setLocalSession(session, { persist: options?.persist === true, forget: options?.forget === true })
    },
  )
  ipcMain.handle('auth:get-login-prefs', (event) => {
    if (!fromAppPage(event)) return {}
    return authStore().getLoginPrefs()
  })
  ipcMain.handle('auth:set-login-prefs', (event, prefs: unknown) => {
    if (!fromAppPage(event)) return {}
    return authStore().setLoginPrefs(prefs)
  })

  ipcMain.handle('connection:connect-remote', async (event, raw: unknown) => {
    if (!fromAppPage(event)) return { ok: false, error: '不允许的调用方' }
    try {
      const serverUrl = normalizeServerUrl(String(raw ?? ''))
      const info = await probeServer(serverUrl)
      connectionStore.useRemote(serverUrl)
      setTimeout(reloadForMode, 50)
      return { ok: true, info: { mode: 'server', setupRequired: info.setupRequired, version: info.version } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('connection:use-local', (event) => {
    if (!fromAppPage(event)) return false
    connectionStore.useLocal()
    setTimeout(reloadForMode, 50)
    return true
  })
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  )
}

/** 服务起不来时用一个静态页说明原因，而不是留在空白窗口 */
function showStartupError(error: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const message = error instanceof Error ? error.message : String(error)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${APP_NAME}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #fdfdfd; color: #1f1f22;
    font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: min(560px, 82vw); }
  h1 { margin: 0 0 8px; font-size: 18px; }
  p { margin: 0 0 16px; color: #6b6b73; }
  pre { margin: 0 0 20px; padding: 14px 16px; border-radius: 12px; background: #f4f4f5;
    color: #8a3b3b; font: 12px/1.6 ui-monospace, Consolas, monospace; white-space: pre-wrap; }
  button { padding: 8px 20px; border: 0; border-radius: 10px; background: #1f1f22;
    color: #fff; font-size: 13px; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>LULUX ETA 无法启动</h1>
  <p>本地服务没有成功启动。请确认安装目录完整，或重新打开应用。</p>
  <pre>${escapeHtml(message)}</pre>
  <button onclick="window.close()">退出</button>
</main>
</body>
</html>`
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function loadApp(attempt = 0): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  void window.loadURL(appUrl).catch(() => {
    // 服务刚起时可能还没准备好，短暂重试
    if (attempt < 10) setTimeout(() => loadApp(attempt + 1), 1000)
  })
}

const restartPolicy = new RestartPolicy()
let restartTimer: NodeJS.Timeout | null = null

async function launchLocalServer(preferredPort?: number): Promise<LocalServer> {
  const start = (port?: number): Promise<LocalServer> =>
    startLocalServer({
      token: apiToken,
      confirmMcp: confirmMcpCommand,
      browserAgent,
      computerAgent,
      preferredPort: port,
      onUnexpectedExit: (message) => onServerExit(message),
    })
  let server: LocalServer
  try {
    server = await start(preferredPort)
  } catch (error) {
    // 探测时端口空闲、服务真正监听时却被占（例如别的程序只绑了 0.0.0.0）：换系统分配的端口再试一次
    const message = error instanceof Error ? error.message : String(error)
    if (!preferredPort || !/EADDRINUSE|address already in use/i.test(message)) throw error
    desktopLog(`local server failed on preferred port ${preferredPort}, retrying on the next fixed ports`)
    server = await start(preferredPort + 1 <= 65535 ? preferredPort + 1 : undefined)
  }
  lastLocalPort = server.port
  if (server.masterKeyLocked && !masterKeyLocked) {
    masterKeyLocked = true
    desktopLog('master key could not be unlocked; secrets are read-only this run (master.key.safe kept)')
    const window = mainWindow
    if (window && !window.isDestroyed()) {
      window.webContents.once('did-finish-load', () => notifyRenderer({ type: 'master-key-locked' }))
    }
  }
  try {
    authStore().setLocalPort(server.port)
  } catch {
    // userData 不可写：下次换端口只影响页面里的界面偏好，登录态仍在主进程里
  }
  return server
}

/** 主进程推给界面的通知（界面用 toast 展示） */
function notifyRenderer(notice: Record<string, unknown>): void {
  const window = mainWindow
  if (window && !window.isDestroyed()) window.webContents.send('app:notice', notice)
}

/**
 * 本地服务意外退出：按退避节奏自动重启（沿用原端口，界面不必换地址），并在界面提示；
 * 短时间内反复退出则放弃并弹出错误说明。
 */
function onServerExit(message: string): void {
  if (quitConfirmed || cleanedUp) return
  desktopLog(`local server exited: ${message}`)
  // 不从 localServer 读端口：重启失败时它已经是 null，会退回系统随机端口并被记下来
  const previousPort = lastLocalPort ?? undefined
  localServer = null
  const delay = restartPolicy.nextDelay()
  if (delay === null) {
    desktopLog('local server restart gave up')
    notifyRenderer({ type: 'server-failed', message })
    dialog.showErrorBox(APP_NAME, `${tr('serverGaveUp')}\n\n${tr('serverGaveUpDetail', message)}`)
    return
  }
  notifyRenderer({ type: 'server-restarting', attempt: restartPolicy.attempts, delayMs: delay })
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartLocalServer(previousPort, message)
  }, delay)
}

async function restartLocalServer(preferredPort: number | undefined, lastMessage: string): Promise<void> {
  if (quitConfirmed || cleanedUp || localServer) return
  try {
    localServer = await launchLocalServer(preferredPort)
    restartPolicy.started()
    desktopLog(`local server restarted on port ${localServer.port}`)
    const moved = localServer.url !== appUrl
    appUrl = localServer.url
    if (moved) {
      // 端口变了：页面换到新地址，加载完成后再提示
      mainWindow?.webContents.once('did-finish-load', () => notifyRenderer({ type: 'server-restarted' }))
      loadApp()
    } else {
      notifyRenderer({ type: 'server-restarted' })
    }
  } catch (error) {
    onServerExit(error instanceof Error ? error.message : String(error) || lastMessage)
  }
}

async function boot(): Promise<void> {
  if (!EXTERNAL_URL && !localServer) {
    try {
      localServer = await launchLocalServer(initialLocalPort(authStore().getLocalPort(), process.platform))
      restartPolicy.started()
      appUrl = localServer.url
    } catch (error) {
      showStartupError(error)
      return
    }
  }
  loadApp()
}

/** 本地服务里进行中的会话运行数；查询失败按 0（不阻止关窗） */
async function activeRunCount(): Promise<number> {
  if (!localServer) return 0
  try {
    // 有本机账户时主进程没有本机会话：用只返回数量、不需要会话的接口
    const response = await fetch(`${localServer.url}/api/chat/runs/count`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return 0
    const body = (await response.json()) as { count?: unknown }
    return typeof body.count === 'number' ? body.count : 0
  } catch {
    return 0
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: APP_NAME,
    // 开机自启动且开启了托盘：启动时只在托盘运行
    // macOS 没有托盘也可以从程序坞重新打开窗口
    show: !(launchedHidden() && ((prefs.closeToTray && hasTray()) || process.platform === 'darwin')),
    icon: app.isPackaged ? undefined : join(__dirname, '..', 'build', 'icon.png'),
    ...titleBarOptions(),
    backgroundColor: '#fdfdfd',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })

  const contents = mainWindow.webContents
  attachContextMenu(contents)
  // Windows / Linux 没有应用菜单：Ctrl+Q 作为始终可用的退出入口（托盘图标看不见时也能退出）
  if (process.platform !== 'darwin') {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.shift || input.meta) return
      if (input.key.toLowerCase() !== 'q') return
      event.preventDefault()
      void requestQuit('quit')
    })
  }
  // 新窗口一律不在应用内打开：http/https 交给系统浏览器，其余协议直接拒绝
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  // 主窗口只允许停留在本服务的精确 origin（启动错误页由主进程直接 loadURL，不触发此事件）
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafe(url)
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  contents.on('will-attach-webview', (event) => event.preventDefault())

  watchMaximize(mainWindow)
  browserController = new BrowserController(mainWindow)

  /**
   * 关窗：
   *  - 开启“关闭窗口时最小化到托盘”：只隐藏窗口，本地服务（定时任务、邮箱同步、后台工作流）继续运行；
   *  - macOS 未开启：系统习惯，关窗只关窗口，应用留在程序坞（本地服务继续运行）；
   *  - Windows / Linux 未开启：关窗即退出应用，还有对话在跑时先确认（契约 §6.9）。
   */
  mainWindow.on('close', (event) => {
    const window = mainWindow
    if (quitConfirmed || !window) return
    if (prefs.closeToTray && hasTray()) {
      event.preventDefault()
      window.hide()
      if (!prefs.trayHintShown) {
        prefs = { ...prefs, trayHintShown: true }
        savePrefs()
        showTrayHint(tr('trayHintTitle'), tr('trayHintBody'))
      }
      return
    }
    if (process.platform === 'darwin') return
    event.preventDefault()
    void requestQuit('close')
  })

  // 界面进程崩溃 / 卡死：提示重新加载，而不是留下一个白屏
  let expectCrash = false
  contents.on('render-process-gone', (_event, details) => {
    desktopLog(`renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (expectCrash) {
      // 用户在“没有响应”提示里选了重新加载
      expectCrash = false
      loadApp()
      return
    }
    if (details.reason === 'clean-exit' || quitConfirmed) return
    void offerReload(tr('rendererGone'), tr('rendererGoneDetail', details.reason), [tr('reload'), tr('quitApp')]).then(
      (response) => {
        if (response === 0) loadApp()
        else void requestQuit('quit')
      },
    )
  })
  let unresponsivePrompt = false
  mainWindow.on('unresponsive', () => {
    if (unresponsivePrompt || quitConfirmed) return
    unresponsivePrompt = true
    desktopLog('renderer unresponsive')
    void offerReload(tr('rendererUnresponsive'), tr('rendererUnresponsiveDetail'), [tr('wait'), tr('reload')]).then(
      (response) => {
        unresponsivePrompt = false
        if (response === 1 && mainWindow && !mainWindow.isDestroyed()) {
          expectCrash = true
          mainWindow.webContents.forcefullyCrashRenderer()
        }
      },
    )
  })
  mainWindow.on('responsive', () => {
    unresponsivePrompt = false
  })
  // Windows 注销 / 关机：不弹确认，直接收尾
  mainWindow.on('session-end', () => {
    quitConfirmed = true
  })

  mainWindow.on('closed', () => {
    browserController?.dispose()
    browserController = null
    mainWindow = null
  })

  void boot()
}

async function offerReload(message: string, detail: string, buttons: string[]): Promise<number> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const options: Electron.MessageBoxOptions = { type: 'warning', title: APP_NAME, message, detail, buttons, defaultId: 0, cancelId: 0, noLink: true }
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return result.response
}

function showMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * 真正退出（托盘“退出”、菜单 ⌘Q / 退出、Windows / Linux 未开托盘时关窗）：
 * 本机模式还有对话在跑时先确认；确认后才停止本地服务并退出。
 */
async function requestQuit(origin: 'close' | 'quit'): Promise<void> {
  if (quitConfirmed) {
    app.quit()
    return
  }
  if (quitPrompting) return
  quitPrompting = true
  try {
    const count = localServer && !remoteOrigin ? await activeRunCount() : 0
    if (count > 0) {
      showMainWindow()
      const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: [tr('runsKeepOpen'), origin === 'close' ? tr('runsCloseAnyway') : tr('runsQuitAnyway')],
        defaultId: 0,
        cancelId: 0,
        message: tr('runsActive', count),
        detail: origin === 'close' ? tr('runsActiveDetail') : tr('runsQuitDetail'),
      }
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
      if (response !== 1) return
    }
    quitConfirmed = true
    app.quit()
  } finally {
    quitPrompting = false
  }
}

function savePrefs(): void {
  try {
    writePrefs(prefsFile(), prefs)
  } catch (error) {
    desktopLog(`save prefs failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 开机自启动只对打包后的应用生效（开发态的 electron 可执行文件没有意义） */
function loginItemSupported(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux')
}

function applyLoginItem(enabled: boolean): void {
  if (!loginItemSupported()) return
  if (process.platform === 'linux') {
    setLinuxAutostart(app.getPath('appData'), process.env.APPIMAGE || process.execPath, enabled)
    return
  }
  const path = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  app.setLoginItemSettings({ openAtLogin: enabled, path, args: [HIDDEN_ARG] })
}

function publicPrefs(): Record<string, unknown> {
  return {
    closeToTray: prefs.closeToTray,
    launchAtLogin: prefs.launchAtLogin,
    platform: process.platform,
    trayAvailable: hasTray(),
    launchAtLoginSupported: loginItemSupported(),
    // 系统没有安全存储时，“记住这台机器 / 这台服务器”用本机文件（0600）保存，设置页如实提示
    secureStorage: authStore().storageKind() === 'secure',
    masterKeyLocked,
  }
}

/** 本机服务的日志在数据目录 logs/；连接团队服务器时只有桌面壳自己的日志 */
function logDirs(): Array<{ label: string; dir: string }> {
  const dirs = [{ label: 'desktop', dir: app.getPath('logs') }]
  if (!EXTERNAL_URL) dirs.unshift({ label: 'server', dir: join(resolveDataHome(), 'logs') })
  return dirs
}

function registerDesktopControls(): void {
  // macOS 缺屏幕录制 / 辅助功能权限时，渲染进程引导用户打开系统设置（docs/computer-use.md）
  ipcMain.handle('computer:open-privacy-settings', (event, kind: unknown) => {
    if (!fromAppPage(event) || process.platform !== 'darwin') return false
    if (kind !== 'screen' && kind !== 'accessibility') return false
    const pane = kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    return true
  })
  ipcMain.handle('desktop:get-prefs', (event) => (fromAppPage(event) ? publicPrefs() : null))

  ipcMain.handle('desktop:set-prefs', (event, patch: unknown) => {
    if (!fromAppPage(event)) throw new Error('不允许的调用方')
    const next = applyPrefsPatch(prefs, patch)
    if (next.launchAtLogin !== prefs.launchAtLogin) applyLoginItem(next.launchAtLogin)
    prefs = next
    savePrefs()
    return publicPrefs()
  })

  // 界面里的“退出应用”（托盘图标看不见的桌面环境也有退出入口）
  ipcMain.handle('desktop:quit', (event) => {
    if (!fromAppPage(event)) return false
    void requestQuit('quit')
    return true
  })

  ipcMain.handle('desktop:open-logs', async (event) => {
    if (!fromAppPage(event)) return false
    const dir = logDirs()[0]!.dir
    mkdirSync(dir, { recursive: true })
    const error = await shell.openPath(dir)
    return error === ''
  })

  ipcMain.handle('desktop:export-diagnostics', async (event) => {
    if (!fromAppPage(event)) return { ok: false }
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const options: Electron.SaveDialogOptions = {
      title: tr('diagSaveTitle'),
      defaultPath: join(app.getPath('downloads'), diagnosticsFileName()),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    }
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    const { zip, files } = buildDiagnosticsZip({
      sources: logDirs(),
      days: 3,
      info: {
        app: APP_NAME,
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        osVersion: typeof os.version === 'function' ? os.version() : '',
        locale: app.getLocale(),
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        mode: remoteOrigin ? 'remote' : 'local',
        remoteOrigin: remoteOrigin ?? null,
        localServerRunning: Boolean(localServer),
        uptimeSeconds: Math.round(process.uptime()),
        prefs: { closeToTray: prefs.closeToTray, launchAtLogin: prefs.launchAtLogin },
        generatedAt: new Date().toISOString(),
      },
      extraFiles: [{ path: 'settings/updater.json', file: join(app.getPath('userData'), 'updater.json') }],
    })
    writeFileSync(picked.filePath, zip)
    desktopLog(`diagnostics exported (${files.length} files)`)
    return { ok: true, path: picked.filePath, files: files.length }
  })
}

/** 无界面自检：启动服务、确认健康检查与页面可访问后退出 */
async function runSmoke(): Promise<void> {
  const server = await startLocalServer({ token: apiToken })
  try {
    const health = (await (
      await fetch(`${server.url}/api/health`, { headers: { Authorization: `Bearer ${apiToken}` } })
    ).json()) as {
      ok?: boolean
    }
    const page = await (await fetch(server.url)).text()
    const result = {
      url: server.url,
      ok: health.ok === true,
      served: page.includes('id="app"'),
    }
    const out = process.env.LULUX_ETA_SMOKE_OUT
    if (out) writeFileSync(out, JSON.stringify(result))
    console.log('[smoke]', JSON.stringify(result))
    if (!result.ok || !result.served) process.exitCode = 1
  } finally {
    await server.stop()
  }
}

function reportSmokeFailure(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  const out = process.env.LULUX_ETA_SMOKE_OUT
  if (out) writeFileSync(out, JSON.stringify({ ok: false, error: message }))
  console.error('[smoke] failed', message)
}

/** 调用安装后多久还没退出就视为安装失败 */
const INSTALL_WATCHDOG_MS = 10_000
let installWatchdog: NodeJS.Timeout | null = null

/**
 * 安装更新没有让应用退出：重新拿单实例锁、重启本地服务（沿用原端口）、撤销“已确认退出”，并告诉界面。
 * 锁已经被别的实例拿走时，说明新版本已经起来了，直接退出本进程。
 */
async function recoverFromStalledInstall(): Promise<void> {
  if (installWatchdog) clearTimeout(installWatchdog)
  installWatchdog = null
  desktopLog('update install did not quit the app; restoring local server and single-instance lock')
  if (!app.requestSingleInstanceLock()) {
    desktopLog('another instance holds the lock; exiting')
    app.exit(0)
    return
  }
  quitConfirmed = false
  markInstallFailed(tr('updateInstallFailed'))
  if (EXTERNAL_URL) return
  cleanedUp = false
  localServer = null
  try {
    localServer = await launchLocalServer(lastLocalPort ?? initialLocalPort(authStore().getLocalPort(), process.platform))
    restartPolicy.started()
    const moved = localServer.url !== appUrl
    appUrl = localServer.url
    if (moved) loadApp()
    notifyRenderer({ type: 'update-install-failed' })
  } catch (error) {
    showStartupError(error)
  }
}

const gotLock = app.requestSingleInstanceLock()
/** before-quit 里是否已停止本地服务（安装更新前也会提前停止） */
let cleanedUp = false

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    showMainWindow()
  })

  void app.whenReady().then(() => {
    applyAppMenu(APP_NAME, !app.isPackaged)
    onLanguageChange(() => {
      applyAppMenu(APP_NAME, !app.isPackaged)
      refreshTrayMenu()
    })
    prefs = readPrefs(prefsFile(), process.platform)
    installSecurityPolicies()
    registerWindowControls()
    registerBrowserControls()
    remoteOrigin = connectionStore.remoteOrigin()
    registerConnectionControls()
    registerDesktopControls()

    if (!SMOKE) {
      initUpdater({
        isTrustedSender: fromAppPage,
        getWindow: () => mainWindow,
        beforeInstall: async () => {
          quitConfirmed = true
          // 先停本地服务（释放 SQLite 与端口）并释放单实例锁，新版本才能立即启动
          if (localServer && !cleanedUp) {
            await localServer.stop().catch(() => undefined)
            cleanedUp = true
          }
          app.releaseSingleInstanceLock()
          // 安装程序没能启动时应用不会退出：看门狗到点后恢复，而不是停在“服务已停、锁已放”的半退出状态
          if (installWatchdog) clearTimeout(installWatchdog)
          installWatchdog = setTimeout(() => void recoverFromStalledInstall(), INSTALL_WATCHDOG_MS)
        },
        onInstallFailed: () => void recoverFromStalledInstall(),
      })
    }

    if (SMOKE) {
      void runSmoke()
        .then(() =>
          app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0),
        )
        .catch((error) => {
          reportSmokeFailure(error)
          app.exit(1)
        })
      return
    }

    createTray({
      open: showMainWindow,
      newChat: () => {
        showMainWindow()
        mainWindow?.webContents.send('app:command', 'new-chat')
      },
      quit: () => void requestQuit('quit'),
    })
    // Linux：没有托盘宿主时 new Tray() 不报错但图标看不见；确定没有宿主就当作没有托盘（关窗即退出）
    if (process.platform === 'linux') {
      void linuxTrayHostPresent().then((present) => {
        if (present !== false) return
        desktopLog('no StatusNotifier host on the session bus; tray disabled')
        markTrayHostMissing()
        destroyTray()
        const window = mainWindow
        if (window && !window.isDestroyed() && !window.isVisible()) showMainWindow()
      })
    }
    // 系统关机 / 注销：不弹确认，直接收尾
    powerMonitor.on('shutdown', () => {
      quitConfirmed = true
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })

  app.on('before-quit', (event) => {
    // 菜单 ⌘Q / 退出：与托盘“退出”一样先确认进行中的对话
    if (!quitConfirmed) {
      event.preventDefault()
      void requestQuit('quit')
      return
    }
    if (restartTimer) clearTimeout(restartTimer)
    if (!localServer || cleanedUp) return
    event.preventDefault()
    void localServer.stop().finally(() => {
      cleanedUp = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 真正退出：注销急停快捷键、关闭提示窗（before-quit 可能被“确认退出”取消，不放在那里）
  app.on('will-quit', () => {
    if (installWatchdog) clearTimeout(installWatchdog)
    computerAgent.dispose()
  })
}
