/**
 * 定时任务的触发规则与“下一次触发时间”计算（纯函数，无依赖）。
 *
 * 时区：用 Intl.DateTimeFormat 求某一时刻在 IANA 时区里的本地时间，再反推“本地墙钟 → UTC”。
 * 夏令时：
 * - 不存在的本地时间（春季拨快的那一小时，如 America/New_York 02:30）顺延到拨快后的同一分钟（03:30）；
 * - 重复的本地时间（秋季拨回的那一小时）只在第一次出现时触发。
 */

export type ScheduleSpec =
  | { type: 'once'; at: number }
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: number[]; time: string }
  | { type: 'cron'; expr: string }

export const MIN_INTERVAL_MINUTES = 5
const MINUTE = 60_000
const DAY = 86_400_000

// ── 时区换算 ─────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export interface LocalParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  }
}

/** 某时刻该时区相对 UTC 的偏移（毫秒，本地 = UTC + 偏移） */
export function offsetAt(ms: number, timeZone: string): number {
  const floored = Math.floor(ms / 1000) * 1000
  const p = localParts(floored, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - floored
}

/** 本地墙钟 → UTC 毫秒（不存在的时间顺延，重复的时间取第一次） */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const local = Date.UTC(year, month - 1, day, hour, minute)
  const before = offsetAt(local - DAY, timeZone)
  const after = offsetAt(local + DAY, timeZone)
  const candidates = [local - before, local - after].filter((t) => t + offsetAt(t, timeZone) === local)
  if (candidates.length > 0) return Math.min(...candidates)
  // 夏令时空档：按拨快前的偏移换算，结果落在拨快后的同一分钟
  return local - before
}

// ── 规则解析 ─────────────────────────────────────────────

export class SpecError extends Error {}

export function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new SpecError(`时间格式应为 HH:mm：${value}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new SpecError(`时间超出范围：${value}`)
  return { hour, minute }
}

export interface CronFields {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** 日 / 星期是否被限制（都限制时按 Vixie cron 规则取“或”） */
  dayRestricted: boolean
  weekdayRestricted: boolean
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

function parseField(raw: string, min: number, max: number, label: string, names?: string[]): number[] {
  const value = (token: string): number => {
    const upper = token.toUpperCase()
    if (names) {
      const index = names.indexOf(upper)
      if (index >= 0) return index + (label === '月' ? 1 : 0)
    }
    if (!/^\d+$/.test(token)) throw new SpecError(`cron ${label}字段不合法：${raw}`)
    return Number(token)
  }
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    if (!part) throw new SpecError(`cron ${label}字段不合法：${raw}`)
    const [range, stepRaw] = part.split('/')
    if (part.split('/').length > 2) throw new SpecError(`cron ${label}字段不合法：${raw}`)
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) throw new SpecError(`cron ${label}步长不合法：${raw}`)
      step = Number(stepRaw)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      if (a === undefined || b === undefined || range!.split('-').length !== 2) throw new SpecError(`cron ${label}范围不合法：${raw}`)
      lo = value(a)
      hi = value(b)
    } else {
      lo = value(range!)
      hi = stepRaw !== undefined ? max : lo
    }
    if (lo < min || hi > max || lo > hi) throw new SpecError(`cron ${label}超出范围（${min}-${max}）：${raw}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronFields {
  const trimmed = expr.trim()
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed
  const fields = expanded.split(/\s+/)
  if (fields.length !== 5) throw new SpecError('cron 表达式需要 5 个字段：分 时 日 月 星期')
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string]
  const minutes = parseField(mi, 0, 59, '分')
  const hours = parseField(h, 0, 23, '时')
  const days = parseField(dom, 1, 31, '日')
  const months = parseField(mon, 1, 12, '月', MONTH_NAMES)
  const weekdays = parseField(dow, 0, 7, '星期', DAY_NAMES)
  const weekdaySet = new Set(weekdays.map((d) => (d === 7 ? 0 : d)))
  // Vixie cron：字段以 * 开头（含 */n）视为不限制
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: weekdaySet,
    dayRestricted: !dom.startsWith('*'),
    weekdayRestricted: !dow.startsWith('*'),
  }
}

/** 校验规则；返回规范化后的规则，失败抛 SpecError */
export function normalizeSpec(spec: ScheduleSpec): ScheduleSpec {
  switch (spec.type) {
    case 'once':
      if (!Number.isFinite(spec.at) || spec.at <= 0) throw new SpecError('一次性任务需要有效的时间（毫秒时间戳）')
      return { type: 'once', at: Math.trunc(spec.at) }
    case 'interval':
      if (!Number.isInteger(spec.minutes) || spec.minutes < MIN_INTERVAL_MINUTES) throw new SpecError(`间隔至少 ${MIN_INTERVAL_MINUTES} 分钟`)
      if (spec.minutes > 366 * 24 * 60) throw new SpecError('间隔不能超过一年')
      return { type: 'interval', minutes: spec.minutes }
    case 'daily': {
      const { hour, minute } = parseTime(spec.time)
      return { type: 'daily', time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
    }
    case 'weekly': {
      const { hour, minute } = parseTime(spec.time)
      const days = [...new Set(spec.days)].sort((a, b) => a - b)
      if (days.length === 0) throw new SpecError('每周任务至少选择一天')
      if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new SpecError('星期取值 0-6（0 = 周日）')
      return { type: 'weekly', days, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
    }
    case 'cron': {
      const expr = spec.expr.trim().replace(/\s+/g, ' ')
      parseCron(expr)
      return { type: 'cron', expr }
    }
    default:
      throw new SpecError('未知的定时类型')
  }
}

// ── 下一次触发 ───────────────────────────────────────────

/** 本地日期迭代：从 `after` 所在的本地日期开始，逐日返回 [y, m, d, weekday] */
function* localDays(after: number, timeZone: string, maxDays: number): Generator<[number, number, number, number]> {
  const start = localParts(after, timeZone)
  for (let i = 0; i <= maxDays; i += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i))
    yield [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()]
  }
}

/** 一年内的 cron 匹配上限（如 2 月 30 日永远不会触发）；跨 8 年以覆盖闰年 2 月 29 日 */
const CRON_HORIZON_DAYS = 366 * 8

/**
 * `after` 之后（严格大于）的下一次触发时间；没有则返回 null。
 * interval 以 `anchor` 为起点按固定步长对齐（anchor + k·间隔），避免漂移。
 */
export function nextFire(spec: ScheduleSpec, timeZone: string, after: number, anchor = after): number | null {
  switch (spec.type) {
    case 'once':
      return spec.at > after ? spec.at : null
    case 'interval': {
      const step = spec.minutes * MINUTE
      if (anchor > after) return anchor
      const k = Math.floor((after - anchor) / step) + 1
      return anchor + k * step
    }
    case 'daily': {
      const { hour, minute } = parseTime(spec.time)
      for (const [y, m, d] of localDays(after, timeZone, 3)) {
        const t = zonedToUtc(y, m, d, hour, minute, timeZone)
        if (t > after) return t
      }
      return null
    }
    case 'weekly': {
      const { hour, minute } = parseTime(spec.time)
      const days = new Set(spec.days)
      for (const [y, m, d, wd] of localDays(after, timeZone, 9)) {
        if (!days.has(wd)) continue
        const t = zonedToUtc(y, m, d, hour, minute, timeZone)
        if (t > after) return t
      }
      return null
    }
    case 'cron': {
      const cron = parseCron(spec.expr)
      for (const [y, m, d, wd] of localDays(after, timeZone, CRON_HORIZON_DAYS)) {
        if (!cron.months.has(m)) continue
        const domOk = cron.days.has(d)
        const dowOk = cron.weekdays.has(wd)
        const dayOk =
          cron.dayRestricted && cron.weekdayRestricted ? domOk || dowOk : cron.dayRestricted ? domOk : cron.weekdayRestricted ? dowOk : true
        if (!dayOk) continue
        // 夏令时空档里的时间会被顺延，同一天内按 UTC 取最早的一个
        let best: number | null = null
        for (const hour of cron.hours) {
          for (const minute of cron.minutes) {
            const t = zonedToUtc(y, m, d, hour, minute, timeZone)
            if (t > after && (best === null || t < best)) best = t
          }
        }
        if (best !== null) return best
      }
      return null
    }
  }
}

/** 预览：`after` 之后的前 n 次触发时间 */
export function previewFires(spec: ScheduleSpec, timeZone: string, after: number, count = 5, anchor = after): number[] {
  const out: number[] = []
  let cursor = after
  while (out.length < count) {
    const next = nextFire(spec, timeZone, cursor, anchor)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}
