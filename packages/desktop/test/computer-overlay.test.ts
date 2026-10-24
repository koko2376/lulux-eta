import { describe, expect, it, vi } from 'vitest'
import { ComputerOverlay, EDGE, overlayPieces } from '../src/computer-overlay'

describe('computer overlay', () => {
  it('每块屏四条边 + 一个小条，刚好贴边、不重叠', () => {
    const pieces = overlayPieces({ x: -1920, y: 0, width: 1920, height: 1080 }, 'win32')
    expect(pieces).toHaveLength(5)
    const [top, bottom, left, right, hint] = pieces
    expect(top!.rect).toEqual({ x: -1920, y: 0, width: 1920, height: EDGE })
    expect(bottom!.rect.y + bottom!.rect.height).toBe(1080)
    expect(left!.rect.y).toBe(EDGE)
    expect(right!.rect.x + right!.rect.width).toBe(0)
    expect(hint!.kind).toBe('hint')
    expect(hint!.rect.x).toBeGreaterThan(-1920)
    expect(hint!.rect.x + hint!.rect.width).toBeLessThan(0)
  })

  it('窗口不透明（Linux 无合成器也不会黑屏）、点击穿透、不进截图；hide 全部关闭', () => {
    const made: any[] = []
    const overlay = new ComputerOverlay({
      platform: 'linux',
      displays: () => [{ bounds: { x: 0, y: 0, width: 800, height: 600 } }, { bounds: { x: 800, y: 0, width: 800, height: 600 } }],
      createWindow: (options) => {
        const w = {
          options,
          setAlwaysOnTop: vi.fn(), setContentProtection: vi.fn(), setIgnoreMouseEvents: vi.fn(),
          setVisibleOnAllWorkspaces: vi.fn(), loadURL: vi.fn(() => Promise.resolve()), showInactive: vi.fn(),
          isDestroyed: () => false, close: vi.fn(),
        }
        made.push(w)
        return w as any
      },
    })
    overlay.show()
    expect(made).toHaveLength(10)
    for (const w of made) {
      expect(w.options.transparent).toBeUndefined()
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
      expect(w.setContentProtection).toHaveBeenCalledWith(true)
    }
    expect(made.filter((w) => w.loadURL.mock.calls.length > 0)).toHaveLength(2)
    overlay.hide()
    for (const w of made) expect(w.close).toHaveBeenCalled()
  })
})

describe('提示条文字', () => {
  it('有急停快捷键时写快捷键；被占用时改成在 LULUX 里点停止', async () => {
    const { overlayHint, overlayHtml } = await import('../src/computer-overlay')
    expect(overlayHint('win32')).toContain('Ctrl+Alt+Shift+K')
    expect(overlayHint('darwin')).toContain('⌘⌥⇧K')
    expect(overlayHint('linux', false)).not.toMatch(/Ctrl|⌘/)
    expect(overlayHtml('win32', false)).toContain('点“停止”')
  })
})
