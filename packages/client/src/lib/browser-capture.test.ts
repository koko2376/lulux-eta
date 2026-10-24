import { beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import {
  base64Size,
  captureChip,
  captureContext,
  captureFileName,
  dataUrlBase64,
  pendingCaptures,
  queueBrowserCapture,
  shortSelector,
  shortUrl,
  takeCaptures,
  withCaptureContext,
} from './browser-capture'

const pick = (over: Partial<LuluxBrowserPickResult> = {}): LuluxBrowserPickResult => ({
  mode: 'region',
  image: 'data:image/png;base64,iVBORw0KGgo=',
  width: 300,
  height: 120,
  url: 'https://www.alibaba.com/product/123?x=1',
  title: 'LED 灯条',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  zoomFactor: 1,
  element: { tag: 'div', id: '', classes: ['price'], selector: '#main > div.box > span.price', text: 'US$ 1.20' },
  ...over,
})

describe('内置浏览器框选 → 输入框', () => {
  beforeEach(() => {
    setLanguage('zh-CN')
    pendingCaptures.value = []
  })

  it('入队 / 取走', () => {
    const c = queueBrowserCapture(pick())
    expect(c.element).toEqual({ tag: 'div', selector: '#main > div.box > span.price', text: 'US$ 1.20' })
    expect(pendingCaptures.value).toHaveLength(1)
    expect(takeCaptures()).toEqual([c])
    expect(pendingCaptures.value).toEqual([])
    expect(takeCaptures()).toEqual([])
  })

  it('标签文字：来自浏览器：<url> · <selector>（选择器只留后两段）', () => {
    expect(shortUrl('https://example.com/')).toBe('example.com')
    expect(shortUrl(`https://a.com/${'x'.repeat(80)}`, 20)).toHaveLength(20)
    expect(shortSelector('a > b > c')).toBe('… > b > c')
    expect(shortSelector('#x > b')).toBe('#x > b')
    expect(captureChip(pick())).toBe('来自浏览器：www.alibaba.com/product/123?x=1 · … > div.box > span.price')
    expect(captureChip({ url: 'https://a.com/p', element: null })).toBe('来自浏览器：a.com/p')
  })

  it('截图文件名与 base64 大小', () => {
    expect(captureFileName('https://www.alibaba.com/p', new Date(2026, 9, 21, 9, 5, 7))).toBe(
      'browser-alibaba.com-20261021-090507.png',
    )
    expect(captureFileName('data:text/html,x', new Date(2026, 0, 2, 3, 4, 5))).toBe('browser-page-20260102-030405.png')
    expect(dataUrlBase64('data:image/png;base64,QUJD')).toBe('QUJD')
    expect(base64Size('QUJD')).toBe(3)
    expect(base64Size('QUI=')).toBe(2)
  })

  it('消息里的上下文：页面、元素、文字、截图路径；上传失败时没有截图行', () => {
    const c = queueBrowserCapture(pick())
    const text = captureContext(c, 'uploads/browser-alibaba.com.png')
    expect(text.split('\n')).toEqual([
      '【浏览器框选】',
      '页面：LED 灯条 https://www.alibaba.com/product/123?x=1',
      '元素：#main > div.box > span.price（<div>）',
      '文字：US$ 1.20',
      '截图：uploads/browser-alibaba.com.png（300×120）',
    ])
    const noShot = captureContext({ ...c, mode: 'element', element: null, title: '' }, null)
    expect(noShot).toBe('【浏览器元素】\n页面：https://www.alibaba.com/product/123?x=1')
    expect(withCaptureContext('帮我比价', [noShot])).toBe(`帮我比价\n\n${noShot}`)
    expect(withCaptureContext('hi', [])).toBe('hi')
    setLanguage('en')
    expect(captureChip(c)).toBe('From browser: www.alibaba.com/product/123?x=1 · … > div.box > span.price')
  })
})
