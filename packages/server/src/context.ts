import { AsyncLocalStorage } from 'node:async_hooks'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer']

/** 当前请求的操作者。desktop 模式恒为本机用户（owner）。 */
export interface Actor {
  id: string
  name: string
  email: string
  role: Role
  orgId: string
  teamIds: string[]
  /** server 模式下当前会话 id（用于登出 / 改密时保留当前会话） */
  sessionId: string | null
}

export const LOCAL_ACTOR: Actor = Object.freeze({
  id: 'local',
  name: '本机用户',
  email: '',
  role: 'owner',
  orgId: 'local',
  teamIds: [],
  sessionId: null,
}) as Actor

export interface RequestContext {
  actor: Actor
  ip: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? { actor: LOCAL_ACTOR, ip: '' }
}

export function currentActor(): Actor {
  return currentContext().actor
}

/** 后台任务（同步、定时器）以某个用户身份运行 */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return storage.run({ actor, ip: '' }, fn)
}
