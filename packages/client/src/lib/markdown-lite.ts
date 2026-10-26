/**
 * 极简、安全的消息格式化：只识别围栏代码块、**粗体**、`行内代码`。
 * 输出结构化片段，由组件渲染为 VNode——不使用 v-html，模型输出里的 HTML 一律按纯文本显示。
 */
export type Inline = { kind: 'text' | 'bold' | 'code'; text: string }
export type Block = { kind: 'text'; inlines: Inline[] } | { kind: 'code'; lang: string; code: string; open: boolean }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*([^*\n]+?)\*\*|`([^`\n]+?)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] })
    else out.push({ kind: 'code', text: m[2] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** 拆出围栏代码块；流式时未闭合的代码块也按代码显示（open=true） */
export function parseBlocks(content: string): Block[] {
  const blocks: Block[] = []
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const before = content.slice(last, m.index).replace(/\n+$/, '')
    if (before.trim()) blocks.push({ kind: 'text', inlines: parseInline(before) })
    const closed = m[0].trimEnd().endsWith('```') && m[0].length > 3 + m[1].length
    blocks.push({ kind: 'code', lang: m[1] || 'text', code: m[2].replace(/\n$/, ''), open: !closed })
    last = m.index + m[0].length
    if (m[0].length === 0) break
  }
  const rest = content.slice(last).replace(/^\n+/, '')
  if (rest.trim()) blocks.push({ kind: 'text', inlines: parseInline(rest) })
  return blocks
}
