/**
 * 邮件 HTML 清洗（纵深防御）。界面另外用 `<iframe sandbox srcdoc>` + CSP `default-src 'none'` 展示，
 * 即使这里漏掉也不会执行脚本或加载外部资源。
 * - 删除 script/iframe/object/embed/form/meta/link/base/svg/math 等元素（含内容）
 * - 删除所有 on* 事件属性、formaction
 * - href/src 只保留 http(s)/mailto/cid/data:image(png/jpeg/gif/webp)；javascript:/vbscript:/data:text 等一律移除
 * - 外部图片 src/background/poster 默认改为 data-blocked-src（不加载，防追踪像素）；
 *   调用方显式传入 remoteImages 时，只把允许的地址替换为代理返回的 data URL
 * - cid: 内联图替换为附件 data URL（由调用方提供），CID 统一去尖括号、URL 解码、转小写
 * - srcset 只保留安全候选；src 缺失或不可用时用第一个安全候选回退为 src
 */

import { validateDataImageUrl } from './image-type.js'

const DROP_WITH_CONTENT = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'svg', 'math', 'xml']
const DROP_TAG_ONLY = ['form', 'input', 'button', 'select', 'textarea', 'meta', 'link', 'base', 'html', 'head', 'body', 'title']

/** CID 归一化：去 `cid:` 前缀、URL 解码、去尖括号与空白、转小写 */
export function normalizeCid(value: string): string {
  let cid = value.trim()
  if (/^cid:/i.test(cid)) cid = cid.slice(4)
  try {
    cid = decodeURIComponent(cid)
  } catch {
    // 非法百分号编码：保留原文继续处理
  }
  return cid
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .replace(/[\s\u0000-\u001f]+/g, '')
    .replace(/[;,]+$/, '')
    .toLowerCase()
}

/** 收集 HTML 里引用到的 CID（已归一化），供调用方按需加载内联附件 */
export function cidReferences(html: string): Set<string> {
  const found = new Set<string>()
  const pattern = /\bcid:([^"'\s>)]+)/gi
  let m: RegExpExecArray | null
  while ((m = pattern.exec(html))) {
    const cid = normalizeCid(m[1]!)
    if (cid) found.add(cid)
  }
  return found
}

/** 解码属性里的 HTML 实体，得到实际要请求的 URL（同时用作清洗器与代理映射的键） */
export function decodeAttrUrl(value: string): string {
  return value
    .trim()
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

function isRemoteHttp(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** 收集需要走服务端代理的远程图片地址（src/background/poster/srcset） */
export function remoteImageUrls(html: string): string[] {
  const urls = new Set<string>()
  const add = (raw: string): void => {
    const value = decodeAttrUrl(raw)
    if (isRemoteHttp(value)) urls.add(value)
  }
  const tagPattern = /<[a-zA-Z][^<>]*>/g
  let tag: RegExpExecArray | null
  while ((tag = tagPattern.exec(html))) {
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let m: RegExpExecArray | null
    while ((m = attrPattern.exec(tag[0]))) {
      const name = m[1]!.toLowerCase()
      const value = m[2] ?? m[3] ?? m[4] ?? ''
      if (name === 'src' || name === 'background' || name === 'poster') add(value)
      else if (name === 'srcset') {
        for (const candidate of parseSrcset(value)) add(candidate.url)
      }
    }
  }
  return [...urls]
}

interface SrcsetCandidate {
  url: string
  descriptor: string
}

/** srcset 只支持标准 `url [w|x]` 候选；data URL 内部的逗号不当作分隔符 */
function parseSrcset(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = []
  for (const part of value.split(/\s*,\s+/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const match = /^(\S+)(?:\s+([0-9.]+[wx]))?$/i.exec(trimmed)
    if (!match) continue
    candidates.push({ url: match[1]!, descriptor: match[2] ?? '' })
  }
  return candidates
}

/**
 * @param inlineImages 已归一化 CID → data URL
 * @param remoteImages 远程 URL（decodeAttrUrl 后的值）→ 代理返回的 data URL；缺省时全部拦截
 */
export function sanitizeEmailHtml(
  html: string,
  inlineImages: Map<string, string> = new Map(),
  remoteImages: Map<string, string> = new Map(),
): string {
  let out = html

  // 注释与条件注释
  out = out.replace(/<!--[\s\S]*?-->/g, '')

  for (const tag of DROP_WITH_CONTENT) {
    const paired = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
    out = out.replace(paired, '')
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '')
  }
  for (const tag of DROP_TAG_ONLY) {
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '')
  }

  // 逐个标签处理属性
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?(\/?)>/g, (_match, tag: string, attrs: string | undefined, selfClose: string) => {
    const lower = tag.toLowerCase()
    if (!attrs) return `<${lower}${selfClose ? ' /' : ''}>`
    const kept: string[] = []
    let srcKept = false
    let srcFallback: string | null = null
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let m: RegExpExecArray | null
    while ((m = attrPattern.exec(attrs))) {
      const name = m[1]!.toLowerCase()
      let value = m[2] ?? m[3] ?? m[4] ?? ''
      if (name.startsWith('on') || name === 'formaction' || name === 'xmlns' || name.includes(':')) continue
      if (name === 'style') {
        // 去掉可能加载外部资源或执行表达式的样式
        value = value.replace(/expression\s*\(|url\s*\([^)]*\)|@import|behavior\s*:|-moz-binding/gi, '')
      }
      if (name === 'href' || name === 'src' || name === 'background' || name === 'action' || name === 'poster') {
        const decoded = value.replace(/&#x?[0-9a-f]+;?/gi, '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase()
        const protocol = /^([a-z][a-z0-9+.-]*):/.exec(decoded)?.[1] ?? ''
        if (protocol === 'javascript' || protocol === 'vbscript' || protocol === 'file') continue
        // data: 只允许图片属性继续交给魔数校验；href/action 的 data: 一律丢弃
        if (protocol === 'data' && name !== 'src' && name !== 'background' && name !== 'poster') continue
        if (name === 'src' || name === 'background' || name === 'poster') {
          const resolved = resolveImageValue(value, inlineImages, remoteImages)
          if (resolved) {
            value = resolved
            if (name === 'src') srcKept = true
          } else {
            // poster 没有可替代属性，直接丢弃；src/background 留下被拦截地址供界面提示与“显示远程图片”
            if (name !== 'poster') kept.push(`data-blocked-src="${escapeAttr(value)}"`)
            continue
          }
        }
        if (name === 'action') continue
      }
      if (name === 'srcset') {
        const safe: string[] = []
        let firstBlocked: string | null = null
        for (const candidate of parseSrcset(value)) {
          const resolved = resolveImageValue(candidate.url, inlineImages, remoteImages)
          if (resolved) {
            const descriptor = candidate.descriptor ? ` ${candidate.descriptor}` : ''
            safe.push(`${resolved}${descriptor}`)
            if (!srcFallback) srcFallback = resolved
          } else if (!firstBlocked) {
            firstBlocked = candidate.url
          }
        }
        if (safe.length) {
          value = safe.join(', ')
        } else {
          if (firstBlocked) kept.push(`data-blocked-src="${escapeAttr(firstBlocked)}"`)
          continue
        }
      }
      kept.push(m[2] !== undefined || m[3] !== undefined || m[4] !== undefined ? `${name}="${escapeAttr(value)}"` : name)
    }
    // src 缺失 / 被拦截时，用 srcset 里第一个安全候选兜底（响应式图片只写 srcset 的情况）
    if (!srcKept && srcFallback) kept.push(`src="${escapeAttr(srcFallback)}"`)
    if (lower === 'a') kept.push('target="_blank"', 'rel="noopener noreferrer"')
    return `<${lower}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? ' /' : ''}>`
  })

  return out
}

/** 返回可用的图片地址；null 表示应拦截（远程图不在允许集合、坏 CID、危险协议、伪造 data image） */
function resolveImageValue(value: string, inlineImages: Map<string, string>, remoteImages: Map<string, string>): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('cid:')) {
    // 内联图同样校验魔数：调用方即使给了坏 data URL（SVG / 伪造 MIME）也不放行
    const inline = inlineImages.get(normalizeCid(trimmed))
    return inline ? validateDataImageUrl(inline) : null
  }
  if (lower.startsWith('data:')) return validateDataImageUrl(trimmed)
  if (isRemoteHttp(trimmed)) {
    return remoteImages.get(decodeAttrUrl(trimmed)) ?? null
  }
  // 相对地址、协议相对地址与其他协议一律不加载
  return null
}

function escapeAttr(value: string): string {
  return value.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function wrapEmailHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Segoe UI,Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.5;margin:12px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`
}

export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
