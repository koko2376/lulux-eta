import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * WhatsApp 会话/消息存储、收发闭环、发送失败重试、翻译输入。
 * 全程离线：假 WhatsApp 引擎 + 假翻译器，不下载模型、不联网。
 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    LULUX_WHATSAPP_ENGINE: 'fake',
    LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS: '10',
    LULUX_WHATSAPP_FAKE_REPLY_AFTER_MS: '10',
    LULUX_WHATSAPP_TRANSLATOR: 'fake',
  })
})

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  delete process.env.LULUX_WHATSAPP_FAKE_REPLY_AFTER_MS
  delete process.env.LULUX_WHATSAPP_FAKE_SEND_FAIL_TIMES
  delete process.env.LULUX_WHATSAPP_FAKE_INBOUND_AFTER_MS
  delete process.env.LULUX_WHATSAPP_TRANSLATOR_DIR
  process.env.LULUX_WHATSAPP_ENGINE = 'fake'
  process.env.LULUX_WHATSAPP_TRANSLATOR = 'fake'
  await server.close()
})

async function api(method: string, path: string, body?: unknown) {
  return server.request(method, path, body === undefined ? {} : { body })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T
  do {
    last = await fn()
    if (predicate(last)) return last
    await sleep(20)
  } while (Date.now() < deadline)
  throw new Error(`condition not met before timeout; last=${JSON.stringify(last)}`)
}

async function status() {
  const res = await api('GET', '/api/whatsapp/status')
  expect(res.status, res.text).toBe(200)
  return res.json
}

async function connect(): Promise<void> {
  const accepted = await api('POST', '/api/whatsapp/risk-acceptance')
  expect(accepted.status, accepted.text).toBe(200)
  const started = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
  expect(started.status, started.text).toBe(200)
  await waitFor(status, (value) => value.phase === 'connected')
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
  const next = async (name: string, timeout = 4_000): Promise<any> => {
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

describe('WhatsApp 会话/消息存储', () => {
  it('迁移 38 建表，按 owner 隔离并支持游标分页', async () => {
    const { db } = await import('../src/db.js')
    const version = db
      .prepare("SELECT name FROM schema_migrations WHERE version = 38")
      .get() as unknown as { name: string } | undefined
    expect(version?.name).toBe('whatsapp_conversations_and_messages')

    const store = await import('../src/services/whatsapp/store.js')
    const owner = 'storage-test-owner'
    const conversation = store.ensureConversation({
      ownerId: owner,
      orgId: 'local',
      remoteJid: '8613900000001@s.whatsapp.net',
      phone: '+8613900000001',
      displayName: '存储测试客户',
    })
    expect(conversation.displayName).toBe('存储测试客户')

    const first = store.recordIncomingMessage({
      id: 'storage-in-1',
      remoteJid: conversation.remoteJid,
      phone: conversation.phone,
      displayName: '存储测试客户',
      text: '第一条',
      timestamp: Date.now() - 2_000,
      ownerId: owner,
      orgId: 'local',
    })
    const second = store.recordIncomingMessage({
      id: 'storage-in-2',
      remoteJid: conversation.remoteJid,
      phone: conversation.phone,
      displayName: '存储测试客户',
      text: '第二条',
      timestamp: Date.now() - 1_000,
      ownerId: owner,
      orgId: 'local',
    })
    expect(first.message.status).toBe('received')
    expect(second.conversation.unreadCount).toBe(2)

    // 同一引擎消息 id 不重复入库、不重复计数
    const duplicate = store.recordIncomingMessage({
      id: 'storage-in-2',
      remoteJid: conversation.remoteJid,
      phone: conversation.phone,
      displayName: '存储测试客户',
      text: '第二条',
      timestamp: Date.now(),
      ownerId: owner,
      orgId: 'local',
    })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.conversation.unreadCount).toBe(2)

    const page = store.listMessages(owner, conversation.id, { limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe(page.items[0]!.id)
    const older = store.listMessages(owner, conversation.id, {
      limit: 10,
      before: page.nextCursor,
    })
    expect(older.items.map((item) => item.body)).toEqual(['第一条'])
    expect(older.hasMore).toBe(false)

    // 别的 owner 读不到
    expect(store.listConversations('other-owner').total).toBe(0)
    expect(store.listMessages('other-owner', conversation.id).items).toHaveLength(0)
    expect(store.findConversation('other-owner', conversation.id)).toBeNull()
  })
})

describe('WhatsApp 收发与翻译接口', () => {
  it('翻译引擎缺失：显式 503 TRANSLATOR_NOT_INSTALLED，绝不返回原文冒充译文', async () => {
    delete process.env.LULUX_WHATSAPP_TRANSLATOR
    process.env.LULUX_WHATSAPP_TRANSLATOR_DIR = `${server.home}/no-translator-here`
    const res = await api('POST', '/api/whatsapp/translate', { text: '你好', targetLang: 'en' })
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('TRANSLATOR_NOT_INSTALLED')
    expect(res.json.error.message).not.toBe('你好')
    expect(res.json.error.details?.installHint).toContain('WHATSAPP-TRANSLATOR')
    process.env.LULUX_WHATSAPP_TRANSLATOR = 'fake'
    delete process.env.LULUX_WHATSAPP_TRANSLATOR_DIR
  })

  it('假翻译器：默认目标 en；auto 可选且解析为具体语言', async () => {
    const english = await api('POST', '/api/whatsapp/translate', {
      text: '你好，我想咨询一下产品报价。',
      targetLang: 'en',
    })
    expect(english.status, english.text).toBe(200)
    expect(english.json).toMatchObject({
      provider: 'fake',
      kind: 'local',
      targetLang: 'en',
      text: 'Hello, I would like to ask about your product quotation.',
    })

    const auto = await api('POST', '/api/whatsapp/translate', {
      text: '你好，我想咨询一下产品报价。',
      targetLang: 'auto',
    })
    expect(auto.status, auto.text).toBe(200)
    expect(auto.json.requestedTarget).toBe('auto')
    expect(auto.json.targetLang).toBe('zh-Hans')

    const invalid = await api('POST', '/api/whatsapp/translate', { text: '你好', targetLang: 'xx' })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error.code).toBe('TRANSLATION_INVALID_TARGET')
  })

  it('绑定后：建会话 → 发送文本 → 收到回复 → 未读/预览/已读 → SSE 送达', async () => {
    await connect()
    const created = await api('POST', '/api/whatsapp/conversations', {
      phone: '+86 138-0013-8001',
      displayName: '测试客户',
    })
    expect(created.status, created.text).toBe(201)
    const conversationId = created.json.id
    expect(created.json).toMatchObject({
      phone: '+8613800138001',
      remoteJid: '8613800138001@s.whatsapp.net',
      unreadCount: 0,
    })

    const events = await openEvents()
    try {
      const sent = await api('POST', `/api/whatsapp/conversations/${conversationId}/messages`, {
        text: '你好',
      })
      expect(sent.status, sent.text).toBe(201)
      expect(sent.json).toMatchObject({ direction: 'out', status: 'sent', body: '你好' })

      // 出站先发送中、再已发送，随后是对方回复（假引擎回环）
      const sending = await events.next('whatsapp.message')
      const delivered = await events.next('whatsapp.message')
      const reply = await events.next('whatsapp.message')
      expect([sending.status, delivered.status, reply.status]).toEqual([
        'sending',
        'sent',
        'received',
      ])
      expect(reply).toMatchObject({
        direction: 'in',
        body: '收到：你好',
        conversationId,
      })

      const list = await waitFor(
        () => api('GET', '/api/whatsapp/conversations'),
        (res) => res.json.items.some((item: any) => item.unreadCount === 1),
      )
      const item = list.json.items.find((value: any) => value.id === conversationId)
      expect(item).toMatchObject({
        displayName: '测试客户',
        lastMessageDirection: 'in',
        lastMessagePreview: '收到：你好',
        unreadCount: 1,
      })

      const history = await api(
        'GET',
        `/api/whatsapp/conversations/${conversationId}/messages?limit=10`,
      )
      expect(history.status, history.text).toBe(200)
      expect(history.json.items.map((message: any) => message.body)).toEqual(['你好', '收到：你好'])

      const read = await api('POST', `/api/whatsapp/conversations/${conversationId}/read`)
      expect(read.status, read.text).toBe(200)
      expect(read.json.unreadCount).toBe(0)
    } finally {
      events.close()
    }
  })

  it('列表分页：limit/offset 与 hasMore 正确', async () => {
    const second = await api('POST', '/api/whatsapp/conversations', {
      phone: '+8613800138002',
      displayName: '第二位客户',
    })
    expect(second.status, second.text).toBe(201)

    const page = await api('GET', '/api/whatsapp/conversations?limit=1&offset=0')
    expect(page.status, page.text).toBe(200)
    expect(page.json.items).toHaveLength(1)
    expect(page.json.total).toBe(2)
    expect(page.json.hasMore).toBe(true)

    const next = await api('GET', '/api/whatsapp/conversations?limit=1&offset=1')
    expect(next.status, next.text).toBe(200)
    expect(next.json.items).toHaveLength(1)
    expect(next.json.items[0].id).not.toBe(page.json.items[0].id)
  })

  it('发送失败：标记 failed + 失败原因；重试走同一行并成功', async () => {
    await api('POST', '/api/whatsapp/link/stop')
    process.env.LULUX_WHATSAPP_FAKE_SEND_FAIL_TIMES = '1'
    process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS = '10'
    await connect()

    const created = await api('POST', '/api/whatsapp/conversations', {
      phone: '+8613800138003',
      displayName: '重试客户',
    })
    expect(created.status, created.text).toBe(201)
    const conversationId = created.json.id

    const failed = await api('POST', `/api/whatsapp/conversations/${conversationId}/messages`, {
      text: '这条会失败',
    })
    expect(failed.status).toBe(502)
    expect(failed.json.error.code).toBe('WHATSAPP_SEND_FAILED')
    expect(failed.json.error.details?.messageId).toBeTruthy()

    const history = await api(
      'GET',
      `/api/whatsapp/conversations/${conversationId}/messages?limit=10`,
    )
    const failedMessage = history.json.items.at(-1)
    expect(failedMessage).toMatchObject({ direction: 'out', status: 'failed', body: '这条会失败' })
    expect(failedMessage.failureReason).toContain('模拟发送失败')

    const retried = await api('POST', `/api/whatsapp/messages/${failedMessage.id}/retry`)
    expect(retried.status, retried.text).toBe(200)
    expect(retried.json).toMatchObject({ id: failedMessage.id, status: 'sent', body: '这条会失败' })
    expect(retried.json.failureReason).toBeNull()

    process.env.LULUX_WHATSAPP_FAKE_SEND_FAIL_TIMES = '0'
  })

  it('未连接发送：明确 409 WHATSAPP_NOT_CONNECTED，不落消息', async () => {
    const list = await api('GET', '/api/whatsapp/conversations')
    const conversationId = list.json.items[0].id
    const before = await api('GET', `/api/whatsapp/conversations/${conversationId}/messages?limit=100`)
    const outboundCount = before.json.items.filter((item: any) => item.direction === 'out').length

    await api('POST', '/api/whatsapp/link/stop')
    const res = await api('POST', `/api/whatsapp/conversations/${conversationId}/messages`, {
      text: '未连接时不能发送',
    })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WHATSAPP_NOT_CONNECTED')

    const after = await api('GET', `/api/whatsapp/conversations/${conversationId}/messages?limit=100`)
    expect(after.json.items.filter((item: any) => item.direction === 'out').length).toBe(outboundCount)
  })

  it('引擎缺失时发送同样明确报错，不静默丢弃', async () => {
    process.env.LULUX_WHATSAPP_ENGINE = 'baileys'
    process.env.LULUX_WHATSAPP_ENGINE_DIR = `${server.home}/missing-engine`
    const started = await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })
    expect(started.status).toBe(503)
    expect(started.json.error.code).toBe('ENGINE_NOT_INSTALLED')

    const list = await api('GET', '/api/whatsapp/conversations')
    const res = await api('POST', `/api/whatsapp/conversations/${list.json.items[0].id}/messages`, {
      text: '引擎缺失时不能发送',
    })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WHATSAPP_NOT_CONNECTED')
    expect(res.json.error.message).toContain('未发送')

    process.env.LULUX_WHATSAPP_ENGINE = 'fake'
    delete process.env.LULUX_WHATSAPP_ENGINE_DIR
  })
})
