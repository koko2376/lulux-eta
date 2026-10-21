import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const apiMock = vi.hoisted(() => ({ changePassword: vi.fn() }))
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), ...apiMock }))
const sessionMock = vi.hoisted(() => ({
  initAuth: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
}))
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  ...sessionMock,
}))

import ChangePasswordView from './ChangePasswordView.vue'
import { auth } from '../lib/session'
import type { Me } from '../api'

function me(mustChangePassword: boolean): Me {
  return {
    mode: 'server',
    user: {
      id: 'u1',
      email: 'dave@acme.com',
      name: 'Dave',
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

async function mountView(path = '/change-password?redirect=/customers') {
  const Blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/customers', component: Blank },
      { path: '/login', name: 'login', component: Blank },
      { path: '/change-password', name: 'change-password', component: ChangePasswordView },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ChangePasswordView, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  apiMock.changePassword.mockReset()
  sessionMock.initAuth.mockClear()
  sessionMock.signOut.mockClear()
  auth.mode = 'server'
  auth.me = me(true)
})
afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  document.body.innerHTML = ''
})

describe('强制修改密码页', () => {
  it('校验：临时密码必填、新密码至少 8 位、不能与临时密码相同、两次一致', async () => {
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('dave@acme.com')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('请输入管理员给你的临时密码')
    expect(wrapper.text()).toContain('新密码至少 8 位')
    await wrapper.get('input[name=current-password]').setValue('temp pass 1')
    await wrapper.get('input[name=new-password]').setValue('temp pass 1')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('新密码不能和临时密码相同')
    await wrapper.get('input[name=new-password]').setValue('my own secret')
    await wrapper.get('input[name=confirm-password]').setValue('something else')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('两次输入的新密码不一致')
    expect(apiMock.changePassword).not.toHaveBeenCalled()
  })

  it('修改成功：清掉标记、重新加载登录态，回到原来要去的页面', async () => {
    apiMock.changePassword.mockResolvedValue(undefined)
    const { wrapper, router } = await mountView()
    await wrapper.get('input[name=current-password]').setValue('temp pass 1')
    await wrapper.get('input[name=new-password]').setValue('my own secret')
    await wrapper.get('input[name=confirm-password]').setValue('my own secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMock.changePassword).toHaveBeenCalledWith('temp pass 1', 'my own secret')
    expect(auth.me?.user.mustChangePassword).toBe(false)
    expect(sessionMock.initAuth).toHaveBeenCalledWith(true)
    expect(router.currentRoute.value.path).toBe('/customers')
  })

  it('临时密码错误：字段下提示，不跳转', async () => {
    const { ApiError } = await import('../api')
    apiMock.changePassword.mockRejectedValue(new ApiError('PASSWORD_INCORRECT', 'x', 403))
    const { wrapper, router } = await mountView()
    await wrapper.get('input[name=current-password]').setValue('wrong pass')
    await wrapper.get('input[name=new-password]').setValue('my own secret')
    await wrapper.get('input[name=confirm-password]').setValue('my own secret')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('临时密码不正确')
    expect(router.currentRoute.value.path).toBe('/change-password')
  })

  it('可以退出登录', async () => {
    const { wrapper, router } = await mountView()
    await wrapper.get('[data-testid=change-password-logout]').trigger('click')
    await flushPromises()
    expect(sessionMock.signOut).toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/login')
  })
})

describe('403 PASSWORD_CHANGE_REQUIRED', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('通知改密监听器，不推全局错误提示', async () => {
    const http = await import('../api/http')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改密码' } }), {
            status: 403,
          }),
      ),
    )
    const onChange = vi.fn()
    const onError = vi.fn()
    const off1 = http.onPasswordChangeRequired(onChange)
    const off2 = http.onApiError(onError)
    await expect(http.request('/api/customers')).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
      status: 403,
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    off1()
    off2()
  })
})
