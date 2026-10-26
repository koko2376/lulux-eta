/**
 * 界面缩放（设置里的 90% / 110% / 125%）：appearance.ts 在 <html> 上设置了 CSS zoom。
 *
 * Chromium 里 CSS zoom 的行为：
 * - getBoundingClientRect()、MouseEvent 的 clientX / clientY、window.innerWidth / innerHeight
 *   都是**视觉像素**（已经乘过 zoom）；
 * - 写到 zoom 根元素内部元素上的 left / top / width 还会再乘一次 zoom。
 * 所以把 rect / clientX 直接当作 fixed 弹层的 left / top 会偏移 zoom 倍，需要先除以 zoom 换成 CSS 像素。
 */

/** 读取 <html> 上生效的 zoom；解析失败、空值、非正数时按 1 处理 */
export function getUiZoom(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 1
  const computed = window.getComputedStyle?.(document.documentElement) as
    (CSSStyleDeclaration & { zoom?: string }) | undefined
  const value = Number.parseFloat(String(computed?.zoom ?? ''))
  return Number.isFinite(value) && value > 0 ? value : 1
}

export interface CssRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** 视觉像素的矩形 → CSS 像素（可直接用于 fixed 元素的 left / top / width / height） */
export function toCssRect(rect: CssRect): CssRect {
  const zoom = getUiZoom()
  return {
    left: rect.left / zoom,
    top: rect.top / zoom,
    right: rect.right / zoom,
    bottom: rect.bottom / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  }
}

/** 视觉像素的坐标（鼠标事件 clientX / clientY）→ CSS 像素 */
export function toCssPoint(x: number, y: number): { x: number; y: number } {
  const zoom = getUiZoom()
  return { x: x / zoom, y: y / zoom }
}

/** 视口尺寸：window.innerWidth / innerHeight 是视觉像素，换算成 CSS 像素用于夹取 fixed 弹层 */
export function viewportCss(): { width: number; height: number } {
  return { width: window.innerWidth / getUiZoom(), height: window.innerHeight / getUiZoom() }
}
