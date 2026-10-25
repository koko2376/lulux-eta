import { describe, expect, it, vi } from 'vitest'
import { defaultPrefs } from '../src/desktop-prefs'

vi.mock('electron', () => ({ app: { isPackaged: false }, Menu: {}, nativeImage: {}, Tray: class {} }))
vi.mock('../src/menu', () => ({ tr: (key: string) => key }))

describe('没有托盘宿主的桌面：不把窗口藏进看不见的托盘', () => {
  it('Linux 默认关闭“关窗到托盘”；Windows 默认开；macOS 按系统习惯', () => {
    expect(defaultPrefs('linux').closeToTray).toBe(false)
    expect(defaultPrefs('win32').closeToTray).toBe(true)
    expect(defaultPrefs('darwin').closeToTray).toBe(false)
  })
  it('会话总线上托盘 Watcher 没有所有者 → 确定没有托盘；命令都不可用 → 未知', async () => {
    const { linuxTrayHostPresent, parseNameHasOwner } = await import('../src/tray')
    expect(parseNameHasOwner('method return time=1\n   boolean false\n')).toBe(false)
    expect(parseNameHasOwner('(true,)\n')).toBe(true)
    expect(await linuxTrayHostPresent(async () => '   boolean false')).toBe(false)
    expect(await linuxTrayHostPresent(async (file) => (file === 'gdbus' ? '(true,)' : Promise.reject(new Error('ENOENT'))))).toBe(true)
    expect(await linuxTrayHostPresent(async () => Promise.reject(new Error('ENOENT')))).toBeNull()
  })
  it('标记没有宿主后 hasTray() 为 false', async () => {
    const tray = await import('../src/tray')
    tray.markTrayHostMissing()
    expect(tray.hasTray()).toBe(false)
  })
})
