import { ref } from 'vue'

/**
 * 会话“有新消息”小圆点（Grok 式列表行）：记住每个会话上次看到时的 updatedAt（本机 localStorage）。
 * - 第一次见到的会话以当时的 updatedAt 为基线，不会一打开应用就满屏小圆点
 * - 正在看的会话随时标记为已读；后台生成完成 / 团队里别人更新了会话 → updatedAt 变大 → 显示小圆点
 */
const KEY = 'lulux.sessionSeen'

function load(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, number> = {}
      for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
      }
      return out
    }
  } catch {
    /* 损坏的数据当作空 */
  }
  return {}
}

export const seenAt = ref<Record<string, number>>(load())

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seenAt.value))
  } catch {
    /* 存储不可用时只在内存里记 */
  }
}

interface SessionLike {
  id: string
  updatedAt: number
}

/** 同步会话列表：新会话建基线、当前会话标记已读、删掉已不存在的会话 */
export function syncSeen(sessions: SessionLike[], currentId: string | null): void {
  const next: Record<string, number> = {}
  let changed = false
  for (const session of sessions) {
    const seen = seenAt.value[session.id]
    if (seen === undefined || session.id === currentId) {
      next[session.id] = Math.max(seen ?? 0, session.updatedAt)
      if (next[session.id] !== seen) changed = true
    } else {
      next[session.id] = seen
    }
  }
  if (Object.keys(seenAt.value).length !== Object.keys(next).length) changed = true
  if (!changed) return
  seenAt.value = next
  save()
}

export function isUnread(session: SessionLike, currentId: string | null): boolean {
  if (session.id === currentId) return false
  const seen = seenAt.value[session.id]
  return seen !== undefined && session.updatedAt > seen
}
