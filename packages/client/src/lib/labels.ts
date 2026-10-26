import type { ActivityType, QuoteStatus, Stage } from '../api'
import { localized, t } from '../i18n'

export const STAGE_LABEL: Record<Stage, string> = localized(() => ({
  lead: t('labels.k13d6epn'),
  contacted: t('labels.kutafdb'),
  quoted: t('labels.k1504bj2'),
  negotiating: t('labels.kizbqsf'),
  won: t('labels.kj0dmjy'),
  lost: t('labels.k1n49a5w'),
}))

export const ACTIVITY_LABEL: Record<ActivityType, string> = localized(() => ({
  note: t('labels.k1q7l0g0'),
  email: t('labels.k7x8h8h'),
  call: t('labels.k1vld1sy'),
  quote: t('labels.kxbx0dt'),
}))

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = localized(() => ({
  draft: t('labels.k48glco'),
  sent: t('labels.k1cr4tgy'),
  accepted: t('labels.k1k4ilss'),
  rejected: t('labels.kl7zruv'),
}))

export function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDate(value: number | string | null | undefined): string {
  const d = toDate(value)
  if (!d) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function relativeTime(value: number | string | null | undefined): string {
  const d = toDate(value)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return t('labels.k17y3gw2')
  if (min < 60) return t('labels.kqrn1ac', [min])
  const h = Math.round(min / 60)
  if (h < 24) return t('labels.k11myqaj', [h])
  const days = Math.round(h / 24)
  if (days < 30) return t('labels.k1446nw9', [days])
  return formatDate(value)
}
