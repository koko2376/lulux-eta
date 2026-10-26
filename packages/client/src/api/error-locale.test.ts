import { afterEach, describe, expect, it, vi } from 'vitest'
import { labelled, setLanguage, withParen } from '../i18n'
import { localizeErrorMessage, parseErrorBody, request, setTransport } from './http'
import { parseSseBlock } from './index'

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const headersOf = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls[0][1]!.headers as Record<string, string>

describe('error messages follow the UI language', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setTransport({ baseUrl: '' })
    setLanguage('zh-CN')
  })

  it('sends the current locale on every request', async () => {
    setLanguage('en')
    let fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    expect(headersOf(fetchFn)['X-Lulux-Lang']).toBe('en')
    expect(headersOf(fetchFn)['Accept-Language']).toBe('en')

    setLanguage('zh-CN')
    fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    expect(headersOf(fetchFn)['X-Lulux-Lang']).toBe('zh-CN')
    expect(headersOf(fetchFn)['Accept-Language']).toBe('zh-CN')
  })

  it('only sends the CORS-safe Accept-Language to a remote server', async () => {
    setLanguage('en')
    setTransport({ baseUrl: 'https://lulux.example.com' })
    const fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    expect(headersOf(fetchFn)['Accept-Language']).toBe('en')
    expect(headersOf(fetchFn)['X-Lulux-Lang']).toBeUndefined()
  })

  it('keeps the server-translated message', () => {
    setLanguage('en')
    const error = parseErrorBody(404, JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }))
    expect(error.message).toBe('Customer not found')
  })

  it('replaces Chinese messages from older servers by error code in English', () => {
    setLanguage('en')
    const error = parseErrorBody(
      401,
      JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '登录已过期，请重新登录' } }),
    )
    expect(error.message).toBe('Your session has expired; please sign in again')
    // unknown codes keep the original text rather than hiding it
    expect(localizeErrorMessage('SOMETHING_NEW', '新的错误')).toBe('新的错误')
    setLanguage('zh-CN')
    expect(localizeErrorMessage('SESSION_EXPIRED', '登录已过期，请重新登录')).toBe('登录已过期，请重新登录')
  })

  it('formats composed messages without Chinese punctuation in English', () => {
    setLanguage('en')
    expect(withParen('Add a provider', 'Settings → Models')).toBe('Add a provider (Settings → Models)')
    expect(labelled('Codex', 'failed')).toBe('Codex: failed')
    setLanguage('zh-CN')
    expect(withParen('请先添加', '设置')).toBe('请先添加（设置）')
    expect(labelled('Codex', '运行失败')).toBe('Codex：运行失败')
  })

  it('parses SSE blocks unchanged', () => {
    expect(parseSseBlock('event: error\ndata: {"code":"X","message":"m"}')).toEqual({
      event: 'error',
      data: { code: 'X', message: 'm' },
    })
  })
})
