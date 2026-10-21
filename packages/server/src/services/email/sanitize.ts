/**
 * 邮件 HTML 清洗（纵深防御）。界面另外用 `<iframe sandbox srcdoc>` + CSP `default-src 'none'` 展示，
 * 即使这里漏掉也不会执行脚本或加载外部资源。
 * - 删除 script/iframe/object/embed/form/meta/link/base/svg/math 等元素（含内容）
 * - 删除所有 on* 事件属性、srcset、formaction
 * - href/src 只保留 http(s)/mailto/cid/data:image；javascript:/vbscript:/data:text 等一律移除
 * - 外部图片 src 改为 data-blocked-src（不加载，防追踪像素）
 * - cid: 内联图替换为附件 data URL（由调用方提供）
 */

const DROP_WITH_CONTENT = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'svg', 'math', 'xml']
const DROP_TAG_ONLY = ['form', 'input', 'button', 'select', 'textarea', 'meta', 'link', 'base', 'html', 'head', 'body', 'title']

export function sanitizeEmailHtml(html: string, inlineImages: Map<string, string> = new Map()): string {
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
    const attrPattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    let m: RegExpExecArray | null
    while ((m = attrPattern.exec(attrs))) {
      const name = m[1]!.toLowerCase()
      let value = m[2] ?? m[3] ?? m[4] ?? ''
      if (name.startsWith('on') || name === 'srcset' || name === 'formaction' || name === 'xmlns' || name.includes(':')) continue
      if (name === 'style') {
        // 去掉可能加载外部资源或执行表达式的样式
        value = value.replace(/expression\s*\(|url\s*\([^)]*\)|@import|behavior\s*:|-moz-binding/gi, '')
      }
      if (name === 'href' || name === 'src' || name === 'background' || name === 'action' || name === 'poster') {
        const decoded = value.replace(/&#x?[0-9a-f]+;?/gi, '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase()
        if (/^(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp);)|file):/.test(decoded)) continue
        if (name === 'src' || name === 'background') {
          if (decoded.startsWith('cid:')) {
            const cid = value.trim().slice(4).replace(/^<|>$/g, '').toLowerCase()
            const dataUrl = inlineImages.get(cid)
            if (!dataUrl) continue
            value = dataUrl
          } else if (!decoded.startsWith('data:image/')) {
            kept.push(`data-blocked-src="${escapeAttr(value)}"`)
            continue
          }
        }
        if (name === 'action') continue
      }
      kept.push(m[2] !== undefined || m[3] !== undefined || m[4] !== undefined ? `${name}="${escapeAttr(value)}"` : name)
    }
    if (lower === 'a') kept.push('target="_blank"', 'rel="noopener noreferrer"')
    return `<${lower}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? ' /' : ''}>`
  })

  return out
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
