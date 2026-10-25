import { describe, expect, it } from 'vitest'
import { sanitizeEmailHtml } from '../src/services/email/sanitize.js'

describe('邮件 HTML 清洗', () => {
  it('去掉脚本、事件、危险协议、外部资源；保留正文与安全链接', () => {
    const html = `<div onclick="x()">Hi<script>alert(1)</script><iframe src="https://evil"></iframe>
      <a href="JaVaScRiPt:alert(1)">bad</a><a href="https://ok.example/p?a=1&b=2">ok</a>
      <img src="https://tracker/p.gif"><img src="cid:logo@x"><img src="data:image/png;base64,AAAA">
      <form action="https://evil"><input name="p"></form><svg><script>1</script></svg>
      <p style="color:red;background:url(https://x/y)">styled</p><object data="x"></object></div>`
    const out = sanitizeEmailHtml(html, new Map([['logo@x', 'data:image/png;base64,BBBB']]))
    expect(out).not.toMatch(/<script|<iframe|<form|<input|<svg|<object|onclick|javascript:|url\(/i)
    expect(out).toContain('href="https://ok.example/p?a=1&amp;b=2"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('data-blocked-src="https://tracker/p.gif"')
    expect(out).toContain('src="data:image/png;base64,BBBB"')
    expect(out).toContain('src="data:image/png;base64,AAAA"')
    expect(out).toContain('styled')
  })
})

describe('页面 CSP', () => {
  it('去掉 index.html 里的 meta CSP（以响应头为准）', async () => {
    process.env.LULUX_ETA_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lulux-unit-'))
    const { stripMetaCsp } = await import('../src/app.js')
    const html = `<head><meta charset="UTF-8" /><meta\n      http-equiv="Content-Security-Policy"\n      content="default-src 'self'; connect-src 'self'"\n    /><title>x</title></head>`
    const out = stripMetaCsp(html)
    expect(out).not.toContain('Content-Security-Policy')
    expect(out).toContain('<meta charset="UTF-8" />')
    expect(out).toContain('<title>x</title>')
  })
})
