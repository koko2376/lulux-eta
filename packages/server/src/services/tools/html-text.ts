/** 极简 HTML → 纯文本：去脚本/样式，块级元素换行，保留链接地址，解码常见实体 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  yen: '¥',
  euro: '€',
  pound: '£',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]!.replace(/\s+/g, ' ').trim()) : ''
}

export function htmlToText(html: string, baseUrl?: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, (block) => (block.length > 4000 ? '' : block))

  text = text.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, d, s, u, inner: string) => {
    const href = (d ?? s ?? u ?? '').trim()
    const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return label
    let absolute = href
    try {
      absolute = new URL(href, baseUrl).toString()
    } catch {
      // 保留原样
    }
    if (!/^https?:/i.test(absolute)) return label
    return label ? `[${label}](${absolute})` : ''
  })

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote|pre|main|aside|form|dl|dt|dd|figure|figcaption)>/gi, '\n')
    .replace(/<(p|div|section|article|tr|blockquote|pre|main|dl|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  text = decodeEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
