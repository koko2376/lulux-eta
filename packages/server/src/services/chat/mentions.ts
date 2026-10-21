import type { ResolvedAgent } from '../agent-service.js'

/**
 * 找出文本里 @ 到的成员（按出现位置排序、去重）。认 `@名字` 与 `@agentId`，名字后可紧跟中文。
 * 代码块里的 @ 不算。
 */
export function parseMentions(text: string, members: Array<Pick<ResolvedAgent, 'id' | 'name'>>): string[] {
  const source = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  const hits: Array<{ id: string; at: number }> = []
  for (const member of members) {
    const keys = [member.name, member.id].filter(Boolean)
    let best = -1
    for (const key of keys) {
      for (const marker of ['@', '＠']) {
        const at = source.indexOf(`${marker}${key}`)
        if (at >= 0) {
          // id 形式要求后面不是单词字符，避免 @lux-trade2 误匹配
          const after = source[at + 1 + key.length]
          if (key === member.id && after && /[A-Za-z0-9_-]/.test(after)) continue
          if (best < 0 || at < best) best = at
        }
      }
    }
    if (best >= 0) hits.push({ id: member.id, at: best })
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.id)
}

/**
 * 本轮发言顺序：显式 targetAgentIds > 用户消息 @ > 全体成员按顺序。
 * 不在会话里的 id 忽略；结果为空时退回全体。
 */
export function initialSpeakers(
  members: ResolvedAgent[],
  userText: string,
  targetAgentIds?: string[],
): { order: ResolvedAgent[]; mode: 'targeted' | 'mentioned' | 'all' } {
  const byId = new Map(members.map((member) => [member.id, member]))
  if (targetAgentIds?.length) {
    const order = [...new Set(targetAgentIds)].map((id) => byId.get(id)).filter((m): m is ResolvedAgent => Boolean(m))
    if (order.length > 0) return { order, mode: 'targeted' }
  }
  if (members.length > 1) {
    const mentioned = parseMentions(userText, members).map((id) => byId.get(id)!)
    if (mentioned.length > 0) return { order: mentioned, mode: 'mentioned' }
  }
  return { order: [...members], mode: 'all' }
}

/** 每轮最多发言次数：成员数 + 2，防止 Agent 互相点名死循环 */
export function maxSpeaks(members: ResolvedAgent[]): number {
  return members.length + 2
}
