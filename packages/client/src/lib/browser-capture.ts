import { ref } from 'vue'
import { t } from '../i18n'

/**
 * 内置浏览器的框选 / 元素拾取 → 会话输入框。
 * BrowserPanel 拾取后放进队列，Composer 取走：截图作为附件上传到会话工作区，页面/元素信息作为上下文附在消息里
 *（模型不支持看图时，文字上下文照样送达）。
 */
export interface BrowserCapture {
  id: string
  mode: 'region' | 'element'
  /** PNG data URL */
  image: string
  width: number
  height: number
  url: string
  title: string
  element: { tag: string; selector: string; text: string } | null
}

export const pendingCaptures = ref<BrowserCapture[]>([])

let seq = 0
export function queueBrowserCapture(result: LuluxBrowserPickResult): BrowserCapture {
  const capture: BrowserCapture = {
    id: `cap-${Date.now()}-${++seq}`,
    mode: result.mode,
    image: result.image,
    width: result.width,
    height: result.height,
    url: result.url,
    title: result.title,
    element: result.element
      ? { tag: result.element.tag, selector: result.element.selector, text: result.element.text }
      : null,
  }
  pendingCaptures.value = [...pendingCaptures.value, capture]
  return capture
}

/** 取走队列里的全部拾取结果 */
export function takeCaptures(): BrowserCapture[] {
  const list = pendingCaptures.value
  if (list.length) pendingCaptures.value = []
  return list
}

/** 网址缩短显示：去协议与末尾斜杠，超长截断 */
export function shortUrl(url: string, max = 48): string {
  const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare
}

/** 输入框上方的上下文标签：来自浏览器：<url> · <selector> */
export function captureChip(capture: Pick<BrowserCapture, 'url' | 'element'>): string {
  const selector = capture.element?.selector
  return t('browserCapture.chip', [shortUrl(capture.url) + (selector ? ` · ${shortSelector(selector)}` : '')])
}

/** 选择器只留最后两段，避免标签过长 */
export function shortSelector(selector: string): string {
  const parts = selector.split(' > ')
  return parts.length > 2 ? `… > ${parts.slice(-2).join(' > ')}` : selector
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 截图文件名：browser-<host>-<yyyyMMdd-HHmmss>.png */
export function captureFileName(url: string, now = new Date()): string {
  let host = 'page'
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'page'
  } catch {
    // data: / 无效地址
  }
  host = host.replace(/[^\w.-]+/g, '-').slice(0, 40)
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `browser-${host}-${stamp}.png`
}

/** data URL → 纯 base64 */
export function dataUrlBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

/** 截图 PNG 的字节数（由 base64 长度推算） */
export function base64Size(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** 发送时附在消息里的文字上下文（截图上传失败时 shot 为空，文字照样送达） */
export function captureContext(
  capture: Pick<BrowserCapture, 'mode' | 'url' | 'title' | 'element' | 'width' | 'height'>,
  shot: string | null,
): string {
  const lines = [t(capture.mode === 'element' ? 'browserCapture.headElement' : 'browserCapture.headRegion')]
  lines.push(t('browserCapture.page', [capture.title ? `${capture.title} ` : '', capture.url]))
  const el = capture.element
  if (el?.selector || el?.tag) lines.push(t('browserCapture.element', [el.selector || el.tag, el.tag]))
  if (el?.text) lines.push(t('browserCapture.text', [el.text]))
  if (shot) lines.push(t('browserCapture.shot', [shot, capture.width, capture.height]))
  return lines.join('\n')
}

/** 用户输入 + 浏览器上下文 */
export function withCaptureContext(content: string, contexts: string[]): string {
  return contexts.length ? `${content}\n\n${contexts.join('\n\n')}` : content
}
