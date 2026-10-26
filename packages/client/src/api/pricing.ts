import { request } from './http'

/* ───────── 报价引擎：汇率（/api/fx）、运价表（/api/freight-rates）、按成本算价（/api/pricing） ───────── */

export type FxSource = 'manual' | 'locked' | 'frankfurter' | 'erapi' | 'identity'

export interface FxRate {
  pair: string
  from?: string
  to?: string
  rate: number
  source: FxSource
  asOf: string
  locked: boolean
  stale: boolean
}

export interface FxTable {
  base: string
  stale: boolean
  error: string | null
  rates: FxRate[]
}

export function getFxRates(base = 'USD', symbols: string[] = ['CNY', 'EUR', 'GBP']): Promise<FxTable> {
  return request<FxTable>('/api/fx/rates', { query: { base, symbols: symbols.join(',') }, silent: true })
}

export function refreshFx(): Promise<{ base: string; fetchedAt: number; stale: boolean; error: string | null; rates: Record<string, number> }> {
  return request('/api/fx/refresh', { method: 'POST' })
}

export type Container = '20GP' | '40GP' | '40HQ' | 'LCL'
export const CONTAINERS: Container[] = ['20GP', '40GP', '40HQ', 'LCL']

export interface FreightRate {
  id: string
  pol: string
  pod: string
  podCountry: string
  container: Container
  price: number
  currency: string
  unit: 'container' | 'cbm'
  carrier: string
  validFrom: string
  validUntil: string
  notes: string
  createdAt: number
  updatedAt: number
}

export type FreightRateInput = Partial<Omit<FreightRate, 'id' | 'createdAt' | 'updatedAt'>> & { pod: string }

export function listFreightRates(query: { pod?: string; includeExpired?: boolean } = {}): Promise<FreightRate[]> {
  return request<FreightRate[]>('/api/freight-rates', {
    query: { ...(query.pod ? { pod: query.pod } : {}), ...(query.includeExpired ? { includeExpired: '1' } : {}) },
  })
}

export function createFreightRate(body: FreightRateInput): Promise<FreightRate> {
  return request<FreightRate>('/api/freight-rates', { method: 'POST', body })
}

export function deleteFreightRate(id: string): Promise<void> {
  return request<void>(`/api/freight-rates/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function importFreightRates(rows: Array<Record<string, string>>): Promise<{ created: number; skipped: number; errors: Array<{ row: number; message: string }> }> {
  return request('/api/freight-rates/import', { method: 'POST', body: { rows } })
}

export type PricingIncoterm = 'EXW' | 'FOB' | 'CFR' | 'CIF' | 'DDP'
export const PRICING_INCOTERMS: PricingIncoterm[] = ['EXW', 'FOB', 'CFR', 'CIF', 'DDP']

export interface PricingItemInput {
  name: string
  qty: number
  unit?: string
  unitCost?: number
  costCurrency?: string
  cbmPerUnit?: number
  kgPerUnit?: number
  productId?: string
}

export interface PricingRequest {
  items: PricingItemInput[]
  quoteCurrency: string
  incoterm: PricingIncoterm
  pricing?: { marginPct?: number; markupPct?: number; targetUnitPrices?: number[] }
  costs?: {
    exportPerShipment?: number
    freight?: { amount: number; currency?: string; per?: 'shipment' | 'cbm' }
    pol?: string
    pod?: string
    container?: Container
    insuranceRatePct?: number
    dutyPct?: number
    vatPct?: number
    destinationPerShipment?: number
    exportRebatePct?: number
  }
  fx?: Record<string, number>
}

export interface PricingResult {
  incoterm: PricingIncoterm
  quoteCurrency: string
  items: Array<{
    productId: string | null
    name: string
    qty: number
    unit: string
    unitCost: number
    unitPrice: number
    marginPct: number
    amount: number
    ladderCost: Partial<Record<PricingIncoterm, number>>
    ladder: Partial<Record<PricingIncoterm, number>>
  }>
  totals: { cost: number; revenue: number; profit: number; marginPct: number; cbm: number; kg: number }
  container: { type: Container; count: number; cbmUsed: number; fillPct: number } | null
  freight: { source: 'manual' | 'rate_table' | 'none'; rateId?: string; amount: number; currency: string }
  fx: FxRate[]
  breakdown: Array<{ key: string; label: string; amount: number }>
  warnings: string[]
  quoteItems: Array<{ productId: string | null; name: string; spec: string; qty: number; unit: string; unitPrice: number }>
}

export function calculatePricing(body: PricingRequest): Promise<PricingResult> {
  // 对话框里自己展示错误，不再弹全局 toast（否则错误会出现两遍）
  return request<PricingResult>('/api/pricing/calculate', { method: 'POST', body, silent: true })
}
