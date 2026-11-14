import { beforeEach, describe, expect, it } from 'vitest'
import { auth } from './session'
import { isUnread, seenAt, seenStorageKey, syncSeen } from './unread'

const LEGACY_KEY = 'lulux.sessionSeen'

/** 换成一个登录账号（作用域跟着 mode + baseUrl + userId 变） */
function account(userId: string, options: { baseUrl?: string; connection?: 'local' | 'remote'; mode?: 'desktop' | 'server' } = {}) {
  auth.ready = true
  auth.mode = options.mode ?? (options.baseUrl ? 'server' : 'desktop')
  auth.connection = options.connection ?? (options.baseUrl ? 'remote' : 'local')
  auth.serverUrl = options.baseUrl ?? ''
  auth.me = userId ? ({ user: { id: userId, name: userId } } as never) : null
}

describe('会话未读小圆点', () => {
  beforeEach(() => {
    localStorage.clear()
    auth.ready = false
    auth.mode = 'desktop'
    auth.connection = 'local'
    auth.serverUrl = ''
    auth.me = null
    seenAt.value = {}
  })

  it('第一次见到的会话建基线，不显示小圆点', () => {
    account('u1')
    syncSeen([{ id: 'a', updatedAt: 10 }], null)
    expect(isUnread({ id: 'a', updatedAt: 10 }, null)).toBe(false)
    // 按作用域落盘：键是 lulux.sessionSeen:<hash>
    expect(seenStorageKey()).toMatch(/^lulux\.sessionSeen:[0-9a-f]{8}$/)
    expect(JSON.parse(localStorage.getItem(seenStorageKey())!)).toEqual({ a: 10 })
  })

  it('不在看的会话有更新 → 小圆点；切过去后消失', () => {
    account('u1')
    syncSeen(
      [
        { id: 'a', updatedAt: 10 },
        { id: 'b', updatedAt: 10 },
      ],
      'a',
    )
    const later = [
      { id: 'a', updatedAt: 20 },
      { id: 'b', updatedAt: 30 },
    ]
    syncSeen(later, 'a')
    expect(isUnread(later[0], 'a')).toBe(false)
    expect(isUnread(later[1], 'a')).toBe(true)
    syncSeen(later, 'b')
    expect(isUnread(later[1], 'b')).toBe(false)
    expect(isUnread(later[1], 'a')).toBe(false)
  })

  it('删除的会话从记录里移除', () => {
    account('u1')
    syncSeen(
      [
        { id: 'a', updatedAt: 1 },
        { id: 'b', updatedAt: 1 },
      ],
      null,
    )
    syncSeen([{ id: 'a', updatedAt: 1 }], null)
    expect(Object.keys(seenAt.value)).toEqual(['a'])
  })

  it('换账号：不显示上一个账号的未读点，切回来还在', () => {
    account('u1')
    syncSeen([{ id: 'a', updatedAt: 10 }], null)
    syncSeen([{ id: 'a', updatedAt: 20 }], null)
    expect(isUnread({ id: 'a', updatedAt: 20 }, null)).toBe(true)

    account('u2')
    expect(seenAt.value).toEqual({})
    expect(isUnread({ id: 'a', updatedAt: 20 }, null)).toBe(false)

    account('u1')
    expect(isUnread({ id: 'a', updatedAt: 20 }, null)).toBe(true)
  })

  it('两个团队服务器各自记各自的会话 id（同名不互相覆盖）', () => {
    account('u1', { baseUrl: 'https://a.example.com' })
    syncSeen([{ id: 'same', updatedAt: 100 }], null)
    const keyA = seenStorageKey()

    account('u1', { baseUrl: 'https://b.example.com' })
    syncSeen([{ id: 'same', updatedAt: 500 }], null)
    const keyB = seenStorageKey()
    expect(keyB).not.toBe(keyA)
    expect(JSON.parse(localStorage.getItem(keyA)!)).toEqual({ same: 100 })
    expect(JSON.parse(localStorage.getItem(keyB)!)).toEqual({ same: 500 })
  })

  it('登出（没有账号）后界面清空，旧数据留在它自己的作用域里', () => {
    account('u1')
    syncSeen([{ id: 'a', updatedAt: 10 }], null)
    const key = seenStorageKey()
    account('')
    expect(seenAt.value).toEqual({})
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ a: 10 })
  })

  it('旧的无作用域键：本机账号第一次启动时迁到作用域键，之后删掉旧键', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: 7 }))
    account('local')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(seenStorageKey())!)).toEqual({ a: 7 })
    expect(seenAt.value).toEqual({ a: 7 })
  })

  it('团队服务器不迁旧键（不知道旧数据属于谁）', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: 7 }))
    account('u1', { baseUrl: 'https://a.example.com' })
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
    expect(seenAt.value).toEqual({})
  })
})
