import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tr } from './menu'
import { classifyUpdateError, normalizeFeedUrl, type UpdateErrorKind } from './update-source'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'

/**
 * 自动更新（electron-updater，GitHub Releases）。文档：docs/AUTO-UPDATE.md
 *
 * 更新源（优先级从高到低）：
 *   1. LULUX_UPDATE_URL=https://mirror.example.com/lulux/   generic 源（测试 / 企业镜像；目录里放 latest*.yml 与安装包）
 *   2. 设置 → 关于 → “更新源地址”（feedUrl）                  generic 源（公司内网镜像 / 国内 CDN），保存在 updater.json
 *   3. LULUX_UPDATE_REPO=owner/repo                          GitHub Releases（运行时覆盖）
 *   4. <resources>/app-update.yml                            打包时由 electron-builder.yml 的 publish 段写入
 * 默认源：electron-builder.yml 的 koko2376/lulux-eta。若构建时 owner 仍是占位 OWNER，视为“未配置”，不会去请求 github.com。
 *
 * 平台：Windows NSIS 安装版、Linux AppImage 可自动下载并替换；macOS 未签名时只检查、提示前往下载页；
 * Windows 免安装版（portable）与非 AppImage 的 Linux 运行方式同样只提示下载页。
 */

export type UpdateChannel = 'stable' | 'beta'

export interface UpdaterSettings {
  /** 启动后与每 6 小时自动检查 */
  autoCheck: boolean
  /** 发现新版本后自动在后台下载（仅对可自动安装的平台生效） */
  autoDownload: boolean
  /** stable = 只看正式版；beta = 也接收 GitHub 上标记为 prerelease 的版本 */
  channel: UpdateChannel
  /** 用户在原生提示里选“跳过此版本”的版本号；手动检查仍会显示 */
  skippedVersion: string | null
  /** 自定义更新源（generic：目录里放 latest*.yml 与安装包）；null 用默认源 */
  feedUrl: string | null
}

export type UpdaterStatus =
  | 'disabled' // 本次运行不支持检查（开发模式 / 仓库未配置）
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** 不能自动安装 / 不能检查的原因 */
export type UpdaterLimitation =
  | 'dev' // 未打包运行
  | 'unconfigured' // 仓库 owner 仍是 OWNER 占位
  | 'mac-unsigned' // macOS 包没有 Developer ID 签名，Squirrel.Mac 拒绝安装
  | 'portable' // Windows 免安装版
  | 'not-appimage' // Linux 不是以 AppImage 运行（解包运行 / deb 等）
  | 'unsupported-platform'

export interface UpdaterState {
  status: UpdaterStatus
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  /** 能否检查更新 */
  canCheck: boolean
  /** 能否在应用内下载并替换；false 时 download() 打开下载页 */
  canAutoInstall: boolean
  limitation: UpdaterLimitation | null
  channel: UpdateChannel
  source: { provider: 'github'; repo: string } | { provider: 'generic'; url: string; custom?: boolean } | null
  /** 发布页（GitHub Releases 或镜像说明页）；不能自动安装时引导用户手动下载 */
  downloadPage: string | null
  available: {
    version: string
    releaseName: string | null
    releaseDate: string | null
    /** 纯文本发布说明（已去除 HTML 标签）；完整内容见 downloadPage */
    notes: string
    prerelease: boolean
  } | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  /** 最近一次检查完成时间（ISO） */
  lastCheckedAt: string | null
  /** 最近一次错误；后台自动检查的错误只记录在这里和日志，不把 status 置为 error */
  lastError: { message: string; at: string; interactive: boolean; kind: UpdateErrorKind } | null
}

export interface UpdaterOptions {
  /** IPC 来源校验：只接受主窗口里本应用页面 */
  isTrustedSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  getWindow: () => BrowserWindow | null
  /** 安装前收尾（停止本地服务、释放单实例锁），之后才调用 quitAndInstall */
  beforeInstall: () => Promise<void>
}

const PLACEHOLDER_OWNER = 'OWNER'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后首次检查的延迟；LULUX_UPDATE_INITIAL_DELAY_MS 仅供测试 */
const INITIAL_DELAY_MS = (() => {
  const raw = process.env.LULUX_UPDATE_INITIAL_DELAY_MS
  const value = raw ? Number(raw) : NaN
  return Number.isFinite(value) && value >= 0 ? value : 30_000
})()
const LOG_MAX_BYTES = 1024 * 1024
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// ── 日志（userData/logs/updater.log，1 MB 轮转一次）──────────────────────────
let logFile = ''
function log(level: 'info' | 'warn' | 'error' | 'debug', ...parts: unknown[]): void {
  const text = parts
    .map((part) => (part instanceof Error ? part.stack ?? part.message : typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
  const line = `${new Date().toISOString()} [${level}] ${text}\n`
  if (level !== 'debug') (level === 'error' ? console.error : console.log)(`[updater] ${text}`)
  try {
    if (!logFile) {
      logFile = join(app.getPath('logs'), 'updater.log')
      mkdirSync(dirname(logFile), { recursive: true })
    }
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, line)
  } catch {
    // 日志失败不影响更新
  }
}
const logger = {
  info: (message?: unknown) => log('info', message),
  warn: (message?: unknown) => log('warn', message),
  error: (message?: unknown) => log('error', message),
  debug: (message: string) => log('debug', message),
}

// ── 设置（userData/updater.json）────────────────────────────────────────────
function settingsFile(): string {
  return join(app.getPath('userData'), 'updater.json')
}

function defaultChannel(): UpdateChannel {
  return /-/.test(app.getVersion()) ? 'beta' : 'stable'
}

function readSettings(): UpdaterSettings {
  const defaults: UpdaterSettings = { autoCheck: true, autoDownload: true, channel: defaultChannel(), skippedVersion: null, feedUrl: null }
  try {
    if (!existsSync(settingsFile())) return defaults
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<UpdaterSettings>
    return {
      autoCheck: typeof raw.autoCheck === 'boolean' ? raw.autoCheck : defaults.autoCheck,
      autoDownload: typeof raw.autoDownload === 'boolean' ? raw.autoDownload : defaults.autoDownload,
      channel: raw.channel === 'beta' || raw.channel === 'stable' ? raw.channel : defaults.channel,
      skippedVersion: typeof raw.skippedVersion === 'string' ? raw.skippedVersion : null,
      feedUrl: safeFeedUrl(raw.feedUrl),
    }
  } catch {
    return defaults
  }
}

function safeFeedUrl(raw: unknown): string | null {
  try {
    return normalizeFeedUrl(raw)
  } catch {
    return null
  }
}

function writeSettings(value: UpdaterSettings): void {
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(value, null, 2))
  } catch (error) {
    log('warn', '保存更新设置失败', error)
  }
}

// ── 更新源 ───────────────────────────────────────────────────────────────
type Source = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string; custom?: boolean }

/** 读取打包时写入的 app-update.yml（只取 provider/owner/repo，不引入 YAML 依赖） */
function bakedSource(): Source | null {
  const file = app.isPackaged ? join(process.resourcesPath, 'app-update.yml') : join(app.getAppPath(), 'dev-app-update.yml')
  try {
    const text = readFileSync(file, 'utf8')
    const field = (key: string): string | null => {
      const match = new RegExp(`^${key}:\\s*["']?([^"'\\s#]+)`, 'm').exec(text)
      return match ? match[1] : null
    }
    const provider = field('provider')
    if (provider === 'github') {
      const owner = field('owner')
      const repo = field('repo')
      return owner && repo ? { provider: 'github', owner, repo } : null
    }
    if (provider === 'generic') {
      const url = field('url')
      return url ? { provider: 'generic', url } : null
    }
  } catch {
    // 没有 app-update.yml：electron-builder 没配置 publish
  }
  return null
}

function resolveSource(feedUrl: string | null): Source | null {
  const url = process.env.LULUX_UPDATE_URL?.trim()
  if (url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return { provider: 'generic', url: parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/` }
      }
    } catch {
      // fallthrough
    }
    log('warn', `忽略无效的 LULUX_UPDATE_URL：${url}`)
  }
  if (feedUrl) return { provider: 'generic', url: feedUrl, custom: true }
  const repo = process.env.LULUX_UPDATE_REPO?.trim()
  if (repo) {
    if (REPO_RE.test(repo)) {
      const [owner, name] = repo.split('/')
      return { provider: 'github', owner, repo: name }
    }
    log('warn', `忽略无效的 LULUX_UPDATE_REPO（应为 owner/repo）：${repo}`)
  }
  const baked = bakedSource()
  if (baked?.provider === 'github' && baked.owner === PLACEHOLDER_OWNER) return null
  return baked
}

function publicSource(source: Source | null): UpdaterState['source'] {
  if (!source) return null
  if (source.provider === 'github') return { provider: 'github', repo: `${source.owner}/${source.repo}` }
  return source.custom ? { provider: 'generic', url: source.url, custom: true } : { provider: 'generic', url: source.url }
}

function downloadPageFor(source: Source | null, version?: string): string | null {
  if (!source) return null
  if (source.provider === 'github') {
    const base = `https://github.com/${source.owner}/${source.repo}/releases`
    return version ? `${base}/tag/v${version}` : `${base}/latest`
  }
  return (!source.custom && process.env.LULUX_UPDATE_PAGE?.trim()) || source.url
}

/** macOS：只有 Developer ID 签名的包才能被 Squirrel.Mac 安装 */
function macHasDeveloperId(): Promise<boolean> {
  const bundle = resolve(process.execPath, '..', '..', '..')
  return new Promise((done) => {
    execFile('codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (_error, stdout, stderr) => {
      done(/Authority=Developer ID Application/.test(`${stdout}\n${stderr}`))
    })
  })
}

async function detectLimitation(source: Source | null): Promise<UpdaterLimitation | null> {
  if (!app.isPackaged && !process.env.LULUX_UPDATE_URL) return 'dev'
  if (!source) return 'unconfigured'
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : null
  if (process.platform === 'linux') return process.env.APPIMAGE ? null : 'not-appimage'
  if (process.platform === 'darwin') return (await macHasDeveloperId()) ? null : 'mac-unsigned'
  return 'unsupported-platform'
}

/** GitHub 发布说明是 HTML；交给界面的是纯文本 */
function notesToText(notes: UpdateInfo['releaseNotes']): string {
  const raw = Array.isArray(notes)
    ? notes.map((item) => `${item.version}\n${item.note ?? ''}`).join('\n\n')
    : typeof notes === 'string'
      ? notes
      : ''
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|li|h[1-6]|div|ul|ol|pre|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text
}

// ── 控制器 ──────────────────────────────────────────────────────────────
class UpdateController {
  private updater: AppUpdater | null = null
  private source: Source | null = null
  private settings: UpdaterSettings = readSettings()
  private timer: NodeJS.Timeout | null = null
  /** 本次检查/下载是否由用户发起（决定失败时是否把 status 置为 error） */
  private interactive = false
  /** 渲染进程订阅了 onState：由界面负责提示，主进程不弹原生框 */
  private uiSubscribers = new Set<number>()
  private promptedVersions = new Set<string>()
  private installing = false
  private state: UpdaterState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    canCheck: false,
    canAutoInstall: false,
    limitation: null,
    channel: this.settings.channel,
    source: null,
    downloadPage: null,
    available: null,
    progress: null,
    lastCheckedAt: null,
    lastError: null,
  }

  constructor(private readonly options: UpdaterOptions) {}

  async init(): Promise<void> {
    this.registerIpc()
    await this.configure()
  }

  /** 按当前设置解析更新源；启动时与修改“更新源地址”后调用 */
  private async configure(): Promise<void> {
    this.source = resolveSource(this.settings.feedUrl)
    const limitation = await detectLimitation(this.source)
    const canCheck = limitation !== 'dev' && limitation !== 'unconfigured' && limitation !== 'unsupported-platform'
    this.patch({
      limitation,
      canCheck,
      canAutoInstall: canCheck && limitation === null,
      source: publicSource(this.source),
      downloadPage: downloadPageFor(this.source),
      status: canCheck ? 'idle' : 'disabled',
    })
    log('info', `init version=${app.getVersion()} platform=${process.platform}-${process.arch} source=${JSON.stringify(this.state.source)} limitation=${limitation ?? 'none'} settings=${JSON.stringify(this.settings)}`)
    if (!canCheck) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      return
    }
    if (this.updater) {
      // 已创建：只切换更新源，之前的检查结果作废
      this.applyFeed(this.updater)
      this.patch({ available: null, progress: null, lastError: null })
      return
    }
    try {
      this.updater = this.createUpdater()
    } catch (error) {
      log('error', '初始化 electron-updater 失败', error)
      this.patch({ status: 'disabled', canCheck: false, canAutoInstall: false })
      return
    }
    this.schedule(INITIAL_DELAY_MS)
  }

  private createUpdater(): AppUpdater {
    // 延迟加载：自检模式、开发模式不加载 electron-updater
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    const updater = autoUpdater
    updater.logger = logger
    updater.autoDownload = false // 由本控制器按设置决定何时下载
    updater.autoInstallOnAppQuit = this.state.canAutoInstall // 已下载的更新在正常退出时安装（不强制重启）
    updater.allowDowngrade = false
    updater.allowPrerelease = this.settings.channel === 'beta'
    updater.fullChangelog = false
    if (!app.isPackaged) updater.forceDevUpdateConfig = true
    this.applyFeed(updater)

    updater.on('checking-for-update', () => this.patch({ status: 'checking' }))
    updater.on('update-available', (info: UpdateInfo) => this.onAvailable(info))
    updater.on('update-not-available', () => {
      this.patch({ status: 'not-available', available: null, progress: null, lastCheckedAt: new Date().toISOString() })
    })
    updater.on('download-progress', (progress: ProgressInfo) => {
      this.patch({
        status: 'downloading',
        progress: {
          percent: Math.round(progress.percent * 10) / 10,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        },
      })
    })
    updater.on('update-downloaded', (info: UpdateInfo) => {
      log('info', `已下载并校验 ${info.version}`)
      this.patch({
        status: 'downloaded',
        progress: this.state.progress ? { ...this.state.progress, percent: 100 } : null,
      })
      void this.promptInstall(info.version)
    })
    updater.on('error', (error: Error) => this.onError(error))
    return updater
  }

  private applyFeed(updater: AppUpdater): void {
    const source = this.source!
    if (source.provider === 'generic') {
      updater.setFeedURL({ provider: 'generic', url: source.url })
    } else {
      updater.setFeedURL({ provider: 'github', owner: source.owner, repo: source.repo })
    }
  }

  // ── 状态 ──
  private patch(next: Partial<UpdaterState>): void {
    this.state = { ...this.state, ...next }
    const window = this.options.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('updater:state', this.state)
  }

  getState(): UpdaterState {
    return this.state
  }

  // ── 调度 ──
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.settings.autoCheck) void this.check(false)
      this.schedule(CHECK_INTERVAL_MS)
    }, delay)
  }

  async check(interactive: boolean): Promise<UpdaterState> {
    if (!this.updater || !this.state.canCheck) return this.state
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'downloaded' || this.installing) {
      return this.state
    }
    this.interactive = interactive
    this.updater.allowPrerelease = this.settings.channel === 'beta'
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.onError(error)
    }
    return this.state
  }

  private onAvailable(info: UpdateInfo): void {
    const version = info.version
    log('info', `发现新版本 ${version}（当前 ${app.getVersion()}，通道 ${this.settings.channel}）`)
    this.patch({
      status: 'available',
      lastCheckedAt: new Date().toISOString(),
      downloadPage: downloadPageFor(this.source, version),
      progress: null,
      available: {
        version,
        releaseName: info.releaseName ?? null,
        releaseDate: info.releaseDate ?? null,
        notes: notesToText(info.releaseNotes),
        prerelease: /-/.test(version),
      },
    })
    const skipped = !this.interactive && this.settings.skippedVersion === version
    if (this.state.canAutoInstall && this.settings.autoDownload && !skipped) {
      void this.download(this.interactive)
    } else if (!this.state.canAutoInstall && !this.interactive && !skipped) {
      void this.promptDownloadPage(version)
    }
  }

  private lastHandledError: unknown = null

  private onError(error: unknown): void {
    // electron-updater 先发 'error' 事件再让 Promise reject 同一个错误对象：只处理一次
    if (error !== null && typeof error === 'object' && error === this.lastHandledError) return
    this.lastHandledError = error
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    log('error', this.interactive ? '更新失败（手动）' : '更新失败（后台，不提示用户）', error)
    const lastError = { message, at: new Date().toISOString(), interactive: this.interactive, kind: classifyUpdateError(error) }
    if (this.interactive) {
      this.patch({ status: 'error', progress: null, lastError })
    } else {
      // 后台失败不打扰：回到可再次检查的状态，只留记录
      const status: UpdaterStatus = this.state.status === 'downloading' || this.state.status === 'checking' ? (this.state.available ? 'available' : 'idle') : this.state.status
      this.patch({ status, progress: null, lastError })
    }
  }

  async download(interactive: boolean): Promise<UpdaterState> {
    if (!this.updater || !this.state.available) return this.state
    if (!this.state.canAutoInstall) {
      // macOS 未签名 / portable / 非 AppImage：引导到下载页
      if (interactive && this.state.downloadPage) void shell.openExternal(this.state.downloadPage)
      return this.state
    }
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return this.state
    this.interactive = interactive
    this.patch({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.onError(error)
    }
    return this.state
  }

  async install(): Promise<boolean> {
    if (!this.updater || this.state.status !== 'downloaded' || this.installing) return false
    this.installing = true
    log('info', `重启并安装 ${this.state.available?.version ?? ''}`)
    try {
      await this.options.beforeInstall()
    } catch (error) {
      log('warn', '安装前收尾失败，继续安装', error)
    }
    // isSilent=true：Windows 用 NSIS 静默升级；isForceRunAfter=true：装完重新打开应用
    this.updater.quitAndInstall(true, true)
    return true
  }

  // ── 无界面时的原生提示（界面订阅了 onState 时由界面负责）──
  private hasUi(): boolean {
    return this.uiSubscribers.size > 0
  }

  private async promptInstall(version: string): Promise<void> {
    if (this.hasUi() || this.interactive || this.promptedVersions.has(version)) return
    this.promptedVersions.add(version)
    const window = this.options.getWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'LULUX ETA',
      message: tr('updDownloaded', version),
      detail: tr('updDownloadedDetail'),
      buttons: [tr('later'), tr('restartInstall')],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    }
    const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    if (result.response === 1) await this.install()
  }

  private async promptDownloadPage(version: string): Promise<void> {
    if (this.hasUi() || this.promptedVersions.has(version) || !this.state.downloadPage) return
    this.promptedVersions.add(version)
    const why =
      this.state.limitation === 'mac-unsigned'
        ? tr('updMacUnsigned')
        : this.state.limitation === 'portable'
          ? tr('updPortable')
          : this.state.limitation === 'not-appimage'
            ? tr('updNotAppImage')
            : tr('updUnsupported')
    const window = this.options.getWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'LULUX ETA',
      message: tr('updFound', version),
      detail: tr('updGoDownload', why),
      buttons: [tr('later'), tr('skipVersion'), tr('openDownload')],
      defaultId: 2,
      cancelId: 0,
      noLink: true,
    }
    const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    if (result.response === 2) void shell.openExternal(this.state.downloadPage)
    if (result.response === 1) this.setSettings({ skippedVersion: version })
  }

  // ── 设置 ──
  getSettings(): UpdaterSettings {
    return { ...this.settings }
  }

  setSettings(input: unknown): UpdaterSettings {
    if (!input || typeof input !== 'object') throw new Error('设置格式不正确')
    const patch = input as Record<string, unknown>
    const next = { ...this.settings }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'autoCheck' || key === 'autoDownload') {
        if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
        next[key] = value
      } else if (key === 'channel') {
        if (value !== 'stable' && value !== 'beta') throw new Error('channel 只能是 stable 或 beta')
        next.channel = value
      } else if (key === 'feedUrl') {
        next.feedUrl = normalizeFeedUrl(value)
      } else if (key === 'skippedVersion') {
        if (value !== null && (typeof value !== 'string' || value.length > 64)) throw new Error('skippedVersion 格式不正确')
        next.skippedVersion = value as string | null
      } else {
        throw new Error(`未知设置项：${key}`)
      }
    }
    const channelChanged = next.channel !== this.settings.channel
    const feedChanged = next.feedUrl !== this.settings.feedUrl
    this.settings = next
    writeSettings(next)
    if (this.updater) this.updater.allowPrerelease = next.channel === 'beta'
    this.patch({ channel: next.channel })
    // 切换通道后：之前查到但未下载的结果作废，下次检查按新通道
    if (channelChanged && this.state.status === 'available') this.patch({ status: 'idle', available: null })
    if (feedChanged && this.state.status !== 'downloading' && this.state.status !== 'downloaded' && !this.installing) {
      log('info', `更新源地址改为 ${next.feedUrl ?? '（默认）'}`)
      void this.configure().catch((error) => log('error', '切换更新源失败', error))
    }
    return { ...next }
  }

  // ── IPC ──
  private registerIpc(): void {
    const guard = <T>(handler: (event: Electron.IpcMainInvokeEvent, arg: unknown) => T | Promise<T>) =>
      (event: Electron.IpcMainInvokeEvent, arg: unknown): T | Promise<T> => {
        if (!this.options.isTrustedSender(event)) throw new Error('不允许的调用方')
        return handler(event, arg)
      }
    ipcMain.handle('updater:get-state', guard(() => this.getState()))
    ipcMain.handle('updater:check', guard(() => this.check(true)))
    ipcMain.handle('updater:download', guard(() => this.download(true)))
    ipcMain.handle('updater:install', guard(() => this.install()))
    ipcMain.handle('updater:get-settings', guard(() => this.getSettings()))
    ipcMain.handle('updater:set-settings', guard((_event, arg) => this.setSettings(arg)))
    ipcMain.on('updater:subscribe', (event, on: unknown) => {
      if (!this.options.isTrustedSender(event)) return
      const id = event.sender.id
      if (on === false) {
        this.uiSubscribers.delete(id)
      } else if (!this.uiSubscribers.has(id)) {
        this.uiSubscribers.add(id)
        // 页面重新加载时 preload 会先发 subscribe(false)，这里只处理窗口销毁
        event.sender.once('destroyed', () => this.uiSubscribers.delete(id))
      }
    })
  }
}

let controller: UpdateController | null = null

export function initUpdater(options: UpdaterOptions): void {
  if (controller) return
  controller = new UpdateController(options)
  void controller.init().catch((error) => log('error', 'updater init failed', error))
}
