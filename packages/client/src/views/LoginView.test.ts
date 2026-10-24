import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const apiMock = vi.hoisted(() => ({
  login: vi.fn(),
  setupOwner: vi.fn(),
  verifyLock: vi.fn(),
  getLock: vi.fn(),
  localLogin: vi.fn(),
  createLocalAccount: vi.fn(),
  getLocalRecoveryInfo: vi.fn(),
  recoverLocalPassword: vi.fn(),
  resetLocalPasswordWithFile: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), ...apiMock }))

const sessionMock = vi.hoisted(() => ({
  saveSession: vi.fn(),
  saveLocalSession: vi.fn(),
  connectServer: vi.fn(),
  useLocalServer: vi.fn(),
}))
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  ...sessionMock,
}))

import LoginView from './LoginView.vue'
import { auth } from '../lib/session'
import { lockState } from '../lib/lock'

function makeRouter() {
  const Blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/login', component: LoginView },
      { path: '/settings/account', component: Blank },
      { path: '/settings/team', component: Blank },
    ],
  })
  return router
}

async function mountLogin(path = '/login') {
  const router = makeRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(LoginView, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  // 版本检查会请求 {server}/api/version：默认当作旧服务端（404），不拦截登录
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  )
  localStorage.clear()
  sessionStorage.clear()
  Object.values(apiMock).forEach((f) => f.mockReset())
  Object.values(sessionMock).forEach((f) => f.mockReset())
  apiMock.getLock.mockResolvedValue({ enabled: false })
  lockState.checked = false
  lockState.enabled = false
  lockState.unlocked = false
  auth.mode = 'desktop'
  auth.connection = 'local'
  auth.serverUrl = ''
  auth.setupRequired = false
  auth.local = { hasAccount: false, username: '' }
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('登录页布局', () => {
  it('本机：还没有本机账户（全新安装）→ 直接是“创建本机账户”表单，没有“返回登录”，不能留空直接进入', async () => {
    const { wrapper, router } = await mountLogin()
    const text = wrapper.text()
    for (const s of [
      'LULUX ETA',
      '外贸客户与询盘工作台',
      'LULUX',
      '云端 LULUX',
      '用户名',
      '密码',
      '确认密码',
      '记住这台机器',
    ])
      expect(text).toContain(s)
    expect(wrapper.get('[data-testid="login-tab-local"]').text()).toBe('LULUX')
    expect(wrapper.get('[data-testid="login-tab-server"]').text()).toBe('云端 LULUX')
    expect(wrapper.get('[data-testid=login-tab-local]').attributes('aria-selected')).toBe('true')
    expect(text).not.toContain('邮箱')
    expect(wrapper.find('[data-testid=local-login-form]').exists()).toBe(false)
    expect(wrapper.get('[data-testid=local-first-run]').text()).toContain('还没有本机账户')
    expect(wrapper.find('[data-testid=local-back]').exists()).toBe(false)
    // 默认不勾“记住这台机器”：每次打开都先到登录页
    expect((wrapper.get('.ao-check input').element as HTMLInputElement).checked).toBe(false)
    await wrapper.get('[data-testid=local-create-submit]').trigger('click')
    await flushPromises()
    expect(apiMock.createLocalAccount).not.toHaveBeenCalled()
    expect(apiMock.localLogin).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('右上角语言选择：列出应用自带的全部语言，默认简体中文；切换即时生效，与设置里的语言是同一个偏好', async () => {
    const { setLanguage, LOCALES } = await import('../i18n')
    try {
      const { wrapper } = await mountLogin()
      const picker = wrapper.get('[data-testid=login-language]')
      expect(picker.text()).toContain('简体中文')
      const select = wrapper.get('[data-testid=login-language-select]')
      expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(LOCALES)
      expect(select.findAll('option').map((o) => o.text())).toEqual(['简体中文', 'English'])
      expect((select.element as HTMLSelectElement).value).toBe('zh-CN')
      await select.setValue('en')
      await flushPromises()
      expect(localStorage.getItem('lulux.language')).toBe('en')
      expect(wrapper.get('[data-testid=login-language]').text()).toContain('English')
      expect(wrapper.get('[data-testid=local-create-submit]').text()).not.toMatch(/[\u4e00-\u9fff]/)
      expect(document.documentElement.lang).toBe('en')
    } finally {
      setLanguage('zh-CN')
      localStorage.removeItem('lulux.language')
    }
  })

  it('登录页带进场动画（ao-intro），播放一次后去掉', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper } = await mountLogin()
      expect(wrapper.get('[data-testid=login-page]').classes()).toContain('ao-intro')
      vi.advanceTimersByTime(1500)
      await wrapper.vm.$nextTick()
      expect(wrapper.get('[data-testid=login-page]').classes()).not.toContain('ao-intro')
    } finally {
      vi.useRealTimers()
    }
  })

  it('本机：有账户时显示登录表单（用户名 + 密码），上次勾过“记住”才预先勾上', async () => {
    auth.local = { hasAccount: true, username: '' }
    localStorage.setItem('lulux.login', JSON.stringify({ tab: 'local', username: 'Koko', remember: true }))
    const { wrapper } = await mountLogin()
    const text = wrapper.text()
    expect(text).toContain('首次使用，创建本机账户')
    expect(text).toContain('数据只保存在这台电脑上')
    expect(text).toContain('了解本地模式')
    expect(wrapper.find('[data-testid=local-no-account]').exists()).toBe(false)
    const inputs = wrapper.findAll('form input:not([type=checkbox])')
    expect(inputs.map((i) => i.attributes('name'))).toEqual(['username', 'local-password'])
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('Koko')
    expect((wrapper.get('.ao-check input').element as HTMLInputElement).checked).toBe(true)
  })

  it('本机：有账户时用户名 / 密码必填，错误密码页内提示，正确后保存会话（记住 → 持久）', async () => {
    auth.local = { hasAccount: true, username: '' }
    const { ApiError } = await import('../api')
    const { wrapper, router } = await mountLogin()
    expect(wrapper.find('[data-testid=local-no-account]').exists()).toBe(false)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.findAll('[role=alert]').map((a) => a.text())).toEqual(['请输入用户名', '请输入密码'])
    apiMock.localLogin.mockRejectedValueOnce(new ApiError('INVALID_CREDENTIALS', 'bad', 401))
    await wrapper.get('input[name=username]').setValue('koko')
    await wrapper.get('input[name=local-password]').setValue('wrong-pass')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('用户名或密码错误')
    expect(router.currentRoute.value.path).toBe('/login')
    const result = {
      token: 'lls_x',
      expiresAt: 1,
      persistent: true,
      account: { id: 'a', username: 'Koko', createdAt: 0, lastLoginAt: 0 },
    }
    apiMock.localLogin.mockResolvedValueOnce(result)
    await wrapper.get('input[name=local-password]').setValue('correct horse')
    await wrapper.get('.ao-check input').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMock.localLogin).toHaveBeenLastCalledWith('koko', 'correct horse', true)
    expect(sessionMock.saveLocalSession).toHaveBeenCalledWith(result, { persist: true })
    expect(JSON.parse(localStorage.getItem('lulux.login')!)).toEqual({
      tab: 'local',
      local: { username: 'Koko', remember: true },
    })
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('记住的会话失效 / 重启后需重新登录：预填上次用户名、保持勾选、光标在密码框', async () => {
    auth.local = { hasAccount: true, username: '' }
    localStorage.setItem('lulux.login', JSON.stringify({ tab: 'local', local: { username: 'Koko', remember: true } }))
    const { wrapper } = await mountLogin()
    expect((wrapper.get('input[name=username]').element as HTMLInputElement).value).toBe('Koko')
    expect((wrapper.get('.ao-check input').element as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('input[name=local-password]').element)
  })

  it('没勾过“记住”：不预填、不勾选、光标不抢到密码框', async () => {
    auth.local = { hasAccount: true, username: '' }
    const { wrapper } = await mountLogin()
    expect((wrapper.get('input[name=username]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('.ao-check input').element as HTMLInputElement).checked).toBe(false)
    expect(document.activeElement).not.toBe(wrapper.get('input[name=local-password]').element)
  })

  it('“记住”按登录方式分别记：本机勾过不影响云端，云端按服务器地址带出邮箱与勾选', async () => {
    auth.local = { hasAccount: true, username: '' }
    localStorage.setItem(
      'lulux.login',
      JSON.stringify({
        tab: 'local',
        local: { username: 'Koko', remember: true },
        servers: { 'https://eta.example.com': { email: 'a@b.co', remember: true } },
        lastServer: 'https://eta.example.com',
      }),
    )
    const { wrapper } = await mountLogin()
    const box = () => (wrapper.get('.ao-check input').element as HTMLInputElement).checked
    expect(box()).toBe(true)
    await wrapper.get('[data-testid=login-tab-server]').trigger('click')
    expect((wrapper.get('input[name=server]').element as HTMLInputElement).value).toBe('https://eta.example.com')
    expect((wrapper.get('input[name=email]').element as HTMLInputElement).value).toBe('a@b.co')
    expect(box()).toBe(true)
    await wrapper.get('input[name=server]').setValue('https://other.example.com')
    await wrapper.get('[data-testid=login-tab-local]').trigger('click')
    expect(box()).toBe(true)
    await wrapper.get('[data-testid=login-tab-server]').trigger('click')
    expect(box()).toBe(false)
  })

  it('旧格式偏好（一个勾选管两栏）仍能预填', async () => {
    auth.local = { hasAccount: true, username: '' }
    localStorage.setItem(
      'lulux.login',
      JSON.stringify({ tab: 'local', username: 'Old', serverUrl: 'https://eta.example.com', email: 'o@b.co', remember: true }),
    )
    const { wrapper } = await mountLogin()
    expect((wrapper.get('input[name=username]').element as HTMLInputElement).value).toBe('Old')
    expect((wrapper.get('.ao-check input').element as HTMLInputElement).checked).toBe(true)
  })

  it('本机：不勾“记住这台机器”时会话只存本次', async () => {
    auth.local = { hasAccount: true, username: '' }
    const result = {
      token: 'lls_y',
      expiresAt: 1,
      persistent: false,
      account: { id: 'a', username: 'k2', createdAt: 0, lastLoginAt: 0 },
    }
    apiMock.localLogin.mockResolvedValueOnce(result)
    const { wrapper } = await mountLogin()
    await wrapper.get('input[name=username]').setValue('k2')
    await wrapper.get('input[name=local-password]').setValue('password1')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(apiMock.localLogin).toHaveBeenCalledWith('k2', 'password1', false)
    expect(sessionMock.saveLocalSession).toHaveBeenCalledWith(result, { persist: false })
    expect(localStorage.getItem('lulux.login')).toBeNull()
  })

  it('本机：“首次使用，创建本机账户”打开同版式创建表单，校验后创建并登录', async () => {
    const { ApiError } = await import('../api')
    const { wrapper, router } = await mountLogin()
    await wrapper.get('.ao-check input').setValue(true)
    const form = wrapper.get('[data-testid=local-create-form]')
    expect(form.text()).toContain('用户名')
    expect(form.text()).toContain('确认密码')
    expect(form.findAll('input:not([type=checkbox])').map((i) => i.attributes('name'))).toEqual([
      'username',
      'new-password',
      'confirm-password',
    ])
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    expect(wrapper.findAll('[role=alert]').map((a) => a.text())).toEqual(['请输入用户名', '请输入密码'])
    await wrapper.get('input[name=username]').setValue('k')
    await wrapper.get('input[name=new-password]').setValue('short')
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    expect(wrapper.findAll('[role=alert]').map((a) => a.text())).toEqual([
      '用户名需要 2–32 个字符，只能包含字母、数字、中文和 . _ -',
      '密码至少 8 位',
    ])
    await wrapper.get('input[name=username]').setValue('Koko')
    await wrapper.get('input[name=new-password]').setValue('correct horse')
    await wrapper.get('input[name=confirm-password]').setValue('correct horsf')
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toBe('两次输入的密码不一致')
    expect(apiMock.createLocalAccount).not.toHaveBeenCalled()

    apiMock.createLocalAccount.mockRejectedValueOnce(new ApiError('USERNAME_TAKEN', 'dup', 409))
    await wrapper.get('input[name=confirm-password]').setValue('correct horse')
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('这个用户名已经存在')

    const result = {
      token: 'lls_z',
      expiresAt: 1,
      persistent: true,
      account: { id: 'a', username: 'Koko', createdAt: 0, lastLoginAt: null },
    }
    apiMock.createLocalAccount.mockResolvedValueOnce(result)
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    await flushPromises()
    expect(apiMock.createLocalAccount).toHaveBeenLastCalledWith('Koko', 'correct horse', true)
    expect(sessionMock.saveLocalSession).toHaveBeenCalledWith(result, { persist: true })
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('本机：/login?create=1 直接打开创建表单，“返回登录”回到登录表单', async () => {
    auth.local = { hasAccount: true, username: '' }
    const { wrapper } = await mountLogin('/login?create=1')
    expect(wrapper.find('[data-testid=local-create-form]').exists()).toBe(true)
    await wrapper.get('[data-testid=local-back]').trigger('click')
    expect(wrapper.find('[data-testid=local-login-form]').exists()).toBe(true)
  })

  it('连接服务器：内联校验地址 / 邮箱 / 密码，http 非本机地址被拒', async () => {
    const { wrapper } = await mountLogin()
    await wrapper.get('[data-testid=login-tab-server]').trigger('click')
    expect(wrapper.text()).toContain('服务器地址')
    expect(wrapper.text()).toContain('记住这台服务器')
    expect(wrapper.text()).toContain('测试连接')
    await wrapper.get('form').trigger('submit')
    const alerts = () => wrapper.findAll('[role=alert]').map((a) => a.text())
    expect(alerts()).toEqual(['请输入服务器地址', '请输入邮箱', '请输入密码'])
    await wrapper.get('input[name=server]').setValue('http://eta.example.com')
    await wrapper.get('input[name=email]').setValue('not-an-email')
    await wrapper.get('input[name=password]').setValue('x')
    await wrapper.get('form').trigger('submit')
    expect(alerts()[0]).toContain('https')
    expect(alerts()[1]).toBe('邮箱格式不正确')
    expect(wrapper.get('input[name=server]').attributes('aria-invalid')).toBe('true')
    expect(sessionMock.connectServer).not.toHaveBeenCalled()
    expect(apiMock.login).not.toHaveBeenCalled()
  })

  it('连接服务器：先连接再用邮箱密码真实登录；不勾记住时会话不持久', async () => {
    sessionMock.connectServer.mockImplementation(async (url: string) => {
      auth.mode = 'server'
      auth.connection = 'remote'
      auth.serverUrl = url
      return { ok: true }
    })
    apiMock.login.mockResolvedValue({ token: 'lxs_x', user: null, expiresAt: 0 })
    const { wrapper, router } = await mountLogin()
    await wrapper.get('[data-testid=login-tab-server]').trigger('click')
    await wrapper.get('input[name=server]').setValue('https://eta.example.com/')
    await wrapper.get('input[name=email]').setValue('a@b.co')
    await wrapper.get('input[name=password]').setValue('Secret-pass-1')
    await wrapper.get('.ao-check input').setValue(false)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(sessionMock.connectServer).toHaveBeenCalledWith('https://eta.example.com')
    expect(apiMock.login).toHaveBeenCalledWith('a@b.co', 'Secret-pass-1')
    expect(sessionMock.saveSession).toHaveBeenCalledWith(
      { token: 'lxs_x', user: null, expiresAt: 0 },
      { persist: false },
    )
    expect(localStorage.getItem('lulux.login')).toBeNull()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('连接服务器：错误密码在页内提示，不跳转', async () => {
    auth.mode = 'server'
    auth.connection = 'remote'
    auth.serverUrl = 'https://eta.example.com'
    const { ApiError } = await import('../api')
    apiMock.login.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 'bad', 401))
    const { wrapper, router } = await mountLogin()
    expect(wrapper.get('[data-testid=login-tab-server]').attributes('aria-selected')).toBe('true')
    expect((wrapper.get('input[name=server]').element as HTMLInputElement).value).toBe('https://eta.example.com')
    await wrapper.get('input[name=email]').setValue('a@b.co')
    await wrapper.get('input[name=password]').setValue('wrong-pass')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(sessionMock.connectServer).not.toHaveBeenCalled()
    expect(wrapper.get('[role=alert]').text()).toBe('邮箱或密码错误')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('同源团队服务器尚未初始化：显示初始化所有者表单；本机栏如实说明没有本机模式', async () => {
    auth.mode = 'server'
    auth.setupRequired = true
    const { wrapper } = await mountLogin()
    expect(wrapper.find('h1').text()).toBe('初始化团队服务器')
    await wrapper.get('[data-testid=login-tab-local]').trigger('click')
    expect(wrapper.get('[data-testid=local-unavailable]').text()).toContain('没有本机模式')
    expect((wrapper.get('[data-testid=local-enter]').element as HTMLButtonElement).disabled).toBe(true)
  })
})

const localResult = (extra: Record<string, unknown> = {}) => ({
  token: 'lls_r',
  expiresAt: 1,
  persistent: false,
  account: { id: 'a', username: 'Koko', createdAt: 0, lastLoginAt: 0 },
  ...extra,
})
const CODE = 'ABCDE-FGHJK-MNPQR-STVWX'

describe('本机：忘记密码与恢复码', () => {
  beforeEach(() => {
    auth.local = { hasAccount: true, username: '' }
    apiMock.getLocalRecoveryInfo.mockResolvedValue({
      dataDir: '/home/koko/.lulux-eta',
      resetFileName: 'RESET-LOCAL-PASSWORD',
      resetFilePresent: false,
    })
  })

  it('“忘记密码？”→ 恢复码 + 新密码：校验、错误码提示，成功后先显示新恢复码，点“我已保存”才进入', async () => {
    const { ApiError } = await import('../api')
    const { wrapper, router } = await mountLogin()
    await wrapper.get('[data-testid=local-forgot]').trigger('click')
    await flushPromises()
    const form = wrapper.get('[data-testid=local-forgot-form]')
    expect(form.findAll('input').map((i) => i.attributes('name'))).toEqual([
      'username',
      'recovery-code',
      'new-password',
      'confirm-password',
    ])
    await form.trigger('submit')
    expect(wrapper.findAll('[role=alert]').map((a) => a.text())).toEqual(['请输入用户名', '请输入恢复码', '请输入密码'])

    await wrapper.get('input[name=username]').setValue('koko')
    await wrapper.get('input[name=recovery-code]').setValue('wrong')
    await wrapper.get('input[name=new-password]').setValue('brand new pass')
    await wrapper.get('input[name=confirm-password]').setValue('brand new pasz')
    await form.trigger('submit')
    expect(wrapper.get('[role=alert]').text()).toBe('两次输入的密码不一致')
    expect(apiMock.recoverLocalPassword).not.toHaveBeenCalled()

    await wrapper.get('input[name=confirm-password]').setValue('brand new pass')
    apiMock.recoverLocalPassword.mockRejectedValueOnce(new ApiError('RECOVERY_CODE_INVALID', 'bad', 401))
    await form.trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('用户名或恢复码不正确')
    apiMock.recoverLocalPassword.mockRejectedValueOnce(new ApiError('LOGIN_RATE_LIMITED', 'slow', 429))
    await form.trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('尝试次数过多，请稍后再试')

    const result = localResult({ recoveryCode: 'NEW00-NEW00-NEW00-NEW00' })
    apiMock.recoverLocalPassword.mockResolvedValueOnce(result)
    await wrapper.get('input[name=recovery-code]').setValue(CODE)
    await form.trigger('submit')
    await flushPromises()
    expect(apiMock.recoverLocalPassword).toHaveBeenLastCalledWith({
      username: 'koko',
      recoveryCode: CODE,
      newPassword: 'brand new pass',
      remember: false,
    })
    expect(sessionMock.saveLocalSession).toHaveBeenCalledWith(result, { persist: false })
    // 新恢复码只显示这一次：保存前不进入
    const dialog = document.querySelector('[data-testid=recovery-dialog]')!
    expect(dialog.textContent).toContain('旧的恢复码已作废')
    expect(document.querySelector('[data-testid=recovery-code]')!.textContent).toBe('NEW00-NEW00-NEW00-NEW00')
    expect(router.currentRoute.value.path).toBe('/login')
    // 不能用 Esc 关掉
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.querySelector('[data-testid=recovery-dialog]')).not.toBeNull()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    ;(document.querySelector('[data-testid=recovery-copy]') as HTMLButtonElement).click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('NEW00-NEW00-NEW00-NEW00')
    expect(document.querySelector('[data-testid=recovery-dialog]')!.textContent).toContain('已复制到剪贴板')

    ;(document.querySelector('[data-testid=recovery-saved]') as HTMLButtonElement).click()
    await flushPromises()
    expect(document.querySelector('[data-testid=recovery-dialog]')).toBeNull()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('恢复码也丢了：显示数据目录与重置文件说明；检测到文件后不需要恢复码，直接设新密码', async () => {
    const { wrapper, router } = await mountLogin()
    await wrapper.get('[data-testid=local-forgot]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=local-lost-code-help]').exists()).toBe(false)
    await wrapper.get('[data-testid=local-lost-code]').trigger('click')
    const help = wrapper.get('[data-testid=local-lost-code-help]')
    expect(help.text()).toContain('在此目录新建名为 RESET-LOCAL-PASSWORD 的空文件，然后重启 LULUX')
    expect(wrapper.get('[data-testid=local-data-dir]').text()).toBe('/home/koko/.lulux-eta')

    apiMock.getLocalRecoveryInfo.mockResolvedValue({
      dataDir: '/home/koko/.lulux-eta',
      resetFileName: 'RESET-LOCAL-PASSWORD',
      resetFilePresent: true,
    })
    await wrapper.get('[data-testid=local-recheck]').trigger('click')
    await flushPromises()
    const form = wrapper.get('[data-testid=local-forgot-form]')
    expect(form.find('input[name=recovery-code]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=local-reset-file-found]').exists()).toBe(true)
    expect(form.text()).toContain('已检测到重置文件')

    const result = localResult({ persistent: true, recoveryCode: CODE })
    apiMock.resetLocalPasswordWithFile.mockResolvedValueOnce(result)
    await wrapper.get('input[name=username]').setValue('Koko')
    await wrapper.get('input[name=new-password]').setValue('file reset pass')
    await wrapper.get('input[name=confirm-password]').setValue('file reset pass')
    await form.trigger('submit')
    await flushPromises()
    expect(apiMock.resetLocalPasswordWithFile).toHaveBeenCalledWith({
      username: 'Koko',
      newPassword: 'file reset pass',
      remember: false,
    })
    expect(apiMock.recoverLocalPassword).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid=recovery-code]')!.textContent).toBe(CODE)
    ;(document.querySelector('[data-testid=recovery-saved]') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('“返回登录”回到登录表单', async () => {
    const { wrapper } = await mountLogin()
    await wrapper.get('[data-testid=local-forgot]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid=local-back]').trigger('click')
    expect(wrapper.find('[data-testid=local-login-form]').exists()).toBe(true)
  })

  it('创建账户后先显示恢复码，保存后才进入', async () => {
    auth.local = { hasAccount: false, username: '' }
    apiMock.createLocalAccount.mockResolvedValueOnce(localResult({ recoveryCode: CODE }))
    const { wrapper, router } = await mountLogin()
    await wrapper.get('input[name=username]').setValue('Koko')
    await wrapper.get('input[name=new-password]').setValue('correct horse')
    await wrapper.get('input[name=confirm-password]').setValue('correct horse')
    await wrapper.get('[data-testid=local-create-form]').trigger('submit')
    await flushPromises()
    expect(document.querySelector('[data-testid=recovery-dialog]')!.textContent).toContain('它只显示这一次')
    expect(router.currentRoute.value.path).toBe('/login')
    ;(document.querySelector('[data-testid=recovery-saved]') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('早期版本的账户：登录后服务端补发恢复码 → 提示保存一次', async () => {
    apiMock.localLogin.mockResolvedValueOnce(localResult({ recoveryCode: CODE }))
    const { wrapper, router } = await mountLogin()
    await wrapper.get('input[name=username]').setValue('Koko')
    await wrapper.get('input[name=local-password]').setValue('correct horse')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(document.querySelector('[data-testid=recovery-dialog]')!.textContent).toContain('你的账户还没有恢复码')
    expect(router.currentRoute.value.path).toBe('/login')
    ;(document.querySelector('[data-testid=recovery-saved]') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })
})

describe('登录页：客户端与团队服务器的版本兼容', () => {
  function stubVersion(body: Record<string, unknown>) {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/version')) return new Response(JSON.stringify(body), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchFn)
    return fetchFn
  }
  afterEach(async () => {
    vi.unstubAllGlobals()
    const { resetVersionCompat } = await import('../lib/version-compat')
    resetVersionCompat()
  })
  async function submitRemote() {
    auth.mode = 'server'
    auth.connection = 'remote'
    auth.serverUrl = 'https://eta.example.com'
    apiMock.login.mockResolvedValue({ token: 'lxs_x', user: null, expiresAt: 0 })
    const mounted = await mountLogin()
    await mounted.wrapper.get('input[name=email]').setValue('a@b.co')
    await mounted.wrapper.get('input[name=password]').setValue('Secret-pass-1')
    await mounted.wrapper.get('form').trigger('submit')
    await flushPromises()
    return mounted
  }

  it('低于服务器要求的最低客户端版本：不登录，页内说明需要先更新客户端', async () => {
    const fetchFn = stubVersion({ version: '9.0.0', minClientVersion: '99.0.0' })
    const { wrapper, router } = await submitRemote()
    expect(fetchFn.mock.calls[0]![0]).toBe('https://eta.example.com/api/version')
    expect(apiMock.login).not.toHaveBeenCalled()
    const note = wrapper.get('[data-testid=server-version-note]')
    expect(note.attributes('role')).toBe('alert')
    expect(note.text()).toContain('低于团队服务器要求的最低版本 99.0.0')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('服务器版本更旧（次版本不同）：照常登录，只提示请管理员升级服务器', async () => {
    stubVersion({ version: '0.0.1', minClientVersion: '0.0.1' })
    const { versionCompat } = await import('../lib/version-compat')
    await submitRemote()
    expect(apiMock.login).toHaveBeenCalled()
    expect(versionCompat.result?.status).toBe('client-newer')
  })

  it('旧服务端没有 /api/version：不拦截', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    await submitRemote()
    expect(apiMock.login).toHaveBeenCalled()
  })

  it('“测试连接”同时给出版本提示', async () => {
    stubVersion({ version: '0.0.1', minClientVersion: '0.0.1' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/api/version')
          ? new Response(JSON.stringify({ version: '0.0.1', minClientVersion: '0.0.1' }), { status: 200 })
          : new Response(JSON.stringify({ mode: 'server', setupRequired: false, version: '0.0.1' }), { status: 200 }),
      ),
    )
    const { wrapper } = await mountLogin()
    await wrapper.get('[data-testid=login-tab-server]').trigger('click')
    await wrapper.get('input[name=server]').setValue('https://eta.example.com')
    await wrapper.get('[data-testid=server-test]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid=server-test-result]').text()).toContain('0.0.1')
    expect(wrapper.get('[data-testid=server-version-note]').text()).toContain('请联系管理员升级服务器')
  })
})
