/**
 * 思考用时（Grok 式“思考中 · 6 秒 / 已思考 12 秒”）。
 * 用时只在本窗口本次运行内可知：从发出请求（或群聊里轮到该成员）开始，到第一个正文 token / 工具调用为止。
 */

/** 毫秒 → 显示用的整秒数（至少 1 秒） */
export function formatThinkSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.round(ms / 1000))
}

/** 思考用时；未开始返回 null，未结束按 now 计 */
export function thinkDuration(startedAt: number | null, endedAt: number | null, now = Date.now()): number | null {
  if (startedAt === null) return null
  return Math.max(0, (endedAt ?? now) - startedAt)
}
