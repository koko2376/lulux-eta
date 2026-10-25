import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const apiMock = vi.hoisted(() => ({
  getLock: vi.fn(),
  regenerateLocalRecoveryCode: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), ...apiMock }))

import SettingsAccountView from './SettingsAccountView.vue'
import { auth } from '../lib/session'

async function mountView() {
  const Blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/login', name: 'login', component: Blank },
      { path: '/settings/account', component: SettingsAccountView },
      { path: '/:rest(.*)*', component: Blank },
    ],
  })
  await router.push('/settings/account')
  await router.isReady()
  const wrapper = mount(SettingsAccountView, {
    global: { plugins: [router], stubs: { SettingsSidebar: true, PageTopbar: true } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset())
  apiMock.getLock.mockResolvedValue({ enabled: false })
  auth.mode = 'desktop'
  auth.connection = 'local'
  auth.local = { hasAccount: true, username: 'Koko' }
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('设置 → 账户：重新生成恢复码', () => {
  it('需要当前密码；错误密码页内提示；成功后显示新恢复码，点“我已保存”关闭', async () => {
    const { ApiError } = await import('../api')
    const wrapper = await mountView()
    await wrapper.get('[data-testid=local-recovery-regenerate]').trigger('click')
    await flushPromises()
    const submit = () => (document.querySelector('[data-testid=local-recovery-submit]') as HTMLButtonElement).click()
    submit()
    await flushPromises()
    expect(document.querySelector('.modal [role=alert]')!.textContent).toBe('请输入密码')
    expect(apiMock.regenerateLocalRecoveryCode).not.toHaveBeenCalled()

    const input = document.querySelector('input[name=recovery-current-password]') as HTMLInputElement
    input.value = 'nope nope'
    input.dispatchEvent(new Event('input'))
    apiMock.regenerateLocalRecoveryCode.mockRejectedValueOnce(new ApiError('PASSWORD_INCORRECT', 'bad', 400))
    submit()
    await flushPromises()
    expect(document.querySelector('.modal [role=alert]')!.textContent).toBe('当前密码不正确')

    input.value = 'correct horse'
    input.dispatchEvent(new Event('input'))
    apiMock.regenerateLocalRecoveryCode.mockResolvedValueOnce({ recoveryCode: 'ABCDE-FGHJK-MNPQR-STVWX' })
    submit()
    await flushPromises()
    expect(apiMock.regenerateLocalRecoveryCode).toHaveBeenLastCalledWith('correct horse')
    expect(document.querySelector('input[name=recovery-current-password]')).toBeNull()
    expect(document.querySelector('[data-testid=recovery-code]')!.textContent).toBe('ABCDE-FGHJK-MNPQR-STVWX')
    expect(document.querySelector('[data-testid=recovery-dialog]')!.textContent).toContain('旧的恢复码已作废')
    ;(document.querySelector('[data-testid=recovery-saved]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-testid=recovery-dialog]')).toBeNull()
  })
})
