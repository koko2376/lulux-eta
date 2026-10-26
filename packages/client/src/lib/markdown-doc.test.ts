import { describe, expect, it } from 'vitest'
import { parseDoc } from './markdown-doc'

describe('文档 Markdown（SKILL.md 预览）', () => {
  it('标题、列表、表格、代码块、引用、分隔线', () => {
    const blocks = parseDoc(
      [
        '# PI / CI / PL 生成',
        '',
        '## 输入准备',
        '1. 从系统取数据：`get_customer`',
        '2. **不要编造**银行账号',
        '   续行内容',
        '',
        '- a',
        '- b',
        '',
        '| 单据 | 用途 |',
        '| --- | :---: |',
        '| PI | 订单确认 |',
        '| CI | 结汇 |',
        '',
        '```json',
        '{"a":1}',
        '```',
        '> 注意 <script>x</script>',
        '---',
        '普通段落',
      ].join('\n'),
    )
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'heading',
      'list',
      'list',
      'table',
      'code',
      'quote',
      'hr',
      'para',
    ])
    const ol = blocks[2] as Extract<(typeof blocks)[number], { kind: 'list' }>
    expect(ol.ordered).toBe(true)
    expect(ol.items[1].map((x) => x.text).join('')).toBe('不要编造银行账号 续行内容')
    const table = blocks[4] as Extract<(typeof blocks)[number], { kind: 'table' }>
    expect(table.head.map((c) => c[0].text)).toEqual(['单据', '用途'])
    expect(table.rows).toHaveLength(2)
    expect((blocks[6] as { inlines: { text: string }[] }).inlines[0].text).toContain('<script>')
  })
})
