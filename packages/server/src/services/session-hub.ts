import type { Actor } from '../context.js'
import { db } from '../db.js'
import { eventBus } from './events.js'

/**
 * 会话实时事件（契约 §6.10.4）：多人群聊的成员订阅 GET /api/sessions/:id/events，
 * 有人发消息 / Agent 回复落库 / 成员或群设置变更时收到推送。
 *
 * - 只推“已落库”的事件（message / session / removed）和运行状态（run），不转发流式 token：
 *   发起人自己的流走 POST /api/chat；其他成员收到 run 后用 GET /api/sessions/:id/stream 接上运行流。
 * - 运行中的草稿消息不推，定稿时以同一 id 推一次 message（客户端按 id upsert）。
 * - 每次推送时按当前成员名单过滤：被移出群 / 退出 / 群被解散的订阅收到 removed 后断开。
 * - 与后台（detached）运行兼容：消息无论由哪个请求或后台任务写入，都经 sessionService.addMessage → publishMessage。
 * - 运行状态（开始 / 结束）由 run-registry 调用 publishSessionEvent(sessionId, 'run', {...}) 推送。
 */

export interface SessionAudience {
  orgId: string
  ownerId: string
  /** 群主 + 真人成员 */
  userIds: string[]
}

interface Subscriber {
  actor: Actor
  send(event: string, payload: unknown): void
  close(): void
}

const subscribers = new Map<string, Set<Subscriber>>()

/** 会话的真人成员（群主 + session_participants）；会话不存在返回 null */
export function sessionAudience(sessionId: string): SessionAudience | null {
  const row = db.prepare('SELECT org_id, owner_id FROM sessions WHERE id = ?').get(sessionId) as
    | { org_id: string; owner_id: string }
    | undefined
  if (!row) return null
  const others = (
    db.prepare('SELECT user_id FROM session_participants WHERE session_id = ?').all(sessionId) as Array<{ user_id: string }>
  ).map((r) => r.user_id)
  return { orgId: row.org_id, ownerId: row.owner_id, userIds: [row.owner_id, ...others.filter((id) => id !== row.owner_id)] }
}

function inAudience(audience: SessionAudience | null, actor: Actor): boolean {
  return Boolean(audience && audience.orgId === actor.orgId && audience.userIds.includes(actor.id))
}

export const sessionHub = {
  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    let set = subscribers.get(sessionId)
    if (!set) subscribers.set(sessionId, (set = new Set()))
    set.add(subscriber)
    return () => {
      const current = subscribers.get(sessionId)
      current?.delete(subscriber)
      if (current && current.size === 0) subscribers.delete(sessionId)
    }
  },

  /** 推给本会话的订阅者；audience 省略时现查（删除会话前由调用方先取好） */
  publish(sessionId: string, event: string, payload: unknown, audience: SessionAudience | null = sessionAudience(sessionId)): void {
    const set = subscribers.get(sessionId)
    if (!set) return
    for (const subscriber of [...set]) {
      try {
        if (inAudience(audience, subscriber.actor)) subscriber.send(event, payload)
        else {
          subscriber.send('removed', { sessionId })
          subscriber.close()
        }
      } catch {
        // 连接已断开，由订阅方清理
      }
    }
  },

  /** 登出 / 停用：断开匹配的订阅 */
  revoke(match: (actor: Actor) => boolean): void {
    for (const set of subscribers.values()) {
      for (const subscriber of [...set]) {
        if (!match(subscriber.actor)) continue
        try {
          subscriber.send('session.revoked', {})
        } catch {
          // ignore
        }
        subscriber.close()
      }
    }
  },

  count(sessionId?: string): number {
    if (sessionId) return subscribers.get(sessionId)?.size ?? 0
    let n = 0
    for (const set of subscribers.values()) n += set.size
    return n
  },
}

eventBus.onRevoke((match) => sessionHub.revoke(match))

/** 新消息落库：推给会话订阅者；多人群聊另在全局 /api/events 发 session.message（侧栏刷新 / 未读） */
export function publishMessage(sessionId: string, message: { id: string; role: string; senderUserId: string | null; content: string; createdAt: number }, full: unknown): void {
  const audience = sessionAudience(sessionId)
  if (!audience) return
  sessionHub.publish(sessionId, 'message', { sessionId, message: full }, audience)
  if (audience.userIds.length > 1) {
    eventBus.publish(
      'session.message',
      {
        sessionId,
        messageId: message.id,
        role: message.role,
        senderUserId: message.senderUserId,
        preview: message.content.slice(0, 120),
        createdAt: message.createdAt,
      },
      { userIds: audience.userIds, orgId: audience.orgId },
    )
  }
}

/** 会话设置 / 成员变化：会话订阅者收到 session（最新会话），全体成员在全局收到 session.updated */
export function publishSessionChanged(sessionId: string, session: unknown, previous?: SessionAudience | null): void {
  const audience = sessionAudience(sessionId)
  if (!audience) return
  sessionHub.publish(sessionId, 'session', { sessionId, session }, audience)
  eventBus.publish('session.updated', { sessionId }, { userIds: audience.userIds, orgId: audience.orgId })
  // 被移出的人：全局 session.removed（侧栏移除）
  const gone = (previous?.userIds ?? []).filter((id) => !audience.userIds.includes(id))
  if (gone.length > 0) eventBus.publish('session.removed', { sessionId }, { userIds: gone, orgId: audience.orgId })
}

/** 会话被删除（群被解散）：audience 需在删除前取好 */
export function publishSessionRemoved(sessionId: string, audience: SessionAudience | null): void {
  if (!audience) return
  sessionHub.publish(sessionId, 'removed', { sessionId }, { ...audience, userIds: [] })
  eventBus.publish('session.removed', { sessionId }, { userIds: audience.userIds, orgId: audience.orgId })
}

/** 通用：推给会话订阅者（例如运行状态 run: { running }） */
export function publishSessionEvent(sessionId: string, event: string, payload: unknown): void {
  sessionHub.publish(sessionId, event, payload)
}
