import { parseInline, type Inline } from './markdown-lite'

/**
 * 文档级 Markdown（技能 SKILL.md 预览）：标题、段落、有序 / 无序列表、表格、引用、分隔线、围栏代码块。
 * 与 markdown-lite 一样输出结构化片段由组件渲染，不使用 v-html，原文里的 HTML 一律按纯文本显示。
 */
export type DocBlock =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'para'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'hr' }

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

export function parseDoc(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: DocBlock[] = []
  let i = 0
  let para: string[] = []
  const flush = (): void => {
    if (para.length) out.push({ kind: 'para', inlines: parseInline(para.join('\n')) })
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```([\w+-]*)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      i++
      out.push({ kind: 'code', lang: fence[1] || 'text', code: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', level: h[1].length, inlines: parseInline(h[2].replace(/\s+#+\s*$/, '')) })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push({ kind: 'hr' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const head = cells(line).map(parseInline)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim())
        rows.push(cells(lines[i++]).map(parseInline))
      out.push({ kind: 'table', head, rows })
      continue
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[1])
      const items: Inline[][] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(parseInline(m[2]))
          i++
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // 续行：并入上一项
          items[items.length - 1] = [...items[items.length - 1], { kind: 'text', text: ` ${lines[i].trim()}` }]
          i++
        } else break
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ kind: 'quote', inlines: parseInline(quote.join('\n')) })
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return out
}
