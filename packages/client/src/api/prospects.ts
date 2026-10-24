import { request } from './http'

/* ───────── 开发客户：线索库（/api/prospects）、制裁名单（/api/sanctions） ───────── */

export type ProspectStatus = 'new' | 'contacted' | 'converted' | 'ignored'
export const PROSPECT_STATUSES: ProspectStatus[] = ['new', 'contacted', 'converted', 'ignored']
export type ProspectFlag = 'forwarder' | 'sanctions_hit' | 'customer_exists' | 'stale' | 'name_conflict' | 'website_down'
export type EvidenceKind = 'customs' | 'bill_of_lading' | 'website' | 'search' | 'directory' | 'import' | 'manual'
/** 海关 / 提单这类正式来源；其余都算“官网 / 网上发现” */
export const CUSTOMS_EVIDENCE: EvidenceKind[] = ['customs', 'bill_of_lading']

export interface ProspectEvidence {
  kind: EvidenceKind
  source: string
  url: string
  title: string
  snippet: string
  observedAt: number
  fields: string[]
}

export interface Prospect {
  id: string
  company: string
  country: string
  website: string
  address: string
  products: string
  hsCodes: string[]
  emails: string[]
  phones: string[]
  socialLinks: string[]
  lastImportAt: number | null
  shipments: number | null
  evidence: ProspectEvidence[]
  flags: ProspectFlag[]
  score: number
  scoreReasons: Array<{ key: string; label: string; points: number }>
  status: ProspectStatus
  customerId: string | null
  searchQuery: string
  notes: string
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
}

export interface ProspectQuery {
  q?: string
  status?: ProspectStatus | ''
  minScore?: number
  hasCustomsEvidence?: boolean
  flag?: ProspectFlag | ''
  sort?: 'score' | 'updated' | 'lastImport'
  limit?: number
  offset?: number
}

export interface ProspectCounts {
  total: number
  byStatus: Record<ProspectStatus, number>
  customerExists: number
}

export type ProspectConvertResult =
  | { converted: true; prospect: Prospect; customer: { id: string; company: string } }
  | {
      converted: false
      duplicate: true
      message: string
      matches: Array<{ customerId?: string; company: string; owner: string; matchedBy: string[] }>
    }

export function hasCustomsEvidence(prospect: Pick<Prospect, 'evidence'>): boolean {
  return prospect.evidence.some((item) => CUSTOMS_EVIDENCE.includes(item.kind))
}

export function listProspects(params: ProspectQuery): Promise<{ items: Prospect[]; total: number }> {
  const query: Record<string, string | number | boolean | undefined> = {
    q: params.q?.trim() || undefined,
    status: params.status || undefined,
    minScore: params.minScore,
    hasCustomsEvidence: params.hasCustomsEvidence,
    flag: params.flag || undefined,
    sort: params.sort,
    limit: params.limit,
    offset: params.offset,
  }
  return request<{ items: Prospect[]; total: number }>('/api/prospects', { query }).then((res) => ({
    items: res?.items ?? [],
    total: res?.total ?? 0,
  }))
}

export function getProspectCounts(): Promise<ProspectCounts> {
  return request<ProspectCounts>('/api/prospects/counts')
}

export function getProspect(id: string): Promise<Prospect> {
  return request<Prospect>(`/api/prospects/${encodeURIComponent(id)}`)
}

export function updateProspect(id: string, patch: Partial<Pick<Prospect, 'notes' | 'flags' | 'website' | 'country'>>): Promise<Prospect> {
  return request<Prospect>(`/api/prospects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

export function setProspectStatus(id: string, status: Exclude<ProspectStatus, 'converted'>): Promise<Prospect> {
  return request<Prospect>(`/api/prospects/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } })
}

export function convertProspect(id: string, force = false): Promise<ProspectConvertResult> {
  return request<ProspectConvertResult>(`/api/prospects/${encodeURIComponent(id)}/convert`, {
    method: 'POST',
    body: force ? { force: true } : {},
  })
}

export function deleteProspect(id: string): Promise<void> {
  return request<void>(`/api/prospects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface SanctionsListStatus {
  list: string
  updatedAt: number | null
  entryCount: number
  sourceUrl: string
  error: string | null
}

export function getSanctionsStatus(): Promise<{ lists: SanctionsListStatus[] }> {
  return request<{ lists: SanctionsListStatus[] }>('/api/sanctions/status')
}

export function refreshSanctions(list: 'ofac' | 'eu' | 'un' | 'all' = 'all'): Promise<{
  updated: string[]
  failed: Array<{ list: string; error: string }>
  lists: SanctionsListStatus[]
}> {
  return request('/api/sanctions/refresh', { method: 'POST', body: { list } })
}

export type ProspectImportField = 'company' | 'country' | 'website' | 'address' | 'products' | 'hsCodes' | 'emails' | 'phones' | 'notes'

export interface ProspectImportResult {
  created: number
  merged: number
  skipped: number
  sanctionsHits: number
  errors: Array<{ row: number; message: string }>
}

export function importProspects(body: {
  fileName: string
  mapping: Partial<Record<ProspectImportField, string>>
  rows: Array<Record<string, string>>
}): Promise<ProspectImportResult> {
  return request<ProspectImportResult>('/api/prospects/import', { method: 'POST', body })
}
