import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLanguagePref, LOCALE_NAMES, LOCALES, setLanguage } from './index'

/** 界面语言偏好：首次启动默认简体中文（不看系统语言）；桌面端 localStorage 丢失时用主进程保存的那份 */
afterEach(() => {
  localStorage.clear()
  delete (globalThis as { lulux?: unknown }).lulux
  vi.restoreAllMocks()
  setLanguage('zh-CN')
  localStorage.clear()
})

describe('界面语言偏好', () => {
  it('首次启动：系统语言是英文也默认简体中文', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    expect(loadLanguagePref()).toBe('zh-CN')
  })

  it('页面存储为空（桌面端换了端口）：用主进程保存的偏好；页面里有的优先', () => {
    ;(globalThis as { lulux?: unknown }).lulux = { languagePref: 'en' }
    expect(loadLanguagePref()).toBe('en')
    localStorage.setItem('lulux.language', 'zh-CN')
    expect(loadLanguagePref()).toBe('zh-CN')
    ;(globalThis as { lulux?: unknown }).lulux = { languagePref: 'bogus' }
    localStorage.clear()
    expect(loadLanguagePref()).toBe('zh-CN')
  })

  it('切换语言：写入同一个偏好，并把偏好（含“跟随系统”）交给桌面主进程保存', () => {
    const bridge = { setLanguage: vi.fn() }
    ;(globalThis as { lulux?: unknown }).lulux = bridge
    setLanguage('en')
    expect(localStorage.getItem('lulux.language')).toBe('en')
    expect(bridge.setLanguage).toHaveBeenLastCalledWith('en')
    setLanguage('system')
    expect(bridge.setLanguage).toHaveBeenLastCalledWith('system')
  })

  it('登录页的选项就是应用自带的全部语言', () => {
    expect(LOCALES).toEqual(Object.keys(LOCALE_NAMES))
  })
})
