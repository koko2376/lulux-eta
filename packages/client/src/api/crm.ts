import { request } from './http'
import type { CustomerDuplicate } from './index'

/* ───────── 商机、订单、收款、漏斗、备份恢复（docs/API-CONTRACT.md §10.3 §10.5 §10.7 §10.8） ───────── */

export type DealStage = 'prospecting' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
export const DEAL_STAGES: DealStage[] = ['prospecting', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
export const OPEN_DEAL_STAGES: DealStage[] = ['prospecting', 'qualified', 'proposal', 'negotiation']

export interface Deal {
  id: string
  title: string
  customerId: string
  customerName: string
  quoteId: string | null
  amount: number
  currency: string
  stage: DealStage
  probability: number
  probabilityOverridden: boolean
  weightedAmount: number
  expectedClose: string
  wonReason: string
  lostReason: string
  notes: string
  source: 'user' | 'agent'
  ownerId: string
  ownerName: string
  overdue: boolean
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export interface DealInput {
  customerId?: string
  title?: string
  amount?: number
  currency?: string
  stage?: DealStage
  probability?: number | null
  expectedClose?: string
  quoteId?: string | null
  wonReason?: string
  lostReason?: string
  notes?: string
}

export type OrderStatus = 'pending_production' | 'in_production' | 'shipped' | 'completed' | 'cancelled'
export const ORDER_FLOW: OrderStatus[] = ['pending_production', 'in_production', 'shipped', 'completed']
export const CONTAINER_TYPES = [
  '',
  'LCL',
  "20'GP",
  "40'GP",
  "40'HQ",
  "45'HQ",
  "20'RF",
  "40'RF",
  'AIR',
  'EXPRESS',
  'OTHER',
]

export interface Shipment {
  containerType: string
  containerNo: string
  blNo: string
  vessel: string
  portOfLoading: string
  portOfDischarge: string
  etd: string
  eta: string
}

export interface Payment {
  id: string
  orderId: string
  amount: number
  currency: string
  receivedAt: string
  method: string
  reference: string
  notes: string
  source: string
  createdBy: string
  createdAt: number
}

export interface Order {
  id: string
  number: string
  customerId: string
  customerName: string
  quoteId: string | null
  quoteNumber: string
  dealId: string | null
  currency: string
  amount: number
  items: unknown[]
  incoterm: string
  paymentTerms: string
  depositAmount: number
  dueDate: string
  status: OrderStatus
  notes: string
  shipment: Shipment
  paid: number
  balance: number
  paymentStatus: 'unpaid' | 'partial' | 'paid'
  overdue: boolean
  overdueDays: number
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
  shippedAt: number | null
  completedAt: number | null
  payments?: Payment[]
}

export type Money = Record<string, number>

export interface ReceivablesSummary {
  openCount: number
  outstandingByCurrency: Money
  overdueCount: number
  overdueByCurrency: Money
}

export interface DealBucket {
  count: number
  amountByCurrency: Money
  weightedByCurrency: Money
}

export interface PipelineStats {
  customers: { total: number; byStage: Record<string, number> }
  funnel: { stage: string; count: number; reached: number; conversionFromPrevious: number | null }[]
  winRate: number | null
  tasks: { open: number; overdue: number }
  deals?: {
    total: number
    byStage: (DealBucket & { stage: DealStage; probability: number })[]
    open: DealBucket
    closingThisMonth: DealBucket
    winRate: number | null
    lostReasons: { reason: string; count: number }[]
  }
  receivables?: ReceivablesSummary
}

export interface RestorePending {
  name: string
  sha256: string
  size: number
  schemaVersion: number
  requestedAt: number | string
  requestedBy: string
}
export interface RestoreResult {
  ok: boolean
  name: string
  at: number | string
  previous: string
  rolledBack: boolean
  error: string
}

export const dealsApi = {
  list: (query: { stage?: string; customerId?: string; mine?: 1; limit?: number } = {}) =>
    request<{ items: Deal[]; total: number }>('/api/deals', { query }),
  create: (body: DealInput) => request<Deal>('/api/deals', { method: 'POST', body }),
  update: (id: string, body: DealInput, silent = false) =>
    request<Deal>(`/api/deals/${encodeURIComponent(id)}`, { method: 'PATCH', body, silent }),
  remove: (id: string) => request<void>(`/api/deals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export const ordersApi = {
  fromQuote: (quoteId: string, body: { depositAmount?: number; dueDate?: string; notes?: string }, silent = false) =>
    request<Order>(`/api/quotes/${encodeURIComponent(quoteId)}/order`, { method: 'POST', body, silent }),
  list: (query: { status?: string; customerId?: string; receivable?: string; limit?: number } = {}) =>
    request<{ items: Order[]; total: number }>('/api/orders', { query }),
  get: (id: string) => request<Order>(`/api/orders/${encodeURIComponent(id)}`),
  update: (id: string, body: Partial<Shipment> & Record<string, unknown>) =>
    request<Order>(`/api/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  remove: (id: string) => request<void>(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addPayment: (
    id: string,
    body: {
      amount: number
      currency?: string
      receivedAt?: string
      method?: string
      reference?: string
      notes?: string
    },
  ) =>
    request<{ payment: Payment; order: Order }>(`/api/orders/${encodeURIComponent(id)}/payments`, {
      method: 'POST',
      body,
      silent: true,
    }),
  removePayment: (id: string, pid: string) =>
    request<void>(`/api/orders/${encodeURIComponent(id)}/payments/${encodeURIComponent(pid)}`, { method: 'DELETE' }),
  receivables: (query: { overdue?: 1; limit?: number } = {}, silent = false) =>
    request<{ items: Order[]; total: number; summary: ReceivablesSummary }>('/api/receivables', { query, silent }),
}

export interface Task {
  id: string
  title: string
  notes: string
  customerId: string | null
  customerName: string | null
  quoteId: string | null
  dueAt: number | null
  status: 'open' | 'done' | 'cancelled'
  priority: string
  overdue: boolean
  createdAt: number
  updatedAt: number
}

export const tasksApi = {
  list: (
    query: {
      status?: string
      due?: 'overdue' | 'today' | 'week'
      mine?: 1
      limit?: number
      customerId?: string
    } = {},
    silent = false,
  ) => request<{ items: Task[]; total: number }>('/api/tasks', { query, silent }),
  update: (id: string, body: { status?: Task['status']; dueAt?: number | null }) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  create: (body: { title: string; notes?: string; customerId?: string | null; dueAt?: number | null }) =>
    request<Task>('/api/tasks', { method: 'POST', body }),
}

export const pipelineApi = {
  stats: () => request<PipelineStats>('/api/pipeline/stats'),
}

export interface BackupFile {
  name: string
  size: number
  createdAt: number
  kind: string
  /** false：在改目录之前的默认目录里 */
  inCurrentDir?: boolean
}
export interface BackupLocation {
  dir: string
  defaultDir: string
  custom: boolean
  configuredDir: string | null
  dataDir: string
  sameDisk: boolean
}

export const backupApi = {
  list: () => request<{ backups: BackupFile[]; location?: BackupLocation }>('/api/data/backups', { silent: true }),
  create: () => request<BackupFile>('/api/data/backups', { method: 'POST' }),
  setLocation: (dir: string | null) =>
    request<BackupLocation>('/api/data/backups/location', { method: 'PUT', body: { dir }, silent: true }),
  download: (name: string) => request<Blob>(`/api/data/backups/${encodeURIComponent(name)}/download`, { blob: true }),
  remove: (name: string) =>
    request<void>(`/api/data/backups/${encodeURIComponent(name)}`, { method: 'DELETE', silent: true }),
}

export const restoreApi = {
  request: (name: string) =>
    request<{ pending: RestorePending; restartRequired: boolean }>(
      `/api/data/backups/${encodeURIComponent(name)}/restore`,
      { method: 'POST', silent: true },
    ),
  state: () =>
    request<{ pending: RestorePending | null; lastResult: RestoreResult | null }>('/api/data/restore', {
      silent: true,
    }),
  cancel: () => request<{ cancelled: boolean }>('/api/data/restore', { method: 'DELETE' }),
}

/** 按币种分别格式化的金额列表（不做汇率折算） */
export function moneyEntries(map: Money | undefined | null): [string, number][] {
  return Object.entries(map ?? {})
    .filter(([, v]) => Number.isFinite(v) && v !== 0)
    .sort((a, b) => b[1] - a[1])
}

/* ───────── 回收站 ───────── */

export type TrashEntity = 'customer' | 'quote' | 'deal' | 'order' | 'task'
export const TRASH_ENTITIES: TrashEntity[] = ['customer', 'quote', 'deal', 'order', 'task']

export interface TrashItem {
  entity: TrashEntity
  id: string
  title: string
  subtitle: string
  customerId: string | null
  ownerId: string
  ownerName: string
  deletedAt: number
  deletedBy: string | null
  deletedByName: string
  /** 自动彻底删除的时间；不自动清理时为 null */
  purgeAt: number | null
  cascadedTasks?: number
}

export const trashApi = {
  list: (query: { entity?: TrashEntity; query?: string; page?: number; pageSize?: number } = {}) =>
    request<{ items: TrashItem[]; total: number; retentionDays: number }>('/api/trash', { query }),
  restore: (entity: TrashEntity, id: string) =>
    request<{ entity: TrashEntity; id: string; restored: number; duplicates?: CustomerDuplicate[] }>(
      `/api/trash/${entity}/${encodeURIComponent(id)}/restore`,
      { method: 'POST', silent: true },
    ),
  purge: (entity: TrashEntity, id: string) =>
    request<void>(`/api/trash/${entity}/${encodeURIComponent(id)}`, { method: 'DELETE', silent: true }),
}
