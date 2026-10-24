import { z } from 'zod'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError, notFound } from '../errors.js'
import { assertCanModify, requireDelete, seesAll, liveClause, type OwnedRow } from '../security/access.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'
import { teamService } from './auth-service.js'
import { trash } from './trash.js'
import { customerService } from './customer-service.js'
import { currencyCode } from './product-service.js'

/**
 * 商机（Deal）：同一客户可有多个商机；金额 + 币种、阶段、预计成交日、赢单 / 输单原因。
 * 可见性随客户（与报价一致，契约 5.6）；可写：商机负责人或 admin/owner。
 * 漏斗按金额加权：weighted = amount × probability%（probability 缺省取阶段默认值）。
 */
export const DEAL_STAGES = ['prospecting', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
export type DealStage = (typeof DEAL_STAGES)[number]
export const OPEN_DEAL_STAGES: DealStage[] = ['prospecting', 'qualified', 'proposal', 'negotiation']

/** 各阶段默认赢单概率（%） */
export const DEAL_STAGE_PROBABILITY: Record<DealStage, number> = {
  prospecting: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 75,
  won: 100,
  lost: 0,
}

export interface Deal {
  id: string
  title: string
  customerId: string
  customerName: string | null
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
  source: string
  ownerId: string
  ownerName: string
  overdue: boolean
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

interface DealRow {
  id: string
  title: string
  customer_id: string
  quote_id: string | null
  amount: number
  currency: string
  stage: string
  probability: number | null
  expected_close: string
  won_reason: string
  lost_reason: string
  notes: string
  source: string
  org_id: string
  owner_id: string
  created_at: number
  updated_at: number
  closed_at: number | null
  company?: string | null
}

const dateString = z
  .string()
  .trim()
  .refine((value) => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))), '日期格式应为 YYYY-MM-DD')

const shape = {
  title: z.string().trim().min(1, '商机名称不能为空').max(300),
  customerId: z.string().trim().min(1, '必须选择客户').max(80),
  quoteId: z.string().trim().max(80).nullable(),
  amount: z.number().finite().min(0, '金额不能为负数').max(1e12),
  currency: currencyCode,
  stage: z.enum(DEAL_STAGES),
  probability: z.number().int().min(0).max(100).nullable(),
  expectedClose: dateString,
  wonReason: z.string().trim().max(1000),
  lostReason: z.string().trim().max(1000),
  notes: z.string().max(10_000),
}

export const dealCreateInput = z
  .object({
    ...shape,
    quoteId: shape.quoteId.optional(),
    amount: shape.amount.default(0),
    currency: shape.currency.default('USD'),
    stage: shape.stage.default('prospecting'),
    probability: shape.probability.optional(),
    expectedClose: shape.expectedClose.default(''),
    wonReason: shape.wonReason.default(''),
    lostReason: shape.lostReason.default(''),
    notes: shape.notes.default(''),
    source: z.string().max(40).optional(),
  })
  .strict()

export const dealPatchInput = z
  .object({ ...shape, ownerId: z.string().trim().min(1).max(80) })
  .omit({ customerId: true })
  .partial()
  .strict()

export const dealListInput = z.object({
  stage: z.enum([...DEAL_STAGES, 'open', 'closed', 'all']).default('all'),
  customerId: z.string().max(80).optional(),
  mine: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toDeal(row: DealRow): Deal {
  const stage = row.stage as DealStage
  const overridden = row.probability !== null && row.probability !== undefined && !['won', 'lost'].includes(stage)
  const probability = overridden ? Number(row.probability) : DEAL_STAGE_PROBABILITY[stage] ?? 0
  const amount = Number(row.amount)
  return {
    id: row.id,
    title: row.title,
    customerId: row.customer_id,
    customerName: row.company ?? null,
    quoteId: row.quote_id,
    amount,
    currency: row.currency,
    stage,
    probability,
    probabilityOverridden: overridden,
    weightedAmount: round2((amount * probability) / 100),
    expectedClose: row.expected_close,
    wonReason: row.won_reason,
    lostReason: row.lost_reason,
    notes: row.notes,
    source: row.source,
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    overdue: OPEN_DEAL_STAGES.includes(stage) && row.expected_close !== '' && row.expected_close < today(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

function rowById(id: string): DealRow | undefined {
  return db
    .prepare('SELECT d.*, c.company AS company FROM deals d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.deleted_at IS NULL')
    .get(id) as unknown as DealRow | undefined
}

function visibleRow(id: string): DealRow {
  const row = rowById(id)
  const actor = currentActor()
  if (!row || row.org_id !== actor.orgId || !customerService.isVisible(row.customer_id)) throw notFound('商机')
  return row
}

function assertQuote(quoteId: string | null | undefined, customerId: string): void {
  if (!quoteId) return
  const quote = db.prepare('SELECT customer_id FROM quotes WHERE id = ? AND deleted_at IS NULL').get(quoteId) as unknown as { customer_id: string } | undefined
  if (!quote || !customerService.isVisible(quote.customer_id)) throw new AppError(400, 'QUOTE_NOT_FOUND', '报价单不存在')
  if (quote.customer_id !== customerId) throw new AppError(400, 'QUOTE_CUSTOMER_MISMATCH', '报价单不属于该客户')
}

function assertReasons(stage: DealStage, lostReason: string): void {
  if (stage === 'lost' && !lostReason.trim()) throw new AppError(400, 'LOST_REASON_REQUIRED', '标记输单时必须填写输单原因')
}

export const dealService = {
  list(input: unknown = {}): { items: Deal[]; total: number } {
    const query = parse(dealListInput, input)
    const actor = currentActor()
    const scope = liveClause('c')
    const where = [scope.sql, 'd.org_id = ?', 'd.deleted_at IS NULL']
    const params: Array<string | number> = [...scope.params, actor.orgId]
    if (query.stage === 'open') where.push(`d.stage IN (${OPEN_DEAL_STAGES.map(() => '?').join(',')})`), params.push(...OPEN_DEAL_STAGES)
    else if (query.stage === 'closed') where.push("d.stage IN ('won','lost')")
    else if (query.stage !== 'all') where.push('d.stage = ?'), params.push(query.stage)
    if (query.customerId) where.push('d.customer_id = ?'), params.push(query.customerId)
    const mine = query.mine === true || query.mine === '1' || query.mine === 'true'
    if (mine) where.push('d.owner_id = ?'), params.push(actor.id)
    const from = `FROM deals d JOIN customers c ON c.id = d.customer_id WHERE ${where.join(' AND ')}`
    const total = Number((db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as unknown as { n: number }).n)
    const rows = db
      .prepare(
        `SELECT d.*, c.company AS company ${from}
         ORDER BY CASE WHEN d.expected_close = '' THEN 1 ELSE 0 END, d.expected_close ASC, d.updated_at DESC LIMIT ?`,
      )
      .all(...params, query.limit) as unknown as DealRow[]
    return { items: rows.map(toDeal), total }
  },

  require(id: string): Deal {
    return toDeal(visibleRow(id))
  },

  create(input: unknown): Deal {
    const data = parse(dealCreateInput, input)
    const actor = currentActor()
    // 能看到客户就能给它建商机（与共享客户可建报价一致）；商机归创建者
    customerService.require(data.customerId)
    assertQuote(data.quoteId, data.customerId)
    assertReasons(data.stage, data.lostReason)
    const now = Date.now()
    const id = newId('deal')
    db.prepare(
      `INSERT INTO deals (id, title, customer_id, quote_id, amount, currency, stage, probability, expected_close, won_reason, lost_reason,
         notes, source, org_id, owner_id, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.title,
      data.customerId,
      data.quoteId ?? null,
      round2(data.amount),
      data.currency,
      data.stage,
      data.probability ?? null,
      data.expectedClose,
      data.wonReason,
      data.lostReason,
      data.notes,
      data.source ?? 'user',
      actor.orgId,
      actor.id,
      now,
      now,
      data.stage === 'won' || data.stage === 'lost' ? now : null,
    )
    return dealService.require(id)
  },

  update(id: string, input: unknown): Deal {
    const patch = parse(dealPatchInput, input)
    const row = visibleRow(id)
    assertCanModify(row as OwnedRow, '商机')
    const stage = (patch.stage ?? row.stage) as DealStage
    const lostReason = patch.lostReason ?? row.lost_reason
    assertReasons(stage, lostReason)
    if (patch.quoteId !== undefined) assertQuote(patch.quoteId, row.customer_id)
    let ownerId = row.owner_id
    if (patch.ownerId && patch.ownerId !== row.owner_id) {
      if (!seesAll()) throw new AppError(403, 'FORBIDDEN', '只有管理员可以转移商机负责人')
      if (!teamService.isOrgMember(patch.ownerId, row.org_id)) throw new AppError(404, 'NOT_FOUND', '负责人不存在或已停用')
      ownerId = patch.ownerId
    }
    const now = Date.now()
    const closed = stage === 'won' || stage === 'lost'
    db.prepare(
      `UPDATE deals SET title = ?, quote_id = ?, amount = ?, currency = ?, stage = ?, probability = ?, expected_close = ?, won_reason = ?,
         lost_reason = ?, notes = ?, owner_id = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
    ).run(
      patch.title ?? row.title,
      patch.quoteId !== undefined ? patch.quoteId : row.quote_id,
      patch.amount !== undefined ? round2(patch.amount) : row.amount,
      patch.currency ?? row.currency,
      stage,
      patch.probability !== undefined ? patch.probability : row.probability,
      patch.expectedClose ?? row.expected_close,
      patch.wonReason ?? row.won_reason,
      lostReason,
      patch.notes ?? row.notes,
      ownerId,
      now,
      closed ? (row.closed_at ?? now) : null,
      id,
    )
    if (patch.stage && patch.stage !== row.stage) {
      const reason = stage === 'won' ? (patch.wonReason ?? row.won_reason) : stage === 'lost' ? lostReason : ''
      customerService.recordActivity(
        row.customer_id,
        'note',
        `商机「${patch.title ?? row.title}」阶段由「${row.stage}」改为「${stage}」${reason ? `（原因：${reason}）` : ''}`,
      )
    }
    return dealService.require(id)
  },

  /** 删除 = 移入回收站，审计里存删除前的快照 */
  remove(id: string): void {
    requireDelete('deal:delete')
    const row = visibleRow(id)
    assertCanModify(row as OwnedRow, '商机')
    if (!trash.mark('deal', id)) throw notFound('商机')
    trash.audit('deal', id, `商机「${row.title}」移入回收站`, toDeal(row))
  },

  /** 订单生成时把关联商机标记为赢单（只处理未关闭的） */
  markWonByOrder(dealId: string, orderNumber: string): void {
    const row = rowById(dealId)
    if (!row || !OPEN_DEAL_STAGES.includes(row.stage as DealStage)) return
    const now = Date.now()
    db.prepare("UPDATE deals SET stage = 'won', won_reason = CASE WHEN won_reason = '' THEN ? ELSE won_reason END, closed_at = ?, updated_at = ? WHERE id = ?").run(
      `已生成订单 ${orderNumber}`,
      now,
      now,
      dealId,
    )
  },

  /** 漏斗统计（按当前用户可见范围）：各阶段数量 / 金额 / 加权金额，按币种分别汇总（不做汇率折算） */
  stats() {
    const scope = liveClause('c')
    const rows = db
      .prepare(
        `SELECT d.stage AS stage, d.currency AS currency, d.amount AS amount, d.probability AS probability, d.lost_reason AS lost_reason,
           d.expected_close AS expected_close
         FROM deals d JOIN customers c ON c.id = d.customer_id WHERE ${scope.sql} AND d.deleted_at IS NULL`,
      )
      .all(...scope.params) as unknown as Array<{ stage: string; currency: string; amount: number; probability: number | null; lost_reason: string; expected_close: string }>
    type Bucket = { count: number; amountByCurrency: Record<string, number>; weightedByCurrency: Record<string, number> }
    const empty = (): Bucket => ({ count: 0, amountByCurrency: {}, weightedByCurrency: {} })
    const add = (bucket: Bucket, currency: string, amount: number, weighted: number): void => {
      bucket.count += 1
      bucket.amountByCurrency[currency] = round2((bucket.amountByCurrency[currency] ?? 0) + amount)
      bucket.weightedByCurrency[currency] = round2((bucket.weightedByCurrency[currency] ?? 0) + weighted)
    }
    const byStage = Object.fromEntries(DEAL_STAGES.map((stage) => [stage, empty()])) as Record<DealStage, Bucket>
    const open = empty()
    const closingThisMonth = empty()
    const month = today().slice(0, 7)
    const lostReasons = new Map<string, number>()
    for (const row of rows) {
      const stage = (DEAL_STAGES as readonly string[]).includes(row.stage) ? (row.stage as DealStage) : 'prospecting'
      const probability = row.probability !== null && !['won', 'lost'].includes(stage) ? Number(row.probability) : DEAL_STAGE_PROBABILITY[stage]
      const amount = Number(row.amount)
      const weighted = (amount * probability) / 100
      add(byStage[stage], row.currency, amount, weighted)
      if (OPEN_DEAL_STAGES.includes(stage)) {
        add(open, row.currency, amount, weighted)
        if (row.expected_close.startsWith(month)) add(closingThisMonth, row.currency, amount, weighted)
      }
      if (stage === 'lost') {
        const reason = row.lost_reason.trim() || '未填写'
        lostReasons.set(reason, (lostReasons.get(reason) ?? 0) + 1)
      }
    }
    const won = byStage.won.count
    const lost = byStage.lost.count
    return {
      total: rows.length,
      byStage: DEAL_STAGES.map((stage) => ({ stage, probability: DEAL_STAGE_PROBABILITY[stage], ...byStage[stage] })),
      open,
      closingThisMonth,
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null,
      lostReasons: [...lostReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    }
  },
}
