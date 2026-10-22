import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorText, uiState } from '../stores/ui'
import { ApiError, request } from './http'

/** 契约 §10.9：错误响应的 X-Request-Id 进入 ApiError，并出现在报错文字里便于排查 */
describe('X-Request-Id', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('错误响应把 X-Request-Id 带进 ApiError 与 errorText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNREACHABLE', message: '无法连接到上游' } }), {
            status: 502,
            headers: { 'X-Request-Id': 'req_0123456789abcdef' },
          }),
      ),
    )
    const err = (await request('/api/providers/p1/discover-models', { method: 'POST', silent: true }).catch(
      (e) => e,
    )) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.message).toBe('无法连接到上游')
    expect(err.requestId).toBe('req_0123456789abcdef')
    expect(errorText(err)).toContain('req_0123456789abcdef')
  })

  it('跨源拿不到头时 requestId 为空，文字里不出现空的请求 ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    )
    const err = (await request('/api/x', { silent: true }).catch((e) => e)) as ApiError
    expect(err.requestId).toBe('')
    expect(errorText(err)).toBe(err.message)
    expect(err.message).not.toBe('')
  })

  it('toastError 把请求 ID 放进 toast', async () => {
    const { toastError } = await import('../stores/ui')
    toastError(new ApiError('X', '出错了', 500, 'req_aaaaaaaaaaaaaaaa'))
    expect(uiState.toasts.at(-1)).toMatchObject({ kind: 'error', message: '出错了', requestId: 'req_aaaaaaaaaaaaaaaa' })
  })
})
