import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, Provider } from '../../api'
import type { WorkflowNode } from '../../api/workflows'
import WorkflowNodeCard from './WorkflowNodeCard.vue'

const agent = (id: string, name: string, kind: Agent['kind'], kernelId: string | null, available = true): Agent => ({
  id,
  name,
  description: '',
  avatar: '',
  accent: '',
  kind,
  kernelId,
  available,
  unavailableReason: available ? null : '未安装',
})
const agents = [
  agent('kernel-hermes', 'Hermes Agent', 'kernel', 'hermes'),
  agent('builtin', 'LULUX', 'builtin', null),
  agent('kernel-codex', 'Codex', 'kernel', 'codex', false),
  agent('kernel-gemini-cli', 'Gemini CLI', 'kernel', 'gemini-cli'),
  agent('persona-x', '旧角色', 'persona', null),
]
const providers: Provider[] = [
  {
    id: 'p1',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: '',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    createdAt: 0,
    hasApiKey: true,
  },
]
const node = (patch: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: 'n1',
  name: '节点 1',
  kernelId: 'builtin',
  providerId: null,
  model: null,
  prompt: '',
  joinStrategy: 'all',
  allowWrite: false,
  position: { x: 0, y: 0 },
  ...patch,
})
const mountCard = (props: Record<string, unknown> = {}) =>
  mount(WorkflowNodeCard, {
    props: { node: node(), agents, providers, hasUpstream: true, ...props },
    attachTo: document.body,
  })

afterEach(() => {
  document.body.innerHTML = ''
})

describe('工作流节点卡片', () => {
  it('LULUX 内核显示模型下拉（默认 + 各 Provider 的模型），命令行内核不显示', async () => {
    const w = mountCard()
    expect(w.find('[data-testid="kernel-select"]').text()).toContain('LULUX')
    expect(w.find('[data-testid="kernel-select"]').text()).not.toContain('内置')
    const model = w.find('[data-testid="model-select"]')
    expect(model.exists()).toBe(true)
    expect(model.findAll('option').map((o) => o.text())).toEqual([
      '默认模型',
      'deepseek-chat',
      'deepseek-reasoner',
    ])
    await model.setValue('p1::deepseek-reasoner')
    expect(w.emitted('update')?.[0]).toEqual([{ providerId: 'p1', model: 'deepseek-reasoner' }])
    await w.setProps({ node: node({ kernelId: 'kernel-hermes' }) })
    expect(w.find('[data-testid="model-select"]').exists()).toBe(false)
    w.unmount()
  })

  it('内核下拉：LULUX 在最前，未安装的置灰不能选；换成命令行内核时清掉模型覆盖', async () => {
    const w = mountCard({ node: node({ providerId: 'p1', model: 'deepseek-chat' }) })
    await w.find('[data-testid="kernel-select"]').trigger('click')
    const opts = Array.from(document.querySelectorAll<HTMLButtonElement>('.ks-menu [role="option"]'))
    expect(opts.map((o) => o.querySelector('.ks-name')?.textContent)).toEqual([
      'LULUX',
      'Hermes Agent',
      'Codex',
      'Gemini CLI',
    ])
    expect(opts[2].disabled).toBe(true)
    expect(opts[2].textContent).toContain('未安装')
    opts[2].click()
    expect(w.emitted('update')).toBeUndefined()
    opts[1].click()
    expect(w.emitted('update')?.[0]).toEqual([{ kernelId: 'kernel-hermes', providerId: null, model: null }])
    w.unmount()
  })

  it('汇合策略 / 允许写操作 / 提示词 / 名称 发出 update；起始节点不显示汇合策略', async () => {
    const w = mountCard()
    await w.find('[data-testid="join-select"]').setValue('any')
    await w.find('button[role="switch"]').trigger('click')
    const prompt = w.find('[data-testid="node-prompt"]')
    expect(prompt.attributes('placeholder')).toBe('描述这个 Agent 要做什么…')
    expect(prompt.classes()).toContain('nodrag')
    await prompt.setValue('整理询盘') // setValue 同时触发 input + change
    const name = w.find('input.wf-name')
    await name.setValue('  抓取询盘 ')
    expect(w.emitted('update')).toEqual([
      [{ joinStrategy: 'any' }],
      [{ allowWrite: true }],
      [{ prompt: '整理询盘' }],
      [{ name: '抓取询盘' }],
    ])
    await w.setProps({ hasUpstream: false })
    expect(w.find('[data-testid="join-select"]').exists()).toBe(false)
    expect(w.find('[data-testid="root-note"]').text()).toContain('起始节点')
    w.unmount()
  })

  it('运行状态徽标；只读时没有删除按钮且控件禁用', async () => {
    const w = mountCard({ status: 'running' })
    expect(w.find('[data-testid="node-status"]').text()).toBe('运行中')
    expect(w.find('.wf-node').classes()).toContain('st-running')
    await w.find('.wf-x').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    await w.setProps({ readonly: true, status: 'failed' })
    expect(w.find('.wf-x').exists()).toBe(false)
    expect(w.find('[data-testid="node-status"]').text()).toBe('失败')
    expect((w.find('[data-testid="join-select"]').element as HTMLSelectElement).disabled).toBe(true)
    w.unmount()
  })
})
