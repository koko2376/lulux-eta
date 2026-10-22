import { afterEach, describe, expect, it } from 'vitest'
import { focusComposer, isTypingTarget, matchesQuery, matchShortcut, shortcutRows } from './shortcuts'

function key(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const { target, ...rest } = init
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest })
  if (target) Object.defineProperty(event, 'target', { value: target })
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('matchShortcut', () => {
  it('Ctrl/⌘+K 打开面板；Ctrl/⌘+Shift+O 新对话；Ctrl/⌘+/ 帮助', () => {
    expect(matchShortcut(key({ key: 'k', ctrlKey: true }))).toBe('palette')
    expect(matchShortcut(key({ key: 'k', metaKey: true }))).toBe('palette')
    expect(matchShortcut(key({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))).toBe('newChat')
    expect(matchShortcut(key({ key: '/', ctrlKey: true }))).toBe('help')
  })

  it('Ctrl/⌘+N 只在桌面应用里算新对话（浏览器会占用）', () => {
    expect(matchShortcut(key({ key: 'n', ctrlKey: true }), { desktop: true })).toBe('newChat')
    expect(matchShortcut(key({ key: 'n', ctrlKey: true }), { desktop: false })).toBeNull()
  })

  it('/ 聚焦输入框、? 打开帮助，但正在输入时不拦截', () => {
    const div = document.createElement('div')
    expect(matchShortcut(key({ key: '/', target: div }))).toBe('focusComposer')
    expect(matchShortcut(key({ key: '?', shiftKey: true, target: div }))).toBe('help')
    for (const tag of ['input', 'textarea', 'select']) {
      const el = document.createElement(tag)
      expect(matchShortcut(key({ key: '/', target: el })), tag).toBeNull()
      expect(matchShortcut(key({ key: '?', target: el })), tag).toBeNull()
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    expect(matchShortcut(key({ key: '/', target: editable }))).toBeNull()
  })

  it('带修饰键的组合在输入框里也生效', () => {
    const textarea = document.createElement('textarea')
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, target: textarea }))).toBe('palette')
  })

  it('输入法组字、重复按键、Alt 组合、已被处理的事件不算', () => {
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, isComposing: true }))).toBeNull()
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, repeat: true }))).toBeNull()
    expect(matchShortcut(key({ key: 'k', ctrlKey: true, altKey: true }))).toBeNull()
    const handled = key({ key: 'k', ctrlKey: true })
    handled.preventDefault()
    expect(matchShortcut(handled)).toBeNull()
    expect(matchShortcut(key({ key: 'b', ctrlKey: true }))).toBeNull()
    expect(matchShortcut(key({ key: 'a' }))).toBeNull()
  })
})

describe('辅助函数', () => {
  it('isTypingTarget：按钮 / 复选框不算输入', () => {
    const button = document.createElement('input')
    button.type = 'checkbox'
    expect(isTypingTarget(button)).toBe(false)
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(null)).toBe(false)
  })

  it('快捷键列表按平台显示 ⌘ / Ctrl，桌面版多一个 Ctrl+N', () => {
    const mac = shortcutRows(true, true)
    expect(mac[0]!.keys).toEqual([['⌘', 'K']])
    expect(mac.find((r) => r.label === 'shortcuts.newChat')!.keys).toEqual([['⌘', 'N'], ['⌘', '⇧', 'O']])
    const web = shortcutRows(false, false)
    expect(web.find((r) => r.label === 'shortcuts.newChat')!.keys).toEqual([['Ctrl', 'Shift', 'O']])
    expect(web.find((r) => r.label === 'shortcuts.toggleSidebar')!.keys).toEqual([['Ctrl', 'B']])
  })

  it('focusComposer 聚焦输入框并把光标放到末尾', () => {
    expect(focusComposer()).toBe(false)
    const ta = document.createElement('textarea')
    ta.setAttribute('data-composer-input', '')
    ta.value = 'hello'
    document.body.appendChild(ta)
    expect(focusComposer()).toBe(true)
    expect(document.activeElement).toBe(ta)
    expect(ta.selectionStart).toBe(5)
  })

  it('matchesQuery：多个词都要出现，不区分大小写', () => {
    expect(matchesQuery('Acme Valves GmbH', 'acme gmbh')).toBe(true)
    expect(matchesQuery('Acme Valves GmbH', 'acme pumps')).toBe(false)
    expect(matchesQuery('anything', '  ')).toBe(true)
  })
})
