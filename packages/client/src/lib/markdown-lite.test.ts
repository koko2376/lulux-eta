import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './markdown-lite'

describe('消息格式化', () => {
  it('粗体与行内代码；HTML 不被解释', () => {
    expect(parseInline('报 **USD 3.85/pc**，型号 `BV-DN25` <b>x</b>')).toEqual([
      { kind: 'text', text: '报 ' },
      { kind: 'bold', text: 'USD 3.85/pc' },
      { kind: 'text', text: '，型号 ' },
      { kind: 'code', text: 'BV-DN25' },
      { kind: 'text', text: ' <b>x</b>' },
    ])
  })
  it('拆出代码块，未闭合（流式中）的代码块标记 open', () => {
    const b = parseBlocks('前言\n\n```html\n<p>1</p>\n```\n\n后记')
    expect(b.map((x) => x.kind)).toEqual(['text', 'code', 'text'])
    expect(b[1]).toMatchObject({ lang: 'html', code: '<p>1</p>', open: false })
    const s = parseBlocks('看这里\n```svg\n<svg>')
    expect(s[1]).toMatchObject({ kind: 'code', lang: 'svg', open: true })
  })
})
