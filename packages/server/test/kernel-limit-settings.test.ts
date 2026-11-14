/**
 * 服务端一侧：CLI 内核运行限制设置（kernelIdleTimeoutSeconds / kernelMaxRunMinutes）。
 * 设置界面读 schema 拿范围与默认值，所以 schema 必须带上 min / max / default；
 * 非整数、越界一律 400 INVALID_SETTING，且不写入；0 = 不限制，下一次内核运行按它算。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

let server: TestServer
beforeAll(async () => {
  server = await startTestServer()
})
afterAll(() => server.close())

const IDLE = 'kernelIdleTimeoutSeconds'
const MAXRUN = 'kernelMaxRunMinutes'

describe('内核运行限制设置', () => {
  it('schema 里两个键带默认值与合法范围', async () => {
    const res = await server.request('GET', '/api/settings/schema')
    expect(res.status).toBe(200)
    const idle = res.json.find((item: { key: string }) => item.key === IDLE)
    const maxRun = res.json.find((item: { key: string }) => item.key === MAXRUN)
    expect(idle).toMatchObject({ type: 'integer', default: '600', min: 0, max: 86400 })
    expect(maxRun).toMatchObject({ type: 'integer', default: '60', min: 0, max: 1440 })
  })

  it.each([
    [{ [IDLE]: 'abc' }],
    [{ [IDLE]: 60.5 }],
    [{ [IDLE]: -1 }],
    [{ [IDLE]: 86401 }],
    [{ [MAXRUN]: '' }],
    [{ [MAXRUN]: '30m' }],
    [{ [MAXRUN]: 1441 }],
    [{ [MAXRUN]: -5 }],
  ])('非法值 %j → 400 INVALID_SETTING，且不写入', async (patch) => {
    const res = await server.request('PATCH', '/api/settings', { body: patch })
    expect(res.status, res.text).toBe(400)
    expect(res.json.error.code).toBe('INVALID_SETTING')
  })

  it('越界被拒后原来的值没变', async () => {
    await server.request('PATCH', '/api/settings', { body: { [IDLE]: 300, [MAXRUN]: 20 } })
    const bad = await server.request('PATCH', '/api/settings', { body: { [MAXRUN]: 5000 } })
    expect(bad.status).toBe(400)
    const after = await server.request('GET', '/api/settings')
    expect(after.json.settings[IDLE]).toBe('300')
    expect(after.json.settings[MAXRUN]).toBe('20')
  })

  it('写进去的值下一次内核运行就生效；0 表示不限制', async () => {
    const { kernelTimeouts } = await import('../src/services/kernels/kernel-runner.js')
    expect((await server.request('PATCH', '/api/settings', { body: { [IDLE]: 45, [MAXRUN]: 0 } })).status).toBe(200)
    expect(kernelTimeouts()).toEqual({ idleMs: 45_000, totalMs: 0 })
    expect((await server.request('PATCH', '/api/settings', { body: { [IDLE]: 0, [MAXRUN]: 90 } })).status).toBe(200)
    expect(kernelTimeouts()).toEqual({ idleMs: 0, totalMs: 90 * 60_000 })
  })
})
