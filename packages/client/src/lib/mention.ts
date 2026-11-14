/**
 * 群聊输入框的 @成员（契约 §6.2：服务端按消息里的 @名字 / @agentId 决定发言顺序）。
 *
 * 边界规则与服务端 `services/chat/mentions.ts` 完全一致，两端跑同一份
 * `test-fixtures/mentions.json` 用例表：`@` 前面只能是开头、空白、中日韩文字 / 全角标点，
 * 或者常见的中英文标点；邮箱（a@b）、URL（.../@name）、代码里的 @ 都不算。
 * 已经点完的名字后面不再弹列表（服务端照常点名）。
 */

export interface MentionQuery {
  /** `@` 所在位置 */
  start: number
  /** `@` 之后、光标之前的文字（名字里可以有空格，例如「LULUX #1」） */
  query: string
}

/** `@` 前面允许的 ASCII 标点（`/` `.` `-` `_` `@` 这些出现在邮箱 / URL / id 里，不算边界） */
const ASCII_BEFORE = new Set([',', ';', ':', "'", '"', '?', '!', '(', ')', '[', ']', '{', '}', '<', '>'])
/** 中文 / 日文 / 全角标点：`，@` `（@` 都可以 */
const CJK_BEFORE = /[\u3000\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/

/** `@` 在 at 这个位置是否算“开始点名”（与服务端 mentionBoundaryAllowed 同一套规则） */
export function mentionBoundaryAllowed(text: string, at: number): boolean {
  if (at <= 0) return true
  const prev = text[at - 1] as string
  if (/\s/.test(prev) || CJK_BEFORE.test(prev)) return true
  return ASCII_BEFORE.has(prev)
}

/** 一次 @ 查询最多这么长（名字再长也够；防止把整段话当成查询） */
const MAX_QUERY = 64

/** 光标前是否正在输入 @xxx：`@` / `＠` 边界正确，中间没有换行、没有第二个 @ */
export function activeMention(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  let at = -1
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const ch = before[i]
    if (ch === '@' || ch === '＠') {
      at = i
      break
    }
    if (ch === '\n' || ch === '\r') return null
  }
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > MAX_QUERY) return null
  return mentionBoundaryAllowed(before, at) ? { start: at, query } : null
}

/**
 * 查询还能不能匹配到候选：labels 是成员名 / id / 群头衔。
 * 匹配不上就收起列表——名字已经点完（后面跟了空格和别的话）时列表本来就该收起。
 */
export function mentionQueryMatches(query: string, labels: string[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return labels.some((label) => label.toLowerCase().includes(q))
}

/** 光标处该不该弹成员列表：@ 边界正确，而且还能匹配到某个候选 */
export function mentionPopup(text: string, caret: number, labels: string[]): MentionQuery | null {
  const mention = activeMention(text, caret)
  if (!mention) return null
  return mentionQueryMatches(mention.query, labels) ? mention : null
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
