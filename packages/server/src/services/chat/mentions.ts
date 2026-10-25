import type { ResolvedAgent } from '../agent-service.js'

/**
 * 找出文本里 @ 到的成员（按出现位置排序、去重）。认 `@名字` 与 `@agentId`，名字后可紧跟中文。
 * 代码块里的 @ 不算。
 * 同一个 @ 位置可能同时命中多个 key（群头衔「销售」与「销售经理」、显示名「LULUX #1」与「LULUX #10」）：
 * 只认最长的那个完整名称，被更长 key 覆盖的短 key 不算点名；以数字结尾的名字后面不能紧跟数字。
 */
export function parseMentions(
  text: string,
  members: Array<Pick<ResolvedAgent, 'id' | 'name'> & { kernelName?: string; role?: string }>,
): string[] {
  const source = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
  // 每个 @ 位置上的候选：{成员, key 长度}
  const candidates = new Map<number, Array<{ id: string; length: number }>>()
  for (const member of members) {
    // 群成员：显示名「Claude Code（跟单员）」、群头衔「跟单员」、内核原名「Claude Code」（同内核成员都算）都认
    const keys = [member.name, member.id, member.role, member.kernelName !== member.name ? member.kernelName : undefined].filter(
      (key): key is string => Boolean(key),
    )
    for (const key of new Set(keys)) {
      for (const marker of ['@', '＠']) {
        let from = 0
        while (from <= source.length) {
          const at = source.indexOf(`${marker}${key}`, from)
          if (at < 0) break
          from = at + 1
          const after = source[at + 1 + key.length]
          const rest = source.slice(at + 1 + key.length)
          // id 形式要求后面不是单词字符，避免 @lux-trade2 误匹配；实例 id 后面也不能再跟 #
          if (key === member.id && after && /[A-Za-z0-9_#-]/.test(after)) continue
          // 内核原名后面紧跟群头衔 / 序号时是在点名某一个成员，不算点到同内核的全部
          if (key === member.kernelName && key !== member.name && /^(\s*#\d|[（(])/.test(rest)) continue
          // 以数字结尾的名字（「LULUX #1」）后面紧跟数字时是另一个名字（「LULUX #10」）的一部分
          if (/\d$/.test(key) && after && /\d/.test(after)) continue
          const list = candidates.get(at) ?? []
          if (!list.some((item) => item.id === member.id && item.length >= key.length)) list.push({ id: member.id, length: key.length })
          candidates.set(at, list)
        }
      }
    }
  }
  const first = new Map<string, number>()
  for (const [at, list] of candidates) {
    // 同一位置只认最长的完整名称（内核原名这类多个成员共用的 key 一样长，都算）
    const longest = Math.max(...list.map((item) => item.length))
    for (const item of list) {
      if (item.length !== longest) continue
      const seen = first.get(item.id)
      if (seen === undefined || at < seen) first.set(item.id, at)
    }
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)
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
