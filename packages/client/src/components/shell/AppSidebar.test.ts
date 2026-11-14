import { flushPromises, mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

// jsdom 不计算容器查询与布局；这里读真实样式源码校验阈值与栅格契约，
// 布局实测由 Playwright + Chrome 另做（见验证证据）。
let themeCss = ''
beforeAll(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  themeCss = fs.readFileSync('src/styles/theme.css', 'utf8')
})

vi.mock('../../api/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/http')>()),
  request: vi.fn(async () => ({ total: 3 })),
}))

import AppSidebar from './AppSidebar.vue'
import { agentSidebar } from '../../lib/agent-sidebar'
import { whatsappShell } from '../../lib/whatsapp'

async function mountAt(path: string, section: string) {
  const Blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: Blank, meta: { section } }],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppSidebar, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  agentSidebar.collapsed = false
  whatsappShell.unread = 0
  whatsappShell.connection = 'disconnected'
})

describe('全局侧栏', () => {
  it('底部 7 个主入口：顺序固定，WhatsApp 紧跟邮箱', async () => {
    const w = await mountAt('/', 'workbench')
    const items = w.findAll('.as-nav-item')
    expect(items.map((i) => i.find('.as-nav-label').text())).toEqual([
      'LULUX',
      '工作台',
      '客户',
      '邮箱',
      'WhatsApp',
      '工作流',
      '技能',
    ])
    expect(items.map((i) => i.attributes('href'))).toEqual([
      '/agent',
      '/',
      '/customers',
      '/mailbox',
      '/whatsapp',
      '/workflows',
      '/skills',
    ])
    expect(items[1]!.classes()).toContain('on')
  })

  it('商机 / 报价 / 订单页都点亮“客户”，定时任务点亮“工作流”', async () => {
    for (const section of ['deals', 'quotation', 'orders']) {
      const w = await mountAt('/x', section)
      expect(w.find('.as-nav-item.on .as-nav-label').text()).toBe('客户')
    }
    const w = await mountAt('/schedules', 'schedules')
    expect(w.find('.as-nav-item.on .as-nav-label').text()).toBe('工作流')
  })

  it('邮箱入口显示未读角标；收起按钮切换侧栏', async () => {
    const w = await mountAt('/', 'workbench')
    expect(w.find('[data-testid=rail-mailbox] .as-badge').text()).toBe('3')
    await w.find('[data-testid=side-toggle]').trigger('click')
    expect(agentSidebar.collapsed).toBe(true)
    expect(w.find('.app-side').classes()).toContain('collapsed')
    await w.find('[data-testid=side-toggle]').trigger('click')
    expect(agentSidebar.collapsed).toBe(false)
  })

  it('收起态保留 7 个图标入口与 WhatsApp 的 title，角标和状态点不隐藏', async () => {
    agentSidebar.collapsed = true
    whatsappShell.unread = 128
    whatsappShell.connection = 'connected'
    const w = await mountAt('/', 'workbench')
    expect(w.findAll('.as-nav-item')).toHaveLength(7)
    expect(w.findAll('.as-nav-item .as-nav-ico svg')).toHaveLength(7)
    const whatsapp = w.find('[data-testid=rail-whatsapp]')
    expect(whatsapp.attributes('title')).toBe('WhatsApp')
    expect(whatsapp.find('[data-testid=whatsapp-badge]').exists()).toBe(true)
    expect(whatsapp.find('[data-testid=whatsapp-state-dot]').exists()).toBe(true)
  })

  it('WhatsApp 未读 99+ 用加宽角标，四态状态点各自渲染并带可访问名称', async () => {
    whatsappShell.unread = 128
    const w = await mountAt('/', 'workbench')
    const badge = w.find('[data-testid=whatsapp-badge]')
    expect(badge.text()).toBe('99+')
    expect(badge.classes()).toContain('wide')
    expect(badge.attributes('aria-label')).toBe('WhatsApp 128 条未读')

    const dot = w.find('[data-testid=whatsapp-state-dot]')
    expect(dot.attributes('role')).toBe('img')
    const states = [
      ['connected', 'WhatsApp 已连接'],
      ['connecting', 'WhatsApp 连接中'],
      ['disconnected', 'WhatsApp 已断开'],
      ['reauth', 'WhatsApp 需要重新授权'],
    ] as const
    for (const [state, label] of states) {
      whatsappShell.connection = state
      await w.vm.$nextTick()
      expect(dot.classes()).toContain(state)
      expect(dot.attributes('aria-label')).toBe(label)
    }
  })

  it('容器宽度 ≥425px：底栏默认单行 7 等分，兜底只在 max-width 424px 生效', () => {
    expect(themeCss).toMatch(/\.app-side\s*\{[^}]*container-type:\s*inline-size/s)
    expect(themeCss).toMatch(/\.app-side\s*\{[^}]*container-name:\s*sidebar/s)
    expect(themeCss).toMatch(/\.as-nav\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*1fr\)/s)
    expect(themeCss).toContain('@container sidebar (max-width: 424px)')
    expect(themeCss).not.toMatch(/@container sidebar \(max-width: 425px\)/)
  })

  it('容器宽度 <425px：12 列栅格，前 4 项 span 3、后 3 项 span 4，折叠态排除在外', () => {
    expect(themeCss).toContain('.app-side:not(.collapsed) .as-nav {\n    grid-template-columns: repeat(12, 1fr);')
    expect(themeCss).toContain('.app-side:not(.collapsed) .as-nav-item:nth-child(-n + 4)')
    expect(themeCss).toContain('.app-side:not(.collapsed) .as-nav-item:nth-child(n + 5)')
    expect(themeCss).toMatch(/:nth-child\(-n \+ 4\)\s*\{\s*grid-column:\s*span 3;/)
    expect(themeCss).toMatch(/:nth-child\(n \+ 5\)\s*\{\s*grid-column:\s*span 4;/)
    expect(themeCss).toMatch(/\.app-side\.collapsed \.as-nav\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })

  it('状态点四色与 99+ 胶囊的尺寸 / 描边契约', () => {
    const dot = (state: string) =>
      new RegExp(`\\.as-state-dot\\.${state}\\s*\\{\\s*background:\\s*var\\(--[a-z-]+\\);`).test(themeCss)
    expect(dot('connected')).toBe(true)
    expect(dot('connecting')).toBe(true)
    expect(dot('disconnected')).toBe(true)
    expect(dot('reauth')).toBe(true)
    expect(themeCss).toMatch(/\.as-badge\.wide\s*\{[^}]*min-width:\s*24px/s)
    expect(themeCss).toMatch(/\.as-badge\s*\{[^}]*height:\s*16px;[^}]*box-shadow:\s*0 0 0 2px var\(--sidebar\);/s)
    expect(themeCss).toMatch(/\.app-side\.collapsed \.as-badge\.wide\s*\{[^}]*right:\s*-2px;[^}]*top:\s*-2px;/s)
  })
})

describe('邮箱未读角标即时刷新', () => {
  it('收到邮箱计数变化通知后立即重新拉取未读数；卸载后不再响应', async () => {
    const http = await import('../../api/http')
    const req = vi.mocked(http.request)
    // 前面用例挂载的侧栏没卸载也会响应，所以按“本实例贡献的增量”断言
    const mailCalls = () => req.mock.calls.filter((c) => c[0] === '/api/email/messages').length
    const w = await mountAt('/', 'workbench')
    req.mockResolvedValue({ total: 7 })
    const { notifyMailCountsChanged } = await import('../../lib/mail-counts')
    const n0 = mailCalls()
    notifyMailCountsChanged()
    await flushPromises()
    const n1 = mailCalls()
    expect(n1).toBeGreaterThan(n0)
    expect(w.find('[aria-label*="7"]').exists()).toBe(true)
    w.unmount()
    notifyMailCountsChanged()
    await flushPromises()
    expect(mailCalls() - n1).toBe(n1 - n0 - 1)
  })
})
