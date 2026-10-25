/** 日期工具：单证、单号、校验统一用本机时区的年月日 */

/** YYYY-MM-DD 且是真实存在的日期（2026-02-30 不通过；Date.parse 会把它顺延成 3 月 2 日） */
export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** 本机时区的日期 YYYY-MM-DD */
export function localDateString(at: number = Date.now()): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本机时区的日期 YYYYMMDD（单号用） */
export function localDateStamp(at: number = Date.now()): string {
  return localDateString(at).replace(/-/g, '')
}
