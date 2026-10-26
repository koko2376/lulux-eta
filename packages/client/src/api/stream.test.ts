import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { attachRunStream, dispatchStreamEvent, parseSseBlock, streamChatRequest, type StreamHandlers } from './index'

function sseResponse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function handlers(): Record<string, Mock> {
  const names = [
    'onStart',
    'onAgent',
    'onDelta',
    'onReasoning',
    'onToolRequest',
    'onToolResult',
    'onRetry',
    'onDowngrade',
    'onContinuation',
    'onToolLimit',
    'onArtifact',
    'onCompaction',
    'onStopped',
    'onDispatch',
    'onNotice',
    'onDone',
    'onError',
  ]
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<string, Mock>
}

describe('SSE 事件（契约 §6.3）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('新事件分发到对应回调，done 带 aborted，error 带 code / partialMessageId', () => {
    const h = handlers()
    const hs = h as unknown as StreamHandlers
    dispatchStreamEvent('reasoning', { agentId: 'a', text: '想' }, hs)
    dispatchStreamEvent(
      'retry',
      {
        agentId: 'a',
        attempt: 1,
        maxRetries: 3,
        delayMs: 1000,
        code: 'UPSTREAM_RATE_LIMITED',
        status: 429,
        message: '',
      },
      hs,
    )
    dispatchStreamEvent(
      'tool_limit',
      { agentId: 'a', maxToolRounds: 90, maxTurns: 90, reason: 'max_turns', used: 90 },
      hs,
    )
    dispatchStreamEvent('compaction', { agentId: 'a', kind: 'tool_results', shrunk: 2 }, hs)
    dispatchStreamEvent('artifact', { agentId: 'a', artifact: { id: 'x', title: 't', language: 'html' } }, hs)
    dispatchStreamEvent('stopped', { sessionId: 's', reason: 'user' }, hs)
    dispatchStreamEvent('done', { message: { id: 'm1' }, aborted: true }, hs)
    dispatchStreamEvent(
      'error',
      { code: 'UPSTREAM_AUTH', message: 'Key 错误', name: 'LULUX', partialMessageId: 'p1', retryable: false },
      hs,
    )
    dispatchStreamEvent('unknown_event', {}, hs)
    expect(h.onReasoning).toHaveBeenCalledWith({ agentId: 'a', text: '想' })
    expect(h.onRetry.mock.calls[0][0].status).toBe(429)
    expect(h.onToolLimit).toHaveBeenCalledWith({
      agentId: 'a',
      maxToolRounds: 90,
      maxTurns: 90,
      reason: 'max_turns',
      used: 90,
    })
    expect(h.onCompaction).toHaveBeenCalledTimes(1)
    expect(h.onArtifact.mock.calls[0][0].artifact.language).toBe('html')
    expect(h.onStopped).toHaveBeenCalledTimes(1)
    expect(h.onDone).toHaveBeenCalledWith({ id: 'm1' }, true)
    expect(h.onError.mock.calls[0][0]).toBe('LULUX：Key 错误')
    expect(h.onError.mock.calls[0][1]).toMatchObject({ code: 'UPSTREAM_AUTH', partialMessageId: 'p1' })
  })

  it('regenerate / edit 走各自路径，请求体不含 kind', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        ['delta', { text: 'hi' }],
        ['done', { message: { id: 'm' } }],
      ]),
    )
    vi.stubGlobal('fetch', fetchFn)
    const h = handlers()
    const hs = h as unknown as StreamHandlers
    await streamChatRequest({ kind: 'regenerate', sessionId: 's1', messageId: 'm0' }, hs)
    await streamChatRequest({ kind: 'edit', sessionId: 's1', messageId: 'u1', content: '新内容' }, hs)
    await streamChatRequest({ kind: 'send', sessionId: 's1', content: 'x', targetAgentIds: ['kernel-codex'] }, hs)
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map((c) => c[0])).toEqual(['/api/chat/regenerate', '/api/chat/edit', '/api/chat'])
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ sessionId: 's1', messageId: 'u1', content: '新内容' })
    expect(JSON.parse(String(calls[2][1].body)).targetAgentIds).toEqual(['kernel-codex'])
    expect(h.onDelta).toHaveBeenCalledWith('hi')
    expect(h.onDone).toHaveBeenCalledWith({ id: 'm' }, false)
  })

  it('群聊主管：dispatch / notice 事件与 agent.role', () => {
    const h = handlers()
    const hs = h as unknown as StreamHandlers
    dispatchStreamEvent(
      'agent',
      { agentId: 'builtin', name: 'LULUX', avatar: '', index: 0, total: 1, role: 'plan' },
      hs,
    )
    dispatchStreamEvent(
      'dispatch',
      { supervisorId: 'builtin', members: ['kernel-claude-code'], instructions: '写方案' },
      hs,
    )
    dispatchStreamEvent('notice', { kind: 'unavailable', agentId: 'kernel-codex', name: 'Codex', reason: '未安装' }, hs)
    expect(h.onAgent.mock.calls[0][0].role).toBe('plan')
    expect(h.onDispatch).toHaveBeenCalledWith({
      supervisorId: 'builtin',
      members: ['kernel-claude-code'],
      instructions: '写方案',
    })
    expect(h.onNotice.mock.calls[0][0]).toMatchObject({ kind: 'unavailable', name: 'Codex' })
  })
})

describe('会话运行事件 seq 与重新接上（契约 §6.9）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('parseSseBlock 读出 id；注释行（心跳）忽略', () => {
    expect(parseSseBlock('id: 7\nevent: delta\ndata: {"text":"a"}')).toEqual({
      id: 7,
      event: 'delta',
      data: { text: 'a' },
    })
    expect(parseSseBlock('event: delta\ndata: {"text":"a"}')).toEqual({ event: 'delta', data: { text: 'a' } })
    expect(parseSseBlock(': ping')).toBeNull()
  })

  it('attachRunStream：GET /api/sessions/:id/stream?after=N，按事件回调 onSeq / onReplayed', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(': ping\n\nid: 4\nevent: delta\ndata: {"text":"x"}\n\nevent: replayed\ndata: {"lastSeq":4}\n\n', {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const h = handlers()
    const onSeq = vi.fn()
    const onReplayed = vi.fn()
    await attachRunStream('s 1', 3, { ...(h as unknown as StreamHandlers), onSeq, onReplayed })
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/sessions/s%201/stream?after=3')
    expect(onSeq).toHaveBeenCalledWith(4)
    expect(h.onDelta).toHaveBeenCalledWith('x')
    expect(onReplayed).toHaveBeenCalledWith({ lastSeq: 4 })
  })
})
