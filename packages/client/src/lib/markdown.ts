import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

/**
 * 助手消息的 Markdown 渲染：markdown-it（html: false，原文里的 HTML 按纯文本显示）→ DOMPurify 再净化一次。
 * 围栏代码块沿用原先的可折叠样式（语言 + 行数，≤6 行或流式中未闭合时展开）；表格包一层可横向滚动的容器；
 * 链接只允许 http/https/mailto，统一 target=_blank，由组件拦截点击交给系统浏览器。
 */
export interface CodeLabels {
  /** 代码块摘要：(语言, 行数) → “代码 · 3 行” */
  lines(count: number): string
  /** 摘要的悬停提示 */
  title(lang: string, count: number): string
  /** html / svg 代码块的“可在产物面板预览” */
  previewHint: string
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })
  // 只允许安全协议（markdown-it 默认已拒绝 javascript: / vbscript: / file: / 大部分 data:）
  const defaultValidate = md.validateLink.bind(md)
  md.validateLink = (url: string) => defaultValidate(url) && /^(https?:|mailto:|#)/i.test(url.trim())
  return md
}

const md = createRenderer()

/** 当前渲染用的代码块文案（渲染是同步的，按调用设置） */
let streaming = false
let labels: CodeLabels = {
  lines: (n) => `${n} lines`,
  title: (lang, n) => `${lang} · ${n}`,
  previewHint: '',
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const lang = (token.info || '').trim().split(/\s+/)[0] || 'text'
  const code = token.content.replace(/\n$/, '')
  const count = code.split('\n').length
  // 流式中正在输出的最后一个代码块保持展开
  const open = count <= 6 || (streaming && idx === tokens.length - 1)
  const hint =
    ['html', 'svg'].includes(lang) && labels.previewHint
      ? ` <span class="md-hint">${escapeHtml(labels.previewHint)}</span>`
      : ''
  return (
    `<details class="md-block"${open ? ' open' : ''}>` +
    `<summary title="${escapeHtml(labels.title(lang, count))}"><span class="md-lang">${escapeHtml(lang)}</span> ${escapeHtml(labels.lines(count))}${hint}</summary>` +
    `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre></details>\n`
  )
}
md.renderer.rules.code_block = (tokens, idx) =>
  `<pre class="md-pre"><code>${escapeHtml(tokens[idx].content.replace(/\n$/, ''))}</code></pre>\n`
md.renderer.rules.table_open = () => '<div class="md-table"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

let hooked = false
function purifier(): typeof DOMPurify {
  if (!hooked) {
    hooked = true
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? ''
        if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href')
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    })
  }
  return DOMPurify
}

const SANITIZE = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    's',
    'del',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'div',
    'span',
    'details',
    'summary',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class', 'open', 'start', 'align', 'style', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
}

/** markdown-it 只会给表格单元格写 text-align；其余 style 一律去掉 */
function stripStyles(html: string): string {
  return html.replace(/ style="(?!text-align:(left|right|center)")[^"]*"/g, '')
}

/** 已完成消息的渲染缓存（流式中的内容每次都变，不进缓存） */
const cache = new Map<string, string>()
const CACHE_LIMIT = 300

export function renderMarkdown(
  content: string,
  codeLabels?: CodeLabels,
  options: { streaming?: boolean } = {},
): string {
  if (codeLabels) labels = codeLabels
  // 语言切换后文案不同：缓存键带上当前文案
  const key = options.streaming ? '' : `${labels.lines(2)}\u0000${content}`
  if (key && cache.has(key)) return cache.get(key)!
  streaming = Boolean(options.streaming)
  const html = stripStyles(purifier().sanitize(md.render(content), SANITIZE) as unknown as string)
  if (key) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(key, html)
  }
  return html
}

/** 测试用 */
export function clearMarkdownCache(): void {
  cache.clear()
}
