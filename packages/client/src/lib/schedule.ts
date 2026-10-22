import type { Schedule, ScheduleInput, ScheduleSpec, ScheduleSpecType, ScheduleTarget } from '../api/workflows'
import { intlLocale, t } from '../i18n'

/**
 * 定时任务：计划的白话描述（每天 09:00 / 每周一三五 18:30）、表单 ⇄ 接口数据、表单校验、时区换算。
 * 时间都按任务自己的 IANA 时区解释与显示。
 */

export const MIN_INTERVAL = 5
export const MAX_INTERVAL = 7 * 24 * 60

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 可选时区：浏览器支持 supportedValuesOf 时给全表，否则给常用的几个；当前值总在里面 */
export function timezoneOptions(current?: string): string[] {
  let all: string[] = []
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    all = fn ? fn('timeZone') : []
  } catch {
    all = []
  }
  if (!all.length)
    all = [
      'Asia/Shanghai',
      'Asia/Hong_Kong',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Asia/Dubai',
      'Europe/London',
      'Europe/Berlin',
      'America/New_York',
      'America/Los_Angeles',
      'UTC',
    ]
  const set = new Set(all)
  for (const tz of [current, systemTimezone()]) if (tz && !set.has(tz)) all = [tz, ...all]
  return all
}

/* ───────────── 时区换算 ───────────── */

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** ms 在某时区的年月日时分 */
export function zonedParts(ms: number, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const get = (type: string): string => fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAY[get('weekday')] ?? 0,
  }
}

function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return asUtc - Math.floor(ms / 60_000) * 60_000
}

/** 'YYYY-MM-DDTHH:mm'（某时区的墙上时间）→ ms；格式不对返回 null */
export function zonedLocalToMs(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) return null
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  if (Number.isNaN(guess)) return null
  let ms = guess - offsetAt(guess, tz)
  ms = guess - offsetAt(ms, tz)
  return ms
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** ms → 'YYYY-MM-DDTHH:mm'（某时区的墙上时间，datetime-local 用） */
export function msToZonedLocal(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** 列表 / 预览里的时间：今天 09:00 / 明天 09:00 / 10月23日 周五 09:00（跨年带年份） */
export function formatWhen(ms: number | null | undefined, tz: string, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const p = zonedParts(ms, tz)
  const n = zonedParts(now, tz)
  const time = `${pad(p.hour)}:${pad(p.minute)}`
  const dayNo = (x: Parts): number => Date.UTC(x.year, x.month - 1, x.day) / 86_400_000
  const diff = dayNo(p) - dayNo(n)
  if (diff === 0) return t('schedule.today', [time])
  if (diff === 1) return t('schedule.tomorrow', [time])
  const date = new Intl.DateTimeFormat(intlLocale(), {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    ...(p.year !== n.year ? { year: 'numeric' } : {}),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(ms))
  return `${date} ${time}`
}

/* ───────────── 白话描述 ───────────── */

function dayNames(): string[] {
  const raw = t('schedule.weekdayNames')
  return raw.includes(',') ? raw.split(',') : [...raw]
}

/** 星期几的列表：一三五 / Mon, Wed, Fri（周一在前，周日最后） */
export function describeDays(days: number[]): string {
  const names = dayNames()
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  const sep = names[0].length > 1 ? ', ' : ''
  return sorted.map((d) => names[d]).join(sep)
}

export function describeSpec(spec: ScheduleSpec, tz = systemTimezone()): string {
  switch (spec.type) {
    case 'once':
      return t('schedule.descOnce', [formatWhen(spec.at, tz)])
    case 'interval': {
      const m = spec.minutes
      if (m >= 60 && m % 60 === 0) return t('schedule.descEveryHours', [m / 60])
      return t('schedule.descEveryMinutes', [m])
    }
    case 'daily':
      return t('schedule.descDaily', [spec.time])
    case 'weekly': {
      const set = [...new Set(spec.days)].sort().join(',')
      if (set === '0,1,2,3,4,5,6') return t('schedule.descDaily', [spec.time])
      if (set === '1,2,3,4,5') return t('schedule.descWeekdays', [spec.time])
      if (set === '0,6') return t('schedule.descWeekends', [spec.time])
      return t('schedule.descWeekly', [describeDays(spec.days), spec.time])
    }
    case 'cron':
      return t('schedule.descCron', [spec.expr.trim()])
  }
}

/* ───────────── 表单 ───────────── */

export interface ScheduleForm {
  name: string
  targetType: 'workflow' | 'prompt'
  workflowId: string
  input: string
  kernelId: string
  prompt: string
  sessionMode: 'new' | 'append'
  sessionId: string
  specType: ScheduleSpecType
  /** once：时区内的 'YYYY-MM-DDTHH:mm' */
  onceAt: string
  minutes: number | string
  time: string
  days: number[]
  cron: string
  timezone: string
  enabled: boolean
}

export type ScheduleFormErrors = Partial<Record<keyof ScheduleForm, string>>

export function defaultScheduleForm(prefill: Partial<ScheduleForm> = {}, now = Date.now()): ScheduleForm {
  const timezone = prefill.timezone || systemTimezone()
  // 一次性默认：一小时后的整点
  const nextHour = Math.ceil((now + 3_600_000) / 3_600_000) * 3_600_000
  return {
    name: '',
    targetType: 'workflow',
    workflowId: '',
    input: '',
    kernelId: 'builtin',
    prompt: '',
    sessionMode: 'new',
    sessionId: '',
    specType: 'daily',
    onceAt: msToZonedLocal(nextHour, timezone),
    minutes: 60,
    time: '09:00',
    days: [1, 3, 5],
    cron: '0 9 * * 1-5',
    timezone,
    enabled: true,
    ...prefill,
  }
}

export function scheduleToForm(s: Schedule): ScheduleForm {
  const base = defaultScheduleForm({ timezone: s.timezone })
  const form: ScheduleForm = { ...base, name: s.name, enabled: s.enabled, specType: s.spec.type }
  if (s.target.type === 'workflow') {
    form.targetType = 'workflow'
    form.workflowId = s.target.workflowId
    form.input = s.target.input ?? ''
  } else {
    form.targetType = 'prompt'
    form.kernelId = s.target.kernelId
    form.prompt = s.target.prompt
    form.sessionMode = s.target.sessionMode
    form.sessionId = s.target.sessionId ?? ''
  }
  const spec = s.spec
  if (spec.type === 'once') form.onceAt = msToZonedLocal(spec.at, s.timezone)
  if (spec.type === 'interval') form.minutes = spec.minutes
  if (spec.type === 'daily') form.time = spec.time
  if (spec.type === 'weekly') {
    form.time = spec.time
    form.days = [...spec.days]
  }
  if (spec.type === 'cron') form.cron = spec.expr
  return form
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const CRON_FIELD = /^[\d*?/,\-A-Za-z#LW]+$/

/** 只做形状检查（5 段、字符合法）；能否解析以服务端预览为准 */
export function isCronShape(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p))
}

/** 表单里的计划 → ScheduleSpec；无效时返回 null（不做“将来时间”判断） */
export function formSpec(form: ScheduleForm): ScheduleSpec | null {
  switch (form.specType) {
    case 'once': {
      const at = zonedLocalToMs(form.onceAt, form.timezone)
      return at === null ? null : { type: 'once', at }
    }
    case 'interval': {
      const minutes = Number(form.minutes)
      return Number.isInteger(minutes) && minutes >= MIN_INTERVAL && minutes <= MAX_INTERVAL
        ? { type: 'interval', minutes }
        : null
    }
    case 'daily':
      return TIME_RE.test(form.time) ? { type: 'daily', time: form.time } : null
    case 'weekly':
      return TIME_RE.test(form.time) && form.days.length
        ? { type: 'weekly', days: [...new Set(form.days)].sort((a, b) => a - b), time: form.time }
        : null
    case 'cron':
      return isCronShape(form.cron) ? { type: 'cron', expr: form.cron.trim().replace(/\s+/g, ' ') } : null
  }
}

/** 返回 字段 → 错误文案；空对象表示通过 */
export function validateScheduleForm(form: ScheduleForm, now = Date.now()): ScheduleFormErrors {
  const e: ScheduleFormErrors = {}
  const name = form.name.trim()
  if (!name) e.name = t('schedule.errName')
  else if (name.length > 80) e.name = t('schedule.errNameLong')

  if (form.targetType === 'workflow') {
    if (!form.workflowId) e.workflowId = t('schedule.errWorkflow')
  } else {
    if (!form.kernelId) e.kernelId = t('schedule.errKernel')
    if (!form.prompt.trim()) e.prompt = t('schedule.errPrompt')
    if (form.sessionMode === 'append' && !form.sessionId) e.sessionId = t('schedule.errSession')
  }

  if (!isValidTimezone(form.timezone)) e.timezone = t('schedule.errTimezone')

  switch (form.specType) {
    case 'once': {
      const at = isValidTimezone(form.timezone) ? zonedLocalToMs(form.onceAt, form.timezone) : null
      if (at === null) e.onceAt = t('schedule.errOnce')
      else if (at <= now) e.onceAt = t('schedule.errOncePast')
      break
    }
    case 'interval': {
      const m = Number(form.minutes)
      if (form.minutes === '' || !Number.isInteger(m) || m < MIN_INTERVAL || m > MAX_INTERVAL)
        e.minutes = t('schedule.errInterval', [MIN_INTERVAL, MAX_INTERVAL])
      break
    }
    case 'weekly':
      if (!form.days.length) e.days = t('schedule.errDays')
      if (!TIME_RE.test(form.time)) e.time = t('schedule.errTime')
      break
    case 'daily':
      if (!TIME_RE.test(form.time)) e.time = t('schedule.errTime')
      break
    case 'cron':
      if (!isCronShape(form.cron)) e.cron = t('schedule.errCron')
      break
  }
  return e
}

export function formTarget(form: ScheduleForm): ScheduleTarget {
  if (form.targetType === 'workflow') {
    const input = form.input.trim()
    return { type: 'workflow', workflowId: form.workflowId, ...(input ? { input } : {}) }
  }
  return {
    type: 'prompt',
    kernelId: form.kernelId,
    prompt: form.prompt.trim(),
    sessionMode: form.sessionMode,
    sessionId: form.sessionMode === 'append' ? form.sessionId || null : null,
  }
}

/** 校验通过后调用 */
export function formToInput(form: ScheduleForm): ScheduleInput {
  const spec = formSpec(form)
  if (!spec) throw new Error('invalid schedule spec')
  return { name: form.name.trim(), target: formTarget(form), spec, timezone: form.timezone, enabled: form.enabled }
}
