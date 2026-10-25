import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSidebar,
  isSidebarShortcut,
  setSidebarCollapsed,
  SIDEBAR_COLLAPSED_KEY,
  toggleSidebar,
} from './agent-sidebar'

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('Agent 页左侧会话列表收起', () => {
  afterEach(() => {
    setSidebarCollapsed(false)
    localStorage.clear()
  })

  it('切换后记在 localStorage，展开时清掉', () => {
    expect(agentSidebar.collapsed).toBe(false)
    toggleSidebar()
    expect(agentSidebar.collapsed).toBe(true)
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1')
    toggleSidebar()
    expect(agentSidebar.collapsed).toBe(false)
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull()
  })

  it('快捷键：Ctrl+B / ⌘B；带 Shift、Alt 或输入法组字中不算', () => {
    expect(isSidebarShortcut(key({ key: 'b', ctrlKey: true }))).toBe(true)
    expect(isSidebarShortcut(key({ key: 'b', metaKey: true }))).toBe(true)
    expect(isSidebarShortcut(key({ key: 'B', ctrlKey: true }))).toBe(true)
    expect(isSidebarShortcut(key({ key: 'b' }))).toBe(false)
    expect(isSidebarShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isSidebarShortcut(key({ key: 'b', ctrlKey: true, altKey: true }))).toBe(false)
    expect(isSidebarShortcut(key({ key: 'b', ctrlKey: true, isComposing: true }))).toBe(false)
    expect(isSidebarShortcut(key({ key: 'k', ctrlKey: true }))).toBe(false)
  })
})
