import { watch } from 'vue'
import * as api from '../api'
import { isMultiHuman } from '../lib/group-members'
import { auth } from '../lib/session'
import { useAppStore } from './app'
import { onServerEvent } from './events'

/**
 * 多人群聊实时同步（契约 §6.10.4）。AppLayout 挂载时 start()。
 *
 * - 当前打开的是多人群聊 → 订阅 GET /api/sessions/:id/events：
 *   message（别人发言 / Agent 回复落库）并入消息列表；session（成员 / 群设置变化）更新侧栏；
 *   run（运行开始 / 结束）→ applyRunState 接上运行流（替代轮询 /api/chat/pending）；
 *   removed（被移出 / 群被解散）从侧栏去掉。
 * - 全局 /api/events：session.message / session.updated / session.removed → 刷新侧栏（新群、未读、被移出）。
 */
export function startGroupLive(): () => void {
  const store = useAppStore()
  let current: { id: string; stop: () => void } | null = null
  let refreshTimer: number | null = null

  const meId = (): string | null => auth.me?.user.id ?? null

  const refreshSoon = (): void => {
    if (refreshTimer !== null) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      void store.refreshSessions().catch(() => undefined)
    }, 300)
  }

  const subscribe = (sessionId: string): void => {
    current?.stop()
    current = {
      id: sessionId,
      stop: api.subscribeSessionEvents(sessionId, (event) => {
        if (event.event === 'message') {
          const data = event.data as { sessionId: string; message: api.Message }
          store.applyRemoteMessage(data.sessionId, data.message, meId())
        } else if (event.event === 'session') {
          const data = event.data as { session: api.Session }
          if (data.session) store.applyRemoteSession(data.session)
        } else if (event.event === 'run') {
          // 运行开始 / 结束（任何成员发起）：接上运行流实时显示，结束后以落库消息为准（契约 §6.9 / §6.10）
          const data = event.data as { sessionId: string; running: boolean; runId?: string }
          void store.applyRunState(data.sessionId ?? sessionId, data.running, data.runId)
        } else if (event.event === 'removed') {
          store.dropSession(sessionId)
        }
      }),
    }
  }

  const stopWatch = watch(
    () => {
      const session = store.currentSession
      return session && isMultiHuman(session) ? session.id : null
    },
    (id) => {
      if (id === (current?.id ?? null)) return
      current?.stop()
      current = null
      if (id) subscribe(id)
    },
    { immediate: true },
  )

  const offs = [
    onServerEvent('session.message', (data) => {
      const { sessionId } = data as { sessionId: string }
      // 当前会话由会话事件流负责；其它群（或侧栏里还没有的新群）刷新列表
      if (sessionId !== current?.id || !store.sessions.some((s) => s.id === sessionId)) refreshSoon()
    }),
    onServerEvent('session.updated', () => refreshSoon()),
    onServerEvent('session.removed', (data) => {
      const { sessionId } = data as { sessionId: string }
      store.dropSession(sessionId)
    }),
  ]

  return () => {
    stopWatch()
    current?.stop()
    current = null
    if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    for (const off of offs) off()
  }
}
