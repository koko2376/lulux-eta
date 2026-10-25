import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, buildUrl, onApiError, parseErrorBody, request, unwrapList, unwrapOne } from './http'
import { listProviders, parseSseBlock } from './index'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(status === 204 ? null : text, { status, headers }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('api/http request()', () => {
  beforeEach(() => {
    delete (window as { luluxAgent?: unknown }).luluxAgent
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('浏览器开发态不加 Authorization（交给 vite proxy）', async () => {
    const fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    const init = fetchFn.mock.calls[0][1]!
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('桌面端带 Bearer window.luluxAgent.apiToken', async () => {
    ;(window as { luluxAgent?: unknown }).luluxAgent = { apiToken: 'tok123', platform: 'win32', versions: {} }
    const fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    const init = fetchFn.mock.calls[0][1]!
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok123')
  })

  it('JSON body 自动序列化并设置 Content-Type，GET 不带 Content-Type', async () => {
    const fetchFn = mockFetch(201, { id: 'x' })
    await request('/api/customers', { method: 'POST', body: { company: 'A' } })
    const init = fetchFn.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"company":"A"}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    await request('/api/customers')
    const getInit = fetchFn.mock.calls[1][1]!
    expect((getInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('契约错误格式解析为 ApiError 并通知全局监听（toast）', async () => {
    mockFetch(409, { error: { code: 'KERNEL_UNAVAILABLE', message: 'Claude Code 未安装' } })
    const seen: ApiError[] = []
    const off = onApiError((e) => seen.push(e))
    await expect(request('/api/chat', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'KERNEL_UNAVAILABLE',
      message: 'Claude Code 未安装',
      status: 409,
    })
    expect(seen).toHaveLength(1)
    off()
  })

  it('silent: true 时不推送全局 toast', async () => {
    mockFetch(500, { error: { code: 'INTERNAL', message: 'boom' } })
    const listener = vi.fn()
    const off = onApiError(listener)
    await expect(request('/api/x', { silent: true })).rejects.toBeInstanceOf(ApiError)
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('网络错误给出可读中文信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    )
    await expect(request('/api/health', { silent: true })).rejects.toMatchObject({ code: 'NETWORK', status: 0 })
  })

  it('204 返回 undefined；text 模式返回原文', async () => {
    mockFetch(204, '')
    await expect(request('/api/x', { method: 'DELETE' })).resolves.toBeUndefined()
    mockFetch(200, '<html>q</html>')
    await expect(request('/api/quotes/1/html', { text: true })).resolves.toBe('<html>q</html>')
  })

  it('兼容旧服务端 { providers: [...] } 与契约新格式数组', async () => {
    mockFetch(200, { providers: [{ id: 'a' }] })
    expect(await listProviders()).toEqual([{ id: 'a' }])
    mockFetch(200, [{ id: 'b' }])
    expect(await listProviders()).toEqual([{ id: 'b' }])
  })
})

describe('api helpers', () => {
  it('parseErrorBody 兼容旧格式与非 JSON', () => {
    expect(parseErrorBody(400, '{"error":"name required"}').message).toBe('name required')
    expect(parseErrorBody(502, '<html>Bad gateway</html>').message).toBe('上游服务连接失败')
    expect(parseErrorBody(401, '').code).toBe('HTTP_401')
  })
  it('buildUrl 跳过空参数', () => {
    expect(buildUrl('/api/customers', { query: '', stage: 'won', page: 2, tag: undefined })).toBe(
      '/api/customers?stage=won&page=2',
    )
  })
  it('unwrapList / unwrapOne', () => {
    expect(unwrapList({ items: [1] }, 'items')).toEqual([1])
    expect(unwrapList(null, 'x')).toEqual([])
    expect(unwrapOne({ provider: { id: 1 } }, 'provider')).toEqual({ id: 1 })
    expect(unwrapOne({ id: 2 }, 'provider')).toEqual({ id: 2 })
  })
  it('parseSseBlock', () => {
    expect(parseSseBlock('event: delta\ndata: {"text":"hi"}')).toEqual({ event: 'delta', data: { text: 'hi' } })
    expect(parseSseBlock(': ping')).toBeNull()
  })
})

describe('团队服务器传输层', () => {
  afterEach(async () => {
    const { setTransport } = await import('./http')
    setTransport({ baseUrl: '', sessionToken: null, localSession: null })
    vi.unstubAllGlobals()
  })
  it('本机账户会话走 X-Lulux-Session，API token 照常；远程服务器不带本机会话', async () => {
    const { setTransport } = await import('./http')
    ;(window as { luluxAgent?: unknown }).luluxAgent = { apiToken: 'local-tok', platform: 'x', versions: {} }
    setTransport({ localSession: 'lls_abc' })
    const fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    const headers = fetchFn.mock.calls[0][1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer local-tok')
    expect(headers['X-Lulux-Session']).toBe('lls_abc')
    setTransport({ baseUrl: 'https://lulux.example.com', sessionToken: 'lxs_1' })
    await request('/api/health')
    expect((fetchFn.mock.calls[1][1]!.headers as Record<string, string>)['X-Lulux-Session']).toBeUndefined()
    delete (window as { luluxAgent?: unknown }).luluxAgent
  })
  it('本机需要登录（LOCAL_LOGIN_REQUIRED）时通知回登录页', async () => {
    const { onUnauthorized } = await import('./http')
    const seen: string[] = []
    const off = onUnauthorized((e) => seen.push(e.code))
    mockFetch(401, { error: { code: 'LOCAL_LOGIN_REQUIRED', message: '请先登录本机账户' } })
    await expect(request('/api/customers', { silent: true })).rejects.toBeInstanceOf(ApiError)
    await expect(request('/api/auth/me', { silent: true, noAuthRedirect: true })).rejects.toBeInstanceOf(ApiError)
    expect(seen).toEqual(['LOCAL_LOGIN_REQUIRED'])
    off()
  })
  it('远程模式拼接 baseUrl，并用会话 token 代替本地 token', async () => {
    const { setTransport } = await import('./http')
    ;(window as { luluxAgent?: unknown }).luluxAgent = { apiToken: 'local-tok', platform: 'x', versions: {} }
    setTransport({ baseUrl: 'https://lulux.example.com/', sessionToken: 'lxs_123' })
    const fetchFn = mockFetch(200, { ok: true })
    await request('/api/health')
    expect(fetchFn.mock.calls[0][0]).toBe('https://lulux.example.com/api/health')
    expect((fetchFn.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBe('Bearer lxs_123')
    delete (window as { luluxAgent?: unknown }).luluxAgent
  })
  it('会话过期 401 通知回登录页；无会话时不通知', async () => {
    const { setTransport, onUnauthorized } = await import('./http')
    const seen: string[] = []
    const off = onUnauthorized((e) => seen.push(e.code))
    mockFetch(401, { error: { code: 'SESSION_EXPIRED', message: '会话过期' } })
    await expect(request('/api/customers', { silent: true })).rejects.toBeInstanceOf(ApiError)
    expect(seen).toEqual([])
    setTransport({ sessionToken: 'lxs_1' })
    await expect(request('/api/customers', { silent: true })).rejects.toBeInstanceOf(ApiError)
    expect(seen).toEqual(['SESSION_EXPIRED'])
    off()
  })
})
