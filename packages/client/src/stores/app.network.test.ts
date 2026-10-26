/**
 * 回归：生成中途断网 —— 显示本地化文案与“正在重连”，恢复联网后从最后的 seq 续接，实时输出不丢。
 */
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { t } from '../i18n'

afterEach(() => {
  vi.unstubAllGlobals()
})

const enc = new TextEncoder()
const sse = (blocks: string[], fail?: Error): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of blocks) c.enqueue(enc.encode(b))
      if (fail) setTimeout(() => c.error(fail), 5)
      else c.close()
    },
  })
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

describe('生成中途断网', () => {
  it('读流时断网：包成本地化的 NETWORK 错误，不显示原始异常文本', async () => {
    api.setTransport({ baseUrl: '', sessionToken: null, localSession: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sse(['id: 1\nevent: start\ndata: {}\n\n'], new TypeError('network error')))),
    )
    const error = await api
      .streamChatRequest(
        { kind: 'send', sessionId: 's1', content: 'hi' },
        { onDelta: () => {}, onDone: () => {}, onError: () => {} },
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(api.ApiError)
    expect((error as api.ApiError).code).toBe('NETWORK')
    expect((error as api.ApiError).message).toBe(t('apiIndex.streamInterrupted'))
  })

  it('保留本地运行状态并提示正在重连；恢复联网后从最后的 seq 接上，收到后续输出', async () => {
    api.setTransport({ baseUrl: '', sessionToken: null, localSession: null })
    setActivePinia(createPinia())
    const { useAppStore } = await import('./app')
    const store = useAppStore()
    store.sessions = [{ id: 's1', title: 'a', agentIds: ['builtin'], updatedAt: 0 } as never]
    store.currentSessionId = 's1'
    store.messages = []
    const final = {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      content: '您好，单价 12.5 USD',
      senderAgentId: 'builtin',
      toolTrace: [],
      createdAt: 2,
    }
    const attachUrls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/chat')) {
        return new Response(
          sse(
            ['id: 1\nevent: start\ndata: {}\n\n', 'id: 2\nevent: delta\ndata: {"text":"您好，"}\n\n'],
            new TypeError('network error'),
          ),
        )
      }
      if (u.includes('/stream?after=')) {
        attachUrls.push(u)
        return new Response(
          sse([
            'id: 3\nevent: delta\ndata: {"text":"单价 12.5 USD"}\n\n',
            `id: 4\nevent: done\ndata: ${JSON.stringify({ message: final })}\n\n`,
          ]),
        )
      }
      if (u.endsWith('/api/sessions/s1')) return json({ session: { id: 's1', running: false }, messages: [final] })
      if (u.endsWith('/api/sessions')) return json(store.sessions)
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    const sending = store.send('报价')
    await vi.waitFor(() => expect(store.runs.s1?.reconnecting).toBe(true))
    expect(store.error).toBe('')
    expect(store.streamText).toBe('您好，')
    expect(store.streamNotices.map((n) => n.text)).toContain(t('storeApp.reconnecting'))
    expect(attachUrls).toHaveLength(0)

    window.dispatchEvent(new Event('online'))
    await sending
    expect(attachUrls).toEqual(['/api/sessions/s1/stream?after=2'])
    expect(store.runs.s1).toBeUndefined()
    expect(store.error).toBe('')
    expect(store.messages.map((m) => m.content)).toEqual(['您好，单价 12.5 USD'])
    expect(store.messageNotices.a1 ?? []).toEqual([])
  })
})
