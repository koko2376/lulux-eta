import { ToolError } from './tool-error.js'

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function parts(instant: number, zone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const out: Record<string, number> = {}
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return out
}

/** 某时区在某时刻相对 UTC 的偏移（分钟） */
export function offsetMinutes(instant: number, zone: string): number {
  const p = parts(instant, zone)
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000)
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export function describeInstant(instant: number, zone: string) {
  const p = parts(instant, zone)
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0')
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'long' }).format(new Date(instant))
  return {
    timeZone: zone,
    local: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`,
    weekday,
    utcOffset: formatOffset(offsetMinutes(instant, zone)),
    iso: new Date(instant).toISOString(),
  }
}

/** 把某时区的墙上时间（YYYY-MM-DD HH:mm[:ss] 或 HH:mm，后者取该时区今天）换算成时刻 */
export function wallTimeToInstant(input: string, zone: string, now = Date.now()): number {
  const text = input.trim().replace('T', ' ')
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  let y: number, mo: number, d: number, h: number, mi: number, s: number
  if (match) {
    y = Number(match[1]); mo = Number(match[2]); d = Number(match[3])
    h = Number(match[4] ?? 0); mi = Number(match[5] ?? 0); s = Number(match[6] ?? 0)
  } else {
    match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
    if (!match) throw new ToolError('时间格式应为 YYYY-MM-DD HH:mm 或 HH:mm')
    const today = parts(now, zone)
    y = today.year!; mo = today.month!; d = today.day!
    h = Number(match[1]); mi = Number(match[2]); s = Number(match[3] ?? 0)
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) throw new ToolError('时间数值超出范围')
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let instant = guess - offsetMinutes(guess, zone) * 60_000
  // 夏令时边界：用换算后时刻的偏移再校正一次
  instant = guess - offsetMinutes(instant, zone) * 60_000
  return instant
}
