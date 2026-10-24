import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogProviders,
  clampEffort,
  effectiveEffort,
  selectedOption,
  sessionModelKernel,
  shortModel,
  type ModelCatalog,
} from '../lib/models'
import { auth } from '../lib/session'

const pushed: unknown[] = []
vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: (to: unknown) => pushed.push(to) }) }
})

const patched: Array<{ id: string; patch: Record<string, unknown> }> = []
const created: Array<Record<string, unknown>> = []
const requested: string[] = []

const builtinCatalog: ModelCatalog = {
  kernel: 'builtin',
  kernelName: 'LULUX',
  mode: 'builtin',
  groups: [
    {
      id: 'p1',
      label: 'OpenAI',
      options: [
        { providerId: 'p1', model: 'gpt-4o', label: 'gpt-4o', efforts: ['off'] },
        { providerId: 'p1', model: 'gpt-5.2', label: 'gpt-5.2', efforts: ['off', 'low', 'medium', 'high', 'xhigh'] },
        { providerId: 'p1', model: 'deepseek-chat', label: 'deepseek-chat', efforts: ['off', 'high'], effortMode: 'toggle' },
        { providerId: 'p1', model: 'kimi-k2-thinking', label: 'kimi-k2-thinking', efforts: ['off'], effortMode: 'fixed' },
        { providerId: 'p1', model: 'zz-house-model', label: 'zz-house-model', efforts: ['off'], effortMode: 'none' },
      ],
    },
    {
      id: 'p2',
      label: 'Anthropic',
      options: [
        {
          providerId: 'p2',
          model: 'claude-sonnet-4-5',
          label: 'claude-sonnet-4-5',
          efforts: ['off', 'low', 'medium', 'high'],
        },
      ],
    },
  ],
  default: { providerId: 'p1', model: null, label: 'gpt-4o', efforts: ['off'] },
  defaultEffort: 'medium',
  effort: true,
}
const geminiCatalog: ModelCatalog = {
  kernel: 'gemini-cli',
  kernelName: 'Gemini CLI',
  mode: 'global',
  groups: [
    {
      id: 'gemini-cli',
      label: 'Gemini CLI',
      options: [{ providerId: null, model: 'gemini-2.5-pro', label: 'gemini-2.5-pro', efforts: [] }],
    },
  ],
  default: { providerId: null, model: null, label: '默认', efforts: [] },
  defaultEffort: null,
  effort: false,
}

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getModels: vi.fn(async (kernel: string) => {
      requested.push(kernel)
      return kernel === 'gemini-cli' ? geminiCatalog : builtinCatalog
    }),
    patchSession: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      patched.push({ id, patch })
      return { ...session(id), ...currentPatch, ...patch }
    }),
    createSession: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return session('ses_new')
    }),
  }
})

let currentPatch: Record<string, unknown> = {}
function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: 't',
    kind: 'single',
    groupName: null,
    providerId: null,
    agentIds: ['builtin'],
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: '',
    model: null,
    reasoningEffort: null,
    myRole: 'owner',
    ...extra,
  }
}

const agents = [
  { id: 'builtin', name: 'LULUX', kind: 'builtin', available: true },
  { id: 'kernel-gemini-cli', name: 'Gemini CLI', kind: 'kernel', kernelId: 'gemini-cli', available: true },
]

async function setup(extra: Record<string, unknown> = {}, withSession = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAppStore } = await import('../stores/app')
  const store = useAppStore()
  store.agents = agents as never
  store.settings = { defaultAgentId: 'builtin' }
  currentPatch = extra
  if (withSession) {
    store.sessions = [session('ses_1', extra) as never]
    store.currentSessionId = 'ses_1'
  }
  const ModelPicker = (await import('./ModelPicker.vue')).default
  const w = mount(ModelPicker, { global: { plugins: [pinia], stubs: { RouterLink: true } }, attachTo: document.body })
  await flushPromises()
  return { w, store }
}

const menu = () => document.body.querySelector<HTMLElement>('[data-testid="model-menu"]')
const sub = () => document.body.querySelector<HTMLElement>('[data-testid="model-submenu"]')
const stops = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('.mp-stop') ?? [])]

afterEach(() => {
  auth.mode = 'desktop'
  auth.me = null
  pushed.length = 0
  patched.length = 0
  created.length = 0
  requested.length = 0
  document.body.innerHTML = ''
})

describe('模型选择（lib）', () => {
  it('内核、选中项、档位收紧、短名、工作流 Provider 形状', () => {
    expect(sessionModelKernel({ kind: 'group', agentIds: ['kernel-gemini-cli'] }, agents as never)).toBe('builtin')
    expect(sessionModelKernel({ kind: 'single', agentIds: ['kernel-gemini-cli'] }, agents as never)).toBe('gemini-cli')
    expect(sessionModelKernel(null, agents as never, 'builtin')).toBe('builtin')
    expect(selectedOption(builtinCatalog, { providerId: 'p1', model: 'gpt-5.2' })?.label).toBe('gpt-5.2')
    expect(selectedOption(builtinCatalog, { providerId: 'p1', model: 'gone' })).toBe(builtinCatalog.default)
    expect(clampEffort('xhigh', ['off', 'low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('low', [])).toBeNull()
    const sonnet = builtinCatalog.groups[1].options[0]
    expect(effectiveEffort(builtinCatalog, sonnet, null)).toBe('medium')
    expect(effectiveEffort(builtinCatalog, sonnet, 'xhigh')).toBe('high')
    expect(effectiveEffort(geminiCatalog, geminiCatalog.default, null)).toBeNull()
    expect(shortModel('openai/gpt-4o')).toBe('gpt-4o')
    expect(catalogProviders(builtinCatalog)?.[0]).toEqual({
      id: 'p1',
      name: 'OpenAI',
      model: 'gpt-4o',
      models: ['gpt-4o', 'gpt-5.2', 'deepseek-chat', 'kimi-k2-thinking', 'zz-house-model'],
    })
    expect(catalogProviders(geminiCatalog)).toBeNull()
  })
})

describe('输入框右侧的模型选择器', () => {
  it('胶囊显示“模型名 强度”；滑块五档，模型不支持的档置灰；选“极高”保存到会话', async () => {
    const { w, store } = await setup({ providerId: 'p1', model: 'gpt-5.2' })
    expect(requested).toContain('builtin')
    const trigger = w.get('[data-testid="model-picker"]')
    expect(trigger.text()).toContain('gpt-5.2')
    expect(trigger.text()).toContain('中')
    await trigger.trigger('click')
    await flushPromises()
    expect(menu()!.textContent).toContain('更快')
    expect(menu()!.textContent).toContain('更聪明')
    expect(stops().map((s) => s.getAttribute('aria-label'))).toEqual(['关闭', '低', '中', '高', '极高'])
    expect(stops().map((s) => s.disabled)).toEqual([false, false, false, false, false])
    expect(stops()[2].getAttribute('aria-checked')).toBe('true')
    stops()[4].click()
    await flushPromises()
    expect(patched).toEqual([{ id: 'ses_1', patch: { reasoningEffort: 'xhigh' } }])
    expect(store.currentSession!.reasoningEffort).toBe('xhigh')
    expect(w.get('[data-testid="model-picker"]').text()).toContain('极高')
  })

  it('“模型”行打开二级菜单：默认在第一个，按 Provider 分组；选模型保存 providerId + model', async () => {
    const { w } = await setup()
    expect(w.get('[data-testid="model-picker"]').text()).toContain('gpt-4o')
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    // 默认模型 gpt-4o 只有“关闭”：其余档置灰，提示不支持
    expect(stops().map((s) => s.disabled)).toEqual([false, true, true, true, true])
    expect(menu()!.querySelector('[data-testid="effort-unsupported"]')).not.toBeNull()
    menu()!.querySelector<HTMLButtonElement>('[data-testid="model-row"]')!.click()
    await flushPromises()
    const options = [...sub()!.querySelectorAll<HTMLButtonElement>('.mp-option')]
    expect(options.map((o) => o.querySelector('strong')!.textContent)).toEqual([
      '默认',
      'gpt-4o',
      'gpt-5.2',
      'deepseek-chat',
      'kimi-k2-thinking',
      'zz-house-model',
      'claude-sonnet-4-5',
    ])
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    expect([...sub()!.querySelectorAll('.mp-group')].map((g) => g.textContent)).toEqual(['OpenAI', 'Anthropic'])
    options[6].click()
    await flushPromises()
    expect(patched).toEqual([{ id: 'ses_1', patch: { providerId: 'p2', model: 'claude-sonnet-4-5' } }])
    expect(menu()).toBeNull()
  })

  it('global CLI 内核不支持推理强度：不显示滑块，只有模型行', async () => {
    const { w } = await setup({ agentIds: ['kernel-gemini-cli'] })
    expect(requested).toContain('gemini-cli')
    expect(w.get('[data-testid="model-picker"]').text()).toContain('默认')
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    expect(menu()!.querySelector('[data-testid="effort-slider"]')).toBeNull()
    menu()!.querySelector<HTMLButtonElement>('[data-testid="model-row"]')!.click()
    await flushPromises()
    sub()!.querySelectorAll<HTMLButtonElement>('.mp-option')[1].click()
    await flushPromises()
    expect(patched).toEqual([{ id: 'ses_1', patch: { model: 'gemini-2.5-pro' } }])
  })

  it('群聊：列 LULUX 的模型并提示只作用于内置成员', async () => {
    const { w } = await setup({ kind: 'group', agentIds: ['builtin', 'kernel-gemini-cli'] })
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    expect(requested).toContain('builtin')
    expect(menu()!.querySelector('[data-testid="model-group-note"]')!.textContent).toContain('LULUX 内置成员')
  })

  it('还没有会话：先记下，新建会话时带上模型与推理强度', async () => {
    const { w, store } = await setup({}, false)
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    menu()!.querySelector<HTMLButtonElement>('[data-testid="model-row"]')!.click()
    await flushPromises()
    sub()!.querySelectorAll<HTMLButtonElement>('.mp-option')[2].click()
    await flushPromises()
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    stops()[3].click()
    await flushPromises()
    expect(patched).toHaveLength(0)
    await store.newSession()
    expect(created[0]).toMatchObject({
      agentIds: ['builtin'],
      model: 'gpt-5.2',
      providerId: 'p1',
      reasoningEffort: 'high',
    })
    expect(store.pendingModel).toBeNull()
  })

  it('未识别到思考强度：提示“去设置”并带上 Provider 与模型跳到模型设置', async () => {
    const { w } = await setup({ providerId: 'p1', model: 'zz-house-model' })
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    const note = menu()!.querySelector('[data-testid="effort-unsupported"]')!
    expect(note.textContent).toContain('未识别到思考强度支持')
    expect(stops().map((s) => s.disabled)).toEqual([false, true, true, true, true])
    note.querySelector<HTMLButtonElement>('[data-testid="effort-configure"]')!.click()
    await flushPromises()
    expect(pushed).toEqual([
      { path: '/settings/models', query: { provider: 'p1', model: 'zz-house-model', focus: 'reasoning' } },
    ])
    expect(menu()).toBeNull()
  })

  it('没有管理模型权限：提示联系管理员，不给入口', async () => {
    auth.mode = 'server'
    auth.me = { permissions: ['data:read', 'data:write'] } as never
    const { w } = await setup({ providerId: 'p1', model: 'zz-house-model' })
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    const note = menu()!.querySelector('[data-testid="effort-unsupported"]')!
    expect(note.textContent).toContain('请联系管理员')
    expect(note.querySelector('[data-testid="effort-configure"]')).toBeNull()
  })

  it('只能开关的模型显示开关（不是“不支持”）；打开保存为 high', async () => {
    const { w } = await setup({ providerId: 'p1', model: 'deepseek-chat', reasoningEffort: 'off' })
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    expect(menu()!.querySelector('[data-testid="effort-slider"]')).toBeNull()
    expect(menu()!.querySelector('[data-testid="effort-unsupported"]')).toBeNull()
    const toggle = menu()!.querySelector('[data-testid="effort-toggle"]')!
    const sw = toggle.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    sw.click()
    await flushPromises()
    expect(patched).toEqual([{ id: 'ses_1', patch: { reasoningEffort: 'high' } }])
    expect(w.get('[data-testid="model-picker"]').text()).toContain('思考')
  })

  it('始终思考的模型：只显示说明', async () => {
    const { w } = await setup({ providerId: 'p1', model: 'kimi-k2-thinking' })
    await w.get('[data-testid="model-picker"]').trigger('click')
    await flushPromises()
    expect(menu()!.querySelector('[data-testid="effort-fixed"]')!.textContent).toContain('始终会先思考')
    expect(menu()!.querySelector('[data-testid="effort-slider"]')).toBeNull()
  })

  it('开关风格：默认档“中”也显示为开（与服务端收紧规则一致）', () => {
    const toggle = builtinCatalog.groups[0].options[2]
    expect(effectiveEffort(builtinCatalog, toggle, null)).toBe('high')
    expect(effectiveEffort(builtinCatalog, toggle, 'off')).toBe('off')
  })
})
