import { publishSessionEvent } from '../session-hub.js'
import { clearSessionAllowPrefix, rejectPendingForSession } from '../tool-approval.js'
import { computerChannel, onComputerEvent } from './channel.js'

/**
 * 电脑操作的运行控制（docs/computer-use.md「服务端（工具层）」最后一条），语义与内置浏览器一致：
 * - 用户在本会话里手动开启（enabled，内存态，默认关；进程重启后清空）；
 * - 状态按会话保存：running / paused / stopped，每次对话运行开始时重置为 running（run-registry 的 startRun 调用 beginRun）；
 * - 步数按“会话 + 本次运行”计：beginRun 清零，工具每成功执行一步 +1；
 * - 主进程的无 id 通知（急停 / 用户动了鼠标）作用在“当前持有电脑操作的会话”上（activeSessionId，begin 时设置）。
 *
 * 与主进程的生命周期：工具首次调用发 `{action:'begin'}`；用户停止（set stop）、关闭、运行结束（endRun）时发 `{action:'end'}`，
 * 让主进程隐藏边框提示窗、注销急停快捷键。
 */

export type ComputerControlState = 'running' | 'paused' | 'stopped'

/** 暂停后最多等这么久恢复，超时按“已停止”处理（与审批等待同一量级） */
export const PAUSE_TIMEOUT_MS = 30 * 60_000

export const COMPUTER_PAUSED_MESSAGE = '电脑操作已暂停（等待恢复超过 30 分钟已放弃本次操作）。用户点“继续”后才能接着操作。'
export const COMPUTER_STOPPED_MESSAGE = '电脑操作已停止。需要继续时请用户重新开启电脑操作。'

interface SessionControl {
  state: ComputerControlState
  /** 当前运行 id（仅用于事件与调试） */
  runId: string | null
  /** 本次运行内已执行的电脑操作步数 */
  steps: number
  /** 状态变化时唤醒正在等待的暂停调用 */
  waiters: Set<() => void>
}

const controls = new Map<string, SessionControl>()
/** 会话删除时的额外清理（tools.ts 注册：清掉该会话最近一张截图的记录） */
const forgetHooks = new Set<(sessionId: string) => void>()
/** 本会话是否已在本进程内开启电脑操作（默认 false；重启后清空） */
const enabledSessions = new Set<string>()
/** 已向主进程发过 begin 且还没发 end 的会话 */
const begunSessions = new Set<string>()
/** 当前持有电脑操作的会话（主进程的 stop / pause 通知作用在它上面） */
let activeSessionId: string | null = null
/** 正在向主进程发 begin（还没收到回复）的会话：先占住，防止两个会话在 await 期间都通过 heldByOther 检查 */
let claimingSessionId: string | null = null

function entry(sessionId: string): SessionControl {
  let control = controls.get(sessionId)
  if (!control) {
    control = { state: 'running', runId: null, steps: 0, waiters: new Set() }
    controls.set(sessionId, control)
  }
  return control
}

function wake(control: SessionControl): void {
  for (const waiter of [...control.waiters]) waiter()
}

/** 通知主进程收起边框提示窗、注销急停快捷键（失败忽略：主进程可能已经不在了） */
function sendEnd(sessionId: string | null): void {
  if (!sessionId || !begunSessions.delete(sessionId)) return
  if (!computerChannel().available()) return
  void computerChannel()
    .request({ action: 'end' }, { timeoutMs: 5000 })
    .catch(() => undefined)
}

export const computerControl = {
  /** 本会话是否已由用户开启电脑操作 */
  enabled(sessionId: string): boolean {
    return enabledSessions.has(sessionId)
  },

  /**
   * 用户在本会话里开启 / 关闭电脑操作（路由调用）。
   * 关闭时同时置为 stopped 并通知主进程 end（隐藏边框窗、注销快捷键）。
   */
  setEnabled(sessionId: string, enabled: boolean): boolean {
    if (enabled) {
      enabledSessions.add(sessionId)
      return true
    }
    enabledSessions.delete(sessionId)
    const control = entry(sessionId)
    control.state = 'stopped'
    wake(control)
    publishSessionEvent(sessionId, 'computer.control', { state: 'stopped', action: 'stop', reason: 'disabled' })
    rejectPendingForSession(sessionId, 'computer_')
    clearSessionAllowPrefix(sessionId, 'computer:')
    sendEnd(sessionId)
    if (activeSessionId === sessionId) activeSessionId = null
    return false
  },

  /** 当前持有电脑操作的会话（测试与调试） */
  activeSession(): string | null {
    return activeSessionId
  },

  /**
   * 别的会话正在用电脑操作（已 begin 未 end）：主进程只有一套边框窗 / 急停快捷键 / 鼠标监测，
   * 两个会话交替操作会让急停与“用户动了鼠标”记到错误的会话上，所以同一时间只允许一个会话操作。
   */
  heldByOther(sessionId: string): boolean {
    if (claimingSessionId !== null && claimingSessionId !== sessionId) return true
    return activeSessionId !== null && activeSessionId !== sessionId && begunSessions.has(activeSessionId)
  },

  /** 同步占住电脑操作（begin 发出前调用）；别的会话持有或正在占用时返回 false */
  claim(sessionId: string): boolean {
    if (computerControl.heldByOther(sessionId)) return false
    claimingSessionId = sessionId
    return true
  },

  /** begin 失败：放开占用 */
  release(sessionId: string): void {
    if (claimingSessionId === sessionId) claimingSessionId = null
  },

  state(sessionId: string): ComputerControlState {
    return controls.get(sessionId)?.state ?? 'running'
  },

  /**
   * 运行开始：本会话状态回到 running，步数清零。只动本会话：别的会话开始运行不能结束 / 抢走正在进行的电脑操作，
   * 持有者（activeSessionId）只在工具真正 begin 时设置（markBegun）。
   */
  beginRun(sessionId: string, runId: string | null = null): void {
    sendEnd(sessionId)
    if (activeSessionId === sessionId) activeSessionId = null
    const control = entry(sessionId)
    control.state = 'running'
    control.runId = runId
    control.steps = 0
    wake(control)
  },

  /**
   * 运行结束（run-registry 的 finish）：用过电脑操作就通知主进程 end，收起边框、注销急停快捷键。
   * 带 runId 时只结束同一次运行（迟到的旧运行收尾不能收起新运行的边框窗）。
   */
  endRun(sessionId: string, runId: string | null = null): void {
    const control = controls.get(sessionId)
    if (runId && control?.runId && control.runId !== runId) return
    sendEnd(sessionId)
    if (activeSessionId === sessionId) activeSessionId = null
  },

  /** 会话删除：清掉所有内存状态 */
  forget(sessionId: string): void {
    sendEnd(sessionId)
    if (activeSessionId === sessionId) activeSessionId = null
    if (claimingSessionId === sessionId) claimingSessionId = null
    enabledSessions.delete(sessionId)
    const control = controls.get(sessionId)
    if (control) {
      // 先置 stopped 再唤醒：暂停中等待的工具调用要立刻结束，而不是挂到 30 分钟超时
      control.state = 'stopped'
      wake(control)
    }
    controls.delete(sessionId)
    for (const hook of forgetHooks) {
      try {
        hook(sessionId)
      } catch {
        // ignore
      }
    }
  },

  /** 本次运行是否已经向主进程发过 begin */
  begun(sessionId: string): boolean {
    return begunSessions.has(sessionId)
  },

  /** 工具首次调用前发 begin（记录持有会话，供主进程事件定位） */
  markBegun(sessionId: string): void {
    if (claimingSessionId === sessionId) claimingSessionId = null
    activeSessionId = sessionId
    begunSessions.add(sessionId)
  },

  /** 用户操作（路由调用）或主进程通知：返回设置后的状态 */
  set(sessionId: string, action: 'pause' | 'resume' | 'stop', reason?: string): ComputerControlState {
    const control = entry(sessionId)
    // 停止是强确认：已停止的会话不能靠“继续”恢复，也不能被暂停改写，要用户重新开启（setEnabled 后由下一次运行复位）
    if (control.state === 'stopped' && action !== 'stop') return 'stopped'
    const next: ComputerControlState = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped'
    control.state = next
    wake(control)
    publishSessionEvent(sessionId, 'computer.control', { state: next, action, ...(reason ? { reason } : {}) })
    if (action === 'stop') {
      rejectPendingForSession(sessionId, 'computer_')
      // “本会话始终允许”的电脑动作随停止一起作废：继续对话后每一步重新确认
      clearSessionAllowPrefix(sessionId, 'computer:')
      sendEnd(sessionId)
      if (activeSessionId === sessionId) activeSessionId = null
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
  waitUntilReady(sessionId: string, signal: AbortSignal, timeoutMs = PAUSE_TIMEOUT_MS): Promise<'running' | 'stopped' | 'timeout' | 'aborted'> {
    const control = entry(sessionId)
    if (control.state !== 'paused') return Promise.resolve(control.state === 'stopped' ? 'stopped' : 'running')
    if (signal.aborted) return Promise.resolve('aborted')
    return new Promise<'running' | 'stopped' | 'timeout' | 'aborted'>((resolve) => {
      let settled = false
      const finish = (result: 'running' | 'stopped' | 'timeout' | 'aborted'): void => {
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

  /** 会话删除时的额外清理 */
  onForget(hook: (sessionId: string) => void): void {
    forgetHooks.add(hook)
  },

  /** 测试用：清空所有会话的状态与开启标记 */
  reset(): void {
    for (const control of controls.values()) {
      control.state = 'running'
      control.steps = 0
      wake(control)
    }
    controls.clear()
    enabledSessions.clear()
    begunSessions.clear()
    activeSessionId = null
    claimingSessionId = null
  },
}

/**
 * 主进程主动通知（docs/computer-use.md「IPC 协议」）：急停 → stop，用户动了鼠标 → pause（reason 带上）。
 * 只作用于当前持有电脑操作的会话；没有持有者时忽略。
 */
onComputerEvent((event) => {
  const sessionId = activeSessionId
  if (!sessionId) return
  if (event.event === 'stop') computerControl.set(sessionId, 'stop', event.reason)
  else if (event.event === 'pause') computerControl.set(sessionId, 'pause', event.reason)
})
