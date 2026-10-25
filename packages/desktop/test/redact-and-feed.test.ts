import { describe, expect, it } from 'vitest'
import { redactLine } from '../src/diagnostics'
import { normalizeFeedUrl } from '../src/update-source'

const HEX = 'c0ffee'.repeat(10) + 'abcd'

describe('诊断包脱敏补全', () => {
  it('本机会话 lls_<64hex> 被脱敏（含 JSON 里键名不带 token 字样的情况）', () => {
    expect(redactLine(`X-Lulux-Session: lls_${HEX}`)).not.toContain(HEX)
    expect(redactLine(`{"localSession":"lls_${HEX}"}`)).not.toContain(HEX)
    expect(redactLine(`team lxs_${HEX}`)).not.toContain(HEX)
  })
  it('常见第三方密钥形态被脱敏', () => {
    const samples = ['AIzaSyD' + 'x'.repeat(32), 'ghp_' + 'A1b2'.repeat(9), ['xoxb', '1234567890', '1234567890', 'a'.repeat(24)].join('-')]
    for (const secret of samples) expect(redactLine(`key ${secret}`)).not.toContain(secret)
  })
  it('大写 64 位十六进制也脱敏；更长的十六进制串（例如哈希）不被截成一段', () => {
    expect(redactLine(`k ${HEX.toUpperCase()}`)).not.toContain(HEX.toUpperCase())
    expect(redactLine(`LULUX_MASTER_KEY=${HEX}`)).not.toContain(HEX)
    const longer = 'ab'.repeat(40)
    expect(redactLine(`sha ${longer}`)).toContain(longer)
  })
})

describe('自定义更新源只允许 https', () => {
  it('公网 http 被拒绝，https 与本机回环 http 通过', () => {
    expect(() => normalizeFeedUrl('http://mirror.example.com/lulux')).toThrow(/https/)
    expect(normalizeFeedUrl('https://mirror.example.com/lulux')).toBe('https://mirror.example.com/lulux/')
    expect(normalizeFeedUrl('http://127.0.0.1:8080/feed')).toBe('http://127.0.0.1:8080/feed/')
    expect(normalizeFeedUrl('http://localhost/feed/')).toBe('http://localhost/feed/')
    expect(() => normalizeFeedUrl('ftp://mirror.example.com/')).toThrow()
  })
})
