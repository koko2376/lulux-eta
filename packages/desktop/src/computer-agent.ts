import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { ComputerOverlay } from './computer-overlay'
import {
  dipToNative,
  fitWidth,
  imageToDip,
  movedTooFar,
  nativeToImage,
  parseKeys,
  type Bounds,
  type Point,
} from './computer-geometry'

/**
 * Agent 操作本机桌面（docs/computer-use.md）。
 *
 * 服务进程经 IPC 发来 cmd，这里截屏（desktopCapturer）并用 robotjs 注入鼠标键盘。
 * Electron 依赖全部经构造参数注入，测试可完全 mock；robotjs 懒加载，
 * 加载失败只影响 computer 工具（NATIVE_UNAVAILABLE），不影响应用启动。
 */

export type ComputerErrorCode =
  | 'NATIVE_UNAVAILABLE'
  | 'NO_DISPLAY'
  | 'BAD_ARGS'
  | 'STOPPED'
  | 'USER_INTERRUPT'
  | 'PERMISSION'
  | 'TIMEOUT'
  | 'STALE_SHOT'
  | 'FAILED'

export class ComputerAgentError extends Error {
  readonly code: ComputerErrorCode

  constructor(code: ComputerErrorCode, message: string) {
    super(message)
    this.name = 'ComputerAgentError'
    this.code = code
  }
}

/** 推给渲染进程的 computer:agent-activity */
export interface ComputerAgentActivity {
  action: string
  x?: number
  y?: number
}

/** 推给服务进程 / 渲染进程的 computer-event（无 id） */
export interface ComputerAgentEvent {
  event: 'stop' | 'pause'
  reason: 'hotkey' | 'user-moved-mouse' | 'overlay'
}

/** robotjs 中用到的子集（便于测试替换） */
export interface RobotLike {
  moveMouse(x: number, y: number): void
  mouseClick(button?: string, double?: boolean): void
  mouseToggle(down?: string, button?: string): void
  moveMouseSmooth(x: number, y: number, speed?: number): void
  scrollMouse(x: number, y: number): void
  typeString(text: string): void
  keyTap(key: string, modifier?: string | string[]): void
  getMousePos(): Point
}

export interface DisplayLike {
  id: number
  bounds: Bounds
  scaleFactor: number
}

export interface ScreenLike {
  getAllDisplays(): DisplayLike[]
  getPrimaryDisplay(): DisplayLike
  dipToScreenPoint?(point: Point): Point
  screenToDipPoint?(point: Point): Point
}

export interface NativeImageLike {
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: string }): NativeImageLike
  toJPEG(quality: number): Buffer
  isEmpty?(): boolean
}

export interface DesktopSourceLike {
  id: string
  /** Electron 的 ScreenCaptureSource.display_id（字符串） */
  display_id: string
  thumbnail: NativeImageLike
}

export interface DesktopCapturerLike {
  getSources(options: {
    types: Array<'screen' | 'window'>
    thumbnailSize: { width: number; height: number }
  }): Promise<DesktopSourceLike[]>
}

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface SystemPreferencesLike {
  getMediaAccessStatus(mediaType: 'screen'): string
  isTrustedAccessibilityClient(prompt: boolean): boolean
}

export interface ClipboardLike {
  /** 主进程里是同步字符串；部分平台的 Electron 类型标成 Promise，统一 await */
  readText(): string | Promise<string>
  writeText(text: string): void
}

export interface ComputerOverlayLike {
  show(options?: { hotkey?: boolean }): void
  hide(): void
  dispose(): void
}

export interface ComputerAgentOptions {
  /** 懒加载 robotjs；默认先找打包后的 <resources>/native，再找 node_modules */
  loadNative?: () => RobotLike
  platform?: NodeJS.Platform
  screen: ScreenLike
  desktopCapturer: DesktopCapturerLike
  globalShortcut: GlobalShortcutLike
  systemPreferences: SystemPreferencesLike
  clipboard: ClipboardLike
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow
  overlay?: ComputerOverlayLike
  onActivity?: (activity: ComputerAgentActivity) => void
  onEvent?: (event: ComputerAgentEvent) => void
}

/** 急停快捷键：不用 Esc 组合（mac 会强退、Win 是任务管理器） */
export const STOP_ACCELERATOR = 'CommandOrControl+Alt+Shift+K'

export const MAX_SCREENSHOT_WIDTH = 1280
const JPEG_QUALITY = 70
const MAX_TYPE_CHARS = 2000
const MAX_SCROLL = 30
/** 粘贴后多久恢复原剪贴板：太短时慢应用（远程桌面、Java 客户端）还没读剪贴板就被换回去 */
const PASTE_RESTORE_MS = 800
const SCROLL_STEP = 1

interface LastShot {
  displayId: number
  bounds: Bounds
  width: number
  height: number
  scaleFactor: number
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '操作失败'
}

/** 打包后 robotjs 随 extraResources 在 <resources>/native；开发态走 node_modules */
function defaultLoadNative(): RobotLike {
  const candidates: string[] = []
  const resources = process.resourcesPath
  if (resources) candidates.push(join(resources, 'native', 'node_modules', 'robotjs'))
  candidates.push('robotjs')
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(candidate) as RobotLike
      if (loaded && typeof loaded.moveMouse === 'function') return loaded
    } catch {
      // 换下一个候选
    }
  }
  throw new ComputerAgentError(
    'NATIVE_UNAVAILABLE',
    '本机输入控制不可用（robotjs 未安装或当前桌面环境不支持）',
  )
}

function badArgs(message: string): never {
  throw new ComputerAgentError('BAD_ARGS', message)
}

/** 纯 ASCII 可打印字符才能用 typeString；其他（中文、换行、emoji）走剪贴板 */
function isAsciiPrintable(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) badArgs(`${what} 必须是有限数字`)
  return value
}

export class ComputerAgent {
  private readonly loadNative: () => RobotLike
  private readonly platform: NodeJS.Platform
  private readonly screen: ScreenLike
  private readonly desktopCapturer: DesktopCapturerLike
  private readonly globalShortcut: GlobalShortcutLike
  private readonly systemPreferences: SystemPreferencesLike
  private readonly clipboard: ClipboardLike
  private readonly overlay: ComputerOverlayLike
  private readonly sendActivity: (activity: ComputerAgentActivity) => void
  private readonly sendEvent: (event: ComputerAgentEvent) => void

  /** 懒加载结果（失败也缓存，之后一律 NATIVE_UNAVAILABLE） */
  private native: RobotLike | null = null
  private nativeFailed = false
  private stopped = false
  private hotkeyRegistered = false
  private disposed = false
  private lastShot: LastShot | null = null
  /** 上一个动作结束时的光标位置；用户动过就暂停 */
  private lastCursor: Point | null = null

  constructor(options: ComputerAgentOptions) {
    this.loadNative = options.loadNative ?? defaultLoadNative
    this.platform = options.platform ?? process.platform
    this.screen = options.screen
    this.desktopCapturer = options.desktopCapturer
    this.globalShortcut = options.globalShortcut
    this.systemPreferences = options.systemPreferences
    this.clipboard = options.clipboard
    this.sendActivity = options.onActivity ?? (() => undefined)
    this.sendEvent = options.onEvent ?? (() => undefined)
    this.overlay =
      options.overlay ??
      new ComputerOverlay({
        createWindow: options.createWindow,
        displays: () => this.screen.getAllDisplays(),
        platform: this.platform,
      })
  }

  /* ── 命令入口 ─────────────────────────────────────────── */

  async execute(cmd: unknown): Promise<unknown> {
    if (!cmd || typeof cmd !== 'object') badArgs('命令格式不正确')
    const command = cmd as Record<string, unknown>
    const action = command.action
    if (typeof action !== 'string') badArgs('缺少 action')
    try {
      return await this.dispatch(action, command)
    } catch (error) {
      if (error instanceof ComputerAgentError) throw error
      throw new ComputerAgentError('FAILED', messageOf(error))
    }
  }

  private async dispatch(action: string, cmd: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'status':
        return this.status()
      case 'begin':
        return this.begin()
      case 'end':
        return this.end()
      default:
        break
    }
    if (this.disposed) throw new ComputerAgentError('FAILED', '桌面操作已关闭')
    if (this.stopped) throw new ComputerAgentError('STOPPED', '已急停，请重新开始（begin）')
    switch (action) {
      case 'screenshot':
        return await this.screenshot(cmd)
      case 'click':
        return this.click(cmd)
      case 'move':
        return this.move(cmd)
      case 'drag':
        return this.drag(cmd)
      case 'scroll':
        return this.scroll(cmd)
      case 'type':
        return await this.type(cmd)
      case 'key':
        return this.key(cmd)
      case 'cursor':
        return this.cursor()
      default:
        badArgs(`未知的 action：${action}`)
    }
  }

  /* ── 状态 / 生命周期 ──────────────────────────────────── */

  private robot(): RobotLike {
    if (this.native) return this.native
    if (this.nativeFailed) throw new ComputerAgentError('NATIVE_UNAVAILABLE', '本机输入控制不可用（robotjs 加载失败）')
    try {
      this.native = this.loadNative()
      return this.native
    } catch (error) {
      this.nativeFailed = true
      if (error instanceof ComputerAgentError) throw error
      throw new ComputerAgentError('NATIVE_UNAVAILABLE', `本机输入控制不可用：${messageOf(error)}`)
    }
  }

  private permission(): { screen: string; accessibility: string } {
    if (this.platform !== 'darwin') return { screen: 'granted', accessibility: 'granted' }
    let screen = 'denied'
    let accessibility = 'denied'
    try {
      screen = this.systemPreferences.getMediaAccessStatus('screen') || 'denied'
    } catch {
      // 查询失败按未授权处理
    }
    try {
      accessibility = this.systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
    } catch {
      // 同上
    }
    return { screen, accessibility }
  }

  private requirePermission(kind: 'screen' | 'accessibility'): void {
    if (this.platform !== 'darwin') return
    const permission = this.permission()
    if (permission[kind] !== 'granted') {
      const name = kind === 'screen' ? '屏幕录制' : '辅助功能'
      throw new ComputerAgentError('PERMISSION', `macOS 未授权${name}权限，请在系统设置中允许 LULUX ETA`)
    }
  }

  private status(): Record<string, unknown> {
    let native = false
    try {
      this.robot()
      native = true
    } catch {
      native = false
    }
    const primaryId = this.safePrimaryDisplay()?.id ?? null
    let displays: Array<{ id: number; primary: boolean; bounds: Bounds; scaleFactor: number }> = []
    try {
      displays = this.screen.getAllDisplays().map((display) => ({
        id: display.id,
        primary: display.id === primaryId,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
      }))
    } catch {
      displays = []
    }
    return {
      native,
      permission: this.permission(),
      displays,
      stopped: this.stopped,
      hotkey: this.hotkeyRegistered,
    }
  }

  private safePrimaryDisplay(): DisplayLike | null {
    try {
      return this.screen.getPrimaryDisplay()
    } catch {
      return null
    }
  }

  private begin(): Record<string, unknown> {
    this.stopped = false
    this.lastCursor = null
    // 先注册快捷键，提示条才知道该写“按快捷键停止”还是“在 LULUX 里点停止”
    this.registerHotkey()
    if (!this.disposed) this.overlay.show({ hotkey: this.hotkeyRegistered })
    return { hotkey: this.hotkeyRegistered }
  }

  private end(): Record<string, unknown> {
    this.overlay.hide()
    this.unregisterHotkey()
    this.lastCursor = null
    return {}
  }

  private registerHotkey(): void {
    if (this.hotkeyRegistered) return
    try {
      this.hotkeyRegistered = this.globalShortcut.register(STOP_ACCELERATOR, () => this.emergencyStop())
    } catch {
      // 快捷键被别的程序占用：不报错，status.hotkey = false
      this.hotkeyRegistered = false
    }
  }

  private unregisterHotkey(): void {
    if (!this.hotkeyRegistered) return
    this.hotkeyRegistered = false
    try {
      this.globalShortcut.unregister(STOP_ACCELERATOR)
    } catch {
      // 已注销
    }
  }

  private emergencyStop(): void {
    this.stopped = true
    this.lastCursor = null
    this.overlay.hide()
    this.emit({ event: 'stop', reason: 'hotkey' })
  }

  private emit(event: ComputerAgentEvent): void {
    try {
      this.sendEvent(event)
    } catch {
      // 界面 / 服务进程不在也不影响急停状态
    }
  }

  /* ── 公共辅助 ─────────────────────────────────────────── */

  private activity(action: string, point?: Point): void {
    try {
      this.sendActivity(point ? { action, x: point.x, y: point.y } : { action })
    } catch {
      // 同上
    }
  }

  /** 动作前检查用户是否接管了鼠标 */
  private checkUserTookOver(): void {
    if (!this.lastCursor) return
    let current: Point
    try {
      current = this.robot().getMousePos()
    } catch {
      return
    }
    if (movedTooFar(this.lastCursor, current)) {
      this.lastCursor = null
      this.emit({ event: 'pause', reason: 'user-moved-mouse' })
      throw new ComputerAgentError('USER_INTERRUPT', '检测到用户移动了鼠标，已暂停')
    }
  }

  /** 动作后记下光标位置；读不到忽略 */
  private rememberCursor(): void {
    try {
      const position = this.robot().getMousePos()
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        this.lastCursor = position
      }
    } catch {
      this.lastCursor = null
    }
  }

  private shot(): LastShot {
    if (!this.lastShot) badArgs('请先 computer_screenshot')
    return this.lastShot
  }

  /** 截图坐标 → robotjs 坐标（需要先截图） */
  private nativePoint(x: unknown, y: unknown): Point {
    const shot = this.shot()
    this.assertDisplayUnchanged(shot)
    const dip = imageToDip(x, y, shot.bounds, shot.width, shot.height)
    return dipToNative(dip, this.platform, shot.scaleFactor, (point) => this.dipToScreen(point))
  }

  /** 截图之后显示器被拔插 / 改了布局或缩放：旧截图的坐标换算已失效，要求重新截图而不是点错位置 */
  private assertDisplayUnchanged(shot: LastShot): void {
    let displays: DisplayLike[]
    try {
      displays = this.screen.getAllDisplays()
    } catch {
      return
    }
    const now = displays.find((display) => display.id === shot.displayId)
    const same =
      now &&
      now.bounds.x === shot.bounds.x &&
      now.bounds.y === shot.bounds.y &&
      now.bounds.width === shot.bounds.width &&
      now.bounds.height === shot.bounds.height &&
      (Number.isFinite(now.scaleFactor) && now.scaleFactor > 0 ? now.scaleFactor : 1) === shot.scaleFactor
    if (!same) {
      this.lastShot = null
      throw new ComputerAgentError('STALE_SHOT', '显示器布局变了，请重新截图')
    }
  }

  private dipToScreen(point: Point): Point {
    if (typeof this.screen.dipToScreenPoint !== 'function') {
      throw new ComputerAgentError('FAILED', '无法换算屏幕坐标（dipToScreenPoint 不可用）')
    }
    return this.screen.dipToScreenPoint(point)
  }

  /** 把 BAD_ARGS（几何校验 / parseKeys）转成自己的错误类型 */
  private run<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (error instanceof ComputerAgentError) throw error
      const code = (error as { code?: unknown })?.code
      if (code === 'BAD_ARGS') throw new ComputerAgentError('BAD_ARGS', messageOf(error))
      throw new ComputerAgentError('FAILED', messageOf(error))
    }
  }

  /* ── 动作 ─────────────────────────────────────────────── */

  private async screenshot(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requirePermission('screen')
    const display = this.resolveDisplay(cmd.displayId)
    this.activity('screenshot')
    this.robot()
    const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.bounds.width * scale)),
      height: Math.max(1, Math.round(display.bounds.height * scale)),
    }
    let sources: DesktopSourceLike[]
    try {
      sources = await this.desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    } catch (error) {
      throw new ComputerAgentError('FAILED', `截屏失败：${messageOf(error)}`)
    }
    const source =
      sources.find((item) => item.display_id === String(display.id)) ??
      // 少数平台不给 display_id（空串）：只有一块屏时就用它
      (sources.length === 1 && !sources[0]!.display_id ? sources[0] : null)
    if (!source) throw new ComputerAgentError('NO_DISPLAY', `找不到显示器 ${display.id} 的截图`)
    let thumbnail = source.thumbnail
    if (!thumbnail) throw new ComputerAgentError('FAILED', '截图为空')
    if (typeof thumbnail.isEmpty === 'function' && thumbnail.isEmpty()) {
      throw new ComputerAgentError('FAILED', '截图为空')
    }
    const size = thumbnail.getSize()
    if (!size || size.width <= 0 || size.height <= 0) throw new ComputerAgentError('FAILED', '截图为空')
    const fitted = fitWidth(size.width, size.height, MAX_SCREENSHOT_WIDTH)
    if (fitted.width !== size.width) {
      thumbnail = thumbnail.resize({ width: fitted.width, quality: 'good' })
    }
    const finalSize = thumbnail.getSize()
    let jpeg: Buffer
    try {
      jpeg = thumbnail.toJPEG(JPEG_QUALITY)
    } catch (error) {
      throw new ComputerAgentError('FAILED', `截屏编码失败：${messageOf(error)}`)
    }
    if (!jpeg || jpeg.length === 0) throw new ComputerAgentError('FAILED', '截图为空')
    this.lastShot = {
      displayId: display.id,
      bounds: display.bounds,
      width: finalSize.width,
      height: finalSize.height,
      scaleFactor: scale,
    }
    return {
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: finalSize.width,
      height: finalSize.height,
      displayId: display.id,
      scale,
    }
  }

  private resolveDisplay(requested: unknown): DisplayLike {
    let displays: DisplayLike[]
    try {
      displays = this.screen.getAllDisplays()
    } catch (error) {
      throw new ComputerAgentError('NO_DISPLAY', `无法读取显示器：${messageOf(error)}`)
    }
    if (displays.length === 0) throw new ComputerAgentError('NO_DISPLAY', '没有可用的显示器')
    if (requested !== undefined && requested !== null && requested !== '') {
      const found = displays.find((display) => String(display.id) === String(requested))
      if (!found) throw new ComputerAgentError('NO_DISPLAY', `显示器 ${String(requested)} 不存在`)
      return found
    }
    // 没指定：沿用上次用的屏（还在的话），否则主屏
    if (this.lastShot) {
      const previous = displays.find((display) => display.id === this.lastShot!.displayId)
      if (previous) return previous
    }
    const primary = this.safePrimaryDisplay()
    if (primary && displays.some((display) => display.id === primary.id)) return primary
    return displays[0]!
  }

  private click(cmd: Record<string, unknown>): Record<string, unknown> {
    this.requirePermission('accessibility')
    const button = cmd.button === undefined ? 'left' : cmd.button
    if (button !== 'left' && button !== 'right' && button !== 'middle') {
      badArgs("button 只能是 'left' | 'right' | 'middle'")
    }
    const double = cmd.double === true
    this.activity('click', this.peekPoint(cmd.x, cmd.y))
    this.checkUserTookOver()
    const point = this.run(() => this.nativePoint(cmd.x, cmd.y))
    const robot = this.robot()
    robot.moveMouse(point.x, point.y)
    robot.mouseClick(button, double)
    this.rememberCursor()
    return { x: Math.round(num(cmd.x, 'x')), y: Math.round(num(cmd.y, 'y')) }
  }

  private move(cmd: Record<string, unknown>): Record<string, unknown> {
    this.requirePermission('accessibility')
    this.activity('move', this.peekPoint(cmd.x, cmd.y))
    this.checkUserTookOver()
    const point = this.run(() => this.nativePoint(cmd.x, cmd.y))
    this.robot().moveMouse(point.x, point.y)
    this.rememberCursor()
    return { x: Math.round(num(cmd.x, 'x')), y: Math.round(num(cmd.y, 'y')) }
  }

  private drag(cmd: Record<string, unknown>): Record<string, unknown> {
    this.requirePermission('accessibility')
    this.activity('drag', this.peekPoint(cmd.x, cmd.y))
    this.checkUserTookOver()
    const from = this.run(() => this.nativePoint(cmd.x, cmd.y))
    const to = this.run(() => this.nativePoint(cmd.toX, cmd.toY))
    const robot = this.robot()
    robot.moveMouse(from.x, from.y)
    robot.mouseToggle('down', 'left')
    try {
      robot.moveMouseSmooth(to.x, to.y)
    } finally {
      robot.mouseToggle('up', 'left')
    }
    this.rememberCursor()
    return {}
  }

  private scroll(cmd: Record<string, unknown>): Record<string, unknown> {
    this.requirePermission('accessibility')
    this.activity('scroll', this.peekPoint(cmd.x, cmd.y))
    this.checkUserTookOver()
    const dx = clampScroll(cmd.dx, 'dx')
    const dy = clampScroll(cmd.dy, 'dy')
    const point = this.run(() => this.nativePoint(cmd.x, cmd.y))
    const robot = this.robot()
    robot.moveMouse(point.x, point.y)
    const native = scrollToNative(dx, dy, this.platform)
    robot.scrollMouse(native.x, native.y)
    this.rememberCursor()
    return {}
  }

  private async type(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requirePermission('accessibility')
    const raw = cmd.text
    if (typeof raw !== 'string') badArgs('type 需要 text')
    if (raw.length > MAX_TYPE_CHARS) badArgs(`text 最多 ${MAX_TYPE_CHARS} 字`)
    this.activity('type')
    this.checkUserTookOver()
    const robot = this.robot()
    if (isAsciiPrintable(raw)) {
      robot.typeString(raw)
    } else {
      await this.pasteText(raw)
    }
    this.rememberCursor()
    return {}
  }

  /** 非 ASCII：写剪贴板 → 粘贴 → 恢复原剪贴板 */
  private async pasteText(text: string): Promise<void> {
    const robot = this.robot()
    // 读不到原内容就不恢复（写回空串等于清空用户的剪贴板）
    let previous: string | null = null
    try {
      previous = await this.clipboard.readText()
    } catch {
      previous = null
    }
    this.clipboard.writeText(text)
    robot.keyTap('v', this.platform === 'darwin' ? 'command' : 'control')
    await sleep(PASTE_RESTORE_MS)
    if (previous === null) return
    try {
      this.clipboard.writeText(previous)
    } catch {
      // 恢复失败不影响已输入的内容
    }
  }

  private key(cmd: Record<string, unknown>): Record<string, unknown> {
    this.requirePermission('accessibility')
    const parsed = this.run(() => parseKeys(cmd.keys, this.platform))
    this.activity('key')
    this.checkUserTookOver()
    const robot = this.robot()
    if (parsed.modifiers.length > 0) robot.keyTap(parsed.key, parsed.modifiers)
    else robot.keyTap(parsed.key)
    this.rememberCursor()
    return {}
  }

  private cursor(): Record<string, unknown> {
    this.requirePermission('accessibility')
    const shot = this.shot()
    this.activity('cursor')
    const position = this.robot().getMousePos()
    const imagePoint = nativeToImage(
      position,
      shot.bounds,
      shot.width,
      shot.height,
      this.platform,
      shot.scaleFactor,
      typeof this.screen.screenToDipPoint === 'function' ? (point) => this.screen.screenToDipPoint!(point) : undefined,
    )
    // 光标不在上次截图的那块屏上：x / y 为 null（docs/computer-use.md “cursor”）
    return (imagePoint ?? { x: null, y: null }) as unknown as Record<string, unknown>
  }

  /** 活动回调要坐标但不校验（非法坐标留给动作本身报错） */
  private peekPoint(x: unknown, y: unknown): Point | undefined {
    if (typeof x !== 'number' || typeof y !== 'number') return undefined
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    return { x: Math.round(x), y: Math.round(y) }
  }

  dispose(): void {
    this.disposed = true
    this.unregisterHotkey()
    this.overlay.dispose()
    this.lastCursor = null
  }
}

function clampScroll(value: unknown, what: string): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) badArgs(`${what} 必须是有限数字`)
  return Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, Math.round(value))) * SCROLL_STEP
}

/**
 * 规格里 dx/dy 以“行（滚轮格）”为单位、正数 = 向右 / 向下；robotjs 的约定是正 y = 向上、正 x = 向左，
 * 且单位各平台不同：Windows 是原始 wheel 数据（一格 WHEEL_DELTA = 120），macOS 是像素，X11 是按键次数。
 */
export const SCROLL_UNIT: Partial<Record<NodeJS.Platform, number>> = { win32: 120, darwin: 40 }

export function scrollToNative(dx: number, dy: number, platform: NodeJS.Platform): { x: number; y: number } {
  const unit = SCROLL_UNIT[platform] ?? 1
  // 0 * -1 会得到 -0，统一成 0
  return { x: dx === 0 ? 0 : -dx * unit, y: dy === 0 ? 0 : -dy * unit }
}
