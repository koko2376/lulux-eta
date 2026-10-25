import { reactive } from 'vue'
import * as api from '../api'

/**
 * 电脑操作（docs/computer-use.md，实验性）的会话开关与状态条。
 * - enabled / available 来自 GET /api/sessions/:id/computer（切换会话时刷新）；
 * - 每一步活动来自桌面端 computer.onActivity，急停 / 用户动了鼠标来自 computer.onEvent；
 * - 「暂停 / 继续 / 停止」经 POST /api/sessions/:id/computer/control。
 * 桌面端的活动不带会话 id：电脑操作同一时间只属于一个会话，就是最近开启并正在运行的那个（activeSessionId）。
 */
export const computerAgent = reactive({
  /** 当前查看的会话 */
  sessionId: '',
  available: false,
  enabled: false,
  state: 'running' as api.ComputerState,
  /** 状态条：本次运行里有活动后显示 */
  visible: false,
  step: 0,
  action: '',
  /** 暂停原因：user-moved-mouse 时提示“你动了鼠标” */
  pauseReason: '',
  busy: false,
})

let hideTimer: ReturnType<typeof setTimeout> | null = null
let loadSeq = 0

function clearHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

function hideLater(ms: number): void {
  clearHide()
  hideTimer = setTimeout(() => {
    hideTimer = null
    computerAgent.visible = false
    computerAgent.step = 0
  }, ms)
}

/** 切换到某个会话：读取开关与可用性（旧服务端没有这个接口 → 视为不可用） */
export async function loadComputerStatus(sessionId: string): Promise<void> {
  const seq = ++loadSeq
  if (computerAgent.sessionId !== sessionId) {
    clearHide()
    // 换会话时先清掉上一个会话的开关，状态回来前不显示旧值
    Object.assign(computerAgent, { sessionId, visible: false, step: 0, action: '', pauseReason: '', state: 'running', enabled: false })
  }
  if (!sessionId) {
    Object.assign(computerAgent, { available: false, enabled: false })
    return
  }
  try {
    const status = await api.computerStatus(sessionId)
    if (seq !== loadSeq) return
    Object.assign(computerAgent, { available: status.available, enabled: status.enabled, state: status.state })
  } catch {
    if (seq !== loadSeq) return
    Object.assign(computerAgent, { available: false, enabled: false })
  }
}

export async function toggleComputer(): Promise<boolean> {
  const sessionId = computerAgent.sessionId
  if (!sessionId || computerAgent.busy) return computerAgent.enabled
  computerAgent.busy = true
  try {
    const next = !computerAgent.enabled
    const result = await api.setComputerEnabled(sessionId, next)
    // 请求期间切到了别的会话：结果属于旧会话，不写进当前状态条
    if (computerAgent.sessionId !== sessionId) return result.enabled
    computerAgent.enabled = result.enabled
    computerAgent.state = result.state
    if (!result.enabled) hideLater(1500)
    return result.enabled
  } finally {
    computerAgent.busy = false
  }
}

/** 桌面端推来的一步活动 */
export function recordComputerActivity(activity: { action: string }): void {
  if (!computerAgent.enabled) return
  clearHide()
  if (!computerAgent.visible) computerAgent.step = 0
  computerAgent.step += 1
  computerAgent.action = activity.action
  if (computerAgent.state !== 'paused') computerAgent.state = 'running'
  computerAgent.pauseReason = ''
  computerAgent.visible = true
}

/** 急停 / 用户动了鼠标（服务端同时收到同一事件并改了状态） */
export function recordComputerEvent(event: { event: 'stop' | 'pause'; reason: string }): void {
  if (!computerAgent.enabled) return
  computerAgent.visible = true
  if (event.event === 'stop') {
    computerAgent.state = 'stopped'
    computerAgent.pauseReason = ''
    hideLater(4000)
  } else {
    computerAgent.state = 'paused'
    computerAgent.pauseReason = event.reason
    clearHide()
  }
}

export function computerRunEnded(sessionId: string): void {
  if (!computerAgent.visible || sessionId !== computerAgent.sessionId) return
  if (computerAgent.state === 'paused') return // 暂停中等用户继续，不收起
  // 运行已结束：“正在操作电脑”不能久留（真 Electron 验证时完成后还挂着 4 秒，像还在动）
  hideLater(1200)
}

export async function controlComputer(action: api.BrowserControlAction): Promise<void> {
  const sessionId = computerAgent.sessionId
  if (!sessionId || computerAgent.busy) return
  computerAgent.busy = true
  try {
    const result = await api.computerControl(sessionId, action)
    if (computerAgent.sessionId !== sessionId) return
    computerAgent.state = result.state
    computerAgent.pauseReason = ''
    if (result.state === 'stopped') hideLater(3000)
    else clearHide()
  } finally {
    computerAgent.busy = false
  }
}

/** 测试用 */
export function resetComputerAgent(): void {
  clearHide()
  loadSeq += 1
  Object.assign(computerAgent, {
    sessionId: '',
    available: false,
    enabled: false,
    state: 'running',
    visible: false,
    step: 0,
    action: '',
    pauseReason: '',
    busy: false,
  })
}
