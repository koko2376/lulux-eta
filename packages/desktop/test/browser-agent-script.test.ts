// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  actionPrepScript,
  clickScript,
  focusScript,
  submitScript,
  describeScript,
  formatSnapshot,
  HIGHLIGHT_MS,
  sanitizeSnapshot,
  selectScript,
  setValueScript,
  snapshotScript,
  type ElementInfo,
  type SnapshotData,
} from '../src/browser-agent-script'

/** jsdom 没有布局：给所有元素一个固定矩形，带 data-hidden 的元素尺寸为 0 */
function mockLayout(): void {
  const hidden = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.hasAttribute('data-hidden')) return true
    }
    return false
  }
  const rect = (el: Element): DOMRect => {
    const zero = hidden(el)
    const width = zero ? 0 : 100
    const height = zero ? 0 : 24
    const left = zero ? 0 : 10
    const top = zero ? 0 : 20
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect
  }
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rect(this)
  }
}

const PAGE = `
  <h1>产品目录</h1>
  <h2>筛选</h2>
  <a id="link" href="/products">Products</a>
  <input id="search" type="text" placeholder="Search products" aria-label="Search" />
  <button id="go">Search</button>
  <select id="country" aria-label="Country">
    <option value="cn">China</option>
    <option value="us">United States</option>
  </select>
  <label for="remember">Remember me</label>
  <input id="remember" type="checkbox" checked />
  <input id="password" type="password" aria-label="Password" value="secret" />
  <div style="display:none"><button id="hidden-style">Hidden style</button></div>
  <span data-hidden="true"><a id="hidden-size" href="/x">Hidden size</a></span>
`

function run<T>(script: string): T {
  // 注入脚本自带 IIFE；new Function 模拟 executeJavaScript
  // eslint-disable-next-line no-new-func
  return new Function(`return ${script}`)() as T
}

function snapshot(maxItems = 200): SnapshotData {
  return run<SnapshotData>(snapshotScript(maxItems))
}

function token(): string {
  return (window as unknown as Record<string, string>).__luluxRefToken
}

function refOf(id: string): number {
  return Number(document.getElementById(id)!.getAttribute('data-lulux-ref'))
}

beforeEach(() => {
  document.body.innerHTML = PAGE
  document.title = '演示页面'
  mockLayout()
})

describe('snapshot', () => {
  it('按文档顺序编号，跳过 display:none 与零尺寸元素', () => {
    const data = snapshot()
    expect(data.docToken).toBeTruthy()
    expect(data.docToken).toBe(token())
    const names = data.items.map((item) => item.name)
    expect(names).toEqual(['Products', 'Search', 'Search', 'Country', 'Remember me', 'Password'])
    expect(data.items.map((item) => item.ref)).toEqual([1, 2, 3, 4, 5, 6])
    expect(document.getElementById('hidden-style')!.hasAttribute('data-lulux-ref')).toBe(false)
    expect(document.getElementById('hidden-size')!.hasAttribute('data-lulux-ref')).toBe(false)
    expect(data.items[0]).toMatchObject({ tag: 'a', role: 'link', href: '/products' })
    expect(data.items[2]).toMatchObject({ tag: 'button', role: 'button', name: 'Search' })
    expect(data.items[1]).toMatchObject({ role: 'textbox', placeholder: 'Search products', name: 'Search' })
    expect(data.items[3]).toMatchObject({ tag: 'select', role: 'combobox', name: 'Country', value: 'China' })
    expect(data.items[4]).toMatchObject({ role: 'checkbox', checked: true })
    expect(data.items[5]).toMatchObject({ role: 'textbox', isPassword: true, value: '' })
    expect(data.headings).toEqual(['产品目录', '筛选'])
    expect(data.title).toBe('演示页面')
    expect(data.truncated).toBe(false)
  })

  it('重新编号：旧的 data-lulux-ref 先清掉，docToken 每次都换', () => {
    const first = snapshot()
    document.body.insertAdjacentHTML('afterbegin', '<button id="new">New</button>')
    const second = snapshot()
    expect(second.docToken).not.toBe(first.docToken)
    expect(refOf('new')).toBe(1)
    expect(refOf('go')).toBe(4)
    expect(document.querySelectorAll('[data-lulux-ref]').length).toBe(second.items.length)
  })

  it('超过 maxItems 时截断并标记 truncated', () => {
    const data = snapshot(2)
    expect(data.items).toHaveLength(2)
    expect(data.truncated).toBe(true)
  })
})

describe('formatSnapshot', () => {
  it('按 docs 的文本格式输出标题、编号元素与密码标记', () => {
    const data = snapshot()
    const text = formatSnapshot(data)
    const lines = text.split('\n')
    expect(lines[0]).toBe('# 演示页面 — http://localhost:3000/')
    expect(lines[1]).toBe('## 产品目录')
    expect(text).toContain('[1] link "Products" → /products')
    expect(text).toContain('[2] textbox "Search" (placeholder: Search products)')
    expect(text).toContain('[3] button "Search"')
    expect(text).toContain('[4] combobox "Country" = "China"')
    expect(text).toContain('[5] checkbox "Remember me" [checked]')
    expect(text).toContain('[6] textbox "Password" (password — Agent 不可读写)')
  })

  it('名字里的双引号换成单引号', () => {
    const data = sanitizeSnapshot({
      url: 'https://example.com',
      title: '',
      docToken: 't',
      items: [{ ref: 1, tag: 'button', role: 'button', name: 'say "hi"' }],
      headings: [],
      truncated: false,
    })!
    expect(formatSnapshot(data)).toBe('# https://example.com\n[1] button "say \'hi\'"')
  })
})

describe('describe / actionPrep', () => {
  it('describe 返回元素信息且不拒绝密码框（只标记）', () => {
    snapshot()
    const info = run<ElementInfo>(describeScript(refOf('password'), token()))
    expect(info).toMatchObject({ ref: 6, tag: 'input', type: 'password', isPassword: true })
    const button = run<ElementInfo>(describeScript(refOf('go'), token()))
    expect(button).toMatchObject({ tag: 'button', role: 'button', name: 'Search', disabled: false })
  })

  it('docToken 不符返回 REF_STALE', () => {
    snapshot()
    const result = run<{ ok: false; code: string }>(describeScript(refOf('go'), 'wrong-token'))
    expect(result).toMatchObject({ ok: false, code: 'REF_STALE' })
    const prep = run<{ ok: false; code: string }>(actionPrepScript(refOf('go'), 'wrong-token'))
    expect(prep).toMatchObject({ ok: false, code: 'REF_STALE' })
  })

  it('ref 不存在返回 REF_NOT_FOUND', () => {
    snapshot()
    const result = run<{ ok: false; code: string }>(describeScript(999, token()))
    expect(result).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
  })

  it('actionPrep 返回中心 CSS 坐标并画高亮层', () => {
    snapshot()
    const prep = run<{ ok: true; x: number; y: number; element: ElementInfo }>(
      actionPrepScript(refOf('go'), token()),
    )
    expect(prep).toMatchObject({ ok: true, x: 60, y: 32, element: { ref: 3, name: 'Search' } })
    const highlight = document.querySelector('[data-lulux-highlight]') as HTMLElement
    expect(highlight).toBeTruthy()
    expect(highlight.style.border).toContain('rgb(111, 195, 240)')
    // 高亮层不参与快照
    expect(snapshot().items).toHaveLength(6)
    expect(HIGHLIGHT_MS).toBe(1200)
  })

  it('密码框拒绝点击 / 输入', () => {
    snapshot()
    const prep = run<{ ok: false; code: string }>(actionPrepScript(refOf('password'), token()))
    expect(prep).toMatchObject({ ok: false, code: 'PASSWORD_FIELD' })
  })
})

describe('setValue / select', () => {
  it('select 按 value 或可见文本选中并派发 input/change', () => {
    snapshot()
    const events: string[] = []
    const select = document.getElementById('country') as HTMLSelectElement
    select.addEventListener('change', () => events.push('change'))
    select.addEventListener('input', () => events.push('input'))
    const byValue = run<{ ok: true }>(selectScript(refOf('country'), token(), 'us'))
    expect(byValue).toEqual({ ok: true })
    expect(select.value).toBe('us')
    const byText = run<{ ok: true }>(selectScript(refOf('country'), token(), 'China'))
    expect(byText).toEqual({ ok: true })
    expect(select.value).toBe('cn')
    expect(events).toEqual(['input', 'change', 'input', 'change'])
    const missing = run<{ ok: false; code: string }>(selectScript(refOf('country'), token(), 'Mars'))
    expect(missing).toMatchObject({ ok: false, code: 'FAILED' })
  })

  it('setValue 写输入框；对下拉框提示改用 select', () => {
    snapshot()
    const input = document.getElementById('search') as HTMLInputElement
    expect(run<{ ok: true }>(setValueScript(refOf('search'), token(), '报价'))).toEqual({ ok: true })
    expect(input.value).toBe('报价')
    expect(run<{ ok: false; code: string }>(setValueScript(refOf('country'), token(), 'us'))).toMatchObject({
      ok: false,
      code: 'BAD_ARGS',
    })
    expect(run<{ ok: false; code: string }>(setValueScript(refOf('password'), token(), 'x'))).toMatchObject({
      ok: false,
      code: 'PASSWORD_FIELD',
    })
  })
})

describe('输入 / 点击的页面脚本（真 Electron 里发现 focus 未注入的回归）', () => {
  it('focusScript 聚焦并清空输入框，不依赖额外 helper', () => {
    snapshot()
    const input = document.getElementById('search') as HTMLInputElement
    input.value = 'old'
    const res = run<{ ok: boolean }>(focusScript(refOf('search'), token(), true))
    expect(res).toEqual({ ok: true })
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
  })

  it('focusScript 拒绝密码框', () => {
    snapshot()
    const res = run<{ ok: boolean; code?: string }>(focusScript(refOf('password'), token(), true))
    expect(res).toMatchObject({ ok: false, code: 'PASSWORD_FIELD' })
  })

  it('clickScript 触发元素 click()（面板未显示时的兜底）', () => {
    snapshot()
    let clicked = 0
    document.getElementById('go')!.addEventListener('click', () => (clicked += 1))
    expect(run(clickScript(refOf('go'), token()))).toEqual({ ok: true })
    expect(clicked).toBe(1)
  })

  it('setValueScript append 在原值后追加；submitScript 提交所在表单', () => {
    document.body.innerHTML = '<form id="f"><input id="q" aria-label="Q" value="BV"></form>'
    mockLayout()
    snapshot()
    expect(run(setValueScript(refOf('q'), token(), '-50', true))).toEqual({ ok: true })
    expect((document.getElementById('q') as HTMLInputElement).value).toBe('BV-50')
    let submitted = 0
    const form = document.getElementById('f') as HTMLFormElement
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted += 1
    })
    expect(run(submitScript(refOf('q'), token()))).toEqual({ ok: true })
    expect(submitted).toBe(1)
  })
})

describe('密码框判定（P1 审查）', () => {
  it('type=text + autocomplete=current-password / new-password / one-time-code 也算密码框', async () => {
    const { elementIsPassword } = await import('../src/browser-agent-script')
    document.body.innerHTML = `
      <input id="a" type="text" autocomplete="current-password">
      <input id="b" type="email" autocomplete="username new-password">
      <input id="c" type="text" autocomplete="one-time-code">
      <input id="d" type="text" autocomplete="username">
      <input id="e" type="password">`
    const el = (id: string) => document.getElementById(id)!
    expect(elementIsPassword(el('a'))).toBe(true)
    expect(elementIsPassword(el('b'))).toBe(true)
    expect(elementIsPassword(el('c'))).toBe(true)
    expect(elementIsPassword(el('d'))).toBe(false)
    expect(elementIsPassword(el('e'))).toBe(true)
  })
})
