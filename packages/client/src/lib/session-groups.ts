/** 会话列表按时间分组：今天 / 昨天 / 7 天内 / 更早；按本机时区的自然日算 */
export type SessionGroupKey = 'today' | 'yesterday' | 'week' | 'older'

export interface SessionGroup<T> {
  key: SessionGroupKey
  items: T[]
}

const ORDER: SessionGroupKey[] = ['today', 'yesterday', 'week', 'older']

export function groupKeyFor(updatedAt: number, now = Date.now()): SessionGroupKey {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (updatedAt >= today) return 'today'
  const yesterday = new Date(start)
  yesterday.setDate(yesterday.getDate() - 1)
  if (updatedAt >= yesterday.getTime()) return 'yesterday'
  const week = new Date(start)
  week.setDate(week.getDate() - 6)
  if (updatedAt >= week.getTime()) return 'week'
  return 'older'
}

/** 保持传入顺序（已按更新时间倒序），只切成连续的组；空组不返回 */
export function groupSessions<T extends { updatedAt: number }>(sessions: T[], now = Date.now()): SessionGroup<T>[] {
  const buckets = new Map<SessionGroupKey, T[]>()
  for (const session of sessions) {
    const key = groupKeyFor(session.updatedAt, now)
    const list = buckets.get(key) ?? []
    list.push(session)
    buckets.set(key, list)
  }
  return ORDER.filter((key) => buckets.has(key)).map((key) => ({ key, items: buckets.get(key)! }))
}
