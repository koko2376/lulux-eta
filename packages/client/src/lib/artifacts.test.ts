import { describe, expect, it } from 'vitest'
import { ARTIFACT_CSP, withArtifactCsp } from './artifacts'

describe('产物预览 CSP', () => {
  it('注入在 <head> 最前面', () => {
    const out = withArtifactCsp('<html><head><script>x()</script></head><body></body></html>')
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script>'))
  })
  it('没有 head 时补齐文档结构', () => {
    expect(withArtifactCsp('<p>hi</p>')).toContain(`content="${ARTIFACT_CSP}"`)
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
  })
})
