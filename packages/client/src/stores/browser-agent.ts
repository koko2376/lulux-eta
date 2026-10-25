import { reactive } from 'vue'
import * as api from '../api'

/**
 * Agent 操作内置浏览器时的状态条（docs/browser-use.md「界面」）。
 * 数据源是桌面端的 onAgentActivity（每执行一步推一次，带发起的会话 id）；
 * 「我来接管 / 继续 / 停止」经 POST /api/sessions/:id/browser/control 通知服务端。
 */
export type BrowserAgentState = 'running' | 'paused' | 'stopped'

export interface BrowserAgentActivity {
  action: string
  url: string
  sessionId?: string
}

export const browserAgent = reactive({
  visible: false,
  sessionId: '',
  step: 0,
  action: '',
  url: '',
  state: 'running' as BrowserAgentState,
  busy: false,
})

let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

function hideLater(ms: number): void {
  clearHide()
  hideTimer = setTimeout(() => {
    hideTimer = null
    browserAgent.visible = false
    browserAgent.step = 0
  }, ms)
}

/** 收到一步活动：同一会话累加步数，换了会话从 1 开始 */
export function recordBrowserActivity(activity: BrowserAgentActivity): void {
  const sessionId = activity.sessionId ?? ''
  clearHide()
  if (!browserAgent.visible || sessionId !== browserAgent.sessionId) {
    browserAgent.step = 0
    browserAgent.state = 'running'
  }
  browserAgent.sessionId = sessionId
  browserAgent.step += 1
  browserAgent.action = activity.action
  browserAgent.url = activity.url
  if (browserAgent.state === 'stopped') browserAgent.state = 'running'
  browserAgent.visible = true
}

/** 运行结束（或会话不再运行）：几秒后收起状态条 */
export function browserRunEnded(sessionId: string): void {
  if (!browserAgent.visible || sessionId !== browserAgent.sessionId) return
  if (browserAgent.state === 'paused') browserAgent.state = 'running'
  hideLater(5000)
}

export async function controlBrowserAgent(action: api.BrowserControlAction): Promise<void> {
  const sessionId = browserAgent.sessionId
  if (!sessionId || browserAgent.busy) return
  browserAgent.busy = true
  try {
    await api.browserControl(sessionId, action)
    if (browserAgent.sessionId !== sessionId) return
    browserAgent.state = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped'
    if (action === 'stop') hideLater(3000)
    else clearHide()
  } finally {
    browserAgent.busy = false
  }
}

/** 测试用 */
export function resetBrowserAgent(): void {
  clearHide()
  Object.assign(browserAgent, { visible: false, sessionId: '', step: 0, action: '', url: '', state: 'running', busy: false })
}
