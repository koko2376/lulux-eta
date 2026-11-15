import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'
import {
  JidResolver,
  contentOf,
  mapHistorySet,
  mapRawMessage,
  timestampOf,
} from '../src/services/whatsapp/message-mapper.js'
import { FAKE_HISTORY_CUSTOMER, FAKE_HISTORY_LID_CUSTOMER } from '../src/services/whatsapp/fake-history.js'

/** 绑定后自动导入近 90 天聊天记录：映射函数单测 + 假引擎端到端（去重、方向、时间、联系人名、进度）。 */

const DAY = 86_400_000

describe('WhatsApp 消息映射', () => {
  it('时间戳：秒 / 毫秒 / 字符串 / Long 都转成毫秒', () => {
    expect(timestampOf(1_700_000_000)).toBe(1_700_000_000_000)
    expect(timestampOf(1_700_000_000_123)).toBe(1_700_000_000_123)
    expect(timestampOf('1700000000')).toBe(1_700_000_000_000)
    expect(timestampOf({ low: 1_700_000_000, high: 0, unsigned: true })).toBe(1_700_000_000_000)
    expect(timestampOf({ toNumber: () => 1_700_000_000 })).toBe(1_700_000_000_000)
    expect(timestampOf(undefined, 42)).toBe(42)
  })

  it('正文：文本、说明、包装消息与非文本占位标签；协议消息跳过', () => {
    expect(contentOf({ conversation: 'hi' })).toBe('hi')
    expect(contentOf({ extendedTextMessage: { text: 'link https://x' } })).toBe('link https://x')
    expect(contentOf({ imageMessage: { caption: 'logo' } })).toBe('[Image] logo')
    expect(contentOf({ imageMessage: {} })).toBe('[Image]')
    expect(contentOf({ videoMessage: { gifPlayback: true } })).toBe('[GIF]')
    expect(contentOf({ audioMessage: { ptt: true } })).toBe('[Voice message]')
    expect(contentOf({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'PI-001.pdf', caption: 'see PI' } } } })).toBe(
      '[Document: PI-001.pdf] see PI',
    )
    expect(contentOf({ viewOnceMessageV2: { message: { imageMessage: {} } } })).toBe('[Image]')
    expect(contentOf({ ephemeralMessage: { message: { conversation: 'temp' } } })).toBe('temp')
    expect(contentOf({ locationMessage: { name: 'Port', address: 'Ningbo' } })).toBe('[Location: Port · Ningbo]')
    expect(contentOf({ contactMessage: { displayName: 'Tom' } })).toBe('[Contact card: Tom]')
    expect(contentOf({ pollCreationMessageV3: { name: 'Color?' } })).toBe('[Poll: Color?]')
    expect(contentOf({ protocolMessage: { type: 0 } })).toBeNull()
    expect(contentOf({ reactionMessage: { text: '👍' }, messageContextInfo: {} })).toBeNull()
    expect(contentOf({ someFutureMessage: {} })).toBe('[Unsupported message]')
  })

  it('方向与会话：fromMe → out；@lid 用会话里的号码映射；群聊 / 状态跳过', () => {
    const resolver = new JidResolver()
    const now = Date.now()
    const batch = mapHistorySet(
      {
        chats: [{ id: '111@lid', pnJid: '15555550111@s.whatsapp.net', name: 'Bob' }],
        contacts: [],
        messages: [
          { key: { remoteJid: '111@lid', id: 'm1', fromMe: true }, messageTimestamp: Math.floor(now / 1000), pushName: 'Me', message: { conversation: 'hello' } },
          { key: { remoteJid: 'status@broadcast', id: 'm2' }, messageTimestamp: Math.floor(now / 1000), message: { conversation: 'status' } },
          { key: { remoteJid: '1203@g.us', id: 'm3' }, messageTimestamp: Math.floor(now / 1000), message: { conversation: 'group' } },
          { key: { remoteJid: '15555550111@s.whatsapp.net', id: 'old' }, messageTimestamp: Math.floor((now - 91 * DAY) / 1000), message: { conversation: 'old' } },
        ],
        progress: 55,
        isLatest: true,
      },
      now - 90 * DAY,
      resolver,
      now,
    )
    expect(batch.messages).toHaveLength(1)
    expect(batch.messages[0]).toMatchObject({
      id: 'm1',
      remoteJid: '15555550111@s.whatsapp.net',
      phone: '+15555550111',
      fromMe: true,
      displayName: '',
      text: 'hello',
    })
    expect(batch.chats).toEqual([{ remoteJid: '15555550111@s.whatsapp.net', phone: '+15555550111', name: 'Bob', unreadCount: undefined, archived: undefined }])
    expect(batch.progress).toBe(55)
    expect(batch.isLatest).toBe(true)

    // 映射表跨批次保留；实时消息的 key 带号码时也能学到
    expect(mapRawMessage({ key: { remoteJid: '111@lid', id: 'x' }, message: { conversation: 'again' } }, resolver)?.remoteJid).toBe(
      '15555550111@s.whatsapp.net',
    )
    expect(
      mapRawMessage({ key: { remoteJid: '222@lid', senderPn: '15555550112@s.whatsapp.net', id: 'y' }, message: { conversation: 'pn' } }, resolver)
        ?.phone,
    ).toBe('+15555550112')
  })
})

let server: TestServer

beforeAll(async () => {
  server = await startTestServer({
    LULUX_WHATSAPP_ENGINE: 'fake',
    LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS: '10',
    LULUX_WHATSAPP_FAKE_HISTORY_AFTER_MS: '10',
  })
})

afterAll(async () => {
  delete process.env.LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS
  delete process.env.LULUX_WHATSAPP_FAKE_HISTORY_AFTER_MS
  process.env.LULUX_WHATSAPP_ENGINE = 'fake'
  await server.close()
})

async function api(method: string, path: string, body?: unknown) {
  return server.request(method, path, body === undefined ? {} : { body })
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T
  do {
    last = await fn()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error(`condition not met before timeout; last=${JSON.stringify(last)}`)
}

const status = async () => (await api('GET', '/api/whatsapp/status')).json

describe('WhatsApp 历史同步（假引擎）', () => {
  it('扫码绑定后自动导入近 90 天聊天：去重、方向、时间、占位标签、联系人名、未读与完成状态', async () => {
    expect((await api('POST', '/api/whatsapp/risk-acceptance')).status).toBe(200)
    expect((await api('POST', '/api/whatsapp/link/start', { mode: 'qr' })).status).toBe(200)
    const done = await waitFor(status, (value) => value.history?.state === 'done')
    expect(done.history).toMatchObject({ state: 'done', days: 90, progress: 100 })
    // 3 条（A）+ 2 条（lid 客户）；重复、群聊、协议、90 天前的都不算
    expect(done.history.imported).toBe(5)

    const list = await waitFor(
      async () => (await api('GET', '/api/whatsapp/conversations')).json,
      (value) => value.items.some((item: { lastMessagePreview: string }) => item.lastMessagePreview === 'Sent from my phone'),
    )
    expect(list.items).toHaveLength(2)
    const a = list.items.find((item: { phone: string }) => item.phone === FAKE_HISTORY_CUSTOMER.phone)
    const b = list.items.find((item: { phone: string }) => item.phone === FAKE_HISTORY_LID_CUSTOMER.phone)
    // 通讯录名不被昵称覆盖；只有昵称的客户用昵称
    expect(a).toMatchObject({ displayName: FAKE_HISTORY_CUSTOMER.name, remoteJid: FAKE_HISTORY_CUSTOMER.jid, unreadCount: 0, lastMessageDirection: 'out' })
    expect(b).toMatchObject({ displayName: FAKE_HISTORY_LID_CUSTOMER.pushName, remoteJid: FAKE_HISTORY_LID_CUSTOMER.jid, lastMessagePreview: '[Voice message]' })

    const messages = (await api('GET', `/api/whatsapp/conversations/${a.id}/messages`)).json.items as Array<{
      body: string
      direction: string
      status: string
      createdAt: number
    }>
    expect(messages.map((m) => [m.direction, m.body])).toEqual([
      ['in', 'Hi, can you send the price list?'],
      ['out', 'Sure, attached.'],
      ['in', '[Image] our logo'],
      ['out', 'Sent from my phone'],
    ])
    expect(messages[1]!.status).toBe('sent')
    const now = Date.now()
    expect(Math.round((now - messages[0]!.createdAt) / DAY)).toBe(10)
    expect(Math.round((now - messages[1]!.createdAt) / DAY)).toBe(9)
    // 自己从手机回复后未读清零（历史里手机端未读是 2）
    expect(a.unreadCount).toBe(0)

    const bMessages = (await api('GET', `/api/whatsapp/conversations/${b.id}/messages`)).json.items
    expect(bMessages.map((m: { body: string }) => m.body)).toEqual(['Guten Tag, I need 500 units.', '[Voice message]'])
  })
})
