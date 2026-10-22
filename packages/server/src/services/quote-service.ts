import { z } from 'zod'
import { db } from '../db.js'
import { AppError, notFound } from '../errors.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'
import { currentActor } from '../context.js'
import { assertCanModify, requireDelete, liveClause } from '../security/access.js'
import { teamService } from './auth-service.js'
import { trash } from './trash.js'
import { customerService } from './customer-service.js'
import { currencyCode } from './product-service.js'
import { INCOTERMS, quoteTemplateService, type Incoterm, type QuoteTemplate } from './quote-template-service.js'

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected'] as const

export interface QuoteItem {
  productId: string | null
  name: string
  spec: string
  qty: number
  unit: string
  unitPrice: number
}

export interface Quote {
  id: string
  number: string
  customerId: string
  currency: string
  incoterm: Incoterm
  port: string
  validUntil: string
  paymentTerms: string
  leadTime: string
  items: QuoteItem[]
  notes: string
  status: (typeof QUOTE_STATUSES)[number]
  subtotal: number
  ownerId: string
  ownerName: string
  createdAt: number
  updatedAt: number
}

const itemInput = z.object({
  productId: z.string().max(64).nullable().default(null),
  name: z.string().trim().min(1, '品名不能为空').max(300),
  spec: z.string().max(2000).default(''),
  qty: z.number().finite().positive('数量必须大于 0').max(1e9),
  unit: z.string().trim().max(30).default('pcs'),
  unitPrice: z.number().finite().min(0, '单价不能为负数').max(1e12),
})

const dateString = z
  .string()
  .trim()
  .refine((value) => value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))), '日期格式应为 YYYY-MM-DD')

const shape = {
  number: z.string().trim().min(1).max(64),
  customerId: z.string().min(1, '必须选择客户').max(64),
  currency: currencyCode,
  incoterm: z.enum(INCOTERMS),
  port: z.string().trim().max(200),
  validUntil: dateString,
  paymentTerms: z.string().trim().max(1000),
  leadTime: z.string().trim().max(200),
  items: z.array(itemInput).max(500),
  notes: z.string().max(10_000),
  status: z.enum(QUOTE_STATUSES),
}

export const quoteCreateInput = z.object({
  ...shape,
  number: shape.number.optional(),
  currency: shape.currency.optional(),
  incoterm: shape.incoterm.optional(),
  port: shape.port.default(''),
  validUntil: shape.validUntil.default(''),
  paymentTerms: shape.paymentTerms.optional(),
  leadTime: shape.leadTime.default(''),
  items: shape.items.default([]),
  notes: shape.notes.default(''),
  status: shape.status.default('draft'),
})

export const quotePatchInput = z.object(shape).partial().strict()

interface QuoteRow {
  id: string
  number: string
  customer_id: string
  currency: string
  incoterm: string
  port: string
  valid_until: string
  payment_terms: string
  lead_time: string
  items: string
  notes: string
  status: string
  subtotal: number
  org_id: string
  owner_id: string
  created_at: number
  updated_at: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function subtotalOf(items: QuoteItem[]): number {
  return round2(items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0))
}

function toQuote(row: QuoteRow): Quote {
  let items: QuoteItem[] = []
  try {
    const parsed = JSON.parse(row.items) as unknown
    items = Array.isArray(parsed) ? (parsed as QuoteItem[]) : []
  } catch {
    items = []
  }
  return {
    id: row.id,
    number: row.number,
    customerId: row.customer_id,
    currency: row.currency,
    incoterm: row.incoterm as Incoterm,
    port: row.port,
    validUntil: row.valid_until,
    paymentTerms: row.payment_terms,
    leadTime: row.lead_time,
    items,
    notes: row.notes,
    status: row.status as Quote['status'],
    subtotal: Number(row.subtotal),
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function nextNumber(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const prefix = `Q-${stamp}-`
  const row = db
    .prepare('SELECT number FROM quotes WHERE number LIKE ? ORDER BY number DESC LIMIT 1')
    .get(`${prefix}%`) as unknown as { number: string } | undefined
  const last = row ? Number.parseInt(row.number.slice(prefix.length), 10) : 0
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(3, '0')}`
}

/** 单号全局唯一（数据库约束）：回收站里的报价单仍占用单号，彻底删除后才释放 */
function assertNumberFree(number: string, exceptId?: string): void {
  const row = db.prepare('SELECT id, deleted_at FROM quotes WHERE number = ?').get(number) as unknown as
    | { id: string; deleted_at: number | null }
    | undefined
  if (row && row.id !== exceptId) {
    throw new AppError(
      409,
      'QUOTE_NUMBER_TAKEN',
      row.deleted_at ? `报价单号 ${number} 被回收站里的报价单占用，彻底删除后才能复用` : `报价单号 ${number} 已存在`,
    )
  }
}

export const quoteService = {
  /** 报价随客户可见（契约 5.6） */
  list(filter: { customerId?: string } = {}): Quote[] {
    const scope = liveClause('c')
    const where = [scope.sql, 'q.deleted_at IS NULL']
    const params: string[] = [...scope.params]
    if (filter.customerId) {
      where.push('q.customer_id = ?')
      params.push(filter.customerId)
    }
    const rows = db
      .prepare(
        `SELECT q.* FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE ${where.join(' AND ')}
         ORDER BY q.created_at DESC, q.rowid DESC`,
      )
      .all(...params)
    return (rows as unknown as QuoteRow[]).map(toQuote)
  },

  get(id: string): Quote | undefined {
    const row = db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as QuoteRow | undefined
    return row ? toQuote(row) : undefined
  },

  require(id: string): Quote {
    const quote = quoteService.get(id)
    if (!quote || !customerService.isVisible(quote.customerId)) throw notFound('报价单')
    return quote
  },

  requireWritable(id: string): Quote {
    const quote = quoteService.require(id)
    const row = db.prepare('SELECT org_id, owner_id FROM quotes WHERE id = ?').get(id) as unknown as { org_id: string; owner_id: string }
    assertCanModify(row, '报价单')
    return quote
  },

  create(input: unknown): Quote {
    const data = parse(quoteCreateInput, input)
    const customer = customerService.get(data.customerId)
    if (!customer || !customerService.isVisible(customer.id)) throw new AppError(400, 'CUSTOMER_NOT_FOUND', '客户不存在')
    const actor = currentActor()
    const template = quoteTemplateService.getDefault()
    const number = data.number ?? nextNumber()
    assertNumberFree(number)
    const now = Date.now()
    const id = newId('quo')
    const items = data.items as QuoteItem[]
    const quote: Quote = {
      id,
      number,
      customerId: customer.id,
      currency: data.currency ?? template?.defaultCurrency ?? 'USD',
      incoterm: data.incoterm ?? template?.defaultIncoterm ?? 'FOB',
      port: data.port,
      validUntil: data.validUntil,
      paymentTerms: data.paymentTerms ?? template?.defaultPaymentTerms ?? '',
      leadTime: data.leadTime,
      items,
      notes: data.notes,
      status: data.status,
      subtotal: subtotalOf(items),
      ownerId: actor.id,
      ownerName: actor.name,
      createdAt: now,
      updatedAt: now,
    }
    db.prepare(
      `INSERT INTO quotes (id, number, customer_id, currency, incoterm, port, valid_until, payment_terms, lead_time, items, notes, status, subtotal, created_at, updated_at, org_id, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      quote.id,
      quote.number,
      quote.customerId,
      quote.currency,
      quote.incoterm,
      quote.port,
      quote.validUntil,
      quote.paymentTerms,
      quote.leadTime,
      JSON.stringify(quote.items),
      quote.notes,
      quote.status,
      quote.subtotal,
      quote.createdAt,
      quote.updatedAt,
      actor.orgId,
      actor.id,
    )
    customerService.recordActivity(
      customer.id,
      'quote',
      `创建报价单 ${quote.number}（${quote.currency} ${quote.subtotal.toFixed(2)}，${quote.incoterm}）`,
    )
    customerService.setStageIfEarlier(customer.id, 'quoted')
    return quote
  },

  update(id: string, input: unknown): Quote {
    const patch = parse(quotePatchInput, input)
    const current = quoteService.requireWritable(id)
    if (patch.customerId && !customerService.isVisible(patch.customerId)) {
      throw new AppError(400, 'CUSTOMER_NOT_FOUND', '客户不存在')
    }
    if (patch.number) assertNumberFree(patch.number, id)
    const items = (patch.items as QuoteItem[] | undefined) ?? current.items
    const next: Quote = { ...current, ...patch, items, subtotal: subtotalOf(items), updatedAt: Date.now() }
    db.prepare(
      `UPDATE quotes SET number = ?, customer_id = ?, currency = ?, incoterm = ?, port = ?, valid_until = ?, payment_terms = ?,
         lead_time = ?, items = ?, notes = ?, status = ?, subtotal = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.number,
      next.customerId,
      next.currency,
      next.incoterm,
      next.port,
      next.validUntil,
      next.paymentTerms,
      next.leadTime,
      JSON.stringify(next.items),
      next.notes,
      next.status,
      next.subtotal,
      next.updatedAt,
      id,
    )
    if (patch.status && patch.status !== current.status) {
      const labels = { draft: '草稿', sent: '已发送', accepted: '已接受', rejected: '已拒绝' }
      customerService.recordActivity(next.customerId, 'quote', `报价单 ${next.number} 状态改为「${labels[patch.status]}」`)
      if (patch.status === 'accepted') customerService.setStageIfEarlier(next.customerId, 'won')
    }
    return quoteService.get(id)!
  },

  /** 删除 = 移入回收站（单号仍被占用），审计里存删除前的快照 */
  remove(id: string): void {
    requireDelete('quote:delete')
    const quote = quoteService.requireWritable(id)
    if (!trash.mark('quote', id)) throw notFound('报价单')
    trash.audit('quote', id, `报价单 ${quote.number} 移入回收站`, quote)
  },
}

// ── 可打印 HTML ─────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )
}

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function renderQuoteHtml(quote: Quote, template: QuoteTemplate | undefined): string {
  const customer = customerService.get(quote.customerId)
  const primary = customer?.contacts.find((contact) => contact.isPrimary) ?? customer?.contacts[0]
  const company = template?.company ?? { name: '', address: '', phone: '', email: '', logoDataUrl: '' }
  const logo = company.logoDataUrl ? `<img class="logo" src="${escapeHtml(company.logoDataUrl)}" alt="">` : ''
  const rows = quote.items
    .map(
      (item, index) => `<tr>
        <td>${index + 1}</td>
        <td><strong>${escapeHtml(item.name)}</strong>${item.spec ? `<div class="spec">${escapeHtml(item.spec)}</div>` : ''}</td>
        <td class="num">${escapeHtml(item.qty)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td class="num">${money(item.unitPrice)}</td>
        <td class="num">${money(item.qty * item.unitPrice)}</td>
      </tr>`,
    )
    .join('')

  const created = new Date(quote.createdAt).toISOString().slice(0, 10)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Quotation ${escapeHtml(quote.number)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif; color: #1f1f22; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f1f22; padding-bottom: 12px; }
  .logo { max-height: 56px; max-width: 200px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 2px; }
  .meta, .parties { display: flex; gap: 24px; margin: 16px 0; }
  .meta div, .parties div { flex: 1; }
  .label { color: #6b6b73; font-size: 11px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border-bottom: 1px solid #e4e4e7; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f5; font-size: 11px; text-transform: uppercase; }
  .num { text-align: right; white-space: nowrap; }
  .spec { color: #6b6b73; white-space: pre-wrap; }
  .total td { font-weight: 700; border-bottom: 2px solid #1f1f22; }
  .terms { margin-top: 16px; }
  .terms td { border: none; padding: 2px 8px 2px 0; }
  footer { margin-top: 24px; color: #6b6b73; white-space: pre-wrap; border-top: 1px solid #e4e4e7; padding-top: 8px; }
</style>
</head>
<body>
<header>
  <div>${logo}<div><strong>${escapeHtml(company.name)}</strong></div>
    <div>${escapeHtml(company.address)}</div>
    <div>${escapeHtml(company.phone)} ${escapeHtml(company.email)}</div></div>
  <div style="text-align:right"><h1>QUOTATION</h1><div>No. ${escapeHtml(quote.number)}</div><div>Date: ${created}</div></div>
</header>
<section class="parties">
  <div><div class="label">To</div><strong>${escapeHtml(customer?.company ?? '')}</strong>
    <div>${escapeHtml(customer?.country ?? '')}</div>
    ${primary ? `<div>${escapeHtml(primary.name)} ${escapeHtml(primary.email)}</div>` : ''}</div>
  <div><div class="label">Trade terms</div>${escapeHtml(quote.incoterm)}${quote.port ? ` ${escapeHtml(quote.port)}` : ''}
    <div class="label" style="margin-top:6px">Currency</div>${escapeHtml(quote.currency)}</div>
</section>
<table>
  <thead><tr><th>#</th><th>Description</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit price (${escapeHtml(quote.currency)})</th><th class="num">Amount (${escapeHtml(quote.currency)})</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr class="total"><td colspan="5" class="num">Total ${escapeHtml(quote.incoterm)}</td><td class="num">${escapeHtml(quote.currency)} ${money(quote.subtotal)}</td></tr></tfoot>
</table>
<table class="terms">
  ${quote.paymentTerms ? `<tr><td class="label">Payment</td><td>${escapeHtml(quote.paymentTerms)}</td></tr>` : ''}
  ${quote.leadTime ? `<tr><td class="label">Lead time</td><td>${escapeHtml(quote.leadTime)}</td></tr>` : ''}
  ${quote.validUntil ? `<tr><td class="label">Valid until</td><td>${escapeHtml(quote.validUntil)}</td></tr>` : ''}
  ${quote.notes ? `<tr><td class="label">Notes</td><td style="white-space:pre-wrap">${escapeHtml(quote.notes)}</td></tr>` : ''}
</table>
${template?.footer ? `<footer>${escapeHtml(template.footer)}</footer>` : ''}
</body>
</html>`
}
