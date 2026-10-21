import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import KernelMenu from './KernelMenu.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

describe('Agent 选择浮层', () => {
  it('浮层打开时直接打字：关闭浮层并把焦点还给消息输入框', async () => {
    const textarea = document.createElement('textarea')
    textarea.setAttribute('data-composer-input', '')
    document.body.appendChild(textarea)
    const w = mount(KernelMenu, { props: { x: 10, y: 10, agents: [] }, attachTo: document.body })
    await new Promise((r) => setTimeout(r, 0))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    expect(w.emitted('close')).toBeUndefined()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }))
    expect(w.emitted('close')).toHaveLength(1)
    expect(document.activeElement).toBe(textarea)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
    textarea.remove()
  })
})

describe('选择内核（原版浮层）', () => {
  const agent = (id: string, name: string, kind: string, kernelId: string | null, available = true) => ({
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
  // 服务端顺序故意把内置放在中间：浮层必须把它放到最前
  const agents = [
    agent('kernel-hermes', 'Hermes Agent', 'kernel', 'hermes'),
    agent('builtin', 'LULUX', 'builtin', null),
    agent('kernel-claude-code', 'Claude Code', 'kernel', 'claude-code'),
    agent('kernel-gemini-cli', 'Gemini CLI', 'kernel', 'gemini-cli'),
    agent('kernel-grok', 'Grok', 'kernel', 'grok'),
    agent('kernel-codex', 'Codex', 'kernel', 'codex', false),
  ] as unknown as import('../api').Agent[]

  it('标题“选择内核”，内置在最前，头像用原版图，当前项打勾，未安装置灰并给“去安装”，点击切换', async () => {
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAppStore } = await import('../stores/app')
    useAppStore().agents = agents
    const w = mount(KernelMenu, {
      props: { x: 10, y: 10, agents, currentId: 'kernel-claude-code' },
      global: { plugins: [pinia] },
      attachTo: document.body,
    })
    await new Promise((r) => setTimeout(r, 0))
    const menu = document.body.querySelector('.kernel-menu')!
    expect(menu.querySelector('.kernel-title')!.textContent).toBe('选择内核')
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('.kernel-row')]
    expect(rows.map((r) => r.querySelector('strong')!.textContent)).toEqual([
      'LULUX',
      'Hermes Agent',
      'Claude Code',
      'Gemini CLI',
      'Grok',
      'Codex',
    ])
    expect(rows[0].querySelector('.kernel-text span')!.textContent).toBe('内置 · 随软件更新，无需单独安装')
    expect(rows[2].querySelector('.kernel-text span')!.textContent).toContain('Anthropic')
    const srcs = rows.map((r) => r.querySelector('img')!.getAttribute('src'))
    expect(srcs[0]).toBe('/icon.png')
    expect(srcs[1]).toBe('/agents/hermes.png')
    expect(srcs[2]).toBe('/agents/claude.png')
    expect(srcs[3]).toMatch(/gemini\.svg|^data:image\/svg/) // 原版内核管理页的标志（小图会被内联成 data URI）
    expect(rows[3].querySelector('.agent-avatar')!.classList.contains('kernel-logo')).toBe(true)
    expect(srcs[4]).toBe('/agents/grok.png')
    expect(rows[4].querySelector('.kernel-text span')!.textContent).toBe('SpaceXAI · npm')
    expect(srcs[5]).toBe('/agents/codex.png')
    expect(rows[2].classList.contains('checked')).toBe(true)
    expect(rows[2].querySelector('.kernel-check')).not.toBeNull()
    expect(rows.filter((r) => r.querySelector('.kernel-check'))).toHaveLength(1)
    expect(rows[5].disabled).toBe(true)
    const install = menu.querySelectorAll('.kernel-install')
    expect(install).toHaveLength(1)
    expect(install[0].closest('.kernel-item')!.getAttribute('data-kernel')).toBe('codex')
    rows[1].click()
    rows[0].click()
    expect(w.emitted('select')).toEqual([['kernel-hermes'], ['builtin']])
    w.unmount()
  })
})
