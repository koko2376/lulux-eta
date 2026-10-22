import type { Actor } from '../context.js'
import { canSee, type OwnedRow } from '../security/access.js'

/**
 * 事件范围：
 * - OwnedRow：按业务对象可见性（客户、邮箱…，含 team / org 共享与 admin 全览）
 * - { userId }：只推给某个人（任务提醒、工作流 / 定时任务——仅本人）
 * - { userIds }：只推给这些人（会话：负责人 + 群聊真人成员；admin 也不例外）
 */
export type EventScope = OwnedRow | { userId: string; orgId: string } | { userIds: string[]; orgId: string }

interface Subscriber {
  actor: Actor
  send(event: string, payload: unknown): void
  close(): void
}

const subscribers = new Set<Subscriber>()
/** 其他订阅源（会话事件 GET /api/sessions/:id/events）在登出 / 停用时一并断开 */
const revokeHooks = new Set<(match: (actor: Actor) => boolean) => void>()

function visible(scope: EventScope, actor: Actor): boolean {
  if ('userId' in scope) return scope.userId === actor.id && scope.orgId === actor.orgId
  if ('userIds' in scope) return scope.orgId === actor.orgId && scope.userIds.includes(actor.id)
  return canSee(scope, actor)
}

/** 进程内事件总线：GET /api/events 订阅，按订阅者身份过滤（契约 4.8） */
export const eventBus = {
  subscribe(subscriber: Subscriber): () => void {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  },

  publish(event: string, payload: unknown, scope: EventScope): void {
    for (const subscriber of subscribers) {
      if (!visible(scope, subscriber.actor)) continue
      try {
        subscriber.send(event, payload)
      } catch {
        // 连接已断开，由订阅方清理
      }
    }
  },

  onRevoke(hook: (match: (actor: Actor) => boolean) => void): void {
    revokeHooks.add(hook)
  },

  revokeSession(sessionId: string | null): void {
    if (!sessionId) return
    for (const hook of revokeHooks) hook((actor) => actor.sessionId === sessionId)
    for (const subscriber of [...subscribers]) {
      if (subscriber.actor.sessionId === sessionId) {
        subscriber.send('session.revoked', {})
        subscriber.close()
      }
    }
  },

  revokeUser(userId: string): void {
    for (const hook of revokeHooks) hook((actor) => actor.id === userId)
    for (const subscriber of [...subscribers]) {
      if (subscriber.actor.id === userId) {
        subscriber.send('session.revoked', {})
        subscriber.close()
      }
    }
  },

  count(): number {
    return subscribers.size
  },
}
