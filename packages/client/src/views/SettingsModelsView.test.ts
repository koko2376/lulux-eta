import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { auth } from '../lib/session'

const query: Record<string, string> = {}
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRoute: () => ({ query }), useRouter: () => ({ push: vi.fn() }) }
})

function provider(manual: api.ReasoningChoice | null = null): api.Provider {
  const effective = manual ?? 'none'
  return {
    id: 'p1',
    name: 'Relay',
    kind: 'openai',
    baseUrl: 'https://relay.example.com/v1',
    model: 'zz-house-model',
    models: ['zz-house-model', 'vendor/odd-thinker'],
    createdAt: 0,
    hasApiKey: true,
    apiKeyPreview: 'sk-…1234',
    apiKeyError: null,
    modelReasoning: {
      'zz-house-model': { manual, detected: null, auto: 'none', effective },
      'vendor/odd-thinker': { manual: null, detected: 'openai', auto: 'openai', effective: 'openai' },
    },
  }
}

let current = provider()

async function mountView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(api, 'listProviders').mockImplementation(async () => [current])
  vi.spyOn(api, 'listSettings').mockResolvedValue({} as never)
  vi.spyOn(api, 'getModels').mockResolvedValue({
    kernel: 'builtin',
    kernelName: 'LULUX',
    mode: 'builtin',
    groups: [],
    default: { providerId: null, model: null, label: '', efforts: ['off'] },
    defaultEffort: null,
    effort: true,
  })
  const builtin = await import('../api/builtin')
  vi.spyOn(builtin, 'getCapabilities').mockResolvedValue(null as never)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.modelCatalogs = { builtin: null }
  const View = (await import('./SettingsModelsView.vue')).default
  const wrapper = mount(View, {
    global: { plugins: [pinia], stubs: { SettingsSidebar: true, PageTopbar: true, RouterLink: true, teleport: true } },
    attachTo: document.body,
  })
  await flushPromises()
  return { wrapper, store }
}

beforeEach(() => {
  current = provider()
  for (const key of Object.keys(query)) delete query[key]
})

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('模型与密钥：按模型设置思考强度', () => {
  it('展开后每个模型一个选择器：自动检测显示识别结果；手动选择保存并刷新输入框模型列表', async () => {
    const set = vi.spyOn(api, 'setModelReasoning').mockImplementation(async (_id, _model, reasoning) => {
      current = provider(reasoning === 'auto' ? null : reasoning)
      return current
    })
    const { wrapper } = await mountView()
    expect(wrapper.find('[data-testid="reasoning-p1"]').exists()).toBe(false)
    await wrapper.get('[data-testid="reasoning-toggle-p1"]').trigger('click')
    const rows = wrapper.findAll('[data-reasoning-model]')
    expect(rows.map((r) => r.attributes('data-reasoning-model'))).toEqual(['zz-house-model', 'vendor/odd-thinker'])
    const select = rows[0].get('select')
    expect((select.element as HTMLSelectElement).value).toBe('auto')
    const labels = select.findAll('option').map((o) => o.text())
    expect(labels).toEqual([
      '自动检测（不支持）',
      '支持（OpenAI 风格 reasoning_effort）',
      '支持（Anthropic 思考预算）',
      '支持（Qwen enable_thinking）',
      '只能开关（thinking.type，DeepSeek / GLM / 豆包）',
      '始终思考（不可调节）',
      '不支持',
    ])
    expect(rows[1].get('option').text()).toBe('自动检测（支持（OpenAI 风格 reasoning_effort） · 服务商元数据）')

    const refreshed = vi.mocked(api.getModels)
    refreshed.mockClear()
    await select.setValue('openai')
    await flushPromises()
    expect(set).toHaveBeenCalledWith('p1', 'zz-house-model', 'openai')
    expect(refreshed).toHaveBeenCalledWith('builtin')
    expect((wrapper.findAll('[data-reasoning-model]')[0].get('select').element as HTMLSelectElement).value).toBe('openai')
  })

  it('从输入框“去设置”跳转：自动展开并定位到该模型', async () => {
    query.provider = 'p1'
    query.model = 'zz-house-model'
    const { wrapper } = await mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="reasoning-p1"]').exists()).toBe(true)
    const row = wrapper.findAll('[data-reasoning-model]').find((r) => r.attributes('data-reasoning-model') === 'zz-house-model')!
    expect(row.classes()).toContain('focused')
    expect(document.activeElement).toBe(row.get('select').element)
  })

  it('没有管理模型权限：只能查看', async () => {
    auth.mode = 'server'
    auth.me = { permissions: ['data:read', 'settings:read'] } as never
    const { wrapper } = await mountView()
    await wrapper.get('[data-testid="reasoning-toggle-p1"]').trigger('click')
    expect(wrapper.get('[data-testid="reasoning-p1"]').text()).toContain('只有能管理模型与密钥的成员可以修改')
    expect(wrapper.findAll('[data-reasoning-model] select').every((s) => (s.element as HTMLSelectElement).disabled)).toBe(true)
  })
})
