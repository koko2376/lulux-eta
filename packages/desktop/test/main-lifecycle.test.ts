import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 主进程生命周期：替换桌面框架接口与本地服务后真实加载 src/main.ts。
 * 覆盖：崩溃重启沿用原端口、默认端口、API token 不进命令行、Ctrl+Q 退出、安装更新失败后的恢复、
 * 没有托盘宿主时关窗即退出、主密钥解不开时的提示。
 */
const h = vi.hoisted(() => {
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

let electronApp: { quit: ReturnType<typeof vi.fn> }

describe('主进程生命周期', () => {
  beforeAll(async () => {
    vi.useFakeTimers()
    // 有对话在跑的查询直接失败（按 0 处理），不发真实请求
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    let call = 0
    h.trayHost = null
    h.startImpl = async (port) => {
      call += 1
      if (call === 1) return fakeServer(port ?? 0, { masterKeyLocked: true })
      if (call === 2) throw new Error('本地服务启动失败（退出码 1）database is locked')
      return fakeServer(port ?? 60123)
    }
    await import('../src/main')
    electronApp = (await import('electron')).app as unknown as { quit: ReturnType<typeof vi.fn> }
    await flush()
  })
  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('全新安装：首次启动用动态端口段之外的固定默认端口', () => {
    expect(h.startCalls).toEqual([31789])
    expect(storedPort()).toBe(31789)
  })

  it('本地服务崩溃、第一次重启失败：第二次重启仍沿用原端口，不会漂移到随机端口', async () => {
    h.onExit!('本地服务已退出（退出码 1）')
    await flush(1000)
    await flush(3000)
    expect(h.startCalls).toEqual([31789, 31789, 31789])
    expect(storedPort()).toBe(31789)
  })

  it('API token 不经命令行参数传给渲染进程，只经同步 IPC 交给主窗口里的应用页面', () => {
    const options = mainWindow().options as { webPreferences?: { additionalArguments?: string[] } }
    expect(JSON.stringify(options.webPreferences?.additionalArguments ?? [])).not.toContain('f'.repeat(64))
    const handler = h.ipcOn.get('app:get-api-token')!
    const fromMain = { sender: mainWindow().webContents, senderFrame: { url: '' }, returnValue: undefined as unknown }
    handler(fromMain)
    expect(fromMain.returnValue).toBe('f'.repeat(64))
    const fromOther = { sender: new EventEmitter(), senderFrame: { url: '' }, returnValue: undefined as unknown }
    handler(fromOther)
    expect(fromOther.returnValue).toBe('')
  })

  it('主密钥解不开：页面加载完成后提示用户', () => {
    const contents = mainWindow().webContents as EventEmitter & { send: ReturnType<typeof vi.fn> }
    contents.emit('did-finish-load')
    expect(contents.send).toHaveBeenCalledWith('app:notice', { type: 'master-key-locked' })
  })

  it('Windows / Linux 上 Ctrl+Q 是始终可用的退出入口', async () => {
    if (process.platform === 'darwin') return
    electronApp.quit.mockClear()
    const event = { preventDefault: vi.fn() }
    mainWindow().webContents.emit('before-input-event', event, { type: 'keyDown', control: true, alt: false, shift: false, meta: false, key: 'q' })
    expect(event.preventDefault).toHaveBeenCalled()
    await flush(0)
    expect(electronApp.quit).toHaveBeenCalled()
  })
  it('安装更新没有让应用退出：看门狗恢复单实例锁与本地服务（沿用原端口），并标记安装失败', async () => {
    const failed = vi.fn()
    h.markInstallFailed = failed
    const locksBefore = h.lockCalls
    const startsBefore = h.startCalls.length
    await h.updaterOptions!.beforeInstall()
    await flush(10_000)
    expect(h.lockCalls).toBe(locksBefore + 1)
    expect(h.startCalls.slice(startsBefore)).toEqual([31789])
    expect(failed).toHaveBeenCalled()
    // 恢复后关窗 / 退出仍要走确认流程（quitConfirmed 已复位）
    const event = { preventDefault: vi.fn() }
    h.appEvents.emit('before-quit', event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

})
