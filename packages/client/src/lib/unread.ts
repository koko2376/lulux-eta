import { ref, watch } from 'vue'
import { auth, onAccountReset } from './session'
import { isLocalScope, scopedKey, storageScopeHash } from './storage-scope'

/**
 * 会话“有新消息”小圆点（列表行）：记住每个会话上次看到时的 updatedAt（本机 localStorage）。
 * - 第一次见到的会话以当时的 updatedAt 为基线，不会一打开应用就满屏小圆点
 * - 正在看的会话随时标记为已读；后台生成完成 / 团队里别人更新了会话 → updatedAt 变大 → 显示小圆点
 * - 键按“账号 + 服务器”分作用域（`lulux.sessionSeen:<hash>`）：换服务器 / 换账号不串，
 *   登出或切账号后界面上不显示上一个账号的未读点
 */
const KEY = 'lulux.sessionSeen'

/** 当前作用域下真实的存储键（测试与“清空本机数据”用） */
export function seenStorageKey(): string {
  return scopedKey(KEY, storageScopeHash.value)
}

function read(key: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}') as unknown
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

/**
 * 旧版只有 `lulux.sessionSeen` 一个键，没有作用域：本机（local）账号首次启动时迁到当前作用域，
 * 迁完就删掉旧键，只做一次。团队服务器不迁（无法判断旧数据属于谁）。
 */
function migrateLegacy(hash: string): void {
  if (!auth.ready || !isLocalScope()) return
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem(KEY)
  } catch {
    return
  }
  if (legacy === null) return
  try {
    const target = scopedKey(KEY, hash)
    if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy)
    localStorage.removeItem(KEY)
  } catch {
    /* 存储不可用（隐私模式 / 配额满）：下次启动再试 */
  }
}

/** 当前作用域（切换账号 / 服务器时跟着变） */
let scopeHash = ''

export const seenAt = ref<Record<string, number>>({})

/** 切作用域：换个键读；顺便做一次旧键迁移 */
function load(): void {
  scopeHash = storageScopeHash.value
  migrateLegacy(scopeHash)
  seenAt.value = read(scopedKey(KEY, scopeHash))
}

function save(): void {
  try {
    localStorage.setItem(scopedKey(KEY, scopeHash), JSON.stringify(seenAt.value))
  } catch {
    /* 存储不可用时只在内存里记 */
  }
}

// auth 里换了账号 / 服务器：立刻换成那个作用域的记录（不等界面刷新）
watch(storageScopeHash, load, { immediate: true, flush: 'sync' })

// 退出登录 / 会话失效 / 换账号：先清掉内存里的，界面上不留上一个账号的未读点；
// 该账号自己的记录留在它自己的作用域里，切回来还在
onAccountReset(() => {
  seenAt.value = {}
})

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
