import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/** 解析成 DOM 检查：危险的是元素与属性，转义后的文字无害 */
function dom(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}
const eventAttrs = (el: HTMLElement) =>
  [...el.querySelectorAll('*')].flatMap((node) => [...node.attributes].map((a) => a.name)).filter((n) => /^on/i.test(n))

const labels = { lines: (n: number) => `${n} 行`, title: (l: string, n: number) => `${l} ${n}`, previewHint: '预览' }
const render = (md: string, streaming = false) => renderMarkdown(md, labels, { streaming })

describe('助手消息 Markdown 渲染', () => {
  it('标题、列表、粗体、行内代码、引用、表格（包一层可滚动容器）', () => {
    const html = render(
      '## 结论\n\n- **报价** USD 3.85\n- 用 `FOB`\n\n> 注意交期\n\n| 品名 | 单价 |\n| --- | ---: |\n| 球阀 | 3.85 |',
    )
    expect(html).toContain('<h2>结论</h2>')
    expect(html).toContain('<li><strong>报价</strong> USD 3.85</li>')
    expect(html).toContain('<code>FOB</code>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<div class="md-table"><table>')
    expect(html).toContain('<th style="text-align:right">单价</th>')
  })

  it('围栏代码块：可折叠，带语言与行数；≤6 行展开，长代码默认收起；html 提示可预览', () => {
    const short = render('```ts\nconst a = 1\n```')
    expect(short).toContain('<details class="md-block" open="">')
    expect(short).toContain('<span class="md-lang">ts</span> 1 行')
    expect(short).toContain('const a = 1')
    const long = render('```html\n' + '<p>x</p>\n'.repeat(10) + '```')
    expect(long).toContain('<details class="md-block">')
    expect(long).toContain('&lt;p&gt;x&lt;/p&gt;')
    expect(long).toContain('<span class="md-hint">预览</span>')
    // 流式中最后一个未闭合的长代码块保持展开
    expect(render('```py\n' + 'x = 1\n'.repeat(10), true)).toContain('open=""')
  })

  it('净化：<script>、onerror、javascript: 链接、style 注入全部去掉；原始 HTML 按文本显示', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[点我](javascript:alert(1)) [ok](https://example.com)\n\n<a href="https://x" onclick="evil()">a</a>',
    )
    const el = dom(html)
    expect(el.querySelector('script, img, iframe')).toBeNull()
    expect(eventAttrs(el)).toEqual([])
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs).toContain('https://example.com')
    expect(hrefs.every((h) => /^https:\/\//.test(h))).toBe(true)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>')
  })

  it('即使渲染器产出了危险 HTML，DOMPurify 也会剥掉（data: 链接、事件属性）', () => {
    const html = render('[x](data:text/html;base64,PHNjcmlwdD4=) ![img](https://e.com/a.png "t")')
    const el = dom(html)
    expect(el.querySelector('a[href^="data:"]')).toBeNull()
    expect(el.querySelector('img')).toBeNull()
  })

  it('裸链接自动识别并新窗口打开；换行保留', () => {
    const html = render('见 https://lulux.example/docs\n第二行')
    expect(html).toContain('<a href="https://lulux.example/docs" target="_blank" rel="noopener noreferrer">')
    expect(html).toContain('<br>')
  })
})
