import { publishSessionEvent } from '../session-hub.js'
import { rejectPendingForSession } from '../tool-approval.js'

/**
 * 内置浏览器的运行控制（docs/browser-use.md「服务端（工具层）约束」最后一条）：
 * 用户在浏览器面板点“我来接管”→ pause（后续 browser 工具调用等待恢复，最长 30 分钟）；
 * “停止”→ stop（本次运行内后续 browser 工具全部返回“用户已停止浏览器操作”）。
 *
 * 状态按会话保存，每次对话运行开始时重置为 running（run-registry 的 startRun 调用 beginBrowserRun）。
 * 步数也按“会话 + 本次运行”计数：beginBrowserRun 清零，工具每成功执行一步 +1。
 */

export type BrowserControlState = 'running' | 'paused' | 'stopped'

/** 暂停后最多等这么久恢复，超时按“已停止”处理（与审批等待同一量级） */
export const PAUSE_TIMEOUT_MS = 30 * 60_000

export const BROWSER_PAUSED_MESSAGE = '用户正在接管浏览器，操作已暂停（等待恢复超过 30 分钟已放弃本次操作）'
export const BROWSER_STOPPED_MESSAGE = '用户已停止浏览器操作'

interface SessionControl {
  state: BrowserControlState
  /** 当前运行 id（仅用于事件与调试） */
  runId: string | null
  /** 本次运行内已执行的浏览器步数 */
  steps: number
  /** 状态变化时唤醒正在等待的暂停调用 */
  waiters: Set<() => void>
  /** stop 时中止正在进行的浏览器请求（慢导航、等待）；beginRun 时换新 */
  stopper: AbortController
}

const controls = new Map<string, SessionControl>()

function entry(sessionId: string): SessionControl {
  let control = controls.get(sessionId)
  if (!control) {
    control = { state: 'running', runId: null, steps: 0, waiters: new Set(), stopper: new AbortController() }
    controls.set(sessionId, control)
  }
  return control
}

function wake(control: SessionControl): void {
  for (const waiter of [...control.waiters]) waiter()
}

/** 等待结果：继续执行 / 已停止 / 超时 / 运行被取消 */
export type BrowserWaitResult = 'running' | 'stopped' | 'timeout' | 'aborted'

export const browserControl = {
  state(sessionId: string): BrowserControlState {
    return controls.get(sessionId)?.state ?? 'running'
  },

  /** 运行开始：状态回到 running，步数清零 */
  beginRun(sessionId: string, runId: string | null = null): void {
    const control = entry(sessionId)
    control.state = 'running'
    control.runId = runId
    control.steps = 0
    if (control.stopper.signal.aborted) control.stopper = new AbortController()
    wake(control)
  },

  /** 本会话当前运行的“停止”信号：用户点停止时中止正在进行的浏览器请求 */
  stopSignal(sessionId: string): AbortSignal {
    return entry(sessionId).stopper.signal
  },

  /** 用户操作（路由调用）：返回设置后的状态 */
  set(sessionId: string, action: 'pause' | 'resume' | 'stop'): BrowserControlState {
    const control = entry(sessionId)
    // 停止对本次运行是终态（停止信号已发出）：只有下一次运行开始才回到 running
    if (control.state === 'stopped' && action !== 'stop') return 'stopped'
    const next: BrowserControlState = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped'
    control.state = next
    wake(control)
    publishSessionEvent(sessionId, 'browser.control', { state: next, action })
    // 停止：收回还挂着的浏览器审批卡（高风险点击），不让用户在“已停止”后还能批准
    if (next === 'stopped') {
      rejectPendingForSession(sessionId, 'browser_')
      control.stopper.abort()
    }
    return next
  },

  /** 本次运行已执行的步数（含当前这一步） */
  steps(sessionId: string): number {
    return controls.get(sessionId)?.steps ?? 0
  },

  /** 记一步，返回本步的序号（从 1 开始） */
  takeStep(sessionId: string): number {
    const control = entry(sessionId)
    control.steps += 1
    return control.steps
  },

  /**
   * 工具调用前等待可用：paused 时等到 resume / stop / 超时 / 运行取消（signal）。
   * 非 paused 时立即返回当前状态。
   */
  waitUntilReady(sessionId: string, signal: AbortSignal, timeoutMs = PAUSE_TIMEOUT_MS): Promise<BrowserWaitResult> {
    const control = entry(sessionId)
    if (control.state !== 'paused') return Promise.resolve(control.state === 'stopped' ? 'stopped' : 'running')
    if (signal.aborted) return Promise.resolve('aborted')
    return new Promise<BrowserWaitResult>((resolve) => {
      let settled = false
      const finish = (result: BrowserWaitResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        control.waiters.delete(onWake)
        resolve(result)
      }
      const onWake = (): void => {
        if (control.state === 'running') finish('running')
        else if (control.state === 'stopped') finish('stopped')
      }
      const onAbort = (): void => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      timer.unref?.()
      signal.addEventListener('abort', onAbort, { once: true })
      control.waiters.add(onWake)
    })
  },

  /** 会话删除：唤醒等待者并清掉状态（避免内存残留与 id 复用时带上旧状态） */
  forget(sessionId: string): void {
    const control = controls.get(sessionId)
    if (!control) return
    control.state = 'stopped'
    wake(control)
    controls.delete(sessionId)
  },

  /** 测试用：清空所有会话的状态 */
  reset(): void {
    for (const control of controls.values()) {
      control.state = 'running'
      control.steps = 0
      wake(control)
    }
    controls.clear()
  },
}
