import { z } from 'zod'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError, notFound } from '../errors.js'
import { assertCanModify, requireDelete, liveClause, type OwnedRow } from '../security/access.js'
import { newId } from '../utils/id.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { teamService } from './auth-service.js'
import { trash } from './trash.js'
import { customerService } from './customer-service.js'
import { dealService } from './deal-service.js'
import { currencyCode } from './product-service.js'
import { quoteService, type QuoteItem } from './quote-service.js'

/**
 * 最小订单 + 出运 + 收款闭环（契约 §10.8）。
 * - 报价 → 订单（一个报价最多一个订单；报价自动标记 accepted；关联的未关闭商机自动赢单）；
 * - 订单状态：pending_production 待生产 → in_production 生产中 → shipped 已出运 → completed 已完成（另有 cancelled）；
 * - 出运信息：柜型、柜号、提单号、船名航次、起运港 / 目的港、ETD / ETA；
 * - 收款：多笔登记（币种必须与订单一致），应收余额 = 订单金额 − 已收；dueDate 过了仍有余额 → 逾期应收。
 * 可见性随客户；可写：订单负责人或 admin/owner。
 */
export const ORDER_STATUSES = ['pending_production', 'in_production', 'shipped', 'completed', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const CONTAINER_TYPES = ['', 'LCL', "20'GP", "40'GP", "40'HQ", "45'HQ", "20'RF", "40'RF", 'AIR', 'EXPRESS', 'OTHER'] as const

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

export interface Order {
  id: string
  number: string
  customerId: string
  customerName: string | null
  quoteId: string | null
  quoteNumber: string | null
  dealId: string | null
  currency: string
  amount: number
  items: QuoteItem[]
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

interface OrderRow {
  id: string
  number: string
  customer_id: string
  quote_id: string | null
  deal_id: string | null
  currency: string
  amount: number
  items: string
  incoterm: string
  payment_terms: string
  deposit_amount: number
  due_date: string
  status: string
  notes: string
  container_type: string
  container_no: string
  bl_no: string
  vessel: string
  port_of_loading: string
  port_of_discharge: string
  etd: string
  eta: string
  org_id: string
  owner_id: string
  created_at: number
  updated_at: number
  shipped_at: number | null
  completed_at: number | null
  company?: string | null
  quote_number?: string | null
  paid?: number | null
}

interface PaymentRow {
  id: string
  order_id: string
  amount: number
  currency: string
  received_at: string
  method: string
  reference: string
  notes: string
  created_by: string
  source: string
  created_at: number
}

const dateString = z
  .string()
  .trim()
  .refine((value) => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))), '日期格式应为 YYYY-MM-DD')

const shipmentShape = {
  containerType: z.string().trim().max(30),
  containerNo: z.string().trim().max(200),
  blNo: z.string().trim().max(100),
  vessel: z.string().trim().max(200),
  portOfLoading: z.string().trim().max(200),
  portOfDischarge: z.string().trim().max(200),
  etd: dateString,
  eta: dateString,
}

export const orderFromQuoteInput = z
  .object({
    number: z.string().trim().min(1).max(64).optional(),
    depositAmount: z.number().finite().min(0).max(1e12).optional(),
    dueDate: dateString.optional(),
    dealId: z.string().trim().max(80).nullable().optional(),
    notes: z.string().max(10_000).optional(),
  })
  .strict()

export const orderPatchInput = z
  .object({
    status: z.enum(ORDER_STATUSES),
    depositAmount: z.number().finite().min(0).max(1e12),
    dueDate: dateString,
    paymentTerms: z.string().trim().max(1000),
    notes: z.string().max(10_000),
    ...shipmentShape,
  })
  .partial()
  .strict()

export const paymentInput = z
  .object({
    amount: z.number().finite().positive('收款金额必须大于 0').max(1e12),
    currency: currencyCode.optional(),
    receivedAt: dateString.refine((v) => v !== '', '请填写到账日期').optional(),
    method: z.string().trim().max(100).default(''),
    reference: z.string().trim().max(200).default(''),
    notes: z.string().max(2000).default(''),
    source: z.string().max(40).optional(),
  })
  .strict()

export const orderListInput = z.object({
  status: z.enum([...ORDER_STATUSES, 'open', 'all']).default('all'),
  customerId: z.string().max(80).optional(),
  /** open：有未收余额；overdue：逾期未收 */
  receivable: z.enum(['open', 'overdue']).optional(),
  mine: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function todayString(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    amount: Number(row.amount),
    currency: row.currency,
    receivedAt: row.received_at,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

function toOrder(row: OrderRow, now = Date.now()): Order {
  let items: QuoteItem[] = []
  try {
    const parsed = JSON.parse(row.items) as unknown
    items = Array.isArray(parsed) ? (parsed as QuoteItem[]) : []
  } catch {
    items = []
  }
  const amount = Number(row.amount)
  const paid = round2(Number(row.paid ?? 0))
  const balance = row.status === 'cancelled' ? 0 : round2(Math.max(0, amount - paid))
  const today = todayString(now)
  const overdue = balance > 0 && row.due_date !== '' && row.due_date < today
  return {
    id: row.id,
    number: row.number,
    customerId: row.customer_id,
    customerName: row.company ?? null,
    quoteId: row.quote_id,
    quoteNumber: row.quote_number ?? null,
    dealId: row.deal_id,
    currency: row.currency,
    amount,
    items,
    incoterm: row.incoterm,
    paymentTerms: row.payment_terms,
    depositAmount: Number(row.deposit_amount),
    dueDate: row.due_date,
    status: row.status as OrderStatus,
    notes: row.notes,
    shipment: {
      containerType: row.container_type,
      containerNo: row.container_no,
      blNo: row.bl_no,
      vessel: row.vessel,
      portOfLoading: row.port_of_loading,
      portOfDischarge: row.port_of_discharge,
      etd: row.etd,
      eta: row.eta,
    },
    paid,
    balance,
    paymentStatus: paid <= 0 ? 'unpaid' : paid + 0.005 >= amount ? 'paid' : 'partial',
    overdue,
    overdueDays: overdue ? Math.floor((Date.parse(today) - Date.parse(row.due_date)) / 86_400_000) : 0,
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shippedAt: row.shipped_at,
    completedAt: row.completed_at,
  }
}

const SELECT = `SELECT o.*, c.company AS company, q.number AS quote_number,
  (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id) AS paid
  FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN quotes q ON q.id = o.quote_id`

function rowById(id: string): OrderRow | undefined {
  return db.prepare(`${SELECT} WHERE o.id = ? AND o.deleted_at IS NULL`).get(id) as unknown as OrderRow | undefined
}

function visibleRow(id: string): OrderRow {
  const row = rowById(id)
  if (!row || row.org_id !== currentActor().orgId || !customerService.isVisible(row.customer_id)) throw notFound('订单')
  return row
}

function nextNumber(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const prefix = `SO-${stamp}-`
  const row = db.prepare('SELECT number FROM orders WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(`${prefix}%`) as unknown as
    | { number: string }
    | undefined
  const last = row ? Number.parseInt(row.number.slice(prefix.length), 10) : 0
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(3, '0')}`
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_production: '待生产',
  in_production: '生产中',
  shipped: '已出运',
  completed: '已完成',
  cancelled: '已取消',
}

export const orderService = {
  list(input: unknown = {}): { items: Order[]; total: number } {
    const query = parse(orderListInput, input)
    const actor = currentActor()
    const scope = liveClause('c')
    const where = [scope.sql, 'o.org_id = ?', 'o.deleted_at IS NULL']
    const params: Array<string | number> = [...scope.params, actor.orgId]
    if (query.status === 'open') where.push("o.status NOT IN ('completed','cancelled')")
    else if (query.status !== 'all') where.push('o.status = ?'), params.push(query.status)
    if (query.customerId) where.push('o.customer_id = ?'), params.push(query.customerId)
    const mine = query.mine === true || query.mine === '1' || query.mine === 'true'
    if (mine) where.push('o.owner_id = ?'), params.push(actor.id)
    if (query.receivable) {
      where.push("o.status <> 'cancelled' AND o.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.order_id = o.id) > 0.004")
      if (query.receivable === 'overdue') where.push("o.due_date <> '' AND o.due_date < ?"), params.push(todayString())
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id ${clause}`).get(...params) as unknown as { n: number }).n,
    )
    const order = query.receivable ? "CASE WHEN o.due_date = '' THEN 1 ELSE 0 END, o.due_date ASC" : 'o.created_at DESC'
    const rows = db.prepare(`${SELECT} ${clause} ORDER BY ${order}, o.rowid DESC LIMIT ?`).all(...params, query.limit) as unknown as OrderRow[]
    const now = Date.now()
    return { items: rows.map((row) => toOrder(row, now)), total }
  },

  require(id: string, withPayments = true): Order {
    const order = toOrder(visibleRow(id))
    if (withPayments) order.payments = orderService.payments(id)
    return order
  },

  payments(orderId: string): Payment[] {
    return (db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY received_at ASC, created_at ASC').all(orderId) as unknown as PaymentRow[]).map(toPayment)
  },

  /** 报价 → 订单。报价必须可见且可写；被拒绝的报价不能转订单；一个报价只能有一个订单 */
  fromQuote(quoteId: string, input: unknown = {}): Order {
    const data = parse(orderFromQuoteInput, input)
    const quote = quoteService.get(quoteId)
    if (!quote || !customerService.isVisible(quote.customerId)) throw notFound('报价单')
    const quoteRow = db.prepare('SELECT org_id, owner_id FROM quotes WHERE id = ?').get(quoteId) as unknown as OwnedRow
    assertCanModify(quoteRow, '报价单')
    const trashed = db.prepare('SELECT number FROM orders WHERE quote_id = ? AND deleted_at IS NOT NULL').get(quoteId) as unknown as
      | { number: string }
      | undefined
    if (trashed) {
      throw new AppError(409, 'ORDER_IN_TRASH', `该报价单的订单 ${trashed.number} 在回收站里，请先恢复或彻底删除它`)
    }
    if (quote.status === 'rejected') throw new AppError(409, 'QUOTE_REJECTED', '已拒绝的报价不能转为订单')
    if (quote.items.length === 0 || quote.subtotal <= 0) throw new AppError(400, 'QUOTE_EMPTY', '报价没有明细或金额为 0，不能转为订单')
    const existing = db.prepare('SELECT id, number FROM orders WHERE quote_id = ?').get(quoteId) as unknown as { id: string; number: string } | undefined
    if (existing) throw new AppError(409, 'ORDER_EXISTS', `该报价已生成订单 ${existing.number}`)
    let dealId = data.dealId ?? null
    if (dealId) {
      const deal = dealService.require(dealId)
      if (deal.customerId !== quote.customerId) throw new AppError(400, 'DEAL_CUSTOMER_MISMATCH', '商机不属于该客户')
    } else {
      const linked = db.prepare("SELECT id FROM deals WHERE quote_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1").get(quoteId) as unknown as { id: string } | undefined
      dealId = linked?.id ?? null
    }
    const number = data.number ?? nextNumber()
    const taken = db.prepare('SELECT deleted_at FROM orders WHERE number = ?').get(number) as unknown as { deleted_at: number | null } | undefined
    if (taken) {
      throw new AppError(
        409,
        'ORDER_NUMBER_TAKEN',
        taken.deleted_at ? `订单号 ${number} 被回收站里的订单占用，彻底删除后才能复用` : `订单号 ${number} 已存在`,
      )
    }
    const actor = currentActor()
    const id = newId('ord')
    const now = Date.now()
    transaction(() => {
      db.prepare(
        `INSERT INTO orders (id, number, customer_id, quote_id, deal_id, currency, amount, items, incoterm, payment_terms, deposit_amount, due_date,
           status, notes, port_of_loading, org_id, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_production', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        number,
        quote.customerId,
        quoteId,
        dealId,
        quote.currency,
        quote.subtotal,
        JSON.stringify(quote.items),
        quote.incoterm,
        quote.paymentTerms,
        round2(data.depositAmount ?? 0),
        data.dueDate ?? '',
        data.notes ?? '',
        quote.port,
        actor.orgId,
        actor.id,
        now,
        now,
      )
      if (quote.status !== 'accepted') db.prepare("UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?").run(now, quoteId)
      if (dealId) dealService.markWonByOrder(dealId, number)
      customerService.recordActivity(quote.customerId, 'note', `报价 ${quote.number} 已转为订单 ${number}（${quote.currency} ${quote.subtotal}）`)
    })
    return orderService.require(id)
  },

  update(id: string, input: unknown): Order {
    const patch = parse(orderPatchInput, input)
    const row = visibleRow(id)
    assertCanModify(row as OwnedRow, '订单')
    if (patch.containerType !== undefined && !(CONTAINER_TYPES as readonly string[]).includes(patch.containerType)) {
      throw new AppError(400, 'VALIDATION_ERROR', `柜型只能是：${CONTAINER_TYPES.filter(Boolean).join(' / ')}`)
    }
    const status = (patch.status ?? row.status) as OrderStatus
    const now = Date.now()
    const shippedAt = status === 'shipped' || status === 'completed' ? (row.shipped_at ?? now) : row.shipped_at
    const completedAt = status === 'completed' ? (row.completed_at ?? now) : null
    db.prepare(
      `UPDATE orders SET status = ?, deposit_amount = ?, due_date = ?, payment_terms = ?, notes = ?, container_type = ?, container_no = ?,
         bl_no = ?, vessel = ?, port_of_loading = ?, port_of_discharge = ?, etd = ?, eta = ?, shipped_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status,
      patch.depositAmount !== undefined ? round2(patch.depositAmount) : row.deposit_amount,
      patch.dueDate ?? row.due_date,
      patch.paymentTerms ?? row.payment_terms,
      patch.notes ?? row.notes,
      patch.containerType ?? row.container_type,
      patch.containerNo ?? row.container_no,
      patch.blNo ?? row.bl_no,
      patch.vessel ?? row.vessel,
      patch.portOfLoading ?? row.port_of_loading,
      patch.portOfDischarge ?? row.port_of_discharge,
      patch.etd ?? row.etd,
      patch.eta ?? row.eta,
      shippedAt,
      completedAt,
      now,
      id,
    )
    if (patch.status && patch.status !== row.status) {
      const extra = status === 'shipped' && (patch.blNo ?? row.bl_no) ? `，提单号 ${patch.blNo ?? row.bl_no}` : ''
      customerService.recordActivity(row.customer_id, 'note', `订单 ${row.number} 状态：${STATUS_LABEL[status]}${extra}`)
    }
    return orderService.require(id)
  },

  /** 删除 = 移入回收站（收款记录随订单保留），审计里存删除前的快照（含收款） */
  remove(id: string): void {
    requireDelete('order:delete')
    const row = visibleRow(id)
    assertCanModify(row as OwnedRow, '订单')
    const snapshot = { ...toOrder(row), payments: orderService.payments(id) }
    if (!trash.mark('order', id)) throw notFound('订单')
    trash.audit('order', id, `订单 ${row.number} 移入回收站`, snapshot)
  },

  /** 登记收款：币种必须与订单一致；不允许超过应收余额（避免重复登记） */
  recordPayment(orderId: string, input: unknown): { payment: Payment; order: Order } {
    const data = parse(paymentInput, input)
    const row = visibleRow(orderId)
    assertCanModify(row as OwnedRow, '订单')
    if (row.status === 'cancelled') throw new AppError(409, 'ORDER_CANCELLED', '已取消的订单不能登记收款')
    const currency = data.currency ?? row.currency
    if (currency !== row.currency) throw new AppError(400, 'CURRENCY_MISMATCH', `收款币种必须与订单一致（${row.currency}）`)
    const balance = round2(Number(row.amount) - Number(row.paid ?? 0))
    if (data.amount > balance + 0.004) throw new AppError(400, 'PAYMENT_EXCEEDS_BALANCE', `收款金额超过应收余额 ${row.currency} ${balance}`)
    const id = newId('pay')
    const now = Date.now()
    db.prepare(
      `INSERT INTO payments (id, order_id, amount, currency, received_at, method, reference, notes, created_by, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orderId, round2(data.amount), currency, data.receivedAt ?? todayString(now), data.method, data.reference, data.notes, currentActor().id, data.source ?? 'user', now)
    db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now, orderId)
    customerService.recordActivity(row.customer_id, 'note', `订单 ${row.number} 收款 ${currency} ${round2(data.amount)}${data.reference ? `（${data.reference}）` : ''}`)
    const payment = toPayment(db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as unknown as PaymentRow)
    return { payment, order: orderService.require(orderId) }
  },

  removePayment(orderId: string, paymentId: string): void {
    requireDelete('order:delete')
    const row = visibleRow(orderId)
    assertCanModify(row as OwnedRow, '订单')
    const result = db.prepare('DELETE FROM payments WHERE id = ? AND order_id = ?').run(paymentId, orderId)
    if (Number(result.changes) === 0) throw notFound('收款记录')
  },

  /** 应收汇总（按币种）：未收余额、逾期余额、逾期订单数 */
  receivableSummary() {
    const items = orderService.list({ receivable: 'open', limit: 500 }).items
    const outstandingByCurrency: Record<string, number> = {}
    const overdueByCurrency: Record<string, number> = {}
    let overdueCount = 0
    for (const order of items) {
      outstandingByCurrency[order.currency] = round2((outstandingByCurrency[order.currency] ?? 0) + order.balance)
      if (order.overdue) {
        overdueCount += 1
        overdueByCurrency[order.currency] = round2((overdueByCurrency[order.currency] ?? 0) + order.balance)
      }
    }
    return { openCount: items.length, outstandingByCurrency, overdueCount, overdueByCurrency }
  },
}
