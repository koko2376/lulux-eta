import { ref } from 'vue'

/** 「最近查看」的客户（本机 localStorage，最多 8 个；客户详情页打开时记录） */
const KEY = 'lulux.recentCustomers'
const MAX = 8

export interface RecentCustomer {
  id: string
  company: string
  at: number
}

function load(): RecentCustomer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown
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

export const recentCustomers = ref<RecentCustomer[]>(load())

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentCustomers.value))
  } catch {
    /* 存储满 / 隐私模式：只保留在内存里 */
  }
}

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
