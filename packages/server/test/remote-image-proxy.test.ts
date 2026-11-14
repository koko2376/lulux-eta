import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 远程图片代理的 SSRF / 超时 / 类型校验。
 * undici 与 DNS 用 vi.mock 替换：只验证代理自身的策略，不依赖外网。
 */
const { fetchMock, dnsLookupMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  dnsLookupMock: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('undici', () => ({
  Agent: class Agent {
    constructor(_options?: unknown) {}
  },
  fetch: (...args: unknown[]) => fetchMock(...args),
}))

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...(args as [])),
}))

const { clearRemoteImageCache, remoteImageProxy } = await import('../src/services/email/remote-image-proxy.js')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PUBLIC_URL = 'https://cdn.example.com/a.png'

async function errorCode(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return 'OK'
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message
  }
}

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null }
}

function imageResponse(options: { contentType?: string; body?: Buffer; contentLength?: number } = {}) {
  const body = options.body ?? PNG
  const contentType = options.contentType ?? 'image/png'
  let sent = false
  return {
    status: 200,
    ok: true,
    headers: headers({
      'content-type': contentType,
      'content-length': String(options.contentLength ?? body.length),
    }),
    body: {
      cancel: async () => undefined,
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: new Uint8Array(body) }
        },
        releaseLock: () => undefined,
      }),
    },
  }
}

function redirectResponse(location: string) {
  return {
    status: 302,
    ok: false,
    headers: headers({ location }),
    body: { cancel: async () => undefined },
  }
}

beforeEach(() => {
  clearRemoteImageCache()
  fetchMock.mockReset()
  dnsLookupMock.mockReset()
  dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

describe('远程图片代理：地址校验', () => {
  it('只接受 http/https，且不允许用户名密码', async () => {
    expect(await errorCode(remoteImageProxy.fetch('file:///etc/passwd'))).toBe('IMAGE_URL_INVALID')
    expect(await errorCode(remoteImageProxy.fetch('ftp://cdn.example.com/a.png'))).toBe('IMAGE_URL_INVALID')
    expect(await errorCode(remoteImageProxy.fetch('https://user:pw@cdn.example.com/a.png'))).toBe('IMAGE_URL_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本机 / 内网 / 链路本地 / 元数据地址一律拒绝', async () => {
    for (const url of [
      'http://localhost/a.png',
      'http://127.0.0.1/a.png',
      'http://[::1]/a.png',
      'http://10.0.0.8/a.png',
      'http://172.16.3.4/a.png',
      'http://192.168.1.2/a.png',
      'http://169.254.169.254/latest/meta-data/a.png',
    ]) {
      expect(await errorCode(remoteImageProxy.fetch(url)), url).toBe('IMAGE_URL_BLOCKED')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('域名解析到内网地址时拒绝（DNS 层）', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_URL_BLOCKED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('重定向到内网地址时拒绝（逐跳校验）', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('http://10.0.0.1/secret.png'))
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_URL_BLOCKED')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('远程图片代理：下载与类型', () => {
  it('正常 PNG 返回 data URL 与归一化 MIME', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse())
    const image = await remoteImageProxy.fetch(PUBLIC_URL)
    expect(image.contentType).toBe('image/png')
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(image.buffer.equals(PNG)).toBe(true)
  })

  it('声明 SVG 或内容与 MIME 不一致时拒绝', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse({ contentType: 'image/svg+xml' }))
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_BAD_TYPE')
    clearRemoteImageCache()
    fetchMock.mockResolvedValueOnce(imageResponse({ contentType: 'image/png', body: Buffer.from('<svg/>') }))
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_BAD_TYPE')
  })

  it('超过单图上限时拒绝', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse({ contentLength: 5 * 1024 * 1024 }))
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_TOO_LARGE')
  })

  it('超时映射为 IMAGE_PROXY_TIMEOUT', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
    expect(await errorCode(remoteImageProxy.fetch(PUBLIC_URL))).toBe('IMAGE_PROXY_TIMEOUT')
  })

  it('成功结果走缓存，重复请求不再下载', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse())
    await remoteImageProxy.fetch(PUBLIC_URL)
    await remoteImageProxy.fetch(PUBLIC_URL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
