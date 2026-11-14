import { ref, watch } from 'vue'
import { auth, onAccountReset } from './session'
import { isLocalScope, scopedKey, storageScopeHash } from './storage-scope'

/**
 * 「最近查看」的客户（本机 localStorage，最多 8 个；客户详情页打开时记录）。
 * 键按“账号 + 服务器”分作用域（`lulux.recentCustomers:<hash>`）：团队服务器 A / B 里同名 id 的客户
 * 不互相覆盖，换账号后也不会看到上一个账号的最近客户。
 */
const KEY = 'lulux.recentCustomers'
const MAX = 8

/** 当前作用域下真实的存储键（测试用） */
export function recentStorageKey(): string {
  return scopedKey(KEY, storageScopeHash.value)
}

export interface RecentCustomer {
  id: string
  company: string
  at: number
}

function read(key: string): RecentCustomer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (x): x is RecentCustomer =>
          !!x && typeof x.id === 'string' && typeof x.company === 'string' && typeof x.at === 'number',
      )
      .slice(0, MAX)
  } catch {
    return []
  }
}

/**
 * 旧版只有 `lulux.recentCustomers` 一个键（没有作用域）：本机（local）账号首次启动时整份迁到当前作用域，
 * 迁完删掉旧键，只做一次；团队服务器不迁（不知道旧数据属于哪个账号）。
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
    /* 存储不可用：下次启动再试 */
  }
}

let scopeHash = ''

export const recentCustomers = ref<RecentCustomer[]>([])

function load(): void {
  scopeHash = storageScopeHash.value
  migrateLegacy(scopeHash)
  recentCustomers.value = read(scopedKey(KEY, scopeHash))
}

function save(): void {
  try {
    localStorage.setItem(scopedKey(KEY, scopeHash), JSON.stringify(recentCustomers.value))
  } catch {
    /* 存储满 / 隐私模式：只保留在内存里 */
  }
}

watch(storageScopeHash, load, { immediate: true, flush: 'sync' })

// 退出登录 / 换账号：界面上立刻不显示上一个账号的最近客户（那份记录留在它自己的作用域里）
onAccountReset(() => {
  recentCustomers.value = []
})

export function rememberCustomer(id: string, company: string): void {
  recentCustomers.value = [{ id, company, at: Date.now() }, ...recentCustomers.value.filter((x) => x.id !== id)].slice(
    0,
    MAX,
  )
  save()
}

export function forgetCustomer(id: string): void {
  recentCustomers.value = recentCustomers.value.filter((x) => x.id !== id)
  save()
}
