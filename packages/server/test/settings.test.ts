import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(() => server.close())

describe('设置白名单与运行时校验', () => {
  it('GET /api/settings/schema 返回 {key,type,default,enum?}[]', async () => {
    const res = await server.request('GET', '/api/settings/schema')
    expect(res.status).toBe(200)
    const keys = res.json.map((item: { key: string }) => item.key)
    expect(keys).toEqual(
      expect.arrayContaining(['theme', 'language', 'contextLimit', 'toolApproval', 'allowMcpWithoutNativeConfirm']),
    )
    const theme = res.json.find((item: { key: string }) => item.key === 'theme')
    expect(theme).toMatchObject({ type: 'enum', default: 'dark', enum: ['dark', 'light', 'system'] })
    expect(res.json.find((item: { key: string }) => item.key === 'allowMcpWithoutNativeConfirm').default).toBe('0')
  })

  it('GET /api/settings 只返回白名单键，带默认值', async () => {
    const res = await server.request('GET', '/api/settings')
    expect(res.json.settings).toMatchObject({ toolApproval: 'ask', contextLimit: '40', defaultAgentId: 'builtin' })
  })

  it('未知键 → 400 UNKNOWN_SETTING，且不写入', async () => {
    const res = await server.request('PATCH', '/api/settings', { body: { evilKey: '1', theme: 'light' } })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('UNKNOWN_SETTING')
    const after = await server.request('GET', '/api/settings')
    expect(after.json.settings.theme).toBe('dark')
    expect(after.json.settings.evilKey).toBeUndefined()
  })

  it.each([
    [{ toolApproval: 'yolo' }],
    [{ contextLimit: 1 }],
    [{ contextLimit: '9999' }],
    [{ contextLimit: 'abc' }],
    [{ webhookEnabled: 'maybe' }],
    [{ theme: 3 }],
    [{ proxyUrl: 'file:///etc/passwd' }],
    [{ proxyUrl: 'socks5://127.0.0.1:1080' }],
    [{ webhookUrl: 'javascript:alert(1)' }],
    [{ defaultAgentId: 'nobody' }],
    [{ defaultProviderId: 'prov_missing' }],
  ])('非法值 %j → 400', async (patch) => {
    const res = await server.request('PATCH', '/api/settings', { body: patch })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toMatch(/INVALID_SETTING|INVALID_URL/)
  })

  it('合法值被规范化：布尔、整数、代理补协议、旧 Agent id 映射', async () => {
    const res = await server.request('PATCH', '/api/settings', {
      body: { webhookEnabled: true, contextLimit: 20, proxyUrl: '127.0.0.1:7890', defaultAgentId: 'hermes', theme: 'light' },
    })
    expect(res.status).toBe(200)
    expect(res.json.settings).toMatchObject({
      webhookEnabled: '1',
      contextLimit: '20',
      proxyUrl: 'http://127.0.0.1:7890',
      defaultAgentId: 'builtin',
      theme: 'light',
    })
  })

  it('请求体不是对象 → 400', async () => {
    const res = await server.request('PATCH', '/api/settings', { body: ['theme'] })
    expect(res.status).toBe(400)
  })
})
