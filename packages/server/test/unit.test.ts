import { describe, expect, it } from 'vitest'
import {
  imageDataUrl,
  normalizeImageMime,
  sniffImage,
  validateDataImageUrl,
} from '../src/services/email/image-type.js'
import { cidReferences, normalizeCid, remoteImageUrls, sanitizeEmailHtml } from '../src/services/email/sanitize.js'

/** 1×1 透明 PNG（真实魔数，能被 image-type 的 base64 校验接受） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

describe('邮件 HTML 清洗', () => {
  it('去掉脚本、事件、危险协议、外部资源；保留正文与安全链接', () => {
    const html = `<div onclick="x()">Hi<script>alert(1)</script><iframe src="https://evil"></iframe>
      <a href="JaVaScRiPt:alert(1)">bad</a><a href="https://ok.example/p?a=1&b=2">ok</a>
      <img src="https://tracker/p.gif"><img src="cid:logo@x"><img src="data:image/png;base64,AAAA">
      <form action="https://evil"><input name="p"></form><svg><script>1</script></svg>
      <p style="color:red;background:url(https://x/y)">styled</p><object data="x"></object></div>`
    const out = sanitizeEmailHtml(html, new Map([['logo@x', PNG_DATA_URL]]))
    expect(out).not.toMatch(/<script|<iframe|<form|<input|<svg|<object|onclick|javascript:|url\(/i)
    expect(out).toContain('href="https://ok.example/p?a=1&amp;b=2"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('data-blocked-src="https://tracker/p.gif"')
    expect(out).toContain(`src="${PNG_DATA_URL}"`)
    // 伪造的 PNG base64 不当作图片放行，但保留位置提示（不影响排版）
    expect(out).toContain('data-blocked-src="data:image/png;base64,AAAA"')
    expect(out).toContain('styled')
  })

  it('data: 只放行真实 PNG/JPEG/GIF/WebP；SVG 与伪造 MIME 拒绝', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    const forged = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    const out = sanitizeEmailHtml(`<img src="${PNG_DATA_URL}"><img src="${svg}"><img src="${forged}">`)
    expect(out).toContain(`src="${PNG_DATA_URL}"`)
    expect(out).not.toMatch(/\ssrc="data:image\/svg/i)
    expect(out.match(/<img\b/g)).toHaveLength(3)
    expect(out).toContain('data-blocked-src="data:image/png;base64,')
    // 链接上的 data: 一律丢弃（不是图片属性）
    const link = sanitizeEmailHtml('<a href="data:text/html;base64,PHN2Zz4=">x</a>')
    expect(link).not.toContain('href=')
    expect(link).toContain('>x</a>')
  })

  it('CID 归一化：大小写、尖括号、URL 编码都能匹配', () => {
    expect(normalizeCid('CID:%3CLogo%40Acme.COM%3E')).toBe('logo@acme.com')
    expect(normalizeCid(' <a@b> ')).toBe('a@b')
    const refs = cidReferences('<img src="cid:%3CLogo%40Acme.COM%3E"><img src=\'cid:other@x\'>')
    expect([...refs]).toEqual(['logo@acme.com', 'other@x'])
    const out = sanitizeEmailHtml('<img src="CID:%3CLogo%40Acme.COM%3E">', new Map([['logo@acme.com', PNG_DATA_URL]]))
    expect(out).toContain(`src="${PNG_DATA_URL}"`)
  })

  it('坏 CID 不破坏正文：移除图片但保留其他内容', () => {
    const out = sanitizeEmailHtml('<p>before</p><img src="cid:missing@x"><p>after</p>', new Map())
    expect(out).toContain('<p>before</p>')
    expect(out).toContain('<p>after</p>')
    expect(out).toContain('data-blocked-src="cid:missing@x"')
    expect(out).not.toMatch(/\ssrc="cid:/)
  })

  it('远程图片默认拦截；显式放行时只替换为代理返回的 data URL', () => {
    const html = '<img src="https://cdn.example/a.png"><img src="https://tracker.example/pixel.gif">'
    expect(remoteImageUrls(html)).toEqual(['https://cdn.example/a.png', 'https://tracker.example/pixel.gif'])
    const blocked = sanitizeEmailHtml(html)
    expect(blocked).not.toMatch(/\ssrc="https?:/i)
    expect(blocked).toContain('data-blocked-src="https://cdn.example/a.png"')
    const allowed = sanitizeEmailHtml(html, new Map(), new Map([['https://cdn.example/a.png', PNG_DATA_URL]]))
    expect(allowed).toContain(`src="${PNG_DATA_URL}"`)
    expect(allowed).toContain('data-blocked-src="https://tracker.example/pixel.gif"')
  })

  it('srcset 只保留安全候选，并在缺少 src 时回退为 src', () => {
    const html = '<img srcset="https://cdn.example/a.png 1x, https://tracker.example/b.png 2x">'
    const out = sanitizeEmailHtml(html, new Map(), new Map([['https://cdn.example/a.png', PNG_DATA_URL]]))
    expect(out).toContain(`srcset="${PNG_DATA_URL} 1x"`)
    expect(out).toContain(`src="${PNG_DATA_URL}"`)
    expect(out).not.toContain('tracker.example')
    const blocked = sanitizeEmailHtml(html)
    expect(blocked).not.toContain('srcset=')
    expect(blocked).toContain('data-blocked-src="https://cdn.example/a.png"')
  })

  it('属性里的 HTML 实体先解码再判断远程地址', () => {
    const html = '<img src="https://cdn.example/a.png?x=1&amp;y=2">'
    expect(remoteImageUrls(html)).toEqual(['https://cdn.example/a.png?x=1&y=2'])
    const out = sanitizeEmailHtml(html, new Map(), new Map([['https://cdn.example/a.png?x=1&y=2', PNG_DATA_URL]]))
    expect(out).toContain(`src="${PNG_DATA_URL}"`)
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

describe('图片类型识别（data URL / 代理共用）', () => {
  const png = Buffer.from(PNG_BASE64, 'base64')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const gif = Buffer.from('GIF89a', 'ascii')
  const webp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')

  it('按魔数识别 PNG / JPEG / GIF / WebP，其余返回 null', () => {
    expect(sniffImage(png)).toBe('png')
    expect(sniffImage(jpeg)).toBe('jpeg')
    expect(sniffImage(gif)).toBe('gif')
    expect(sniffImage(webp)).toBe('webp')
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it('MIME 归一化与魔数必须一致', () => {
    expect(normalizeImageMime('image/jpg; charset=binary')).toBe('image/jpeg')
    expect(normalizeImageMime('IMAGE/PNG')).toBe('image/png')
    expect(imageDataUrl(png, 'image/png')?.kind).toBe('png')
    expect(imageDataUrl(jpeg, 'image/png')).toBeNull()
    expect(imageDataUrl(png, 'image/svg+xml')).toBeNull()
  })

  it('data URL 校验：真实图片通过，SVG / 非 base64 / 伪造 MIME 拒绝', () => {
    const valid = `data:image/png;base64,${PNG_BASE64}`
    expect(validateDataImageUrl(valid)).toBe(valid)
    expect(validateDataImageUrl(`data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBeNull()
    expect(validateDataImageUrl(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBeNull()
    expect(validateDataImageUrl('data:image/png;base64,@@@not-base64@@@')).toBeNull()
    expect(validateDataImageUrl('data:image/png,notbase64')).toBeNull()
    expect(validateDataImageUrl('https://example.com/a.png')).toBeNull()
  })
})
