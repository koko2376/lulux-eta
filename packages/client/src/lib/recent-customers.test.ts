import { beforeEach, describe, expect, it } from 'vitest'
import { recentCustomers, recentStorageKey, rememberCustomer } from './recent-customers'
import { auth } from './session'

const LEGACY_KEY = 'lulux.recentCustomers'
const MAX = 8

function account(userId: string, options: { baseUrl?: string; connection?: 'local' | 'remote'; mode?: 'desktop' | 'server' } = {}) {
  auth.ready = true
  auth.mode = options.mode ?? (options.baseUrl ? 'server' : 'desktop')
  auth.connection = options.connection ?? (options.baseUrl ? 'remote' : 'local')
  auth.serverUrl = options.baseUrl ?? ''
  auth.me = userId ? ({ user: { id: userId, name: userId } } as never) : null
}

describe('最近查看的客户（按账号 + 服务器隔离）', () => {
  beforeEach(() => {
    localStorage.clear()
    auth.ready = false
    auth.mode = 'desktop'
    auth.connection = 'local'
    auth.serverUrl = ''
    auth.me = null
    recentCustomers.value = []
  })

  it('记最近 8 个，重复查看提到最前', () => {
    account('u1')
    for (let i = 1; i <= 9; i += 1) rememberCustomer(`c${i}`, `客户${i}`)
    expect(recentCustomers.value).toHaveLength(MAX)
    expect(recentCustomers.value[0].id).toBe('c9')
    rememberCustomer('c5', '客户5')
    expect(recentCustomers.value.map((x) => x.id).slice(0, 2)).toEqual(['c5', 'c9'])
    // 按作用域落盘
    expect(recentStorageKey()).toMatch(/^lulux\.recentCustomers:[0-9a-f]{8}$/)
    expect(JSON.parse(localStorage.getItem(recentStorageKey())!)).toHaveLength(MAX)
  })

  it('服务器 A / B 里同名 id 的客户不互相覆盖', () => {
    account('u1', { baseUrl: 'https://a.example.com' })
    rememberCustomer('same-id', 'A 公司的客户')
    const keyA = recentStorageKey()

    account('u1', { baseUrl: 'https://b.example.com' })
    expect(recentCustomers.value).toEqual([])
    rememberCustomer('same-id', 'B 公司的客户')
    const keyB = recentStorageKey()
    expect(keyB).not.toBe(keyA)

    account('u1', { baseUrl: 'https://a.example.com' })
    expect(recentCustomers.value.map((x) => x.company)).toEqual(['A 公司的客户'])
  })

  it('换账号后看不到上一个账号的最近客户，切回来还在', () => {
    account('u1')
    rememberCustomer('c1', '客户甲')
    account('u2')
    expect(recentCustomers.value).toEqual([])
    account('u1')
    expect(recentCustomers.value.map((x) => x.id)).toEqual(['c1'])
  })

  it('旧的无作用域键：本机账号第一次启动时迁移，之后删掉旧键', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([{ id: 'c9', company: '老客户', at: 5 }]))
    account('local')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(recentCustomers.value.map((x) => x.id)).toEqual(['c9'])
  })
})
