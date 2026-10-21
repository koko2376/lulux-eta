/**
 * 内置浏览器“框选 / 元素”拾取：注入网页的覆盖层脚本 + 坐标换算。
 *
 * 不依赖 electron，主进程（browser.ts）与单测共用。注入脚本由下面几个函数的源码拼成，
 * 所以这些函数必须自包含：不引用模块里的其他导出（CommonJS 编译会改写成 exports.x），
 * 需要的辅助函数一律通过参数传入。
 */

export type PickMode = 'region' | 'element'

/** 网页视口里的矩形（CSS 像素） */
export interface PickRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PickElementInfo {
  tag: string
  id: string
  classes: string[]
  selector: string
  /** 元素文字，空白折叠，≤300 字 */
  text: string
}

/** 注入脚本的返回值（来自网页上下文，主进程使用前需再校验） */
export interface PickPageResult {
  mode: PickMode
  rect: PickRect
  viewport: { width: number; height: number }
  element: PickElementInfo | null
}

export const PICK_TEXT_LIMIT = 300
/** 拖动小于这个尺寸视为点击（区域模式下改为选中指针下的元素） */
export const MIN_DRAG = 6

/** 两个拖动端点 → 规范化矩形（宽高为正） */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number): PickRect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/** 裁到视口内；裁完不足 1px 返回 null */
export function clampRect(rect: PickRect, viewport: { width: number; height: number }): PickRect | null {
  const left = Math.max(0, Math.min(rect.x, viewport.width))
  const top = Math.max(0, Math.min(rect.y, viewport.height))
  const right = Math.max(0, Math.min(rect.x + rect.width, viewport.width))
  const bottom = Math.max(0, Math.min(rect.y + rect.height, viewport.height))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 网页 CSS 像素 → webContents.capturePage 的矩形（DIP）。
 * 页面缩放 zoomFactor 时 1 CSS px = zoomFactor DIP；devicePixelRatio 由 capturePage 自己处理
 *（返回的图像是物理像素，宽 ≈ DIP × scaleFactor）。结果取整（向外扩，不丢边缘像素）并裁到视图尺寸内。
 */
export function toCaptureRect(
  rect: PickRect,
  zoomFactor: number,
  viewSize: { width: number; height: number },
): PickRect | null {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  const left = Math.max(0, Math.floor(rect.x * zoom))
  const top = Math.max(0, Math.floor(rect.y * zoom))
  const right = Math.min(Math.floor(viewSize.width), Math.ceil((rect.x + rect.width) * zoom))
  const bottom = Math.min(Math.floor(viewSize.height), Math.ceil((rect.y + rect.height) * zoom))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 截图过大时缩小到的宽度（物理像素）；返回 null 表示不用缩 */
export function downscaleWidth(width: number, max = 2000): number | null {
  return width > max ? max : null
}

/* ── 以下函数会以源码形式注入网页，必须自包含 ── */

interface ElementLike {
  tagName: string
  id?: string
  classList?: ArrayLike<string>
  parentElement: ElementLike | null
  children?: ArrayLike<ElementLike>
}

/**
 * 简短的 CSS 选择器路径：遇到合法 id 停止；每层 tag + 至多 2 个“像样的”class，
 * 同名兄弟多于一个时补 :nth-of-type；最多 maxDepth 层，不含 html / body。
 */
export function cssPath(el: ElementLike | null, maxDepth = 5): string {
  const parts: string[] = []
  const goodId = /^[A-Za-z][\w-]{0,63}$/
  const goodClass = /^[A-Za-z_][\w-]{0,39}$/
  let node: ElementLike | null = el
  while (node && parts.length < maxDepth) {
    const tag = String(node.tagName || '').toLowerCase()
    if (!tag || tag === 'html' || tag === 'body') break
    const id = node.id || ''
    if (id && goodId.test(id)) {
      parts.unshift(`#${id}`)
      break
    }
    let part = tag
    const classes = Array.from(node.classList ?? [])
      .filter((name) => goodClass.test(name) && !/\d{3,}/.test(name))
      .slice(0, 2)
    for (const name of classes) part += `.${name}`
    const parent: ElementLike | null = node.parentElement
    if (parent?.children) {
      const same = Array.from(parent.children).filter((child) => String(child.tagName).toLowerCase() === tag)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

/** 元素摘要（tag / id / class / 选择器 / 文字） */
export function describeElement(
  el: (ElementLike & { innerText?: string; textContent?: string | null }) | null,
  path: (el: ElementLike | null, maxDepth?: number) => string,
  limit = 300,
): PickElementInfo | null {
  if (!el) return null
  const raw = (typeof el.innerText === 'string' && el.innerText) || el.textContent || ''
  return {
    tag: String(el.tagName || '').toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList ?? []).slice(0, 8),
    selector: path(el),
    text: raw.replace(/\s+/g, ' ').trim().slice(0, limit),
  }
}

interface PickHelpers {
  normalizeRect: typeof normalizeRect
  clampRect: typeof clampRect
  cssPath: typeof cssPath
  describeElement: typeof describeElement
  minDrag: number
  textLimit: number
  labels: { region: string; element: string }
}

/**
 * 在网页里运行：画全屏透明覆盖层，区域模式拖框、元素模式悬停高亮 + 点击；Esc 取消。
 * 结束时先移除覆盖层、等两帧（截图里不带覆盖层）再 resolve。
 */
export function pickInPage(mode: PickMode, h: PickHelpers): Promise<PickPageResult | null> {
  const w = window as unknown as Window & { __luluxPickCancel?: () => void }
  w.__luluxPickCancel?.()
  return new Promise((resolve) => {
    const doc = document
    const Z = '2147483647'
    const layer = doc.createElement('div')
    layer.setAttribute('data-lulux-pick', '')
    layer.style.cssText = `position:fixed;inset:0;z-index:${Z};cursor:crosshair;background:rgba(15,23,42,.06);user-select:none;-webkit-user-select:none;`
    const box = doc.createElement('div')
    box.setAttribute('data-lulux-pick', '')
    box.style.cssText = `position:fixed;z-index:${Z};pointer-events:none;display:none;border:2px solid #2f9ae2;background:rgba(47,154,226,.14);border-radius:2px;box-sizing:border-box;`
    const tip = doc.createElement('div')
    tip.setAttribute('data-lulux-pick', '')
    tip.textContent = mode === 'region' ? h.labels.region : h.labels.element
    tip.style.cssText = `position:fixed;z-index:${Z};pointer-events:none;top:10px;left:50%;transform:translateX(-50%);padding:5px 12px;border-radius:999px;background:rgba(17,24,39,.86);color:#fff;font:12px/1.5 system-ui,sans-serif;`
    const root = doc.documentElement
    root.appendChild(layer)
    root.appendChild(box)
    root.appendChild(tip)

    const viewport = (): { width: number; height: number } => ({ width: w.innerWidth, height: w.innerHeight })
    const isOurs = (node: Element): boolean => node.hasAttribute('data-lulux-pick')
    const elementAt = (x: number, y: number, within?: { x: number; y: number; width: number; height: number }): Element | null => {
      const stack = doc.elementsFromPoint(x, y).filter((node) => !isOurs(node))
      const meaningful = stack.filter((node) => node !== doc.documentElement && node !== doc.body)
      if (within) {
        // 区域模式：选中心点下最小的、能包住整个选区的元素；没有就取最上层的元素
        const tol = 2
        const container = meaningful.find((node) => {
          const r = node.getBoundingClientRect()
          return r.left <= within.x + tol && r.top <= within.y + tol && r.right >= within.x + within.width - tol && r.bottom >= within.y + within.height - tol
        })
        if (container) return container
      }
      return meaningful[0] ?? stack[0] ?? null
    }
    const show = (r: { x: number; y: number; width: number; height: number } | null): void => {
      if (!r) {
        box.style.display = 'none'
        return
      }
      box.style.display = 'block'
      box.style.left = `${r.x}px`
      box.style.top = `${r.y}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
    }
    const rectOf = (node: Element): { x: number; y: number; width: number; height: number } => {
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }

    let start: { x: number; y: number } | null = null
    let done = false
    const finish = (result: PickPageResult | null): void => {
      if (done) return
      done = true
      w.removeEventListener('keydown', onKey, true)
      layer.remove()
      box.remove()
      tip.remove()
      if (w.__luluxPickCancel === cancel) delete w.__luluxPickCancel
      // 等覆盖层真正从画面上消失再交给主进程截图
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)))
    }
    const cancel = (): void => finish(null)
    const pickElement = (node: Element | null): void => {
      if (!node) return finish(null)
      const rect = h.clampRect(rectOf(node), viewport())
      if (!rect) return finish(null)
      finish({ mode, rect, viewport: viewport(), element: h.describeElement(node as never, h.cssPath, h.textLimit) })
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    w.__luluxPickCancel = cancel
    w.addEventListener('keydown', onKey, true)

    layer.addEventListener('mousedown', (event) => {
      event.preventDefault()
      if (event.button !== 0) return cancel()
      if (mode === 'region') {
        start = { x: event.clientX, y: event.clientY }
        show({ x: start.x, y: start.y, width: 0, height: 0 })
      }
    })
    layer.addEventListener('mousemove', (event) => {
      if (mode === 'region') {
        if (start) show(h.normalizeRect(start.x, start.y, event.clientX, event.clientY))
        return
      }
      const node = elementAt(event.clientX, event.clientY)
      show(node ? rectOf(node) : null)
    })
    layer.addEventListener('mouseup', (event) => {
      event.preventDefault()
      if (mode === 'element') return pickElement(elementAt(event.clientX, event.clientY))
      if (!start) return
      const drag = h.normalizeRect(start.x, start.y, event.clientX, event.clientY)
      start = null
      if (drag.width < h.minDrag && drag.height < h.minDrag) return pickElement(elementAt(event.clientX, event.clientY))
      const rect = h.clampRect(drag, viewport())
      if (!rect) return finish(null)
      const node = elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2, rect)
      finish({ mode, rect, viewport: viewport(), element: h.describeElement(node as never, h.cssPath, h.textLimit) })
    })
    layer.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      cancel()
    })
  })
}

/** 拼出注入脚本（executeJavaScript 会等待返回的 Promise） */
export function pickScript(mode: PickMode, labels: { region: string; element: string }): string {
  const helpers = [
    `normalizeRect: ${normalizeRect.toString()}`,
    `clampRect: ${clampRect.toString()}`,
    `cssPath: ${cssPath.toString()}`,
    `describeElement: ${describeElement.toString()}`,
    `minDrag: ${MIN_DRAG}`,
    `textLimit: ${PICK_TEXT_LIMIT}`,
    `labels: ${JSON.stringify(labels)}`,
  ]
  return `(${pickInPage.toString()})(${JSON.stringify(mode)}, { ${helpers.join(', ')} })`
}

export const CANCEL_PICK_SCRIPT = 'void (window.__luluxPickCancel && window.__luluxPickCancel())'

/** 网页上下文返回的数据不可信：校验数字、截断字符串 */
export function sanitizePickResult(raw: unknown, mode: PickMode): PickPageResult | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const r = (value.rect ?? {}) as Record<string, unknown>
  const vp = (value.viewport ?? {}) as Record<string, unknown>
  const x = num(r.x)
  const y = num(r.y)
  const width = num(r.width)
  const height = num(r.height)
  const vw = num(vp.width)
  const vh = num(vp.height)
  if (x === null || y === null || width === null || height === null || vw === null || vh === null) return null
  if (width <= 0 || height <= 0 || vw <= 0 || vh <= 0) return null
  let element: PickElementInfo | null = null
  if (value.element && typeof value.element === 'object') {
    const e = value.element as Record<string, unknown>
    element = {
      tag: str(e.tag, 40),
      id: str(e.id, 120),
      classes: Array.isArray(e.classes) ? e.classes.filter((c): c is string => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 60)) : [],
      selector: str(e.selector, 400),
      text: str(e.text, PICK_TEXT_LIMIT),
    }
  }
  return { mode, rect: { x, y, width, height }, viewport: { width: vw, height: vh }, element }
}
