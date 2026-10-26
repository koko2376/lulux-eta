import { reactive } from 'vue'

/**
 * Agent 页左侧会话列表的收起 / 展开（全局一个状态，记在 localStorage）。
 * 与右侧面板“按会话记住”的展开状态（lulux.panel.<accountId>.<sessionId>）互不相干。
 */
export const SIDEBAR_COLLAPSED_KEY = 'lulux.agent.sidebarCollapsed'

function read(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export const agentSidebar = reactive({ collapsed: read() })

export function setSidebarCollapsed(collapsed: boolean): void {
  agentSidebar.collapsed = collapsed
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
  } catch {
    // 存储不可用：只在内存里
  }
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!agentSidebar.collapsed)
}

/** Ctrl+B（macOS ⌘B）：不带 Shift / Alt；输入法组字中不算 */
export function isSidebarShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false
  const mod = event.metaKey || event.ctrlKey
  return mod && (event.key === 'b' || event.key === 'B' || event.code === 'KeyB')
}
