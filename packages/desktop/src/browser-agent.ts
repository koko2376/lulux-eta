import { setTimeout as sleep } from 'node:timers/promises'
import type { WebContents } from 'electron'
import type { BrowserController } from './browser'
import {
  actionPrepScript,
  classifyFailure,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ITEMS,
  describeScript,
  focusScript,
  formatSnapshot,
  MAX_SCREENSHOT_WIDTH,
  sanitizeElementInfo,
  sanitizePageText,
  sanitizeScroll,
  sanitizeSnapshot,
  scrollScript,
  selectScript,
  clickScript,
  armClickProbeScript,
  CLICK_PROBE_READ,
  setValueScript,
  submitScript,
  snapshotScript,
  textScript,
  waitTextScript,
  type ElementInfo,
  type ScriptFailure,
} from './browser-agent-script'

/**
 * Agent 操作内置浏览器（docs/browser-use.md）。
 *
 * 服务进程经 IPC 发来 cmd，这里在 BrowserController 的活动标签页上执行，
 * 页面侧脚本见 browser-agent-script.ts。失败一律抛 BrowserAgentError。
 */

export type BrowserErrorCode =
  | 'NO_WINDOW'
  | 'NO_TAB'
  | 'REF_NOT_FOUND'
  | 'REF_STALE'
  | 'PASSWORD_FIELD'
  | 'NAV_BLOCKED'
  | 'BUSY'
  | 'TIMEOUT'
  | 'BAD_ARGS'
  | 'FAILED'

export class BrowserAgentError extends Error {
  readonly code: BrowserErrorCode

  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserAgentError'
    this.code = code
  }
}

/** 推给渲染进程的 browser:agent-activity */
export interface BrowserAgentActivity {
  action: string
  url: string
  /** 发起这一步的会话（服务端随命令带来；没有时为空串） */
  sessionId: string
}

export interface BrowserPageInfo {
  tabId: string
  url: string
  title: string
}

/** 页面脚本 / 导航的超时上限 */
const SCRIPT_TIMEOUT = 15_000
/** 浏览器占用租约：持有会话最后一次操作后这么久无动作即释放 */
export const OWNER_LEASE_MS = 90_000
const OPEN_TIMEOUT = 15_000
const ACTION_SETTLE_MS = 600
const NAV_TIMEOUT = 10_000
const WAIT_DEFAULT_MS = 10_000
const WAIT_MAX_MS = 30_000
const SCREENSHOT_TIMEOUT = 10_000

type ControllerGetter = () => BrowserController | null
type ActivitySender = (activity: BrowserAgentActivity) => void

function badArgs(message: string): never {
  throw new BrowserAgentError('BAD_ARGS', message)
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function refArg(value: unknown): number {
  const ref = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(ref) || ref <= 0) badArgs('ref 必须是正整数')
  return Math.floor(ref)
}

function clampMs(value: unknown, fallback: number, max: number): number {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(0, Math.floor(ms)), max)
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserAgentError('TIMEOUT', `${what}超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '操作失败'
}

/** 页面脚本返回 ScriptFailure 时转成异常；否则原样返回 */
function ensureOk<T>(raw: unknown): T {
  const failure = classifyFailure(raw)
  if (failure) throw new BrowserAgentError(failure.code as BrowserErrorCode, failure.message)
  return raw as T
}

export class BrowserAgent {
  private readonly getController: ControllerGetter
  private readonly sendActivity: ActivitySender
  /** 最近一次 snapshot 的文档 token：ref 只在这个文档里有效 */
  private token: string | null = null
  /**
   * 浏览器面板只有一个，页面上的 data-lulux-ref 编号也只有一套：同一时间只让一个会话操作。
   * 持有者空闲超过 OWNER_LEASE_MS 自动释放（运行结束 / 用户停止后另一个会话即可接手）。
   */
  private owner: { sessionId: string; at: number } | null = null

  constructor(getController: ControllerGetter, onActivity?: ActivitySender) {
    this.getController = getController
    this.sendActivity = onActivity ?? (() => undefined)
  }

  async execute(cmd: unknown): Promise<unknown> {
    if (!cmd || typeof cmd !== 'object') badArgs('命令格式不正确')
    const command = cmd as Record<string, unknown>
    const action = command.action
    if (typeof action !== 'string') badArgs('缺少 action')
    if (action !== 'status') {
      this.claim(typeof command.sessionId === 'string' ? command.sessionId : '')
      this.updateGuard(command.deniedDomains)
    }
    // 先推活动：界面据此展开浏览器面板并显示“第 N 步”（status / describe 是内部查询，不算一步）
    if (action !== 'status' && action !== 'describe') {
      const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
      const contents = this.getController()?.activeContents() ?? null
      this.activity(action, contents && !contents.isDestroyed() ? contents.getURL() : '', sessionId)
    }
    return this.dispatch(action, command)
  }

  /** 占用浏览器：别的会话持有且未过期 → BUSY；换了持有者时旧的 snapshot 编号作废 */
  /** 最近一次命令下发的黑名单（open 程序化导航不经过 will-navigate，要自己查） */
  private deniedDomains: string[] = []

  private claim(sessionId: string, now = Date.now()): void {
    const current = this.owner
    if (current && current.sessionId !== sessionId && now - current.at < OWNER_LEASE_MS) {
      throw new BrowserAgentError('BUSY', '内置浏览器正在被另一个对话使用，请等它结束后再试')
    }
    if (!current || current.sessionId !== sessionId) this.token = null
    this.owner = { sessionId, at: now }
  }

  /** 黑名单随命令下发：Agent 持有浏览器期间（租约内）在导航发生前拦截命中的网址 */
  private updateGuard(raw: unknown): void {
    const domains = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 253).map((item) => item.toLowerCase())
      : []
    this.deniedDomains = domains
    const controller = this.getController()
    if (!controller) return
    if (domains.length === 0) {
      controller.navigationGuard = null
      return
    }
    controller.navigationGuard = (url: string): boolean => {
      // 租约过期（Agent 不再操作）后不再拦用户自己的浏览
      if (!this.owner || Date.now() - this.owner.at >= OWNER_LEASE_MS) return false
      return isHostDenied(url, domains)
    }
  }

  /** 点击 / 输入前等面板显示出来（界面收到活动后展开，通常 < 300ms）；等不到返回 false，改走 DOM 方式 */
  private async waitShowing(timeoutMs = 1500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.getController()?.isShowing()) {
        // 刚挂上的视图要等一帧布局，坐标才准
        await new Promise((resolve) => setTimeout(resolve, 120))
        return true
      }
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private async dispatch(action: string, command: Record<string, unknown>): Promise<unknown> {
    try {
      switch (action) {
        case 'status':
          return this.status()
        case 'open':
          return await this.open(command)
        case 'snapshot':
          return await this.snapshot(command)
        case 'describe':
          return await this.describe(command)
        case 'click':
          return await this.click(command)
        case 'type':
          return await this.type(command)
        case 'select':
          return await this.select(command)
        case 'scroll':
          return await this.scroll(command)
        case 'screenshot':
          return await this.screenshot()
        case 'text':
          return await this.text(command)
        case 'wait':
          return await this.wait(command)
        case 'back':
          return await this.back()
        case 'switchTab':
          return await this.switchTab(command)
        default:
          badArgs(`未知的 action：${action}`)
      }
    } catch (error) {
      if (error instanceof BrowserAgentError) throw error
      throw new BrowserAgentError('FAILED', messageOf(error))
    }
  }

  /* ── 上下文 ───────────────────────────────────────────── */

  private controller(): BrowserController {
    const controller = this.getController()
    if (!controller) throw new BrowserAgentError('NO_WINDOW', '主窗口不存在')
    return controller
  }

  private contents(): WebContents {
    const contents = this.controller().ensureTab()
    if (!contents || contents.isDestroyed()) {
      throw new BrowserAgentError('NO_TAB', '没有可用的浏览器标签页')
    }
    return contents
  }

  private pageInfo(contents: WebContents): BrowserPageInfo {
    const state = this.getController()?.state()
    return {
      tabId: state?.activeTabId ?? '',
      url: contents.getURL(),
      title: contents.getTitle() || '',
    }
  }

  private activity(action: string, url: string, sessionId: string): void {
    try {
      this.sendActivity({ action, url, sessionId })
    } catch {
      // 界面不在也不影响 Agent 操作
    }
  }

  private async runScript(contents: WebContents, script: string): Promise<unknown> {
    try {
      return await withTimeout(contents.executeJavaScript(script, true), SCRIPT_TIMEOUT, '页面脚本')
    } catch (error) {
      if (error instanceof BrowserAgentError) throw error
      throw new BrowserAgentError('FAILED', messageOf(error))
    }
  }

  /** ref 相关脚本需要的 docToken；没有 snapshot 过视为过期 */
  private requireToken(): string {
    if (!this.token) throw new BrowserAgentError('REF_STALE', '还没有 snapshot，请先读取页面')
    return this.token
  }

  /**
   * 动作后的稳定等待：600ms 内没开始导航就返回；开始导航了就等到提交 / 加载结束（最多 NAV_TIMEOUT），
   * 这样返回给模型的网址、标题已经是新页面的。
   */
  private async settle(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return
    await new Promise<void>((resolve) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        contents.removeListener('did-start-loading', onStart)
        contents.removeListener('did-stop-loading', finish)
        contents.removeListener('did-navigate-in-page', finish)
        contents.removeListener('did-fail-load', onFail)
        contents.removeListener('destroyed', finish)
      }
      // 只认主文档失败：页面里的 iframe / 广告加载失败不算导航结束
      const onFail = (_event: unknown, _code: number, _desc: string, _url: string, isMainFrame?: boolean): void => {
        if (isMainFrame !== false) finish()
      }
      const finish = (): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        cleanup()
        resolve()
      }
      const onStart = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(finish, NAV_TIMEOUT)
      }
      contents.on('did-start-loading', onStart)
      contents.on('did-stop-loading', finish)
      contents.on('did-navigate-in-page', finish)
      contents.on('did-fail-load', onFail)
      contents.once('destroyed', finish)
      if (contents.isLoading()) onStart()
      else timer = setTimeout(finish, ACTION_SETTLE_MS)
    })
  }

  /* ── 动作 ─────────────────────────────────────────────── */

  private status(): { visible: boolean; activeTabId: string | null; tabs: Array<{ id: string; url: string; title: string; loading: boolean }> } {
    const state = this.controller().state()
    return {
      visible: state.visible,
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(({ id, url, title, loading }) => ({ id, url, title, loading })),
    }
  }

  private async open(cmd: Record<string, unknown>): Promise<BrowserPageInfo> {
    const raw = str(cmd.url, 4000).trim()
    if (!raw) badArgs('open 需要 url')
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      throw new BrowserAgentError('NAV_BLOCKED', '只允许 http/https 地址')
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new BrowserAgentError('NAV_BLOCKED', '只允许 http/https 地址')
    }
    const url = target.toString()
    if (this.deniedDomains.length && isHostDenied(url, this.deniedDomains)) {
      throw new BrowserAgentError('NAV_BLOCKED', `${target.hostname} 在禁止访问的域名名单里`)
    }
    const controller = this.controller()
    const newTab = cmd.newTab === true
    const state = controller.state()
    const useNewTab = newTab || state.activeTabId === null
    if (useNewTab) {
      controller.newTab(url)
      const contents = controller.activeContents()
      if (!contents) throw new BrowserAgentError('NO_TAB', '没有可用的浏览器标签页')
      const loaded = await controller.waitForLoad(contents, OPEN_TIMEOUT)
      if (!loaded) throw new BrowserAgentError('TIMEOUT', `页面在 ${OPEN_TIMEOUT}ms 内没有加载完成`)
      return this.pageInfo(contents)
    }
    const contents = controller.activeContents()
    if (!contents) throw new BrowserAgentError('NO_TAB', '没有可用的浏览器标签页')
    try {
      await withTimeout(contents.loadURL(url), OPEN_TIMEOUT, '页面加载')
    } catch (error) {
      if (error instanceof BrowserAgentError) throw error
      throw new BrowserAgentError('FAILED', messageOf(error))
    }
    return this.pageInfo(contents)
  }

  private async snapshot(cmd: Record<string, unknown>): Promise<{
    url: string
    title: string
    text: string
    count: number
    truncated: boolean
  }> {
    const contents = this.contents()
    const maxItems = clampMs(cmd.maxItems, DEFAULT_MAX_ITEMS, 2000) || DEFAULT_MAX_ITEMS
    const raw = await this.runScript(contents, snapshotScript(maxItems))
    const data = sanitizeSnapshot(raw)
    if (!data) throw new BrowserAgentError('FAILED', '页面快照格式不正确')
    this.token = data.docToken
    return {
      url: data.url || contents.getURL(),
      title: data.title || contents.getTitle() || '',
      text: formatSnapshot(data),
      count: data.items.length,
      truncated: data.truncated,
    }
  }

  private async describe(cmd: Record<string, unknown>): Promise<ElementInfo> {
    const ref = refArg(cmd.ref)
    const contents = this.contents()
    const token = this.requireToken()
    const raw = await this.runScript(contents, describeScript(ref, token))
    const info = sanitizeElementInfo(ensureOk<unknown>(raw), ref)
    if (!info) throw new BrowserAgentError('FAILED', '元素信息格式不正确')
    return info
  }

  private async click(cmd: Record<string, unknown>): Promise<BrowserPageInfo> {
    const ref = refArg(cmd.ref)
    const contents = this.contents()
    const token = this.requireToken()
    const prep = ensureOk<{ x: number; y: number; element: ElementInfo }>(
      await this.runScript(contents, actionPrepScript(ref, token)),
    )
    const x = Number(prep.x)
    const y = Number(prep.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BrowserAgentError('FAILED', '无法确定元素位置')
    }
    if (await this.waitShowing()) {
      // 面板可见：真实鼠标事件（坐标是 CSS 像素，乘页面缩放得到视图像素）
      const prepAgain = ensureOk<{ x: number; y: number }>(await this.runScript(contents, actionPrepScript(ref, token)))
      const zoom = this.zoomOf(contents)
      const point = { x: Math.round(Number(prepAgain.x) * zoom), y: Math.round(Number(prepAgain.y) * zoom) }
      ensureOk<unknown>(await this.runScript(contents, armClickProbeScript(ref, token)))
      const urlBefore = contents.getURL()
      contents.sendInputEvent({ type: 'mouseMove', ...point })
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      // 鼠标事件没落到元素上（被别的元素挡住、视图还没合成出画面）：改用元素 click()。
      // 已经开始跳转 / 页面已换掉时不补点，避免重复提交
      const landed =
        contents.isLoading() || contents.getURL() !== urlBefore
          ? true
          : await contents.executeJavaScript(CLICK_PROBE_READ, true).then((v) => v !== false, () => true)
      if (!landed) ensureOk<unknown>(await this.runScript(contents, clickScript(ref, token)))
    } else {
      // 面板没显示（例如用户在设置页）：视图不在窗口上收不到鼠标事件，改用元素 click()
      ensureOk<unknown>(await this.runScript(contents, clickScript(ref, token)))
    }
    await this.settle(contents)
    return this.pageInfo(contents)
  }

  private async type(cmd: Record<string, unknown>): Promise<BrowserPageInfo> {
    const ref = refArg(cmd.ref)
    const rawText = cmd.text
    if (typeof rawText !== 'string') badArgs('type 需要 text')
    const text = rawText.slice(0, 10_000)
    const clear = cmd.clear !== false
    const submit = cmd.submit === true
    const contents = this.contents()
    const token = this.requireToken()
    ensureOk<unknown>(await this.runScript(contents, actionPrepScript(ref, token)))
    ensureOk<unknown>(await this.runScript(contents, focusScript(ref, token, clear)))
    if (await this.waitShowing()) {
      contents.focus()
      await contents.insertText(text)
      if (submit) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        contents.sendInputEvent({ type: 'char', keyCode: 'Enter' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      }
    } else {
      // 面板没显示：直接写值并派发 input / change，提交走表单
      ensureOk<unknown>(await this.runScript(contents, setValueScript(ref, token, text, !clear)))
      if (submit) ensureOk<unknown>(await this.runScript(contents, submitScript(ref, token)))
    }
    await this.settle(contents)
    return this.pageInfo(contents)
  }

  private async select(cmd: Record<string, unknown>): Promise<BrowserPageInfo> {
    const ref = refArg(cmd.ref)
    const value = str(cmd.value, 2000)
    if (!value) badArgs('select 需要 value')
    const contents = this.contents()
    const token = this.requireToken()
    ensureOk<unknown>(await this.runScript(contents, actionPrepScript(ref, token)))
    ensureOk<unknown>(await this.runScript(contents, selectScript(ref, token, value)))
    await this.settle(contents)
    return this.pageInfo(contents)
  }

  private async scroll(cmd: Record<string, unknown>): Promise<{ scrollY: number; scrollHeight: number; viewportHeight: number }> {
    const direction = cmd.direction === 'up' ? 'up' : cmd.direction === 'down' ? 'down' : null
    if (!direction) badArgs("scroll 需要 direction: 'up' | 'down'")
    const amount = typeof cmd.amount === 'number' && Number.isFinite(cmd.amount) && cmd.amount > 0 ? Math.min(cmd.amount, 20) : 0.8
    const contents = this.contents()
    const raw = await this.runScript(contents, scrollScript(direction, amount))
    const state = sanitizeScroll(raw)
    if (!state) throw new BrowserAgentError('FAILED', '滚动结果格式不正确')
    return state
  }

  private async screenshot(): Promise<{ image: string; width: number; height: number }> {
    const contents = this.contents()
    let image = await withTimeout(contents.capturePage(), SCREENSHOT_TIMEOUT, '截图')
    if (image.isEmpty()) throw new BrowserAgentError('FAILED', '页面截图为空')
    if (image.getSize().width > MAX_SCREENSHOT_WIDTH) {
      image = image.resize({ width: MAX_SCREENSHOT_WIDTH, quality: 'good' })
    }
    const size = image.getSize()
    return {
      image: `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`,
      width: size.width,
      height: size.height,
    }
  }

  private async text(cmd: Record<string, unknown>): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const maxChars = clampMs(cmd.maxChars, DEFAULT_MAX_CHARS, 200_000) || DEFAULT_MAX_CHARS
    const contents = this.contents()
    const raw = await this.runScript(contents, textScript(maxChars))
    const page = sanitizePageText(raw)
    if (!page) throw new BrowserAgentError('FAILED', '页面文本格式不正确')
    return { url: page.url, title: page.title, text: page.text, truncated: page.truncated }
  }

  private async wait(cmd: Record<string, unknown>): Promise<{ found: boolean }> {
    const needle = str(cmd.text, 500)
    const contents = this.contents()
    if (!needle) {
      await sleep(clampMs(cmd.ms, WAIT_DEFAULT_MS, WAIT_MAX_MS))
      return { found: true }
    }
    const timeoutMs = clampMs(cmd.timeoutMs, WAIT_DEFAULT_MS, WAIT_MAX_MS)
    const deadline = Date.now() + timeoutMs
    do {
      const raw = await this.runScript(contents, waitTextScript(needle))
      if (raw && typeof raw === 'object' && (raw as { found?: unknown }).found === true) return { found: true }
      if (contents.isDestroyed()) break
      await sleep(250)
    } while (Date.now() < deadline)
    return { found: false }
  }

  private async back(): Promise<BrowserPageInfo> {
    const controller = this.controller()
    const contents = this.contents()
    if (!contents.navigationHistory.canGoBack()) return this.pageInfo(contents)
    contents.navigationHistory.goBack()
    const loaded = await controller.waitForLoad(contents, NAV_TIMEOUT)
    if (!loaded) throw new BrowserAgentError('TIMEOUT', `返回上一页在 ${NAV_TIMEOUT}ms 内没有完成`)
    return this.pageInfo(contents)
  }

  private async switchTab(cmd: Record<string, unknown>): Promise<BrowserPageInfo> {
    const tabId = str(cmd.tabId, 200)
    if (!tabId) badArgs('switchTab 需要 tabId')
    const controller = this.controller()
    const state = controller.state()
    if (!state.tabs.some((tab) => tab.id === tabId)) {
      throw new BrowserAgentError('NO_TAB', `标签页 ${tabId} 不存在`)
    }
    controller.activate(tabId)
    const contents = controller.activeContents()
    if (!contents) throw new BrowserAgentError('NO_TAB', '标签页已关闭')
    return this.pageInfo(contents)
  }

  private zoomOf(contents: WebContents): number {
    const zoom = contents.getZoomFactor()
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  }
}

/** 供测试 / 服务端判断脚本失败 */
export type { ScriptFailure }

/** url 的主机是否命中黑名单（example.com 同时拦截 a.example.com）；与服务端 isDomainDenied 同规则 */
export function isHostDenied(url: string, domains: string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}
