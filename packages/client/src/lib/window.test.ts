import { describe, expect, it } from 'vitest'
import { chromeFor, detectPlatform, shouldHandleTitleBarDoubleClick } from './window'

describe('标题栏按平台', () => {
  it('mac 用原生红绿灯，Windows / Linux 右上角自绘按钮，浏览器不画', () => {
    expect(chromeFor('darwin', true)).toBe('mac')
    expect(chromeFor('win32', true)).toBe('win')
    expect(chromeFor('linux', true)).toBe('win')
    expect(chromeFor('win32', false)).toBe('none')
    expect(chromeFor('', false)).toBe('none')
  })
  it('平台优先读新 preload window.lulux，旧版回退 luluxAgent，都没有为空', () => {
    expect(detectPlatform({ lulux: { platform: 'win32' } } as unknown as Window)).toBe('win32')
    expect(detectPlatform({ luluxAgent: { platform: 'darwin' } } as unknown as Window)).toBe('darwin')
    expect(detectPlatform({} as Window)).toBe('')
    expect(detectPlatform(undefined)).toBe('')
  })
  it('双击标题栏只在 doubleClickMaximizeNative=false 时由界面切换最大化（契约 §9.1）', () => {
    const w = (native?: boolean) =>
      ({
        lulux: {
          platform: 'linux',
          titleBar: native === undefined ? undefined : { doubleClickMaximizeNative: native },
          win: {},
        },
      }) as unknown as Window
    expect(shouldHandleTitleBarDoubleClick(w(false))).toBe(true)
    expect(shouldHandleTitleBarDoubleClick(w(true))).toBe(false)
    expect(shouldHandleTitleBarDoubleClick(w(undefined))).toBe(false)
    expect(shouldHandleTitleBarDoubleClick({ luluxAgent: { window: {} } } as unknown as Window)).toBe(false)
    expect(shouldHandleTitleBarDoubleClick(undefined)).toBe(false)
  })
})
