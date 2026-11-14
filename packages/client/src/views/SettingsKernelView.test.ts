/**
 * CLI 内核超时设置界面。
 * 两个字段可读可写可恢复默认；非整数 / 越界前端拦下不发请求；0 显示“不限制”；
 * 帮助文字区分“无输出超时”与“单次运行总时长”。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'

function signIn(permissions: api.Permission[] = [...api.ALL_PERMISSIONS]): void {
  auth.mode = 'server'
  auth.me = {
    mode: 'server',
    user: { id: 'me', email: 'me@acme.example.com', name: 'Me', role: 'owner', disabled: false, createdAt: 0, lastLoginAt: null },
    org: { id: 'o', name: 'Acme', createdAt: 0 },
    teams: [],
    permissions,
    session: null,
  } as never
}

const SCHEMA: api.SettingSchema[] = [
  { key: 'kernelIdleTimeoutSeconds', type: 'integer', default: '600', min: 0, max: 86400 },
  { key: 'kernelMaxRunMinutes', type: 'integer', default: '60', min: 0, max: 1440 },
]

async function mountView(settings: Record<string, string> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(api, 'listKernels').mockResolvedValue([
    { id: 'builtin', name: 'LULUX', vendor: 'LULUX', status: 'idle', installed: true } as never,
  ])
  vi.spyOn(api, 'getSettingsSchema').mockResolvedValue(SCHEMA)
  vi.spyOn(api, 'listProviders').mockResolvedValue([])
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.settings = { ...settings }
  store.refreshSettings = vi.fn(async () => undefined)
  const saveSettings = vi
    .spyOn(store, 'saveSettings')
    .mockImplementation(async (patch: Record<string, string>) => {
      store.settings = { ...store.settings, ...patch }
    })
  const { i18n } = await import('../i18n')
  const View = (await import('./SettingsKernelView.vue')).default
  const wrapper = mount(View, {
    global: {
      plugins: [pinia, i18n],
      directives: { perm: () => undefined },
      stubs: { SettingsSidebar: true, PageTopbar: true, RouterLink: true, ServerFeatureNote: true, teleport: true },
    },
  })
  await flushPromises()
  return { wrapper, store, saveSettings }
}

const idleInput = (w: Awaited<ReturnType<typeof mountView>>['wrapper']) =>
  w.find('input[name="kernelIdleTimeoutSeconds"]')
const maxRunInput = (w: Awaited<ReturnType<typeof mountView>>['wrapper']) =>
  w.find('input[name="kernelMaxRunMinutes"]')
const saveButton = (w: Awaited<ReturnType<typeof mountView>>['wrapper']) =>
  w.find('[data-testid="kernel-run-limits"]').find('button[type="submit"]')
/** jsdom 里点 submit 按钮不会触发 form 的 submit 事件：直接提交表单走同一条路径 */
const submitLimits = async (w: Awaited<ReturnType<typeof mountView>>['wrapper']) => {
  await w.find('[data-testid="kernel-run-limits"] form').trigger('submit')
  await flushPromises()
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

beforeEach(() => signIn())

describe('运行限制区块', () => {
  it('两个字段可读：显示服务端已存的值', async () => {
    const { wrapper } = await mountView({ kernelIdleTimeoutSeconds: '900', kernelMaxRunMinutes: '30' })
    expect((idleInput(wrapper).element as HTMLInputElement).value).toBe('900')
    expect((maxRunInput(wrapper).element as HTMLInputElement).value).toBe('30')
  })

  it('服务端没存过时显示默认值 600 / 60，并写明范围与默认值', async () => {
    const { wrapper } = await mountView()
    expect((idleInput(wrapper).element as HTMLInputElement).value).toBe('600')
    expect((maxRunInput(wrapper).element as HTMLInputElement).value).toBe('60')
    const text = wrapper.find('[data-testid="kernel-run-limits"]').text()
    expect(text).toContain('600')
    expect(text).toContain('0–86400')
    expect(text).toContain('0–1440')
  })

  it('帮助文字写清“无输出超时”与“单次运行总时长”的区别', async () => {
    const { wrapper } = await mountView()
    const text = wrapper.find('[data-testid="kernel-run-limits"]').text()
    expect(text).toContain('无输出超时')
    expect(text).toContain('单次运行总时长')
    // 两段说明都在：一段讲没输出就结束，一段讲不管有没有输出都有总时长上限
    expect(text).toContain('没有任何输出')
    expect(text).toContain('不管有没有输出')
  })

  it('可写：保存时把两个值一起 PATCH 出去', async () => {
    const { wrapper, saveSettings } = await mountView()
    await idleInput(wrapper).setValue('1200')
    await maxRunInput(wrapper).setValue('90')
    await submitLimits(wrapper)
    expect(saveSettings).toHaveBeenCalledWith({ kernelIdleTimeoutSeconds: '1200', kernelMaxRunMinutes: '90' })
  })

  it('0 明确显示“不限制”', async () => {
    const { wrapper } = await mountView({ kernelIdleTimeoutSeconds: '0', kernelMaxRunMinutes: '0' })
    expect(wrapper.find('[data-testid="idle-unlimited"]').text()).toContain('不限制')
    expect(wrapper.find('[data-testid="maxrun-unlimited"]').text()).toContain('不限制')

    // 改成非 0 后标记消失
    await idleInput(wrapper).setValue('30')
    expect(wrapper.find('[data-testid="idle-unlimited"]').exists()).toBe(false)
  })

  it.each([
    ['非整数', 'abc'],
    ['小数', '60.5'],
    ['负数', '-1'],
    ['越界', '86401'],
    ['空', ''],
  ])('%s 前端直接拦下，不发 PATCH', async (_why, bad) => {
    const { wrapper, saveSettings } = await mountView()
    await idleInput(wrapper).setValue(bad)
    await submitLimits(wrapper)
    expect(saveSettings).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="limits-error"]').exists()).toBe(true)
  })

  it('总时长越界同样拦下', async () => {
    const { wrapper, saveSettings } = await mountView()
    await maxRunInput(wrapper).setValue('1441')
    await submitLimits(wrapper)
    expect(saveSettings).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="limits-error"]').text()).toContain('0–1440')
  })

  it('恢复默认把输入框填回 600 / 60（保存前不写入）', async () => {
    const { wrapper, saveSettings } = await mountView({
      kernelIdleTimeoutSeconds: '120',
      kernelMaxRunMinutes: '5',
    })
    const reset = wrapper.find('[data-testid="kernel-run-limits"]').findAll('button').at(-1)!
    await reset.trigger('click')
    expect((idleInput(wrapper).element as HTMLInputElement).value).toBe('600')
    expect((maxRunInput(wrapper).element as HTMLInputElement).value).toBe('60')
    expect(saveSettings).not.toHaveBeenCalled()

    await submitLimits(wrapper)
    expect(saveSettings).toHaveBeenCalledWith({ kernelIdleTimeoutSeconds: '600', kernelMaxRunMinutes: '60' })
  })

  it('服务端拒绝（400 INVALID_SETTING）时把原始错误显示出来，不改本地值', async () => {
    const { wrapper, store, saveSettings } = await mountView()
    saveSettings.mockRejectedValueOnce(new api.ApiError('INVALID_SETTING', '设置项 kernelMaxRunMinutes 不能大于 1440', 400))
    await maxRunInput(wrapper).setValue('200')
    await submitLimits(wrapper)
    expect(wrapper.find('[data-testid="limits-error"]').text()).toContain('不能大于 1440')
    expect(store.settings.kernelMaxRunMinutes).toBeUndefined()
  })

  it('没有 settings:write 权限时两个输入框与保存按钮都禁用', async () => {
    signIn(['data:read'])
    const { wrapper } = await mountView()
    expect((idleInput(wrapper).element as HTMLInputElement).disabled).toBe(true)
    expect((maxRunInput(wrapper).element as HTMLInputElement).disabled).toBe(true)
    expect((saveButton(wrapper).element as HTMLButtonElement).disabled).toBe(true)
  })
})
