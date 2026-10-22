import { db } from '../../db.js'
import type { ChatTurn, HistoryMessage } from '../../types.js'
import { estimateTokens, estimateTurns } from '../llm/tokens.js'

/**
 * 上下文压缩。
 * 原则：以**消息**为单位切分（一条助手消息展开后的 assistant(tool_calls) 与 tool 结果永远在同一侧），
 * 因而压缩后不会出现孤立的 tool 结果或缺结果的工具调用；最终发送前再用 sanitizeToolPairing 兜底修复。
 */

/** 摘要的目标：压缩后历史占预算的比例 */
export const COMPACTION_TARGET_RATIO = 0.55

export interface CompactionPlan {
  /** 需要被摘要的消息条数（从头开始）；0 表示不需要/无法压缩 */
  cut: number
  tokensBefore: number
  tokensAfter: number
}

/**
 * 计算要摘要掉多少条较早的消息：
 * - fixed：系统提示、工具定义等固定开销；perMessage：每条消息展开后的 token；
 * - 最后一条用户消息及其之后的消息永远保留；
 * - 只有总量超过 budget 才压缩，压到 budget·ratio 以下（为摘要本身留 summaryReserve）。
 */
export function planCompaction(
  perMessage: number[],
  roles: Array<HistoryMessage['role']>,
  fixed: number,
  budget: number,
  summaryReserve = 1200,
  ratio = COMPACTION_TARGET_RATIO,
): CompactionPlan {
  const total = fixed + perMessage.reduce((sum, n) => sum + n, 0)
  if (total <= budget) return { cut: 0, tokensBefore: total, tokensAfter: total }
  let lastUser = roles.lastIndexOf('user')
  if (lastUser < 0) lastUser = perMessage.length - 1
  const target = Math.max(0, budget * ratio - summaryReserve)
  let remaining = total
  let cut = 0
  while (cut < lastUser && remaining > target) {
    remaining -= perMessage[cut]!
    cut += 1
    if (remaining <= target) break
  }
  // 保留部分必须从一条用户消息开始（Anthropic 要求首条为 user；也避免只剩回答没有问题）
  while (cut > 0 && cut < lastUser && roles[cut] !== 'user') {
    remaining -= perMessage[cut]!
    cut += 1
  }
  return { cut, tokensBefore: total, tokensAfter: remaining + (cut > 0 ? summaryReserve : 0) }
}

/** 修复工具配对：去掉孤立的 tool 结果，给缺结果的调用补占位结果（各家 API 对此都会 400） */
export function sanitizeToolPairing(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = []
  let open: { ids: string[]; answered: Set<string> } | null = null

  const closeOpen = (): void => {
    if (!open) return
    for (const id of open.ids) {
      if (!open.answered.has(id)) {
        let call: { name: string } | undefined
        for (let k = out.length - 1; k >= 0 && !call; k -= 1) call = out[k]!.toolCalls?.find((c) => c.id === id)
        out.push({ role: 'tool', content: '（没有结果：调用被中断）', toolCallId: id, toolName: call?.name })
      }
    }
    open = null
  }

  for (const turn of turns) {
    if (turn.role === 'tool') {
      if (open && turn.toolCallId && open.ids.includes(turn.toolCallId) && !open.answered.has(turn.toolCallId)) {
        open.answered.add(turn.toolCallId)
        out.push(turn)
      }
      // 孤立结果：丢弃
      continue
    }
    closeOpen()
    out.push(turn)
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      open = { ids: turn.toolCalls.map((call) => call.id), answered: new Set() }
    }
  }
  closeOpen()
  return out
}

/** 校验配对是否完整（测试与断言用） */
export function toolPairingProblems(turns: ChatTurn[]): string[] {
  const problems: string[] = []
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      const ids = new Set(turn.toolCalls.map((c) => c.id))
      let j = i + 1
      while (j < turns.length && turns[j]!.role === 'tool') {
        ids.delete(turns[j]!.toolCallId ?? '')
        j += 1
      }
      for (const id of ids) problems.push(`调用 ${id} 没有结果`)
    }
    if (turn.role === 'tool') {
      let k = i - 1
      while (k >= 0 && turns[k]!.role === 'tool') k -= 1
      const owner = turns[k]
      if (!owner || owner.role !== 'assistant' || !owner.toolCalls?.some((c) => c.id === turn.toolCallId)) {
        problems.push(`结果 ${turn.toolCallId} 没有对应的调用`)
      }
    }
  }
  return problems
}

/**
 * 当前回复内部的工具循环超预算时：从最早的工具结果开始截短（保留最近一轮完整），配对不变。
 * 返回被截短的结果数。
 */
export function shrinkToolResults(turns: ChatTurn[], budget: number, fixed: number, keepFrom: number): number {
  let shrunk = 0
  for (const limit of [2000, 500, 120]) {
    if (estimateTurns(turns) + fixed <= budget) break
    for (let i = 0; i < Math.min(keepFrom, turns.length); i += 1) {
      const turn = turns[i]!
      if (turn.role !== 'tool' || turn.content.length <= limit) continue
      turn.content = `${turn.content.slice(0, limit)}\n…（为节省上下文已截短，原文 ${turn.content.length} 字）`
      shrunk += 1
      if (estimateTurns(turns) + fixed <= budget) break
    }
  }
  return shrunk
}

/** 把要摘要的消息渲染成中性的对话记录 */
export function renderTranscript(messages: HistoryMessage[], nameOf: (id: string) => string | undefined): string {
  const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text)
  return messages
    .map((message) => {
      const who = message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : (nameOf(message.senderAgentId ?? '') ?? '助手')
      const tools = message.toolTrace
        .map((entry) => `  [工具 ${entry.name}${entry.approved ? '' : '（被拒绝）'}] ${clip(entry.arguments, 200)} → ${clip(entry.result, 400)}`)
        .join('\n')
      return `【${who}】${clip(message.content, 2500)}${tools ? `\n${tools}` : ''}`
    })
    .join('\n\n')
}

export const SUMMARY_SYSTEM_PROMPT =
  '你负责压缩一段外贸业务助手的对话记录，供后续对话继续使用。用简体中文写一份结构化摘要（不超过 600 字）：' +
  '用户的目标与偏好；已确认的事实与数据（客户、产品、价格、数量、条款、日期、链接、文件名等原样保留）；' +
  '已做出的决定与已完成的操作（包括工具调用结果要点）；尚未解决的问题与下一步。不要编造，不要寒暄。'

export interface StoredSummary {
  sessionId: string
  uptoMessageId: string
  summarizedCount: number
  summary: string
  createdAt: number
}

export const summaryStore = {
  get(sessionId: string): StoredSummary | null {
    const row = db.prepare('SELECT * FROM chat_summaries WHERE session_id = ?').get(sessionId) as unknown as
      | { session_id: string; upto_message_id: string; summarized_count: number; summary: string; created_at: number }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      uptoMessageId: row.upto_message_id,
      summarizedCount: Number(row.summarized_count),
      summary: row.summary,
      createdAt: Number(row.created_at),
    }
  },

  save(summary: Omit<StoredSummary, 'createdAt'>): void {
    db.prepare(
      `INSERT INTO chat_summaries (session_id, upto_message_id, summarized_count, summary, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET upto_message_id = excluded.upto_message_id,
         summarized_count = excluded.summarized_count, summary = excluded.summary, created_at = excluded.created_at`,
    ).run(summary.sessionId, summary.uptoMessageId, summary.summarizedCount, summary.summary, Date.now())
  },

  clear(sessionId: string): void {
    db.prepare('DELETE FROM chat_summaries WHERE session_id = ?').run(sessionId)
  },
}

/** 已存摘要覆盖到的位置：返回窗口里需要丢弃的前缀长度；摘要失效（消息已删）返回 null */
export function applyStoredSummary(window: HistoryMessage[], summary: StoredSummary | null, existsInSession: (id: string) => boolean): number | null {
  if (!summary) return null
  const index = window.findIndex((message) => message.id === summary.uptoMessageId)
  if (index >= 0) return index + 1
  return existsInSession(summary.uptoMessageId) ? 0 : null
}

export function summaryTokens(summary: string | undefined): number {
  return summary ? estimateTokens(summary) + 30 : 0
}
