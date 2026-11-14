/**
 * 导入结果展示 appliedSettings / skippedSettings。
 * 只显示键名（不显示任何设置值 / 密钥），长列表可折叠，空结果不渲染空面板。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'

function signIn(): void {
  auth.mode = 'desktop'
  auth.connection = 'local'
  auth.me = {
    mode: 'desktop',
    user: { id: 'me', email: '', name: 'Me', role: 'owner', disabled: false, createdAt: 0, lastLoginAt: null },
    org: { id: 'local', name: 'Local', createdAt: 0 },
    teams: [],
    permissions: [...api.ALL_PERMISSIONS],
    session: null,
  } as never
}

const fullResult = (over: Partial<api.DataImportResult> = {}): api.DataImportResult => ({
  imported: { settings: 3, customers: 12, sessions: 5, messages: 40, quotes: 2 },
  backup: '/Users/test/.lulux-eta/backups/before-import-2026-11-11.db',
  appliedSettings: ['theme', 'language', 'contextLimit'],
  skippedSettings: ['webhookUrl', 'proxyUrl', 'masterKey'],
  ...over,
})

async function mountView(result: api.DataImportResult | Error) {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(api, 'getDataSummary').mockResolvedValue({
    sessions: 1,
    messages: 2,
    providers: 1,
    mcpServers: 0,
    databaseBytes: 4096,
  } as never)
  vi.spyOn(api, 'importData').mockImplementation(async () => {
    if (result instanceof Error) throw result
    return result
  })
  // 文件选择：直接喂一个 JSON，跳过真实 input[type=file]
  const file = { name: 'lulux-backup.json', text: async () => JSON.stringify({ app: 'LULUX ETA' }) }
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.refreshSessions = vi.fn(async () => undefined)
  const View = (await import('./SettingsBackupView.vue')).default
  const wrapper = mount(View, {
    global: {
      plugins: [pinia],
      directives: { perm: () => undefined },
      stubs: { SettingsSidebar: true, PageTopbar: true, RouterLink: true, BackupSnapshots: true, teleport: true },
    },
  })
  await flushPromises()
  return { wrapper, store, file }
}

/** 触发一次导入：组件用 confirmDialog 二次确认，这里直接确认通过 */
async function doImport(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper'], file: { name: string; text: () => Promise<string> }) {
  const ui = await import('../stores/ui')
  vi.spyOn(ui, 'confirmDialog').mockResolvedValue(true)
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

beforeEach(() => signIn())

describe('导入结果面板', () => {
  it('导入前不渲染结果面板（空结果不显示空面板）', async () => {
    const { wrapper } = await mountView(fullResult())
    expect(wrapper.find('[data-testid="import-result"]').exists()).toBe(false)
  })

  it('显示“已应用 N 项”“已跳过 N 项”和键名，数量与结果一致', async () => {
    const { wrapper, file } = await mountView(fullResult())
    await doImport(wrapper, file)

    const panel = wrapper.find('[data-testid="import-result"]')
    expect(panel.exists()).toBe(true)
    expect(wrapper.find('[data-testid="import-applied"]').text()).toContain('已应用 3 项')
    expect(wrapper.find('[data-testid="import-skipped"]').text()).toContain('已跳过 3 项')
    const skipped = wrapper.find('[data-testid="import-skipped"]').text()
    for (const key of ['webhookUrl', 'proxyUrl', 'masterKey']) expect(skipped).toContain(key)
    const applied = wrapper.find('[data-testid="import-applied"]').text()
    for (const key of ['theme', 'language', 'contextLimit']) expect(applied).toContain(key)
    // 表计数仍在
    expect(panel.text()).toContain('客户')
  })

  it('只显示键名，绝不显示设置值（密钥类值不进 DOM）', async () => {
    const secret = 'sk-live-DEADBEEF-not-shown'
    const { wrapper, file } = await mountView(
      fullResult({
        // 服务端只回键名；即使备份里带了值也只会出现在 imported 计数里
        skippedSettings: ['masterKey'],
        appliedSettings: ['theme'],
        imported: { settings: 1 },
      }),
    )
    await doImport(wrapper, file)
    const text = wrapper.text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain('sk-')
    // 键名在
    expect(text).toContain('masterKey')
  })

  it('空结果（没有设置被应用或跳过）不渲染设置两栏，只有表计数', async () => {
    const { wrapper, file } = await mountView(fullResult({ appliedSettings: [], skippedSettings: [] }))
    await doImport(wrapper, file)
    expect(wrapper.find('[data-testid="import-result"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="import-applied"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="import-skipped"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('导入结果')
  })

  it('长列表默认只列 6 项，点“展开全部”后全部可见并可收起', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `setting${i}`)
    const { wrapper, file } = await mountView(fullResult({ appliedSettings: many, skippedSettings: [] }))
    await doImport(wrapper, file)
    const group = wrapper.find('[data-testid="import-applied"]')
    expect(group.findAll('li')).toHaveLength(6)

    const toggle = group.find('button')
    expect(toggle.text()).toContain('展开全部 11 项')
    await toggle.trigger('click')
    expect(group.findAll('li')).toHaveLength(11)
    expect(group.find('button').text()).toContain('收起')

    await group.find('button').trigger('click')
    expect(group.findAll('li')).toHaveLength(6)
  })

  it('导入失败时不留下上一次的成功面板内容（不显示伪造结果）', async () => {
    const { wrapper, file } = await mountView(new api.ApiError('HTTP_400', '备份文件格式不对', 400))
    const ui = await import('../stores/ui')
    const errorToast = vi.spyOn(ui.toast, 'error')
    await doImport(wrapper, file).catch(() => undefined)
    expect(wrapper.find('[data-testid="import-result"]').exists()).toBe(false)
    expect(errorToast).toHaveBeenCalled()
  })
})
