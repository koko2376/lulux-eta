import { describe, expect, it } from 'vitest'
import { previewText } from '../src/services/email/sequence-service.js'
import { countryCode } from '../src/services/trade/country-tz.js'

describe('v0.1.2 复审修复', () => {
  it('序列预览：超长时在词边界截断并加省略号', () => {
    const text = 'Hi Felix, we make brass valves in Wenzhou and ship to German distributors. If you would rather not receive further emails just reply'
    const out = previewText(text, 100)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(101)
    expect(text.startsWith(out.slice(0, -1))).toBe(true)
    // 不在单词中间截断
    expect(text.charAt(out.length - 1)).toMatch(/\s|[.,]/)
    expect(previewText('short  text\nhere', 100)).toBe('short text here')
  })

  it('UK 这类非 ISO 两字母写法也能认出国家', () => {
    expect(countryCode('UK')).toBe('GB')
    expect(countryCode('GB')).toBe('GB')
    expect(countryCode('DE')).toBe('DE')
    expect(countryCode('ZZ')).toBeNull()
  })
})
