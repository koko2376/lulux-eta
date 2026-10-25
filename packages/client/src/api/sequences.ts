import { request } from './http'

/* ───────── 开发信序列（/api/sequences、/api/sequence-sends、/api/email-suppressions） ───────── */

export interface SequenceStep {
  delayDays: number
  subject: string
  body: string
}

export type SequenceStatus = 'active' | 'paused'
export type EnrollmentStatus = 'active' | 'paused' | 'replied' | 'unsubscribed' | 'bounced' | 'completed' | 'stopped'
export type SequenceSendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'

export interface Sequence {
  id: string
  ownerId: string
  name: string
  accountId: string
  accountEmail: string
  steps: SequenceStep[]
  windowStart: number
  windowEnd: number
  skipWeekends: boolean
  stopOnCompanyReply: boolean
  includeOptout: boolean
  autoSend: boolean
  dailyLimit: number
  status: SequenceStatus
  stats: { total: number; active: number; replied: number; unsubscribed: number; bounced: number; completed: number; pending: number; sent: number }
  createdAt: number
  updatedAt: number
}

export interface SequenceInput {
  name: string
  accountId?: string
  steps: SequenceStep[]
  windowStart: number
  windowEnd: number
  skipWeekends: boolean
  stopOnCompanyReply: boolean
  includeOptout: boolean
  autoSend: boolean
  dailyLimit: number
}

export interface SequenceEnrollment {
  id: string
  sequenceId: string
  email: string
  name: string
  company: string
  country: string
  timezone: string
  customerId: string | null
  prospectId: string | null
  status: EnrollmentStatus
  currentStep: number
  nextSendAt: number | null
  lastSentAt: number | null
  stopReason: string
  createdAt: number
}

export interface SequenceSend {
  id: string
  enrollmentId: string
  sequenceId: string
  sequenceName: string
  email: string
  name: string
  company: string
  stepIndex: number
  draftId: string | null
  status: SequenceSendStatus
  subject: string
  preview: string
  scheduledAt: number
  sentAt: number | null
  error: string
  missingVars: string[]
}

export interface EnrollContact {
  email: string
  name?: string
  company?: string
  country?: string
  timezone?: string
}

const enc = encodeURIComponent

export const listSequences = (): Promise<Sequence[]> => request('/api/sequences')
export const getSequence = (id: string): Promise<Sequence> => request(`/api/sequences/${enc(id)}`)
export const createSequence = (body: SequenceInput): Promise<Sequence> => request('/api/sequences', { method: 'POST', body })
export const updateSequence = (id: string, body: Partial<SequenceInput> & { status?: SequenceStatus }): Promise<Sequence> =>
  request(`/api/sequences/${enc(id)}`, { method: 'PATCH', body })
export const deleteSequence = (id: string): Promise<void> => request(`/api/sequences/${enc(id)}`, { method: 'DELETE' })
export const listSequenceEnrollments = (id: string): Promise<SequenceEnrollment[]> => request(`/api/sequences/${enc(id)}/enrollments`)
export const enrollSequence = (
  id: string,
  body: { contacts?: EnrollContact[]; customerIds?: string[]; prospectIds?: string[]; force?: boolean },
): Promise<{ enrolled: SequenceEnrollment[]; skipped: Array<{ email: string; reason: string }> }> =>
  request(`/api/sequences/${enc(id)}/enrollments`, { method: 'POST', body })
export const setEnrollmentStatus = (id: string, status: 'active' | 'paused' | 'stopped'): Promise<SequenceEnrollment> =>
  request(`/api/sequence-enrollments/${enc(id)}`, { method: 'PATCH', body: { status } })
export const listSequenceSends = (query: { status?: SequenceSendStatus; sequenceId?: string; limit?: number } = {}): Promise<SequenceSend[]> =>
  request('/api/sequence-sends', { query: query as Record<string, string | number | undefined> })
export const approveSequenceSends = (ids: string[]): Promise<{ sent: SequenceSend[]; failed: Array<{ id: string; error: string }> }> =>
  request('/api/sequence-sends/approve', { method: 'POST', body: { ids } })
export const skipSequenceSend = (id: string): Promise<SequenceSend> => request(`/api/sequence-sends/${enc(id)}/skip`, { method: 'POST' })
export const listSuppressions = (): Promise<Array<{ email: string; reason: string; createdAt: number }>> => request('/api/email-suppressions')
export const addSuppression = (email: string, reason?: string): Promise<{ email: string; stopped: number }> =>
  request('/api/email-suppressions', { method: 'POST', body: { email, reason } })
export const removeSuppression = (email: string): Promise<void> => request(`/api/email-suppressions/${enc(email)}`, { method: 'DELETE' })

/** 粘贴的联系人：每行“邮箱, 姓名, 公司, 国家”（逗号 / 制表符分隔，后三项可省略） */
export function parseContactLines(text: string): { contacts: EnrollContact[]; invalid: string[] } {
  const contacts: EnrollContact[] = []
  const invalid: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cells = line.split(/\t|,|，|;|；/).map((c) => c.trim())
    const emailIndex = cells.findIndex((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.replace(/^<|>$/g, '')))
    if (emailIndex < 0) {
      invalid.push(line)
      continue
    }
    const email = cells[emailIndex]!.replace(/^<|>$/g, '').toLowerCase()
    const rest = cells.filter((_, i) => i !== emailIndex)
    contacts.push({ email, name: rest[0] || undefined, company: rest[1] || undefined, country: rest[2] || undefined })
  }
  return { contacts, invalid }
}
