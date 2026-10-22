/** 群聊输入框的 @成员（契约 §6.2：服务端按消息里的 @名字 / @agentId 决定发言顺序） */

export interface MentionQuery {
  /** `@` 所在位置 */
  start: number
  /** `@` 之后、光标之前的文字 */
  query: string
}

/** 光标前是否正在输入 @xxx（`@` 位于开头或空白之后，中间没有空白） */
export function activeMention(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]{0,20})$/.exec(before)
  if (!m) return null
  return { start: caret - m[2].length - 1, query: m[2] }
}

export function filterMembers<T extends { id: string; name: string }>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return members
  return members.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
}

/** 用 `@名字 ` 替换正在输入的 @xxx，返回新文本与光标位置 */
export function insertMention(text: string, mention: MentionQuery, name: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  const insert = `@${name} `
  const after = text.slice(end).replace(/^ /, '')
  return { text: text.slice(0, mention.start) + insert + after, caret: mention.start + insert.length }
}
