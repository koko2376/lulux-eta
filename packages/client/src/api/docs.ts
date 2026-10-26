import { request } from './http'

/* ───────── 出货单证（/api/orders/:id/docs）与 HS 建议（/api/hs/suggest） ───────── */

export type DocKind = 'ci' | 'pl' | 'co'
export const DOC_KINDS: DocKind[] = ['ci', 'pl', 'co']

export interface DocParty {
  name: string
  address: string
  contact: string
}

export interface DocLine {
  itemIndex: number
  itemKey?: string
  description: string
  hsCode: string
  cartons: number
  netKg: number
  grossKg: number
  cbm: number
}

export interface DocLineView extends DocLine {
  name: string
  spec: string
  qty: number
  unit: string
  unitPrice: number
  amount: number
}

export interface DocInfo {
  invoiceNo: string
  invoiceDate: string
  shipper: DocParty
  consignee: DocParty
  notifyParty: string
  marks: string
  origin: string
  portOfLoading: string
  portOfDischarge: string
  vessel: string
  packageUnit: string
  lines: DocLine[]
  updatedAt: number | null
}

export interface DocIssue {
  level: 'error' | 'warning'
  field: string
  code: string
  params: Array<string | number>
  message: string
}

export interface DocBundle {
  orderId: string
  orderNumber: string
  currency: string
  incoterm: string
  paymentTerms: string
  info: DocInfo
  lines: DocLineView[]
  totals: { qty: number; amount: number; cartons: number; netKg: number; grossKg: number; cbm: number }
  issues: DocIssue[]
}

export type DocPatch = Partial<Omit<DocInfo, 'lines' | 'updatedAt' | 'shipper' | 'consignee'>> & {
  shipper?: Partial<DocParty>
  consignee?: Partial<DocParty>
  lines?: Array<Partial<DocLine> & { itemIndex: number }>
}

export interface HsCandidate {
  code: string
  hs6: string
  description: string
  source: 'product' | 'history' | 'uk_tariff'
  detail: string
}

const enc = encodeURIComponent

export const getOrderDocs = (orderId: string): Promise<DocBundle> => request(`/api/orders/${enc(orderId)}/docs`)
export const updateOrderDocs = (orderId: string, body: DocPatch): Promise<DocBundle> =>
  request(`/api/orders/${enc(orderId)}/docs`, { method: 'PATCH', body })
export const orderDocPdf = (orderId: string, kind: DocKind): Promise<Blob> => request(`/api/orders/${enc(orderId)}/docs/${kind}.pdf`, { blob: true })
export const suggestHs = (q: string): Promise<{ query: string; candidates: HsCandidate[]; tariffError: string | null; note: string }> =>
  request('/api/hs/suggest', { query: { q } })
