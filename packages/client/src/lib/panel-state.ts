/**
 * 会话右侧面板（详情 / 产物 / 浏览器）的展开状态，按账号 + 会话记在 localStorage：
 * lulux.panel.<accountId>.<sessionId> = 'detail' | 'artifacts' | 'browser' | 'none'。
 * 键里带账号 id：云端模式多人共用同一浏览器时互不影响；每个账号只保留最近 MAX_SESSIONS 个会话的状态。
 * 没记过的会话默认展开详情；窄屏（浮层模式）不读不写，保持默认收起。
 */
import { auth } from './session'

export type PanelId = 'detail' | 'artifacts' | 'browser'
const PANELS: readonly string[] = ['detail', 'artifacts', 'browser']
export const MAX_SESSIONS = 200

function accountId(): string {
  return auth.me?.user?.id || 'local'
}

export function panelKey(sessionId: string, account: string = accountId()): string {
  return `lulux.panel.${account}.${sessionId}`
}

/** 该账号记过状态的会话（最近的在最后），用来裁剪 */
function orderKey(account: string): string {
  return `lulux.panel.${account}.__order`
}

/** 读取某会话的面板状态；没有记录 / 读取失败时为默认（详情） */
export function loadPanel(sessionId: string | null | undefined, fallback: PanelId | null = 'detail'): PanelId | null {
  if (!sessionId) return fallback
  try {
    const value = window.localStorage.getItem(panelKey(sessionId))
    if (value === 'none') return null
    if (value && PANELS.includes(value)) return value as PanelId
  } catch {
    /* 隐私模式等：按默认 */
  }
  return fallback
}

export function savePanel(sessionId: string | null | undefined, panel: PanelId | null): void {
  if (!sessionId) return
  try {
    const storage = window.localStorage
    const account = accountId()
    storage.setItem(panelKey(sessionId, account), panel ?? 'none')
    // 旧格式（不分账号）的键：顺手删掉
    storage.removeItem(`lulux.panel.${sessionId}`)
    let order: string[] = []
    try {
      const parsed: unknown = JSON.parse(storage.getItem(orderKey(account)) ?? '[]')
      if (Array.isArray(parsed)) order = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      order = []
    }
    order = [...order.filter((id) => id !== sessionId), sessionId]
    while (order.length > MAX_SESSIONS) storage.removeItem(panelKey(order.shift()!, account))
    storage.setItem(orderKey(account), JSON.stringify(order))
  } catch {
    /* 存不了就算了 */
  }
}
