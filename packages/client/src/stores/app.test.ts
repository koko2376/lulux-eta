import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../api'
import { compactionNoticeText, regenerateAnchor, retryNoticeText, useAppStore } from './app'

const msg = (id: string, role: Message['role'], content = id): Message => ({
  id,
  sessionId: 's1',
  role,
  content,
  senderAgentId: role === 'assistant' ? 'builtin' : null,
  toolTrace: [],
  createdAt: 1,
})

function sse(events: Array<[string, unknown]>): Response {
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    status: 200,
  })
}

/** 按 URL 路由的假服务端 */
function server(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const path = url.split('?')[0]
    const handler = routes[`${init?.method ?? 'GET'} ${path}`]
    if (!handler) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: path } }), { status: 404 })
    return handler(init)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const session = {
  id: 's1',
  title: 't',
  groupName: null,
  providerId: null,
  agentIds: ['builtin'],
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  preview: '',
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })

describe('内置内核：store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('regenerate 锚点：助手消息 → 它之前最近的用户消息；缺省 → 最后一条用户消息', () => {
    const list = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
      msg('a3', 'assistant'),
    ]
    expect(regenerateAnchor(list)).toBe(2)
    expect(regenerateAnchor(list, 'a1')).toBe(0)
    expect(regenerateAnchor(list, 'a3')).toBe(2)
    expect(regenerateAnchor(list, 'nope')).toBe(-1)
  })

  it('状态提示文案', () => {
    expect(
      retryNoticeText({
        agentId: 'a',
        attempt: 2,
        maxRetries: 3,
        delayMs: 2000,
        code: 'UPSTREAM_RATE_LIMITED',
        status: 429,
        message: '',
      }),
    ).toBe('请求过于频繁（429），正在重试（第 2/3 次，2 秒后）')
    expect(
      compactionNoticeText({
        agentId: 'a',
        kind: 'summary',
        ok: true,
        summarizedMessages: 12,
        tokensBefore: 1,
        tokensAfter: 1,
        budget: 1,
      }),
    ).toBe('较早的对话已压缩（12 条消息 → 摘要）')
  })

  it('重新生成：先在本地删掉后续消息，流式显示 reasoning / 提示，done 后以服务端为准', async () => {
    const store = useAppStore()
    store.currentSessionId = 's1'
    store.messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')]
    let seenDuring: { messages: string[]; reasoning: string; notices: string[] } | null = null
    const calls = server({
      'POST /api/chat/regenerate': () => {
        // 请求发出时本地已经截断
        seenDuring = { messages: store.messages.map((m) => m.id), reasoning: '', notices: [] }
        return sse([
          ['start', { sessionId: 's1', group: false, members: [], mode: 'regenerate', speakers: ['builtin'] }],
          ['agent', { agentId: 'builtin', name: 'LULUX', avatar: '', index: 0, total: 1 }],
          ['reasoning', { agentId: 'builtin', text: '先想一下' }],
          [
            'retry',
            {
              agentId: 'builtin',
              attempt: 1,
              maxRetries: 3,
              delayMs: 0,
              code: 'UPSTREAM_OVERLOADED',
              status: 503,
              message: '',
            },
          ],
          ['continuation', { agentId: 'builtin', reason: 'length', attempt: 1 }],
          ['delta', { text: '新的回答' }],
          [
            'done',
            { message: { ...msg('a2b', 'assistant', '新的回答'), reasoning: '先想一下', finishReason: 'stop' } },
          ],
        ])
      },
      'GET /api/sessions': json({ sessions: [session] }),
      'GET /api/sessions/s1': json({
        messages: [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2b', 'assistant', '新的回答')],
      }),
    })
    await store.regenerate('a2')
    expect(seenDuring!.messages).toEqual(['u1', 'a1', 'u2'])
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sessionId: 's1', messageId: 'a2' })
    expect(store.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2b'])
    // 续写提示保留在完成的消息上，重试提示不保留
    expect(store.messageNotices.a2b.map((n) => n.kind)).toEqual(['continuation'])
    // 思考用时：本窗口内记录在完成的消息上（刷新后没有）
    expect(typeof store.thinkDurations.a2b).toBe('number')
    expect(store.thinkDurations.a2b).toBeGreaterThanOrEqual(0)
    expect(store.streaming).toBe(false)
  })

  it('编辑重发：服务端拒绝时恢复被截掉的消息并把内容退回输入框', async () => {
    const store = useAppStore()
    store.currentSessionId = 's1'
    store.messages = [msg('u1', 'user', '旧问题'), msg('a1', 'assistant')]
    store.startEdit('u1')
    expect(store.editing).toEqual({ messageId: 'u1', content: '旧问题', dropCount: 1 })
    server({
      'POST /api/chat/edit': () =>
        new Response(JSON.stringify({ error: { code: 'NOT_USER_MESSAGE', message: '不是用户消息' } }), { status: 400 }),
      'GET /api/sessions': json({ sessions: [session] }),
    })
    await store.submitEdit('新问题')
    expect(store.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(store.failedDraft).toBe('新问题')
    expect(store.error).toContain('不是用户消息')
  })

  it('停止：调用 /api/sessions/:id/cancel；旧服务端（会话没有 running 字段）切回会话时用 /api/chat/pending 恢复运行中与待审批卡片', async () => {
    const store = useAppStore()
    const calls = server({
      'GET /api/sessions/s1': json({ session: {}, messages: [msg('u1', 'user')] }),
      'GET /api/chat/sessions/s1/context': json({ customerId: 'c1', quoteId: null }),
      'GET /api/chat/pending': json({
        running: true,
        allowedTools: [],
        requests: [
          {
            requestId: 'r1',
            sessionId: 's1',
            agentId: 'builtin',
            name: 'workspace_write',
            server: 'LULUX',
            arguments: '{}',
            risk: 'write',
            builtin: true,
            toolKey: 'k',
            createdAt: 1,
            expiresAt: 2,
          },
        ],
      }),
      'POST /api/sessions/s1/cancel': json({ stopped: true, runId: 'run_1' }),
      'POST /api/chat/tool-decision': json({ ok: true }),
    })
    await store.selectSession('s1')
    expect(store.streaming).toBe(true)
    expect(store.streamTools).toHaveLength(1)
    expect(store.streamTools[0]).toMatchObject({ requestId: 'r1', status: 'pending', risk: 'write' })
    await store.decideTool('r1', true, 'session')
    const decision = calls.find((c) => c.url === '/api/chat/tool-decision')!
    expect(JSON.parse(String(decision.init?.body))).toEqual({ requestId: 'r1', approved: true, remember: 'session' })
    await store.stop()
    expect(calls.some((c) => c.url === '/api/sessions/s1/cancel' && c.init?.method === 'POST')).toBe(true)
    await vi.waitFor(() => expect(store.context.customerId).toBe('c1'))
    store.stopPolling('s1')
  })

  it('session.title 事件更新侧栏标题', () => {
    const store = useAppStore()
    store.sessions = [
      {
        id: 's1',
        title: '新会话',
        groupName: null,
        providerId: null,
        agentIds: [],
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        preview: '',
      },
    ]
    store.applySessionTitle('s1', '德国球阀报价')
    expect(store.sessions[0].title).toBe('德国球阀报价')
  })
})

describe('群聊主管：store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('不可用成员的提示在发言前出现，保留到第一条（主管规划）消息上', async () => {
    const store = useAppStore()
    const groupSession = { ...session, agentIds: ['builtin', 'kernel-claude-code', 'kernel-codex'] }
    store.sessions = [groupSession]
    store.currentSessionId = 's1'
    const plan = { ...msg('p1', 'assistant', '交给 Claude Code'), supervisorRole: 'plan' as const }
    let resolveStream: (r: Response) => void = () => undefined
    server({
      'POST /api/chat': () => new Promise<Response>((r) => (resolveStream = r)),
      'GET /api/sessions': json({ sessions: [groupSession] }),
      'GET /api/sessions/s1': json({ messages: [msg('u1', 'user'), plan] }),
    })
    const sending = store.send('大家看看')
    await new Promise((r) => setTimeout(r, 0))
    resolveStream(
      new Response(
        [
          [
            'start',
            {
              sessionId: 's1',
              group: true,
              members: [],
              speakers: ['builtin'],
              speakMode: 'supervised',
              supervisorId: 'builtin',
            },
          ],
          ['notice', { kind: 'unavailable', agentId: 'kernel-codex', name: 'Codex', reason: '未安装' }],
          ['agent', { agentId: 'builtin', name: 'LULUX', avatar: '', index: 0, total: 1, role: 'plan' }],
          ['delta', { text: '交给 Claude Code' }],
        ]
          .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
          .join('') +
          [
            ['dispatch', { supervisorId: 'builtin', members: ['kernel-claude-code'], instructions: '写方案' }],
            ['done', { message: plan }],
          ]
            .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
            .join(''),
        { status: 200 },
      ),
    )
    await sending
    // 不可用提示：发言前出现，保留到第一条消息上
    expect(store.messageNotices.p1.map((n) => n.kind)).toEqual(['unavailable'])
    expect(store.messageNotices.p1[0].text).toBe('「Codex」暂不可用（未安装），本轮跳过')
    expect(store.streaming).toBe(false)
  })
})

describe('服务端持有的会话运行：store（契约 §6.9）', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  /** 带 id（seq）的 SSE；replayedAt 给出时在该位置之后插入 replayed（不带 id） */
  function sseWithIds(events: Array<[string, unknown]>, replayedAt?: number): string {
    return events
      .map(([e, d], i) => {
        const block = `id: ${i + 1}\nevent: ${e}\ndata: ${JSON.stringify(d)}\n\n`
        return replayedAt === i + 1 ? `${block}event: replayed\ndata: {"lastSeq":${i + 1}}\n\n` : block
      })
      .join('')
  }

  it('打开正在运行的会话：接上 /stream 回放并实时显示；草稿不重复；结束后以落库消息为准', async () => {
    const store = useAppStore()
    store.sessions = [{ ...session, running: true, activeRunId: 'run_1' }]
    const draft = { ...msg('a1', 'assistant', '正在'), finishReason: 'streaming' as const }
    const final = { ...msg('a1', 'assistant', '正在写开发信'), finishReason: 'stop' as const }
    let finishStream: () => void = () => undefined
    let detailCalls = 0
    const calls = server({
      'GET /api/sessions/s1': () => {
        detailCalls += 1
        // 第 1 次（打开会话）：运行中 + 草稿；之后：运行已结束
        return detailCalls === 1
          ? new Response(
              JSON.stringify({
                session: { ...session, running: true, activeRunId: 'run_1' },
                messages: [msg('u1', 'user'), draft],
              }),
            )
          : new Response(
              JSON.stringify({
                session: { ...session, running: false, activeRunId: null },
                messages: [msg('u1', 'user'), final],
              }),
            )
      },
      'GET /api/chat/sessions/s1/context': json({ customerId: null, quoteId: null }),
      'GET /api/sessions': json({ sessions: [{ ...session, running: false }] }),
      'GET /api/sessions/s1/stream': () => {
        const head = sseWithIds(
          [
            ['start', { sessionId: 's1', group: false, members: [], speakers: ['builtin'] }],
            ['agent', { agentId: 'builtin', name: 'LULUX', avatar: '', index: 0, total: 1 }],
            ['delta', { text: '正在' }],
          ],
          3,
        )
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(head))
            finishStream = () => {
              controller.enqueue(new TextEncoder().encode(`id: 4\nevent: delta\ndata: {"text":"写开发信"}\n\n`))
              controller.enqueue(
                new TextEncoder().encode(`id: 5\nevent: done\ndata: ${JSON.stringify({ message: final })}\n\n`),
              )
              controller.close()
            }
          },
        })
        return new Response(body, { status: 200 })
      },
    })
    expect(store.isRunning('s1')).toBe(true)
    await store.selectSession('s1')
    await vi.waitFor(() => expect(store.streamText).toBe('正在'))
    // 草稿由流渲染，列表里不重复
    expect(store.messages.map((m) => m.id)).toEqual(['u1'])
    expect(store.streaming).toBe(true)
    expect(store.currentRun?.replaying).toBe(false)
    expect(store.currentRun?.lastSeq).toBe(3)
    expect(calls.find((c) => c.url.startsWith('/api/sessions/s1/stream'))!.url).toBe('/api/sessions/s1/stream?after=0')
    finishStream()
    await vi.waitFor(() => expect(store.streaming).toBe(false))
    expect(store.messages.map((m) => [m.id, m.content])).toEqual([
      ['u1', 'u1'],
      ['a1', '正在写开发信'],
    ])
    // 回放中的发言不计思考用时
    expect(store.thinkDurations.a1).toBeUndefined()
  })

  it('POST 流意外断开而服务端仍在运行：从最后的 seq 续接，不丢内容', async () => {
    const store = useAppStore()
    store.sessions = [session]
    store.currentSessionId = 's1'
    const final = { ...msg('a1', 'assistant', '你好呀'), finishReason: 'stop' as const }
    let detailCalls = 0
    const calls = server({
      'POST /api/chat': () =>
        new Response(
          sseWithIds([
            ['start', { sessionId: 's1', group: false, members: [], speakers: ['builtin'] }],
            ['agent', { agentId: 'builtin', name: 'LULUX', avatar: '', index: 0, total: 1 }],
            ['delta', { text: '你好' }],
          ]),
          { status: 200 },
        ),
      'GET /api/sessions/s1': () => {
        detailCalls += 1
        return new Response(
          JSON.stringify({
            session: { ...session, running: detailCalls === 1 },
            messages: detailCalls === 1 ? [msg('u1', 'user')] : [msg('u1', 'user'), final],
          }),
        )
      },
      'GET /api/sessions/s1/stream': () =>
        new Response(
          `id: 4\nevent: delta\ndata: {"text":"呀"}\n\nevent: replayed\ndata: {"lastSeq":4}\n\nid: 5\nevent: done\ndata: ${JSON.stringify({ message: final })}\n\n`,
          { status: 200 },
        ),
      'GET /api/sessions': json({ sessions: [session] }),
    })
    await store.send('打个招呼')
    await vi.waitFor(() => expect(store.streaming).toBe(false))
    expect(calls.find((c) => c.url.startsWith('/api/sessions/s1/stream'))!.url).toBe('/api/sessions/s1/stream?after=3')
    expect(store.messages.map((m) => m.content)).toEqual(['u1', '你好呀'])
  })

  it('会话已在服务端运行（409 RUN_ACTIVE）：撤回乐观消息、内容退回输入框，并接上运行', async () => {
    const store = useAppStore()
    store.sessions = [session]
    store.currentSessionId = 's1'
    store.messages = [msg('u0', 'user')]
    const calls = server({
      'POST /api/chat': () =>
        new Response(JSON.stringify({ error: { code: 'RUN_ACTIVE', message: '这个会话正在运行' } }), { status: 409 }),
      'GET /api/sessions': json({ sessions: [session] }),
      'GET /api/sessions/s1/stream': () => new Response('', { status: 200 }),
      'GET /api/sessions/s1': json({ session: { ...session, running: false }, messages: [msg('u0', 'user')] }),
    })
    await store.send('再来一条')
    expect(store.failedDraft).toBe('再来一条')
    expect(store.error).toContain('正在运行')
    await vi.waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/sessions/s1/stream'))).toBe(true))
    await vi.waitFor(() => expect(store.streaming).toBe(false))
    expect(store.messages.map((m) => m.id)).toEqual(['u0'])
  })

  it('session.run 事件：更新侧栏运行中标记；正在看的会话开始运行时接上', async () => {
    const store = useAppStore()
    store.sessions = [session, { ...session, id: 's2' }]
    store.currentSessionId = 's1'
    const calls = server({
      'GET /api/sessions/s1/stream': () => new Response('', { status: 200 }),
      'GET /api/sessions/s1': json({ session: { ...session, running: false }, messages: [] }),
      'GET /api/sessions': json({ sessions: [session, { ...session, id: 's2' }] }),
    })
    await store.applyRunState('s2', true, 'run_2')
    expect(store.isRunning('s2')).toBe(true)
    expect(calls).toHaveLength(0)
    await store.applyRunState('s1', true, 'run_1')
    await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/sessions/s1/stream?after=0')).toBe(true))
  })
})
