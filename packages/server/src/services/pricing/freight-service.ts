import { z } from 'zod'
import { db } from '../../db.js'
import { notFound } from '../../errors.js'
import { currentActor } from '../../context.js'
import { requirePermission } from '../../security/access.js'
import { newId } from '../../utils/id.js'
import { transaction } from '../../utils/tx.js'
import { parse } from '../../validation.js'
import { currencyCode } from '../product-service.js'

/**
 * 运价表：按组织隔离的海运 / 拼箱价格。
 * - 港口匹配不区分大小写、忽略空格；
 * - 查价只考虑未过期（valid_until 为空或 >= 日期）且 valid_from 已生效的条目；
 * - 删除直接删，不进回收站（运价是可重建的参考数据）。
 */

export const CONTAINERS = ['20GP', '40GP', '40HQ', 'LCL'] as const
export type Container = (typeof CONTAINERS)[number]

export const FREIGHT_UNITS = ['container', 'cbm'] as const

export interface FreightRate {
  id: string
  pol: string
  pod: string
  podCountry: string
  container: Container
  price: number
  currency: string
  unit: (typeof FREIGHT_UNITS)[number]
  carrier: string
  validFrom: string
  validUntil: string
  notes: string
  createdAt: number
  updatedAt: number
}

const dateString = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))),
    '日期格式应为 YYYY-MM-DD',
  )

const shape = {
  pol: z.string().trim().max(100),
  pod: z.string().trim().min(1, '目的港不能为空').max(100),
  podCountry: z.string().trim().max(100),
  container: z.enum(CONTAINERS),
  price: z.number().finite().positive('运价必须大于 0').max(1e12),
  currency: currencyCode,
  unit: z.enum(FREIGHT_UNITS),
  carrier: z.string().trim().max(200),
  validFrom: dateString,
  validUntil: dateString,
  notes: z.string().max(2000),
}

export const freightCreateInput = z.object({
  ...shape,
  pol: shape.pol.default(''),
  podCountry: shape.podCountry.default(''),
  container: shape.container.default('40HQ'),
  currency: shape.currency.default('USD'),
  unit: shape.unit.default('container'),
  carrier: shape.carrier.default(''),
  validFrom: shape.validFrom.default(''),
  validUntil: shape.validUntil.default(''),
  notes: shape.notes.default(''),
})

export const freightPatchInput = z.object(shape).partial().strict()

export const freightImportInput = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  })
  .strict()

interface FreightRow {
  id: string
  pol: string
  pod: string
  pod_country: string
  container: string
  price: number
  currency: string
  unit: string
  carrier: string
  valid_from: string
  valid_until: string
  notes: string
  created_at: number
  updated_at: number
}

const orgId = (): string => currentActor().orgId

/** 港口名比较：去空格、忽略大小写 */
export function portKey(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

function toRate(row: FreightRow): FreightRate {
  return {
    id: row.id,
    pol: row.pol,
    pod: row.pod,
    podCountry: row.pod_country,
    container: row.container as Container,
    price: Number(row.price),
    currency: row.currency,
    unit: row.unit as FreightRate['unit'],
    carrier: row.carrier,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 当天（YYYY-MM-DD，本地时区） */
function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[,\s$€£¥]/g, '')
  if (!cleaned) return undefined
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : Number.NaN
}

function textCell(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

function normalizeContainer(value: string): Container | null {
  const upper = value.replace(/[\s'’"]/g, '').toUpperCase()
  if (upper === '20GP') return '20GP'
  if (upper === '40GP') return '40GP'
  if (upper === '40HQ' || upper === '40HC') return '40HQ'
  if (upper === 'LCL' || upper === 'CBM') return 'LCL'
  return null
}

export interface FreightFilter {
  pod?: string
  pol?: string
  container?: Container
  includeExpired?: boolean
}

export interface FindBestInput {
  pol?: string
  pod: string
  container: Container
  /** YYYY-MM-DD；不填用今天 */
  date?: string
}

export const freightService = {
  list(filter: FreightFilter = {}): FreightRate[] {
    const where = ['org_id = ?']
    const params: string[] = [orgId()]
    if (filter.pod) {
      where.push(`upper(replace(pod, ' ', '')) = ?`)
      params.push(portKey(filter.pod))
    }
    if (filter.pol) {
      where.push(`upper(replace(pol, ' ', '')) = ?`)
      params.push(portKey(filter.pol))
    }
    if (filter.container) {
      where.push('container = ?')
      params.push(filter.container)
    }
    if (!filter.includeExpired) {
      where.push("(valid_until = '' OR valid_until >= ?) AND (valid_from = '' OR valid_from <= ?)")
      params.push(today(), today())
    }
    const rows = db
      .prepare(`SELECT * FROM freight_rates WHERE ${where.join(' AND ')} ORDER BY price ASC, created_at DESC`)
      .all(...params) as unknown as FreightRow[]
    return rows.map(toRate)
  },

  get(id: string): FreightRate | undefined {
    const row = db
      .prepare('SELECT * FROM freight_rates WHERE id = ? AND org_id = ?')
      .get(id, orgId()) as unknown as FreightRow | undefined
    return row ? toRate(row) : undefined
  },

  require(id: string): FreightRate {
    const rate = freightService.get(id)
    if (!rate) throw notFound('运价')
    return rate
  },

  create(input: unknown): FreightRate {
    requirePermission('data:write')
    const data = parse(freightCreateInput, input)
    return freightService.insert(data)
  },

  insert(data: z.infer<typeof freightCreateInput>): FreightRate {
    const now = Date.now()
    const id = newId('frt')
    db.prepare(
      `INSERT INTO freight_rates (id, org_id, pol, pod, pod_country, container, price, currency, unit, carrier,
         valid_from, valid_until, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      orgId(),
      data.pol,
      data.pod,
      data.podCountry,
      data.container,
      data.price,
      data.currency,
      data.unit,
      data.carrier,
      data.validFrom,
      data.validUntil,
      data.notes,
      now,
      now,
    )
    return freightService.get(id)!
  },

  update(id: string, input: unknown): FreightRate {
    requirePermission('data:write')
    const patch = parse(freightPatchInput, input)
    const current = freightService.require(id)
    const next = { ...current, ...patch }
    db.prepare(
      `UPDATE freight_rates SET pol = ?, pod = ?, pod_country = ?, container = ?, price = ?, currency = ?, unit = ?,
         carrier = ?, valid_from = ?, valid_until = ?, notes = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    ).run(
      next.pol,
      next.pod,
      next.podCountry,
      next.container,
      next.price,
      next.currency,
      next.unit,
      next.carrier,
      next.validFrom,
      next.validUntil,
      next.notes,
      Date.now(),
      id,
      orgId(),
    )
    return freightService.get(id)!
  },

  remove(id: string): void {
    requirePermission('data:write')
    const result = db.prepare('DELETE FROM freight_rates WHERE id = ? AND org_id = ?').run(id, orgId())
    if (Number(result.changes) === 0) throw notFound('运价')
  },

  /**
   * 选最便宜的一条：未过期、柜型匹配；给了 pol 时优先起运港匹配的条目，
   * 没有匹配起运港的条目时退而求其次（运价常按目的港维护）。
   */
  findBest(input: FindBestInput): FreightRate | null {
    const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : today()
    const rows = db
      .prepare(
        `SELECT * FROM freight_rates WHERE org_id = ? AND container = ? AND upper(replace(pod, ' ', '')) = ?
           AND price > 0 AND (valid_from = '' OR valid_from <= ?) AND (valid_until = '' OR valid_until >= ?)
         ORDER BY price ASC, updated_at DESC`,
      )
      .all(orgId(), input.container, portKey(input.pod), date, date) as unknown as FreightRow[]
    if (rows.length === 0) return null
    const pol = portKey(input.pol)
    if (pol) {
      const withPol = rows.filter((row) => !row.pol || portKey(row.pol) === pol)
      if (withPol.length > 0) return toRate(withPol[0]!)
    }
    return toRate(rows[0]!)
  },

  /** CSV 行导入（客户端解析成行后提交）：逐行校验，坏行记错误跳过 */
  import(input: unknown): { created: number; skipped: number; errors: Array<{ row: number; message: string }> } {
    requirePermission('data:write')
    const data = parse(freightImportInput, input)
    const result = { created: 0, skipped: 0, errors: [] as Array<{ row: number; message: string }> }
    transaction(() =>
      data.rows.forEach((raw, index) => {
        const row = index + 1
        const candidate: Record<string, unknown> = {}
        for (const key of ['pol', 'pod', 'podCountry', 'currency', 'carrier', 'validFrom', 'validUntil', 'notes'] as const) {
          const value = textCell(raw[key])
          if (value !== undefined) candidate[key] = value
        }
        const price = numeric(raw.price)
        if (price !== undefined) candidate.price = price
        const container = textCell(raw.container)
        if (container !== undefined) {
          const normalized = normalizeContainer(container)
          if (!normalized) {
            result.skipped += 1
            result.errors.push({ row, message: `container：柜型只能是 ${CONTAINERS.join(' / ')}` })
            return
          }
          candidate.container = normalized
        }
        const unit = textCell(raw.unit)
        if (unit !== undefined) candidate.unit = unit.replace(/[\s'’"]/g, '').toLowerCase()
        const parsed = freightCreateInput.safeParse(candidate)
        if (!parsed.success) {
          result.skipped += 1
          const issue = parsed.error.issues[0]
          result.errors.push({ row, message: `${issue?.path.join('.') || 'row'}：${issue?.message ?? '格式不正确'}` })
          return
        }
        freightService.insert(parsed.data)
        result.created += 1
      }),
    )
    return result
  },
}
