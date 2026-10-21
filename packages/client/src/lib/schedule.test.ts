import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import {
  defaultScheduleForm,
  describeDays,
  describeSpec,
  formSpec,
  formToInput,
  formatWhen,
  isCronShape,
  msToZonedLocal,
  scheduleToForm,
  validateScheduleForm,
  zonedLocalToMs,
} from './schedule'

const TZ = 'Asia/Shanghai'

afterEach(() => setLanguage('zh-CN'))

describe('计划的白话描述', () => {
  it('中文：每天 / 每周一三五 / 工作日 / 周末 / 间隔 / Cron', () => {
    setLanguage('zh-CN')
    expect(describeSpec({ type: 'daily', time: '09:00' }, TZ)).toBe('每天 09:00')
    expect(describeSpec({ type: 'weekly', days: [5, 1, 3], time: '18:30' }, TZ)).toBe('每周一三五 18:30')
    expect(describeSpec({ type: 'weekly', days: [0, 6], time: '10:00' }, TZ)).toBe('周末 10:00')
    expect(describeSpec({ type: 'weekly', days: [1, 2, 3, 4, 5], time: '17:00' }, TZ)).toBe('工作日 17:00')
    expect(describeSpec({ type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' }, TZ)).toBe('每天 08:00')
    expect(describeSpec({ type: 'weekly', days: [0, 1], time: '08:00' }, TZ)).toBe('每周一日 08:00')
    expect(describeSpec({ type: 'interval', minutes: 30 }, TZ)).toBe('每 30 分钟')
    expect(describeSpec({ type: 'interval', minutes: 120 }, TZ)).toBe('每 2 小时')
    expect(describeSpec({ type: 'cron', expr: ' 0 9 * * 1-5 ' }, TZ)).toBe('Cron：0 9 * * 1-5')
  })

  it('一次性：今天 / 明天 / 日期，按任务时区显示', () => {
    setLanguage('zh-CN')
    const now = zonedLocalToMs('2026-10-21T08:00', TZ)!
    expect(formatWhen(zonedLocalToMs('2026-10-21T21:15', TZ), TZ, now)).toBe('今天 21:15')
    expect(formatWhen(zonedLocalToMs('2026-10-22T09:00', TZ), TZ, now)).toBe('明天 09:00')
    expect(formatWhen(zonedLocalToMs('2026-10-30T10:00', TZ), TZ, now)).toMatch(/10月30日.*10:00$/)
    expect(formatWhen(null, TZ, now)).toBe('—')
  })

  it('英文：Mon, Wed, Fri', () => {
    setLanguage('en')
    expect(describeDays([1, 3, 5])).toBe('Mon, Wed, Fri')
    expect(describeSpec({ type: 'weekly', days: [1, 3, 5], time: '18:30' }, TZ)).toBe('Weekly Mon, Wed, Fri 18:30')
    expect(describeSpec({ type: 'daily', time: '09:00' }, TZ)).toBe('Daily 09:00')
  })
})

describe('时区换算', () => {
  it('墙上时间 ⇄ ms（含夏令时时区）', () => {
    const ms = zonedLocalToMs('2026-10-21T09:00', TZ)!
    expect(new Date(ms).toISOString()).toBe('2026-10-21T01:00:00.000Z')
    expect(msToZonedLocal(ms, TZ)).toBe('2026-10-21T09:00')
    const ny = zonedLocalToMs('2026-07-01T09:00', 'America/New_York')!
    expect(new Date(ny).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedLocalToMs('bad', TZ)).toBeNull()
  })
})

describe('表单校验', () => {
  const now = zonedLocalToMs('2026-10-21T08:00', TZ)!
  const base = (patch = {}) => defaultScheduleForm({ timezone: TZ, ...patch }, now)

  it('必填：名称、工作流；提示词目标要内核、提示词，追加时要会话', () => {
    expect(validateScheduleForm(base(), now)).toMatchObject({
      name: expect.any(String),
      workflowId: expect.any(String),
    })
    const prompt = base({ name: 'x', targetType: 'prompt', kernelId: '', prompt: '  ', sessionMode: 'append' })
    expect(Object.keys(validateScheduleForm(prompt, now)).sort()).toEqual(['kernelId', 'prompt', 'sessionId'])
    expect(validateScheduleForm(base({ name: 'x', workflowId: 'w1' }), now)).toEqual({})
  })

  it('计划：一次性必须在将来、间隔 ≥5 分钟整数、每周至少一天、时间格式、Cron 5 段、时区有效', () => {
    const ok = { name: 'x', workflowId: 'w1' }
    expect(validateScheduleForm(base({ ...ok, specType: 'once', onceAt: '2026-10-21T07:59' }), now).onceAt).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'once', onceAt: '2026-10-21T08:30' }), now)).toEqual({})
    expect(validateScheduleForm(base({ ...ok, specType: 'interval', minutes: 4 }), now).minutes).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'interval', minutes: 7.5 }), now).minutes).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'interval', minutes: '' }), now).minutes).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'interval', minutes: 5 }), now)).toEqual({})
    expect(validateScheduleForm(base({ ...ok, specType: 'weekly', days: [] }), now).days).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'daily', time: '25:00' }), now).time).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, specType: 'cron', cron: '0 9 * *' }), now).cron).toBeTruthy()
    expect(validateScheduleForm(base({ ...ok, timezone: 'Mars/Base' }), now).timezone).toBeTruthy()
    expect(isCronShape('*/15 9-18 * * 1-5')).toBe(true)
  })

  it('表单 → 接口数据：去空白、周几排序、追加模式带 sessionId', () => {
    const w = formToInput(
      base({ name: ' 晨报 ', workflowId: 'w1', input: ' ', specType: 'weekly', days: [5, 1, 3, 1], time: '18:30' }),
    )
    expect(w).toEqual({
      name: '晨报',
      target: { type: 'workflow', workflowId: 'w1' },
      spec: { type: 'weekly', days: [1, 3, 5], time: '18:30' },
      timezone: TZ,
      enabled: true,
    })
    const p = formToInput(
      base({
        name: 'p',
        targetType: 'prompt',
        kernelId: 'kernel-claude-code',
        prompt: ' 汇总 ',
        sessionMode: 'append',
        sessionId: 's1',
        specType: 'cron',
        cron: '0  9 * * 1-5',
      }),
    )
    expect(p.target).toEqual({
      type: 'prompt',
      kernelId: 'kernel-claude-code',
      prompt: '汇总',
      sessionMode: 'append',
      sessionId: 's1',
    })
    expect(p.spec).toEqual({ type: 'cron', expr: '0 9 * * 1-5' })
    expect(formSpec(base({ specType: 'once', onceAt: '2026-10-22T09:00' }))).toEqual({
      type: 'once',
      at: zonedLocalToMs('2026-10-22T09:00', TZ),
    })
  })

  it('编辑：已有任务 → 表单字段', () => {
    const f = scheduleToForm({
      id: 's1',
      name: '跟进',
      target: { type: 'prompt', kernelId: 'builtin', prompt: 'hi', sessionMode: 'new' },
      spec: { type: 'once', at: zonedLocalToMs('2026-11-01T10:00', TZ)! },
      timezone: TZ,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      ownerId: 'u',
      createdAt: 0,
      updatedAt: 0,
    })
    expect(f).toMatchObject({
      name: '跟进',
      targetType: 'prompt',
      prompt: 'hi',
      specType: 'once',
      onceAt: '2026-11-01T10:00',
      enabled: false,
    })
  })
})
