import { reactive } from 'vue'

/**
 * 全局快捷键：
 * - Ctrl/⌘+K：搜索 / 命令面板（跳转到客户、报价、订单、会话、页面，执行操作）
 * - Ctrl/⌘+Shift+O：新对话；桌面版另有 Ctrl/⌘+N（浏览器里 Ctrl+N 会被浏览器占用，不拦截）
 * - /：聚焦消息输入框（正在输入时不触发）
 * - Ctrl/⌘+/ 或 ?：快捷键帮助（? 在正在输入时不触发）
 * - Ctrl/⌘+B：收起 / 展开会话列表（在 Agent 页处理，见 agent-sidebar.ts）
 */

export type ShortcutAction = 'palette' | 'newChat' | 'focusComposer' | 'help'

export const shortcutUi = reactive({ palette: false, help: false })

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad/i.test(platform)
}

/** 运行在桌面应用（Electron）里：Ctrl/⌘+N 不会被浏览器占用 */
export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && (Boolean(window.lulux) || Boolean(window.luluxAgent))
}

/** 焦点在可输入的元素上（输入框、多行文本、下拉框、可编辑区域） */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type)
  }
  return Boolean(el.closest('[contenteditable="true"], [contenteditable=""]'))
}

function keyIs(event: KeyboardEvent, letter: string): boolean {
  return event.key.toLowerCase() === letter || event.code === `Key${letter.toUpperCase()}`
}

/**
 * 把按键映射成动作；不认识或不该处理时返回 null。
 * 带 Ctrl/⌘ 的组合在输入框里也生效（不会和打字冲突）；单键（/、?）只在没有在输入时生效。
 */
export function matchShortcut(event: KeyboardEvent, opts: { desktop?: boolean } = {}): ShortcutAction | null {
  if (event.isComposing || event.defaultPrevented || event.repeat) return null
  const mod = event.metaKey || event.ctrlKey
  if (mod && !event.altKey) {
    if (!event.shiftKey && keyIs(event, 'k')) return 'palette'
    if (event.shiftKey && keyIs(event, 'o')) return 'newChat'
    if (!event.shiftKey && keyIs(event, 'n') && (opts.desktop ?? isDesktopApp())) return 'newChat'
    if (event.key === '/' || event.code === 'Slash') return 'help'
    return null
  }
  if (event.altKey || mod) return null
  if (isTypingTarget(event.target)) return null
  if (event.key === '/' && !event.shiftKey) return 'focusComposer'
  if (event.key === '?') return 'help'
  return null
}

export interface ShortcutRow {
  /** 按键序列，每一项是一个键帽 */
  keys: string[][]
  /** i18n 键（shortcuts.*） */
  label: string
}

/** 帮助里列出的快捷键（按平台显示 ⌘ 或 Ctrl） */
export function shortcutRows(mac = isMac(), desktop = isDesktopApp()): ShortcutRow[] {
  const m = mac ? '⌘' : 'Ctrl'
  const shift = mac ? '⇧' : 'Shift'
  return [
    { keys: [[m, 'K']], label: 'shortcuts.palette' },
    { keys: desktop ? [[m, 'N'], [m, shift, 'O']] : [[m, shift, 'O']], label: 'shortcuts.newChat' },
    { keys: [['/']], label: 'shortcuts.focusComposer' },
    { keys: [[m, 'B']], label: 'shortcuts.toggleSidebar' },
    { keys: [[m, '/'], ['?']], label: 'shortcuts.help' },
    { keys: [['Enter']], label: 'shortcuts.send' },
    { keys: [[shift, 'Enter']], label: 'shortcuts.newline' },
    { keys: [['Esc']], label: 'shortcuts.close' },
  ]
}

/** 聚焦消息输入框；没有输入框时返回 false */
export function focusComposer(): boolean {
  const input = document.querySelector<HTMLTextAreaElement>('[data-composer-input]')
  if (!input || input.disabled) return false
  input.focus()
  const end = input.value.length
  input.setSelectionRange?.(end, end)
  return true
}

/** 命令面板的模糊匹配：所有词都出现在文本里（不区分大小写） */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = text.toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}
