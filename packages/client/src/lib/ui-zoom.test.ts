import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiZoom, toCssPoint, toCssRect, viewportCss } from './ui-zoom'

/** jsdom 不实现 CSS zoom 的计算值：用内联 style.zoom 模拟（和 applyAppearance 的写法一致） */
function mockZoom(value: string | undefined): void {
  if (value === undefined) document.documentElement.style.removeProperty('zoom')
  else document.documentElement.style.zoom = value
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ zoom: value }) as unknown as CSSStyleDeclaration)
}

function mockViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty('zoom')
})

describe('界面缩放下 fixed 弹层的坐标换算', () => {
  it('getUiZoom 读 <html> 上生效的 zoom', () => {
    mockZoom('1.25')
    expect(getUiZoom()).toBe(1.25)
    expect(window.getComputedStyle).toHaveBeenCalledWith(document.documentElement)
    mockZoom('0.9')
    expect(getUiZoom()).toBe(0.9)
  })

  it('zoom 为 1 / 空值 / normal / 非正数时兜底为 1', () => {
    mockZoom('1')
    expect(getUiZoom()).toBe(1)
    mockZoom(undefined)
    expect(getUiZoom()).toBe(1)
    mockZoom('')
    expect(getUiZoom()).toBe(1)
    mockZoom('normal')
    expect(getUiZoom()).toBe(1)
    mockZoom('0')
    expect(getUiZoom()).toBe(1)
    mockZoom('-1.25')
    expect(getUiZoom()).toBe(1)
  })

  it('toCssRect 把视觉像素的矩形除以 zoom，六个字段都换', () => {
    mockZoom('1.25')
    const rect = { left: 250, top: 125, right: 500, bottom: 375, width: 250, height: 250 }
    expect(toCssRect(rect)).toEqual({ left: 200, top: 100, right: 400, bottom: 300, width: 200, height: 200 })
  })

  it('toCssRect 在 100% 时原样返回（不复制成同一对象也可以）', () => {
    mockZoom('1')
    const rect = new DOMRect(10, 20, 30, 40)
    expect(toCssRect(rect)).toEqual({ left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 })
  })

  it('toCssPoint 把 clientX / clientY 除以 zoom', () => {
    mockZoom('1.25')
    expect(toCssPoint(250, 125)).toEqual({ x: 200, y: 100 })
    mockZoom('0.9')
    expect(toCssPoint(90, 45)).toEqual({ x: 100, y: 50 })
  })

  it('viewportCss 把 innerWidth / innerHeight 除以 zoom', () => {
    mockZoom('1.25')
    mockViewport(1600, 1000)
    expect(viewportCss()).toEqual({ width: 1280, height: 800 })
    mockZoom('1')
    mockViewport(1440, 900)
    expect(viewportCss()).toEqual({ width: 1440, height: 900 })
  })
})
