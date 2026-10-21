import { intlLocale, t } from '../i18n'

const DAY = 86_400_000

/**
 * 跟进到期时间的显示（原版：红色「逾期 N 天」、加粗「今天 10:00」、「明天」、其余显示日期）。
 * cls：over（已过期，红）/ today（今天到期，加粗黑）/ ''（以后）
 */
export function dueLabel(dueAt: number | null | undefined, now = Date.now()): { text: string; cls: string } {
  if (dueAt === null || dueAt === undefined) return { text: t('wbx.noDue'), cls: '' }
  const n = new Date(now)
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  const d = new Date(dueAt)
  const hm = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
  if (dueAt < now) {
    const dueDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.max(0, Math.round((startToday - dueDay) / DAY))
    return days > 0
      ? { text: t('wbx.overdueDays', [days]), cls: 'over' }
      : { text: t('wbx.todayAt', [hm]), cls: 'over' }
  }
  if (dueAt < startToday + DAY) return { text: t('wbx.todayAt', [hm]), cls: 'today' }
  if (dueAt < startToday + 2 * DAY) return { text: t('wbx.tomorrow'), cls: '' }
  return { text: d.toLocaleDateString(intlLocale(), { month: 'numeric', day: 'numeric', weekday: 'short' }), cls: '' }
}
