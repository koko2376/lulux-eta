import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/session')>()),
  initAuth: vi.fn(async () => undefined),
}))
vi.mock('./layouts/AppLayout.vue', () => ({ default: { template: '<div><RouterView /></div>' } }))

import { auth } from './lib/session'
import type { Me } from './api'

function me(mustChangePassword: boolean): Me {
  return {
    mode: 'server',
    user: {
      id: 'u1',
      email: 'a@b.co',
      name: 'A',
      role: 'member',
      disabled: false,
      mustChangePassword,
      createdAt: 0,
      lastLoginAt: null,
    },
    org: { id: 'o1', name: 'Acme', createdAt: 0 },
    teams: [],
    permissions: ['data:read'],
    session: null,
  } as Me
}

describe('路由守卫：必须先修改密码', () => {
  afterEach(() => {
    auth.mode = 'desktop'
    auth.me = null
  })

  it('团队服务器上 mustChangePassword 的账号只能去改密页（或登录页），改完后改密页回到首页', async () => {
    const { router } = await import('./router')
    auth.mode = 'server'
    auth.me = me(true)
    await router.push('/customers')
    expect(router.currentRoute.value.name).toBe('change-password')
    expect(router.currentRoute.value.query.redirect).toBe('/customers')
    auth.me = me(false)
    await router.push('/change-password')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
