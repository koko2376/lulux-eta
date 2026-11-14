import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * 关联设备接口 + 假引擎的端到端测试。
 * 全程不联网：`LULUX_WHATSAPP_ENGINE=fake` 只驱动状态机与 SSE。
 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    LULUX_WHATSAPP_ENGINE: 'fake',
  })
  process.env.LULUX_WHATSAPP_DIR = `${server.home}/whatsapp`
})

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  delete process.env.LULUX_WHATSAPP_FAKE_DISCONNECT_AFTER_MS
  delete process.env.LULUX_WHATSAPP_ENGINE_DIR
  process.env.LULUX_WHATSAPP_ENGINE = 'fake'
  await server.close()
})

async function api(method: string, path: string, body?: unknown) {
  return server.request(method, path, body === undefined ? {} : { body })
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T
  do {
    last = await fn()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error(`condition not met before timeout; last=${JSON.stringify(last)}`)
}

async function status() {
  const res = await api('GET', '/api/whatsapp/status')
  expect(res.status, res.text).toBe(200)
  return res.json
}

interface EventStream {
  next(name: string, timeout?: number): Promise<any>
  close(): void
}

async function openEvents(): Promise<EventStream> {
  const controller = new AbortController()
  const response = await fetch(`${server.base}/api/events`, {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    signal: controller.signal,
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const next = async (name: string, timeout = 4000): Promise<any> => {
    const deadline = Date.now() + timeout
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        if (event === name) {
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n')
          return data ? JSON.parse(data) : null
        }
        continue
      }
      if (Date.now() >= deadline) throw new Error(`SSE event ${name} not received`)
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`SSE closed while waiting for ${name}`)
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }

  return {
    next,
    close: () => {
      controller.abort()
      reader.cancel().catch(() => {})
    },
  }
}

describe('WhatsApp 关联设备接口', () => {
  it('初始状态：未绑定、引擎为注入的 fake、限制说明齐全', async () => {
    const state = await status()
    expect(state).toMatchObject({
      phase: 'unbound',
      connection: 'disconnected',
      mode: null,
      account: null,
      qr: null,
      pairing: null,
      engine: { id: 'fake', installed: true },
      risk: { accepted: false },
      limits: { linkedDevices: 4, phoneOfflineDays: 14, deviceIdleDays: 30 },
    })
  })

  it('未确认风险不能开始绑定', async () => {
    const res = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('RISK_ACCEPTANCE_REQUIRED')
    expect((await status()).phase).toBe('unbound')
  })

  it('扫码：风险确认 → QR 事件 → 刷新二维码换图且计数增加', async () => {
    const accepted = await api('POST', '/api/whatsapp/risk-acceptance')
    expect(accepted.status, accepted.text).toBe(200)
    expect(accepted.json.risk.accepted).toBe(true)

    const events = await openEvents()
    try {
      const started = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
      expect(started.status, started.text).toBe(200)
      const first = await events.next('whatsapp.qr')
      expect(first.dataUrl).toMatch(/^data:image\/png;base64,/)
      expect(first.expiresAt - first.issuedAt).toBe(20_000)

      const firstStatus = await status()
      expect(firstStatus.phase).toBe('waiting_qr')
      expect(firstStatus.connection).toBe('connecting')
      expect(firstStatus.qr.refreshCount).toBe(1)

      const refreshed = await api('POST', '/api/whatsapp/link/refresh-qr')
      expect(refreshed.status, refreshed.text).toBe(200)
      const second = await events.next('whatsapp.qr')
      expect(second.dataUrl).not.toBe(first.dataUrl)
      expect(second.refreshCount).toBe(2)
    } finally {
      events.close()
      await api('POST', '/api/whatsapp/link/stop')
    }
  })

  it('配对码：未开始绑定时可直接申请；8 位、只回内存；手机号不合法给出明确错误', async () => {
    const invalid = await api('POST', '/api/whatsapp/link/start', { mode: 'pairing', phone: '13800138000' })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error.code).toBe('PAIRING_INVALID_PHONE')

    // 契约 §12.2：没有绑定会话时等价于 link/start 的 pairing 模式
    const started = await api('POST', '/api/whatsapp/link/pairing-code', {
      phone: '+86 138-0013-8000',
    })
    expect(started.status, started.text).toBe(200)
    const state = await waitFor(status, (value) => value.phase === 'waiting_pairing' && value.pairing?.code)
    expect(state.pairing.code).toMatch(/^[A-Z0-9]{8}$/)
    expect(state.pairing.phone).toBe('8613800138000')
    expect(state.pairing.expiresAt - state.pairing.issuedAt).toBe(240_000)

    const badPhone = await api('POST', '/api/whatsapp/link/pairing-code', { phone: '+86 000' })
    expect(badPhone.status).toBe(400)
    expect(badPhone.json.error.code).toBe('PAIRING_INVALID_PHONE')
  })

  it('扫码确认 → 已连接 → 凭据 0600；解绑必须二次确认并删除凭据', async () => {
    await api('POST', '/api/whatsapp/link/stop')
    process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS = '40'
    const started = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(started.status, started.text).toBe(200)
    const connected = await waitFor(status, (value) => value.phase === 'connected')
    expect(connected.account.phone).toBe('+8613800138000')
    expect(connected.connection).toBe('connected')

    const accountFile = `${server.home}/whatsapp/sessions/default/account.json`
    expect(existsSync(accountFile)).toBe(true)
    const { statSync, readFileSync } = await import('node:fs')
    expect((statSync(accountFile).mode & 0o777).toString(8)).toBe('600')
    expect(JSON.parse(readFileSync(accountFile, 'utf8')).ownerId).toBe('local')

    const refused = await api('POST', '/api/whatsapp/logout', {})
    expect(refused.status).toBe(400)
    expect(refused.json.error.code).toBe('CONFIRMATION_REQUIRED')
    expect((await status()).phase).toBe('connected')

    const unlinked = await api('POST', '/api/whatsapp/logout', { confirm: true })
    expect(unlinked.status, unlinked.text).toBe(200)
    expect(unlinked.json).toMatchObject({ phase: 'unbound', account: null })
    expect(existsSync(`${server.home}/whatsapp/sessions/default`)).toBe(false)
    delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  })

  it('手机端登出（401）→ reauth，且本地凭据立即作废', async () => {
    process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS = '30'
    process.env.LULUX_WHATSAPP_FAKE_DISCONNECT_AFTER_MS = '50'
    const started = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(started.status, started.text).toBe(200)
    const reauth = await waitFor(status, (value) => value.phase === 'reauth')
    expect(reauth).toMatchObject({
      connection: 'reauth',
      error: { code: 'AUTH_LOGGED_OUT' },
    })
    expect(existsSync(`${server.home}/whatsapp/sessions/default`)).toBe(false)
    delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
    delete process.env.LULUX_WHATSAPP_FAKE_DISCONNECT_AFTER_MS
  })

  it('引擎缺失：返回 ENGINE_NOT_INSTALLED，界面可见、不静默回退', async () => {
    await api('POST', '/api/whatsapp/link/stop')
    process.env.LULUX_WHATSAPP_ENGINE = 'baileys'
    process.env.LULUX_WHATSAPP_ENGINE_DIR = `${server.home}/no-engine-here`
    const res = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('ENGINE_NOT_INSTALLED')
    const state = await status()
    expect(state.engine).toMatchObject({ installed: false, error: { code: 'ENGINE_NOT_INSTALLED' } })
    expect(state.phase).toBe('failed')
    expect(state.error.code).toBe('ENGINE_NOT_INSTALLED')

    process.env.LULUX_WHATSAPP_ENGINE = 'fake'
    delete process.env.LULUX_WHATSAPP_ENGINE_DIR
  })

  it('引擎不完整（缺 qrcode）：返回 ENGINE_LOAD_FAILED，不静默回退', async () => {
    await api('POST', '/api/whatsapp/link/stop')
    const broken = join(server.home, 'broken-engine')
    const baileys = join(broken, 'node_modules', 'baileys')
    mkdirSync(baileys, { recursive: true })
    writeFileSync(join(baileys, 'package.json'), JSON.stringify({ name: 'baileys', version: '0.0.0-broken-test' }))
    process.env.LULUX_WHATSAPP_ENGINE = 'baileys'
    process.env.LULUX_WHATSAPP_ENGINE_DIR = broken

    const res = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('ENGINE_LOAD_FAILED')
    const state = await status()
    expect(state.engine).toMatchObject({ installed: true, qrAvailable: false })
    expect(state.phase).toBe('failed')
    expect(state.error.code).toBe('ENGINE_LOAD_FAILED')
    expect(state.qr).toBeNull()

    process.env.LULUX_WHATSAPP_ENGINE = 'fake'
    delete process.env.LULUX_WHATSAPP_ENGINE_DIR
  })
})
