import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** 主进程在不同平台上的行为（替换桌面框架接口与本地服务后真实加载 src/main.ts） */
const h = vi.hoisted(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), ev = require('node:events')
  return {
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lulux-main-')) as string,
    appEvents: new ev.EventEmitter(),
    EventEmitter: ev.EventEmitter as typeof EventEmitter,
    join: path.join as typeof join,
    startCalls: [] as Array<number | undefined>,
    onExit: null as ((message: string) => void) | null,
    startImpl: (async () => undefined) as (port: number | undefined) => Promise<unknown>,
    windows: [] as Array<{ options: Record<string, unknown>; webContents: EventEmitter & { send: unknown } }>,
    ipcOn: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
    updaterOptions: null as null | { beforeInstall: () => Promise<void>; onInstallFailed?: () => void },
    lockCalls: 0,
    markInstallFailed: null as null | ((message: string) => void),
    trayHost: null as boolean | null,
    markTrayHostMissing: null as null | (() => void),
  }
})

vi.mock('electron', () => {
  const { EventEmitter, join, userData, appEvents } = h
  class FakeWebContents extends EventEmitter {
    send = vi.fn()
    setWindowOpenHandler = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    isDestroyed = () => false
  }
  class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = []
    webContents = new FakeWebContents()
    constructor(options: Record<string, unknown>) {
      super()
      FakeWindow.all.push(this)
      h.windows.push({ options, webContents: this.webContents })
    }
    static getAllWindows = () => FakeWindow.all
    static fromWebContents = () => null
    loadURL = vi.fn(() => Promise.resolve())
    isDestroyed = () => false
    isVisible = () => true
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isMinimized = () => false
  }
  const app = Object.assign(appEvents, {
    setName: vi.fn(),
    getPath: (name: string) => join(userData, name === 'userData' ? '' : name),
    requestSingleInstanceLock: () => {
      h.lockCalls += 1
      return true
    },
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    isPackaged: false,
    getVersion: () => '0.1.2',
    getLocale: () => 'zh-CN',
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false }),
    quit: vi.fn(),
    exit: vi.fn(),
    releaseSingleInstanceLock: vi.fn(),
    setLoginItemSettings: vi.fn(),
  })
  const ipcMain = {
    on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => h.ipcOn.set(channel, listener)),
    handle: vi.fn(),
  }
  return {
    app,
    BrowserWindow: FakeWindow,
    clipboard: {},
    desktopCapturer: {},
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })), showErrorBox: vi.fn() },
    globalShortcut: {},
    ipcMain,
    nativeTheme: {},
    powerMonitor: new EventEmitter(),
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'os_keyring',
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    screen: {},
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() }, setPermissionRequestHandler: vi.fn() }, fromPartition: vi.fn() },
    shell: { openExternal: vi.fn() },
    systemPreferences: {},
  }
})

vi.mock('../src/server', () => ({
  generateApiToken: () => 'f'.repeat(64),
  resolveDataHome: () => h.join(h.userData, 'data'),
  startLocalServer: (opts: { preferredPort?: number; onUnexpectedExit?: (m: string) => void }) => {
    h.startCalls.push(opts.preferredPort)
    h.onExit = opts.onUnexpectedExit ?? null
    return h.startImpl(opts.preferredPort)
  },
}))
vi.mock('../src/browser', () => ({ BROWSER_PARTITION: 'persist:x', BrowserController: class { dispose() {} } }))
vi.mock('../src/browser-agent', () => ({ BrowserAgent: class {} }))
vi.mock('../src/computer-agent', () => ({ ComputerAgent: class { dispose() {} } }))
vi.mock('../src/tray', () => {
  let missing = false
  h.markTrayHostMissing = () => {
    missing = true
  }
  return {
    createTray: vi.fn(),
    destroyTray: vi.fn(),
    hasTray: () => !missing,
    refreshTrayMenu: vi.fn(),
    showTrayHint: vi.fn(),
    linuxTrayHostPresent: async () => h.trayHost,
    markTrayHostMissing: () => h.markTrayHostMissing?.(),
  }
})
vi.mock('../src/updater', () => ({
  initUpdater: vi.fn((options: { beforeInstall: () => Promise<void> }) => {
    h.updaterOptions = options
  }),
  markInstallFailed: vi.fn((message: string) => h.markInstallFailed?.(message)),
}))
vi.mock('../src/menu', () => ({
  applyAppMenu: vi.fn(),
  attachContextMenu: vi.fn(),
  onLanguageChange: vi.fn(),
  setLanguagePref: vi.fn(),
  storedLanguagePref: () => null,
  tr: (k: string) => k,
}))

const fakeServer = (port: number, extra: Record<string, unknown> = {}) => ({
  url: `http://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  port,
  masterKeyLocked: false,
  sendComputerEvent: vi.fn(),
  stop: vi.fn(async () => undefined),
  ...extra,
})

const storedPort = (): number => JSON.parse(readFileSync(join(h.userData, 'auth-state.json'), 'utf8')).localPort
const mainWindow = () => h.windows[0]!
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('Linux 桌面没有托盘宿主', () => {
  beforeAll(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    // 用户以前打开过“关窗到托盘”
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(join(h.userData, 'desktop-prefs.json'), JSON.stringify({ closeToTray: true }))
    h.trayHost = false
    h.startImpl = async (port) => fakeServer(port ?? 0)
    await import('../src/main')
    await flush()
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('确定没有托盘宿主：托盘视为不可用，关窗走退出流程而不是藏进看不见的托盘', async () => {
    const electron = await import('electron')
    const quit = electron.app.quit as unknown as ReturnType<typeof vi.fn>
    const window = (electron.BrowserWindow as unknown as { all: Array<EventEmitter & { hide: ReturnType<typeof vi.fn> }> }).all[0]!
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    await flush(0)
    expect(window.hide).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
  })
})
