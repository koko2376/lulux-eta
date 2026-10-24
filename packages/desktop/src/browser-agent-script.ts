/**
 * Agent 操作内置浏览器：注入网页的脚本 + 返回值整理。
 *
 * 与 pick-script.ts 一样不依赖 electron，主进程（browser-agent.ts）与单测共用。
 * 注入脚本由下面这些函数的源码拼成，所以它们必须自包含：不引用模块里的其他导出
 * （CommonJS 编译会改写成 exports.x），需要的辅助函数一律通过参数传入。
 */

export const REF_ATTR = 'data-lulux-ref'
export const REF_TOKEN_KEY = '__luluxRefToken'
export const NAME_LIMIT = 80
/** 风险关键词匹配用的名称长度上限（只给服务端判定，不进快照文本） */
export const RISK_NAME_LIMIT = 400
export const HIGHLIGHT_COLOR = '#6fc3f0'
/** 高亮总时长（毫秒）：最后 300ms 淡出 */
export const HIGHLIGHT_MS = 1200
export const DEFAULT_MAX_ITEMS = 200
export const DEFAULT_MAX_CHARS = 20_000
export const MAX_SCREENSHOT_WIDTH = 1280

export type ScriptErrorCode = 'REF_STALE' | 'REF_NOT_FOUND' | 'PASSWORD_FIELD' | 'BAD_ARGS' | 'FAILED'

/** 注入脚本的失败结果（以数据形式返回，由主进程转成错误） */
export interface ScriptFailure {
  ok: false
  code: ScriptErrorCode
  message: string
}

/** describe 的返回 */
export interface ElementInfo {
  ref: number
  tag: string
  role: string
  name: string
  type: string
  href: string
  inForm: boolean
  formAction: string
  isPassword: boolean
  disabled: boolean
  /** 风险判定用的较长名称（≤ RISK_NAME_LIMIT）：避免把关键词挤出 80 字截断窗口绕过审批 */
  riskName?: string
}

/** snapshot 里的一个元素 */
export interface SnapshotItem {
  ref: number
  tag: string
  role: string
  name: string
  type: string
  href: string
  placeholder: string
  value: string
  checked: boolean
  isPassword: boolean
  disabled: boolean
}

/** snapshot 注入脚本的返回值 */
export interface SnapshotData {
  url: string
  title: string
  docToken: string
  items: SnapshotItem[]
  headings: string[]
  truncated: boolean
}

export interface ScrollState {
  scrollY: number
  scrollHeight: number
  viewportHeight: number
}

export interface PageText {
  url: string
  title: string
  text: string
  truncated: boolean
}

/* ── 纯函数：校验网页返回值 ───────────────────────────── */

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 网页上下文返回的 snapshot 不可信：逐字段校验、截断 */
export function sanitizeSnapshot(raw: unknown): SnapshotData | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const docToken = text(value.docToken, 80)
  if (!docToken) return null
  const items: SnapshotItem[] = []
  if (Array.isArray(value.items)) {
    for (const entry of value.items) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const ref = finite(item.ref)
      if (ref === null || ref <= 0) continue
      const isPassword = item.isPassword === true
      items.push({
        ref: Math.floor(ref),
        tag: text(item.tag, 40),
        role: text(item.role, 40),
        name: text(item.name, NAME_LIMIT),
        type: text(item.type, 40),
        href: text(item.href, 500),
        placeholder: text(item.placeholder, 200),
        // 密码框的值一律不读
        value: isPassword ? '' : text(item.value, 300),
        checked: item.checked === true,
        isPassword,
        disabled: item.disabled === true,
      })
    }
  }
  const headings: string[] = []
  if (Array.isArray(value.headings)) {
    for (const heading of value.headings) {
      if (typeof heading !== 'string') continue
      const clean = heading.replace(/\s+/g, ' ').trim()
      if (clean) headings.push(clean.slice(0, 120))
      if (headings.length >= 20) break
    }
  }
  return {
    url: text(value.url, 2000),
    title: text(value.title, 300),
    docToken,
    items,
    headings,
    truncated: value.truncated === true,
  }
}

/** 校验 describe / actionPrep 返回的元素信息 */
export function sanitizeElementInfo(raw: unknown, fallbackRef = 0): ElementInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const ref = finite(value.ref)
  return {
    ref: ref !== null && ref > 0 ? Math.floor(ref) : fallbackRef,
    tag: text(value.tag, 40),
    role: text(value.role, 40),
    name: text(value.name, NAME_LIMIT),
    type: text(value.type, 40),
    href: text(value.href, 500),
    inForm: value.inForm === true,
    formAction: text(value.formAction, 500),
    isPassword: value.isPassword === true,
    disabled: value.disabled === true,
    riskName: text(value.riskName, RISK_NAME_LIMIT),
  }
}

export function sanitizeScroll(raw: unknown): ScrollState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const scrollY = finite(value.scrollY)
  const scrollHeight = finite(value.scrollHeight)
  const viewportHeight = finite(value.viewportHeight)
  if (scrollY === null || scrollHeight === null || viewportHeight === null) return null
  return { scrollY, scrollHeight, viewportHeight }
}

export function sanitizePageText(raw: unknown): PageText | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.text !== 'string') return null
  return {
    url: text(value.url, 2000),
    title: text(value.title, 300),
    text: value.text,
    truncated: value.truncated === true,
  }
}

/** 脚本失败结果 → 错误码；结构不对返回 null */
export function classifyFailure(raw: unknown): ScriptFailure | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.ok !== false) return null
  const code = value.code
  const known: ScriptErrorCode[] = ['REF_STALE', 'REF_NOT_FOUND', 'PASSWORD_FIELD', 'BAD_ARGS', 'FAILED']
  const message = typeof value.message === 'string' && value.message ? value.message.slice(0, 500) : '页面操作失败'
  return {
    ok: false,
    code: known.includes(code as ScriptErrorCode) ? (code as ScriptErrorCode) : 'FAILED',
    message,
  }
}

/* ── 纯函数：snapshot 文本格式 ─────────────────────────── */

/** 名字里的双引号换成单引号，保证一行一个元素的格式可读 */
function quoteName(name: string): string {
  return name.replace(/"/g, "'")
}

/** 按 docs/browser-use.md 的格式把 snapshot 拼成文本 */
export function formatSnapshot(raw: SnapshotData): string {
  const lines: string[] = []
  const title = raw.title.trim()
  lines.push(title && title !== raw.url ? `# ${title} — ${raw.url}` : `# ${raw.url}`)
  for (const heading of raw.headings) lines.push(`## ${heading}`)
  for (const item of raw.items) {
    let line = `[${item.ref}] ${item.role || item.tag}`
    if (item.name) line += ` "${quoteName(item.name)}"`
    if (item.href) line += ` → ${item.href}`
    if (item.placeholder) line += ` (placeholder: ${item.placeholder})`
    if (item.value) line += ` = "${item.value.replace(/"/g, "'")}"`
    if (item.checked) line += ' [checked]'
    if (item.disabled) line += ' [disabled]'
    if (item.isPassword) line += ' (password — Agent 不可读写)'
    lines.push(line)
  }
  return lines.join('\n')
}

/* ── 以下函数会以源码形式注入网页，必须自包含 ─────────── */

/** snapshot 收集的可交互元素（文档顺序） */
export function interactiveSelector(): string {
  return [
    'a[href]',
    'area[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[role="option"]',
    '[onclick]',
  ].join(',')
}

/** 元素可见：自身与祖先都不是 display:none / visibility:hidden、也不是 hidden，且有尺寸 */
export function elementVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false
  let node: Element | null = el
  while (node && node.nodeType === 1) {
    if (node.hasAttribute('hidden')) return false
    const style = window.getComputedStyle(node)
    if (style) {
      if (style.display === 'none') return false
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
      if (node === el && style.opacity !== '' && Number(style.opacity) === 0) return false
    }
    node = node.parentElement
  }
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * 密码框：type=password，或 autocomplete 标明是密码（current-password / new-password / one-time-code），
 * 很多登录页用 type=text + autocomplete=current-password 自绘遮罩，也必须不读不写。
 */
export function elementIsPassword(el: Element): boolean {
  const tag = String(el.tagName || '').toLowerCase()
  if (tag !== 'input') return false
  if (String((el as HTMLInputElement).type || '').toLowerCase() === 'password') return true
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/)
  return tokens.includes('current-password') || tokens.includes('new-password') || tokens.includes('one-time-code')
}

function attr(el: Element, name: string, all = false): string {
  if (all) return (el.getAttribute(name) || '').trim()
  return (el.getAttribute(name) || '').trim()
}

/** 角色：显式 role 优先，否则按标签 / type 推断 */
export function elementRole(el: Element): string {
  const explicit = attr(el, 'role').split(/\s+/)[0]
  if (explicit) return explicit
  const tag = String(el.tagName || '').toLowerCase()
  const type = tag === 'input' ? String((el as HTMLInputElement).type || 'text').toLowerCase() : ''
  if (tag === 'a' || tag === 'area') return 'link'
  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return 'textbox'
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button'
    if (type === 'range') return 'slider'
    return 'textbox'
  }
  return tag || 'element'
}

/** 名称：aria-label / aria-labelledby / label[for] / placeholder / innerText / title / alt / value，≤ limit 字 */
export function elementName(el: Element, limit: number): string {
  const clean = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const candidates: string[] = []
  candidates.push(attr(el, 'aria-label'))
  const labelledBy = attr(el, 'aria-labelledby')
  if (labelledBy) {
    candidates.push(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' '),
    )
  }
  const id = attr(el, 'id')
  if (id) {
    const label = document.querySelector(`label[for="${id.replace(/["\\]/g, '\\$&')}"]`)
    if (label) candidates.push(label.textContent || '')
  }
  const wrapping = el.closest ? el.closest('label') : null
  if (wrapping) candidates.push(wrapping.textContent || '')
  candidates.push(attr(el, 'placeholder'))
  const inner = (el as HTMLElement).innerText || el.textContent || ''
  candidates.push(inner)
  candidates.push(attr(el, 'title'))
  candidates.push(attr(el, 'alt'))
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'input' && !elementIsPassword(el)) {
    const type = String((el as HTMLInputElement).type || '').toLowerCase()
    if (type === 'button' || type === 'submit' || type === 'reset') candidates.push(attr(el, 'value'))
    if (type === 'image') candidates.push(attr(el, 'value'))
  }
  if (tag === 'option') candidates.push(attr(el, 'label'))
  for (const candidate of candidates) {
    const name = clean(candidate)
    if (name) return name.slice(0, limit)
  }
  return ''
}

export function findRefElement(ref: number, refAttr: string): Element | null {
  if (!Number.isFinite(ref) || ref <= 0) return null
  return document.querySelector(`[${refAttr}="${Math.floor(ref)}"]`)
}

/** describe / snapshot 共用的元素信息 */
export function elementInfo(el: Element, ref: number, h: { nameLimit: number; roleOf: (el: Element) => string; isPassword: (el: Element) => boolean }): ElementInfo {
  const tag = String(el.tagName || '').toLowerCase()
  const type = tag === 'input' ? String((el as HTMLInputElement).type || 'text').toLowerCase() : ''
  const form = (el as HTMLInputElement).form || (el.closest ? (el.closest('form') as HTMLFormElement | null) : null)
  const formAction = form ? attr(form, 'action') : ''
  const href = tag === 'a' || tag === 'area' ? attr(el, 'href') : ''
  const formAttribute = attr(el, 'formaction')
  return {
    ref,
    tag,
    role: h.roleOf(el),
    name: elementName(el, h.nameLimit),
    type,
    href,
    inForm: Boolean(form),
    formAction: formAttribute || formAction,
    isPassword: h.isPassword(el),
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
    riskName: elementName(el, 400),
  }
}

/** 收集 snapshot 需要的元素信息（含 placeholder / value / checked） */
export function snapshotItem(
  el: Element,
  ref: number,
  h: { nameLimit: number; roleOf: (el: Element) => string; isPassword: (el: Element) => boolean; infoOf: (el: Element, ref: number) => ElementInfo },
): SnapshotItem {
  const info = h.infoOf(el, ref)
  const tag = info.tag
  let value = ''
  const textTypes = ['', 'text', 'search', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time']
  if (!info.isPassword) {
    if (tag === 'textarea') value = String((el as HTMLTextAreaElement).value ?? '')
    else if (tag === 'input' && textTypes.indexOf(String((el as HTMLInputElement).type || '').toLowerCase()) >= 0) {
      value = String((el as HTMLInputElement).value ?? '')
    } else if (tag === 'select') {
      const option = (el as HTMLSelectElement).selectedOptions?.[0]
      value = option ? (option.textContent || '').replace(/\s+/g, ' ').trim() : ''
    }
  }
  return {
    ...info,
    placeholder: attr(el, 'placeholder').slice(0, 200),
    value: value.slice(0, 300),
    checked: tag === 'input' ? (el as HTMLInputElement).checked === true : el.getAttribute('aria-checked') === 'true',
  }
}

/** 在网页里运行：清掉旧编号，按文档顺序给可见可交互元素编号，返回快照 */
export function snapshotInPage(maxItems: number, h: {
  refAttr: string
  tokenKey: string
  selector: string
  nameLimit: number
  roleOf: (el: Element) => string
  isPassword: (el: Element) => boolean
  visible: (el: Element) => boolean
  infoOf: (el: Element, ref: number) => ElementInfo
  itemOf: (el: Element, ref: number) => SnapshotItem
}): SnapshotData {
  const doc = document
  for (const stale of Array.from(doc.querySelectorAll(`[${h.refAttr}]`))) stale.removeAttribute(h.refAttr)
  const token =
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36)
  ;(window as unknown as Record<string, unknown>)[h.tokenKey] = token

  const items: SnapshotItem[] = []
  let truncated = false
  const all = Array.from(doc.querySelectorAll(h.selector))
  for (const el of all) {
    if (!h.visible(el)) continue
    // 拾取 / 高亮覆盖层不是页面内容
    if (el.hasAttribute('data-lulux-pick') || el.hasAttribute('data-lulux-highlight')) continue
    if (items.length >= maxItems) {
      truncated = true
      break
    }
    const ref = items.length + 1
    el.setAttribute(h.refAttr, String(ref))
    items.push(h.itemOf(el, ref))
  }

  const headings: string[] = []
  for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3'))) {
    if (headings.length >= 20) break
    if (!h.visible(heading)) continue
    const label = (heading.textContent || '').replace(/\s+/g, ' ').trim()
    if (label) headings.push(label.slice(0, 120))
  }

  return { url: location.href, title: doc.title || '', docToken: token, items, headings, truncated }
}

/** 画 1.2s 淡蓝描边高亮（不拦截点击、不影响布局） */
export function highlightElement(el: Element, h: { color: string; durationMs: number }): void {
  const rect = el.getBoundingClientRect()
  const layer = document.createElement('div')
  layer.setAttribute('data-lulux-highlight', '')
  layer.style.cssText =
    `position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;` +
    `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    `border:2px solid ${h.color};border-radius:3px;box-shadow:0 0 0 2px rgba(111,195,240,.28);` +
    `transition:opacity .3s ease;`
  document.documentElement.appendChild(layer)
  window.setTimeout(() => {
    layer.style.opacity = '0'
  }, Math.max(0, h.durationMs - 300))
  window.setTimeout(() => layer.remove(), h.durationMs)
}

interface RefHelpers {
  refAttr: string
  tokenKey: string
  color?: string
  durationMs?: number
  nameLimit?: number
  roleOf: (el: Element) => string
  isPassword: (el: Element) => boolean
  findRef: (ref: number, attr: string) => Element | null
  infoOf: (el: Element, ref: number) => ElementInfo
  highlight?: (el: Element) => void
}

/** ref + docToken → 元素；失败时返回错误结果 */
export function resolveRefInPage(
  ref: number,
  docToken: string,
  h: RefHelpers,
  options: { password?: boolean; highlight?: boolean } = {},
): { ok: true; el: Element; info: ElementInfo } | ScriptFailure {
  const token = (window as unknown as Record<string, unknown>)[h.tokenKey]
  if (!token || token !== docToken) return { ok: false, code: 'REF_STALE', message: '页面已变化，请重新 snapshot' }
  const el = h.findRef(ref, h.refAttr)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `找不到元素 [${ref}]，请重新 snapshot` }
  if (options.password !== true && h.isPassword(el)) {
    return { ok: false, code: 'PASSWORD_FIELD', message: '密码框不允许 Agent 操作' }
  }
  const info = h.infoOf(el, Math.floor(ref))
  return { ok: true, el, info }
}

/** describe：只读，不滚动、不高亮 */
export function describeInPage(ref: number, docToken: string, h: RefHelpers): ElementInfo | ScriptFailure {
  const token = (window as unknown as Record<string, unknown>)[h.tokenKey]
  if (!token || token !== docToken) return { ok: false, code: 'REF_STALE', message: '页面已变化，请重新 snapshot' }
  const el = h.findRef(ref, h.refAttr)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `找不到元素 [${ref}]，请重新 snapshot` }
  return h.infoOf(el, Math.floor(ref))
}

/** 点击 / 输入前的准备：滚动到居中、画高亮、返回中心 CSS 坐标 */
export function actionPrepInPage(
  ref: number,
  docToken: string,
  h: RefHelpers,
): { ok: true; x: number; y: number; element: ElementInfo } | ScriptFailure {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' })
  const rect = el.getBoundingClientRect()
  h.highlight?.(el)
  return {
    ok: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    element: resolved.info,
  }
}

/** 清空输入框（clear）或只聚焦 */
export function focusInPage(ref: number, docToken: string, clear: boolean, h: RefHelpers): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el
  ;(el as HTMLElement).focus?.()
  if (clear) {
    const input = el as HTMLInputElement
    if ('value' in el) input.value = ''
    const setter = nativeValueSetter(el)
    if (setter) {
      try {
        setter.call(el, '')
      } catch {
        // 非输入元素忽略
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { ok: true }
}

function nativeValueSetter(el: Element): ((this: Element, value: string) => void) | null {
  const proto = Object.getPrototypeOf(el)
  if (!proto) return null
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  return descriptor && typeof descriptor.set === 'function' ? (descriptor.set as (this: Element, value: string) => void) : null
}

/** 写入输入框的值（textarea / 普通 input；密码框已在 resolve 时拒绝） */
export function setValueInPage(ref: number, docToken: string, value: string, h: RefHelpers, append = false): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'select') {
    return { ok: false, code: 'BAD_ARGS', message: '下拉框请使用 select' }
  }
  if ('value' in el) {
    const setter = nativeValueSetter(el)
    if (append) value = String((el as HTMLInputElement).value ?? '') + value
    el.value = value
    if (setter) {
      try {
        setter.call(el, value)
      } catch {
        // 忽略：直接赋值已经生效
      }
    }
  } else {
    return { ok: false, code: 'FAILED', message: '元素不支持输入' }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

/** 浏览器面板没显示（视图没挂到窗口上，收不到鼠标事件）时的点击：直接触发元素的 click() */
export function clickInPage(ref: number, docToken: string, h: RefHelpers): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el as HTMLElement
  if (typeof el.click !== 'function') return { ok: false, code: 'FAILED', message: '元素不支持点击' }
  el.click()
  return { ok: true }
}

/**
 * 鼠标点击前布置探针：目标元素（或其子元素）收到 click 时记一笔。点击后读 window 上的标记，
 * 没收到说明鼠标事件没落到元素上（被遮挡、视图未合成等），由调用方改用 click() 兜底。
 */
export function armClickProbeInPage(ref: number, docToken: string, h: RefHelpers): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const w = window as unknown as Record<string, unknown>
  w.__luluxClickHit = false
  resolved.el.addEventListener(
    'click',
    () => {
      w.__luluxClickHit = true
    },
    { once: true, capture: true },
  )
  return { ok: true }
}

/** 面板没显示时的“输入后提交”：优先提交所在表单，否则派发回车 */
export function submitInPage(ref: number, docToken: string, h: RefHelpers): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el as HTMLInputElement
  const form = el.form
  if (form) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.submit()
    return { ok: true }
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  }
  return { ok: true }
}

/** 下拉框：按 option 的 value 或可见文本选中，派发 input/change */
export function selectInPage(ref: number, docToken: string, value: string, h: RefHelpers): ScriptFailure | { ok: true } {
  const resolved = resolveRefInPage(ref, docToken, h)
  if (resolved.ok !== true) return resolved
  const el = resolved.el
  if (String(el.tagName || '').toLowerCase() !== 'select') {
    return { ok: false, code: 'FAILED', message: '元素不是下拉框' }
  }
  const select = el as HTMLSelectElement
  const options = Array.from(select.options || [])
  const target =
    options.find((option) => option.value === value) ||
    options.find((option) => (option.textContent || '').replace(/\s+/g, ' ').trim() === value)
  if (!target) return { ok: false, code: 'FAILED', message: `下拉框里没有 "${value}"` }
  select.value = target.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

/** 滚动：amount 为视口高度倍数 */
export function scrollInPage(direction: string, amount: number): ScrollState {
  const delta = (direction === 'up' ? -1 : 1) * amount * window.innerHeight
  window.scrollBy({ top: delta, left: 0 })
  const doc = document.documentElement
  return {
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
    viewportHeight: window.innerHeight,
  }
}

/** 页面可见正文 */
export function readTextInPage(maxChars: number): PageText {
  const body = document.body
  const raw = body ? body.innerText || body.textContent || '' : ''
  let text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = text.length > maxChars
  if (truncated) text = text.slice(0, maxChars)
  return { url: location.href, title: document.title || '', text, truncated }
}

/** 等待文字出现（主进程轮询调用） */
export function waitTextInPage(needle: string): { found: boolean } {
  const body = document.body
  const raw = body ? body.innerText || body.textContent || '' : ''
  return { found: needle ? raw.includes(needle) : true }
}

/* ── 拼注入脚本 ───────────────────────────────────────── */

/**
 * 被注入函数引用的模块内辅助函数。注入后必须同名（函数体按名字查找），
 * 所以这里用 const 逐个重建，而不是额外传参。
 */
function pagePrelude(): string {
  return [
    `const attr = ${attr.toString()};`,
    `const elementName = ${elementName.toString()};`,
    `const elementIsPassword = ${elementIsPassword.toString()};`,
    `const elementRole = ${elementRole.toString()};`,
    `const elementVisible = ${elementVisible.toString()};`,
    `const findRefElement = ${findRefElement.toString()};`,
    `const elementInfo = ${elementInfo.toString()};`,
    `const snapshotItem = ${snapshotItem.toString()};`,
    `const snapshotInPage = ${snapshotInPage.toString()};`,
    `const describeInPage = ${describeInPage.toString()};`,
    `const actionPrepInPage = ${actionPrepInPage.toString()};`,
    `const resolveRefInPage = ${resolveRefInPage.toString()};`,
    `const focusInPage = ${focusInPage.toString()};`,
    `const setValueInPage = ${setValueInPage.toString()};`,
    `const nativeValueSetter = ${nativeValueSetter.toString()};`,
    `const selectInPage = ${selectInPage.toString()};`,
    `const clickInPage = ${clickInPage.toString()};`,
    `const armClickProbeInPage = ${armClickProbeInPage.toString()};`,
    `const submitInPage = ${submitInPage.toString()};`,
    `const scrollInPage = ${scrollInPage.toString()};`,
    `const readTextInPage = ${readTextInPage.toString()};`,
    `const waitTextInPage = ${waitTextInPage.toString()};`,
    `const highlightElement = ${highlightElement.toString()};`,
    `const interactiveSelector = ${interactiveSelector.toString()};`,
  ].join('\n  ')
}

function pageHelpersSource(): string {
  return `{
    refAttr: ${JSON.stringify(REF_ATTR)},
    tokenKey: ${JSON.stringify(REF_TOKEN_KEY)},
    color: ${JSON.stringify(HIGHLIGHT_COLOR)},
    durationMs: ${HIGHLIGHT_MS},
    nameLimit: ${NAME_LIMIT},
    roleOf: elementRole,
    isPassword: elementIsPassword,
    visible: elementVisible,
    findRef: findRefElement,
    infoOf: function (el, ref) { return elementInfo(el, ref, helpers); },
    itemOf: function (el, ref) { return snapshotItem(el, ref, helpers); },
    highlight: function (el) { highlightElement(el, helpers); },
  }`
}

function wrapScript(body: string): string {
  return `(() => {
  ${pagePrelude()}
  const helpers = ${pageHelpersSource()};
  ${body}
})()`
}

/** snapshot：重新编号所有可见可交互元素，返回 { url, title, docToken, items, headings, truncated } */
export function snapshotScript(maxItems = DEFAULT_MAX_ITEMS): string {
  const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : DEFAULT_MAX_ITEMS
  return wrapScript(`return snapshotInPage(${limit}, Object.assign({ selector: interactiveSelector() }, helpers));`)
}

/** describe：只读元素信息（密码框只标记 isPassword） */
export function describeScript(ref: number, docToken: string): string {
  return wrapScript(`return describeInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, helpers);`)
}

/** 点击 / 输入前：滚动居中 + 1.2s 高亮，返回元素中心 CSS 坐标 */
export function actionPrepScript(ref: number, docToken: string): string {
  return wrapScript(`return actionPrepInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, helpers);`)
}

/** 聚焦输入框，clear=true 时先清空并派发 input/change */
export function focusScript(ref: number, docToken: string, clear: boolean): string {
  return wrapScript(`return focusInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, ${clear}, helpers);`)
}

/** 面板未显示时的 DOM 点击 */
export function clickScript(ref: number, docToken: string): string {
  return wrapScript(`return clickInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, helpers);`)
}

/** 鼠标点击前布置探针 */
export function armClickProbeScript(ref: number, docToken: string): string {
  return wrapScript(`return armClickProbeInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, helpers);`)
}

/** 读探针：鼠标点击是否落到了元素上 */
export const CLICK_PROBE_READ = 'window.__luluxClickHit'

/** 面板未显示时的表单提交 */
export function submitScript(ref: number, docToken: string): string {
  return wrapScript(`return submitInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, helpers);`)
}

/** 写入输入框的值 */
export function setValueScript(ref: number, docToken: string, value: string, append = false): string {
  return wrapScript(
    `return setValueInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, ${JSON.stringify(value)}, helpers, ${append ? 'true' : 'false'});`,
  )
}

/** 下拉框选择：按 option value 或可见文本匹配，派发 input/change */
export function selectScript(ref: number, docToken: string, value: string): string {
  return wrapScript(`return selectInPage(${Math.floor(ref)}, ${JSON.stringify(docToken)}, ${JSON.stringify(value)}, helpers);`)
}

/** 滚动窗口：direction 为 'up' | 'down'，amount 是视口高度倍数 */
export function scrollScript(direction: 'up' | 'down', amount = 0.8): string {
  const times = Number.isFinite(amount) && amount > 0 ? amount : 0.8
  return wrapScript(`return scrollInPage(${JSON.stringify(direction)}, ${times});`)
}

/** 读取可见正文，最多 maxChars 字 */
export function textScript(maxChars = DEFAULT_MAX_CHARS): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS
  return wrapScript(`return readTextInPage(${limit});`)
}

/** 页面上是否出现了指定文字 */
export function waitTextScript(text: string): string {
  return wrapScript(`return waitTextInPage(${JSON.stringify(text)});`)
}
