// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  clampRect,
  cssPath,
  describeElement,
  downscaleWidth,
  normalizeRect,
  pickScript,
  sanitizePickResult,
  toCaptureRect,
  type PickPageResult,
} from '../src/pick-script'

describe('框选矩形换算', () => {
  it('拖动端点规范化（反向拖也得到正宽高）', () => {
    expect(normalizeRect(120, 80, 20, 30)).toEqual({ x: 20, y: 30, width: 100, height: 50 })
  })

  it('裁到视口内；完全在外返回 null', () => {
    expect(clampRect({ x: -10, y: 50, width: 100, height: 600 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 50, width: 90, height: 550 })
    expect(clampRect({ x: 900, y: 0, width: 50, height: 50 }, { width: 800, height: 600 })).toBeNull()
  })

  it('CSS px → capturePage DIP：乘页面缩放、向外取整、裁到视图尺寸', () => {
    expect(toCaptureRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, 1, { width: 800, height: 600 })).toEqual({ x: 10, y: 20, width: 101, height: 51 })
    expect(toCaptureRect({ x: 100, y: 100, width: 200, height: 100 }, 1.25, { width: 800, height: 600 })).toEqual({ x: 125, y: 125, width: 250, height: 125 })
    expect(toCaptureRect({ x: 600, y: 500, width: 400, height: 400 }, 1.5, { width: 1000, height: 800 })).toEqual({ x: 900, y: 750, width: 100, height: 50 })
    expect(toCaptureRect({ x: 10, y: 10, width: 10, height: 10 }, Number.NaN, { width: 800, height: 600 })).toEqual({ x: 10, y: 10, width: 10, height: 10 })
    expect(toCaptureRect({ x: 900, y: 10, width: 10, height: 10 }, 1, { width: 800, height: 600 })).toBeNull()
  })

  it('超宽截图缩到 2000px', () => {
    expect(downscaleWidth(1999)).toBeNull()
    expect(downscaleWidth(3840)).toBe(2000)
  })
})

describe('选择器与元素摘要', () => {
  it('遇到 id 停止；class 过滤掉哈希类名；同名兄弟补 nth-of-type；不含 body', () => {
    document.body.innerHTML = `
      <div id="app"><main class="page css-1a2b345 wide">
        <ul class="list"><li>a</li><li class="item hot extra">  第二项
          文本 </li></ul>
      </main></div>`
    const li = document.querySelectorAll('li')[1]!
    const path = cssPath(li)
    expect(path).toBe('#app > main.page.wide > ul.list > li.item.hot:nth-of-type(2)')
    expect(document.querySelector(path)).toBe(li)
    const info = describeElement(li, cssPath)!
    expect(info).toMatchObject({ tag: 'li', id: '', classes: ['item', 'hot', 'extra'], selector: path, text: '第二项 文本' })
  })

  it('非法 id 不用；最多 5 层；文字截到 300 字', () => {
    document.body.innerHTML = `<section id="1bad"><div><div><div><div><div><p>${'字'.repeat(400)}</p></div></div></div></div></div></section>`
    const p = document.querySelector('p')!
    expect(cssPath(p).split(' > ')).toHaveLength(5)
    expect(cssPath(p)).not.toContain('#1bad')
    expect(describeElement(p, cssPath)!.text).toHaveLength(300)
    expect(describeElement(null, cssPath)).toBeNull()
  })
})

describe('注入脚本', () => {
  function run(mode: 'region' | 'element'): Promise<PickPageResult | null> {
    // jsdom 没有 elementsFromPoint：返回覆盖层 + 目标元素
    const target = document.querySelector('#target')!
    ;(document as any).elementsFromPoint = () => [...document.querySelectorAll('[data-lulux-pick]'), target, document.body, document.documentElement]
    // eslint-disable-next-line no-new-func
    return new Function(`return ${pickScript(mode, { region: 'R', element: 'E' })}`)() as Promise<PickPageResult | null>
  }
  const layer = (): HTMLElement => document.querySelector('div[data-lulux-pick]') as HTMLElement
  const mouse = (type: string, x: number, y: number): void => {
    layer().dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }))
  }

  it('区域模式：拖框 → 选区 + 中心元素；覆盖层移除', async () => {
    document.body.innerHTML = '<div id="target" class="card">报价 FOB</div>'
    const pending = run('region')
    expect(document.querySelectorAll('[data-lulux-pick]').length).toBe(3)
    mouse('mousedown', 200, 150)
    mouse('mousemove', 50, 40)
    mouse('mouseup', 50, 40)
    const result = await pending
    expect(result).toMatchObject({ mode: 'region', rect: { x: 50, y: 40, width: 150, height: 110 }, element: { selector: '#target', text: '报价 FOB' } })
    expect(document.querySelectorAll('[data-lulux-pick]').length).toBe(0)
  })

  it('Esc 取消；再次开始会先取消上一次', async () => {
    document.body.innerHTML = '<div id="target">x</div>'
    const first = run('element')
    const second = run('element')
    expect(await first).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await second).toBeNull()
    expect(document.querySelectorAll('[data-lulux-pick]').length).toBe(0)
  })
})

describe('网页返回值校验', () => {
  it('非法数字 / 结构返回 null；字符串截断', () => {
    expect(sanitizePickResult(null, 'region')).toBeNull()
    expect(sanitizePickResult({ rect: { x: 0, y: 0, width: 'a', height: 1 }, viewport: { width: 1, height: 1 } }, 'region')).toBeNull()
    const ok = sanitizePickResult(
      { rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 10, height: 10 }, element: { tag: 'div', selector: 'x'.repeat(1000), classes: ['a', 1], text: 't' } },
      'element',
    )!
    expect(ok.element!.selector).toHaveLength(400)
    expect(ok.element!.classes).toEqual(['a'])
    expect(ok.mode).toBe('element')
  })
})
