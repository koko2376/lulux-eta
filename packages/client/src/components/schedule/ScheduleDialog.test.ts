import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../api'
import type { Workflow } from '../../api/workflows'
import ScheduleDialog from './ScheduleDialog.vue'

const agents: Agent[] = [
  {
    id: 'builtin',
    name: 'LULUX',
    description: '',
    avatar: '',
    accent: '',
    kind: 'builtin',
    kernelId: null,
    available: true,
  },
]
const workflows = [{ id: 'w1', name: '询盘跟进', nodes: [], edges: [] } as unknown as Workflow]

type Call = { url: string; method?: string; body?: Record<string, unknown> }
let calls: Call[] = []
function stubFetch(handler: (c: Call) => { status?: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const c = { url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(c)
      const r = handler(c)
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
    }),
  )
}

beforeEach(() => {
  calls = []
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const mountDialog = (props: Record<string, unknown> = {}) =>
  mount(ScheduleDialog, { props: { workflows, agents, sessions: [], ...props }, attachTo: document.body })
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!

describe('定时任务对话框', () => {
  it('从工作流打开：预填目标和名称，预览接下来 5 次（防抖后 POST /api/schedules/preview）', async () => {
    const next = [1, 2, 3, 4, 5].map((d) => Date.UTC(2026, 9, 21 + d, 1, 0))
    stubFetch((c) => (c.url === '/api/schedules/preview' ? { body: { next } } : { body: {} }))
    const w = mountDialog({ prefill: { targetType: 'workflow', workflowId: 'w1', timezone: 'Asia/Shanghai' } })
    expect(q<HTMLInputElement>('[data-testid="schedule-name"]').value).toBe('定时运行「询盘跟进」')
    expect(q<HTMLSelectElement>('[data-testid="schedule-workflow"]').value).toBe('w1')
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    const preview = calls.filter((c) => c.url === '/api/schedules/preview')
    expect(preview).toHaveLength(1)
    expect(preview[0].body).toEqual({ spec: { type: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai' })
    expect(document.querySelectorAll('[data-testid="preview-item"]')).toHaveLength(5)
    expect(q('[data-testid="schedule-preview"]').textContent).toContain('每天 09:00')
    w.unmount()
  })

  it('校验：空名称 / 没选工作流 / 每周没选天 不提交，改好后提交契约格式', async () => {
    stubFetch((c) =>
      c.url === '/api/schedules/preview'
        ? { body: { next: [] } }
        : { body: { id: 's1', name: 'x', ...(c.body ?? {}) } },
    )
    const w = mountDialog({ prefill: { timezone: 'Asia/Shanghai' } })
    q<HTMLButtonElement>('[data-testid="spec-weekly"]').click()
    await flushPromises()
    for (const d of [1, 3, 5]) q<HTMLButtonElement>(`[data-testid="day-${d}"]`).click()
    await flushPromises()
    q<HTMLButtonElement>('[data-testid="schedule-save"]').click()
    await flushPromises()
    const errors = Array.from(document.querySelectorAll('.field-error')).map((e) => e.textContent)
    expect(errors).toEqual(['请填写名称', '请选择工作流', '至少选择一天'])
    expect(calls.some((c) => c.url === '/api/schedules')).toBe(false)

    const name = q<HTMLInputElement>('[data-testid="schedule-name"]')
    name.value = '跟进提醒'
    name.dispatchEvent(new Event('input'))
    const sel = q<HTMLSelectElement>('[data-testid="schedule-workflow"]')
    sel.value = 'w1'
    sel.dispatchEvent(new Event('change'))
    for (const d of [5, 1, 3]) q<HTMLButtonElement>(`[data-testid="day-${d}"]`).click()
    const time = q<HTMLInputElement>('[data-testid="spec-time"]')
    time.value = '18:30'
    time.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(document.querySelectorAll('.field-error')).toHaveLength(0)
    q<HTMLButtonElement>('[data-testid="schedule-save"]').click()
    await flushPromises()
    const create = calls.find((c) => c.url === '/api/schedules')!
    expect(create.method).toBe('POST')
    expect(create.body).toEqual({
      name: '跟进提醒',
      target: { type: 'workflow', workflowId: 'w1' },
      spec: { type: 'weekly', days: [1, 3, 5], time: '18:30' },
      timezone: 'Asia/Shanghai',
      enabled: true,
    })
    expect(w.emitted('saved')?.[0][0]).toMatchObject({ id: 's1' })
    w.unmount()
  })

  it('间隔少于 5 分钟时报错且不预览；服务端错误显示在底部', async () => {
    stubFetch((c) =>
      c.url === '/api/schedules/preview'
        ? { body: { next: [] } }
        : { status: 400, body: { error: { code: 'BAD_SPEC', message: 'Cron 无法解析' } } },
    )
    const w = mountDialog({ prefill: { name: 'x', workflowId: 'w1', timezone: 'UTC' } })
    q<HTMLButtonElement>('[data-testid="spec-interval"]').click()
    await flushPromises()
    const minutes = q<HTMLInputElement>('[data-testid="spec-minutes"]')
    minutes.value = '3'
    minutes.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(q('[data-testid="schedule-preview"]').textContent).toContain('填好计划后在这里预览')
    q<HTMLButtonElement>('[data-testid="schedule-save"]').click()
    await flushPromises()
    expect(document.querySelector('.field-error')?.textContent).toBe('间隔为 5–10080 分钟的整数')
    minutes.value = '30'
    minutes.dispatchEvent(new Event('input'))
    await flushPromises()
    q<HTMLButtonElement>('[data-testid="schedule-save"]').click()
    await flushPromises()
    expect(q('.sd-server-err').textContent).toBe('Cron 无法解析')
    expect(w.emitted('saved')).toBeUndefined()
    w.unmount()
  })
})
