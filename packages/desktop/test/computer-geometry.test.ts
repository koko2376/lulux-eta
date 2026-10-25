import { describe, expect, it } from 'vitest'
import {
  ComputerGeometryError,
  dipToNative,
  fitWidth,
  imageToDip,
  movedTooFar,
  nativeToImage,
  parseKeys,
} from '../src/computer-geometry'

const BOUNDS = { x: 100, y: 50, width: 1600, height: 900 }

function codeOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    return error instanceof ComputerGeometryError ? error.code : 'OTHER'
  }
  return 'NO_ERROR'
}

describe('imageToDip', () => {
  it('把截图坐标按显示器 bounds 等比换算并取整', () => {
    expect(imageToDip(0, 0, BOUNDS, 800, 450)).toEqual({ x: 100, y: 50 })
    expect(imageToDip(799, 449, BOUNDS, 800, 450)).toEqual({ x: 1698, y: 948 })
    expect(imageToDip(400, 225, BOUNDS, 800, 450)).toEqual({ x: 900, y: 500 })
    // 1280 宽的图对应同一块屏
    expect(imageToDip(640, 360, BOUNDS, 1280, 720)).toEqual({ x: 900, y: 500 })
  })

  it('越界 / 非有限数 / 非法尺寸都抛 BAD_ARGS', () => {
    expect(codeOf(() => imageToDip(-1, 10, BOUNDS, 800, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(800, 10, BOUNDS, 800, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(10, 450, BOUNDS, 800, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(Number.NaN, 10, BOUNDS, 800, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(10, Number.POSITIVE_INFINITY, BOUNDS, 800, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(10, 10, BOUNDS, 0, 450))).toBe('BAD_ARGS')
    expect(codeOf(() => imageToDip(10, 10, { ...BOUNDS, width: -5 }, 800, 450))).toBe('BAD_ARGS')
  })
})

describe('dipToNative', () => {
  it('win32 用 dipToScreenPoint（物理像素）', () => {
    const seen: Array<{ x: number; y: number }> = []
    const result = dipToNative({ x: 10, y: 20 }, 'win32', 2, (point) => {
      seen.push(point)
      return { x: point.x * 2, y: point.y * 2 }
    })
    expect(seen).toEqual([{ x: 10, y: 20 }])
    expect(result).toEqual({ x: 20, y: 40 })
  })

  it('win32 没给 dipToScreenPoint 抛 BAD_ARGS', () => {
    expect(codeOf(() => dipToNative({ x: 1, y: 2 }, 'win32', 1))).toBe('BAD_ARGS')
  })

  it('darwin 原样使用 DIP（CoreGraphics point）', () => {
    expect(dipToNative({ x: 12, y: 34 }, 'darwin', 2)).toEqual({ x: 12, y: 34 })
  })

  it('linux 乘 scaleFactor 取整', () => {
    expect(dipToNative({ x: 11, y: 21 }, 'linux', 1.5)).toEqual({ x: 17, y: 32 })
    expect(dipToNative({ x: 11, y: 21 }, 'linux', 2)).toEqual({ x: 22, y: 42 })
    // scaleFactor 非法按 1 处理
    expect(dipToNative({ x: 5, y: 6 }, 'linux', 0)).toEqual({ x: 5, y: 6 })
  })
})

describe('nativeToImage', () => {
  it('linux：物理像素反算截图坐标', () => {
    expect(nativeToImage({ x: 200, y: 100 }, BOUNDS, 800, 450, 'linux', 2)).toEqual({ x: 0, y: 0 })
    expect(nativeToImage({ x: 1800, y: 1000 }, BOUNDS, 800, 450, 'linux', 2)).toEqual({ x: 400, y: 225 })
  })

  it('darwin：DIP 直接反算', () => {
    expect(nativeToImage({ x: 900, y: 500 }, BOUNDS, 800, 450, 'darwin', 2)).toEqual({ x: 400, y: 225 })
  })

  it('win32：用 screenToDipPoint 换算', () => {
    const result = nativeToImage({ x: 1800, y: 1000 }, BOUNDS, 800, 450, 'win32', 2, (point) => ({
      x: point.x / 2,
      y: point.y / 2,
    }))
    expect(result).toEqual({ x: 400, y: 225 })
  })

  it('光标不在该屏上返回 null', () => {
    expect(nativeToImage({ x: 0, y: 0 }, BOUNDS, 800, 450, 'darwin', 1)).toBeNull()
    expect(nativeToImage({ x: 1800, y: 500 }, BOUNDS, 800, 450, 'darwin', 1)).toBeNull()
    expect(nativeToImage({ x: 900, y: 1000 }, BOUNDS, 800, 450, 'darwin', 1)).toBeNull()
  })
})

describe('fitWidth', () => {
  it('超宽等比缩到 1280，保持比例', () => {
    expect(fitWidth(3840, 2160)).toEqual({ width: 1280, height: 720 })
    expect(fitWidth(2560, 1600, 1280)).toEqual({ width: 1280, height: 800 })
    expect(fitWidth(3000, 1000, 1000)).toEqual({ width: 1000, height: 333 })
  })

  it('不超宽时原样返回（取整）', () => {
    expect(fitWidth(1280, 800)).toEqual({ width: 1280, height: 800 })
    expect(fitWidth(800.4, 450.6)).toEqual({ width: 800, height: 451 })
  })

  it('非法尺寸抛 BAD_ARGS', () => {
    expect(codeOf(() => fitWidth(0, 100))).toBe('BAD_ARGS')
    expect(codeOf(() => fitWidth(100, Number.NaN))).toBe('BAD_ARGS')
  })
})

describe('parseKeys', () => {
  it('映射修饰键到 robotjs 名', () => {
    expect(parseKeys('ctrl+shift+t', 'win32')).toEqual({ key: 't', modifiers: ['control', 'shift'] })
    expect(parseKeys('Ctrl+Alt+Delete', 'linux')).toEqual({ key: 'delete', modifiers: ['control', 'alt'] })
    expect(parseKeys('enter', 'linux')).toEqual({ key: 'enter', modifiers: [] })
  })

  it("'mod' 在 mac 上是 command，其他平台是 control", () => {
    expect(parseKeys('mod+s', 'darwin')).toEqual({ key: 's', modifiers: ['command'] })
    expect(parseKeys('mod+s', 'win32')).toEqual({ key: 's', modifiers: ['control'] })
    expect(parseKeys('mod+s', 'linux')).toEqual({ key: 's', modifiers: ['control'] })
  })

  it('cmd / win / meta / super 都映射成 command', () => {
    for (const alias of ['cmd', 'win', 'meta', 'super']) {
      expect(parseKeys(`${alias}+a`, 'win32')).toEqual({ key: 'a', modifiers: ['command'] })
    }
  })

  it('字母数字、f1-f24、方向键与常见符号', () => {
    expect(parseKeys('F12', 'linux')).toEqual({ key: 'f12', modifiers: [] })
    expect(parseKeys('f24', 'linux')).toEqual({ key: 'f24', modifiers: [] })
    expect(parseKeys('up', 'linux')).toEqual({ key: 'up', modifiers: [] })
    expect(parseKeys('pagedown', 'linux')).toEqual({ key: 'pagedown', modifiers: [] })
    expect(parseKeys('esc', 'linux')).toEqual({ key: 'escape', modifiers: [] })
    expect(parseKeys('shift+7', 'linux')).toEqual({ key: '7', modifiers: ['shift'] })
    expect(parseKeys('ctrl+plus', 'linux')).toEqual({ key: '+', modifiers: ['control'] })
    expect(parseKeys('ctrl+/', 'linux')).toEqual({ key: '/', modifiers: ['control'] })
  })

  it('非法键名 / 修饰键 / 空值抛 BAD_ARGS', () => {
    expect(codeOf(() => parseKeys('ctrl+nope', 'linux'))).toBe('BAD_ARGS')
    expect(codeOf(() => parseKeys('hyper+a', 'linux'))).toBe('BAD_ARGS')
    expect(codeOf(() => parseKeys('', 'linux'))).toBe('BAD_ARGS')
    expect(codeOf(() => parseKeys('ctrl+', 'linux'))).toBe('BAD_ARGS')
    expect(codeOf(() => parseKeys(42, 'linux'))).toBe('BAD_ARGS')
    expect(codeOf(() => parseKeys('f25', 'linux'))).toBe('BAD_ARGS')
  })
})

describe('movedTooFar', () => {
  it('默认阈值 8 像素', () => {
    expect(movedTooFar({ x: 100, y: 100 }, { x: 108, y: 100 })).toBe(false)
    expect(movedTooFar({ x: 100, y: 100 }, { x: 109, y: 100 })).toBe(true)
    expect(movedTooFar({ x: 100, y: 100 }, { x: 100, y: 92 })).toBe(false)
    expect(movedTooFar({ x: 100, y: 100 }, { x: 100, y: 89 })).toBe(true)
  })

  it('可指定阈值；缺一个位置时为 false', () => {
    expect(movedTooFar({ x: 0, y: 0 }, { x: 3, y: 0 }, 2)).toBe(true)
    expect(movedTooFar(null, { x: 0, y: 0 })).toBe(false)
    expect(movedTooFar({ x: 0, y: 0 }, null)).toBe(false)
  })
})
