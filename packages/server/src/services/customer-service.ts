import { z } from 'zod'
import { db } from '../db.js'
import { AppError, notFound } from '../errors.js'
import { newId } from '../utils/id.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { currentActor } from '../context.js'
import {
  assertCanModify,
  canModify,
  canSee,
  ownershipForNew,
  requireDelete,
  requirePermission,
  seesAll,
  VISIBILITIES,
  liveClause,
  type Visibility,
} from '../security/access.js'
import { auditService } from './audit-service.js'
import { trash } from './trash.js'
import { teamService } from './auth-service.js'
import { rescheduleSchedules, scheduleRow } from './schedule/schedule-service.js'
import { companyEmailDomain, companyNorm, phoneKey } from '../utils/customer-keys.js'

export const CUSTOMER_STAGES = ['lead', 'contacted', 'quoted', 'negotiating', 'won', 'lost'] as const
export type CustomerStage = (typeof CUSTOMER_STAGES)[number]
export const ACTIVITY_TYPES = ['note', 'email', 'call', 'quote'] as const

export interface Contact {
  id: string
  name: string
  title: string
  email: string
  phone: string
  whatsapp: string
  isPrimary: boolean
}

export interface Customer {
  id: string
  company: string
  country: string
  website: string
  stage: CustomerStage
  tags: string[]
  source: string
  notes: string
  contacts: Contact[]
  ownerId: string
  ownerName: string
  visibility: Visibility
  teamId: string | null
  createdAt: number
  updatedAt: number
}

export interface Activity {
  id: string
  customerId: string
  type: (typeof ACTIVITY_TYPES)[number]
  content: string
  actorId: string | null
  actorName: string | null
  createdAt: number
}

// ── 校验 ─────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max)

export const contactInput = z.object({
  id: z.string().max(64).optional(),
  name: text(200).default(''),
  title: text(200).default(''),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('邮箱格式不正确').max(320)]).default(''),
  phone: text(64).default(''),
  whatsapp: text(64).default(''),
  isPrimary: z.boolean().default(false),
})

const tagsInput = z.array(text(50).min(1)).max(50)

export const customerCreateInput = z.object({
  company: text(300).min(1, '公司名不能为空'),
  country: text(100).default(''),
  website: text(500).default(''),
  stage: z.enum(CUSTOMER_STAGES).default('lead'),
  tags: tagsInput.default([]),
  source: text(200).default(''),
  notes: z.string().max(20_000).default(''),
  contacts: z.array(contactInput).max(100).default([]),
  visibility: z.enum(VISIBILITIES).optional(),
  teamId: z.string().max(80).nullable().optional(),
  /** 查重命中后用户确认“仍然创建” */
  force: z.boolean().optional(),
})

export const customerPatchInput = z
  .object({
    company: text(300).min(1, '公司名不能为空'),
    country: text(100),
    website: text(500),
    stage: z.enum(CUSTOMER_STAGES),
    tags: tagsInput,
    source: text(200),
    notes: z.string().max(20_000),
    contacts: z.array(contactInput).max(100),
    visibility: z.enum(VISIBILITIES),
    teamId: z.string().max(80).nullable(),
  })
  .partial()
  .strict()

export const listQueryInput = z.object({
  query: z.string().max(200).optional(),
  stage: z.enum(CUSTOMER_STAGES).optional(),
  tag: z.string().max(50).optional(),
  country: z.string().max(100).optional(),
  ownerId: z.string().max(80).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
})

export const activityInput = z.object({
  type: z.enum(ACTIVITY_TYPES),
  content: z.string().trim().min(1, '内容不能为空').max(20_000),
})

export const IMPORT_FIELDS = [
  'company',
  'country',
  'website',
  'stage',
  'tags',
  'source',
  'notes',
  'contactName',
  'contactTitle',
  'contactEmail',
  'contactPhone',
  'contactWhatsapp',
] as const

export const importInput = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(10_000),
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().max(200)),
  dedupeBy: z.enum(['email', 'company', 'website']),
  onDuplicate: z.enum(['skip', 'merge']),
})

// ── 规范化 ───────────────────────────────────────────

export function companyKey(company: string): string {
  return company.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function websiteKey(website: string): string {
  const value = website.trim().toLowerCase()
  if (!value) return ''
  try {
    const url = new URL(/^[a-z]+:\/\//.test(value) ? value : `http://${value}`)
    return url.hostname.replace(/^www\./, '')
  } catch {
    return value.replace(/^www\./, '').replace(/\/.*$/, '')
  }
}

function uniqueTags(tags: string[]): string[] {
  const result: string[] = []
  for (const tag of tags) {
    const value = tag.trim()
    if (value && !result.some((item) => item.toLowerCase() === value.toLowerCase())) result.push(value)
  }
  return result
}

// ── 行映射 ───────────────────────────────────────────

interface CustomerRow {
  id: string
  company: string
  country: string
  website: string
  stage: string
  tags: string
  source: string
  notes: string
  org_id: string
  owner_id: string
  visibility: string
  team_id: string | null
  created_at: number
  updated_at: number
}

interface ContactRow {
  id: string
  customer_id: string
  name: string
  title: string
  email: string
  phone: string
  whatsapp: string
  is_primary: number
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    isPrimary: Number(row.is_primary) === 1,
  }
}

function contactsFor(ids: string[]): Map<string, Contact[]> {
  const map = new Map<string, Contact[]>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM contacts WHERE customer_id IN (${placeholders}) ORDER BY position ASC`)
    .all(...ids) as unknown as ContactRow[]
  for (const row of rows) {
    const list = map.get(row.customer_id) ?? []
    list.push(toContact(row))
    map.set(row.customer_id, list)
  }
  return map
}

/** 列表行的最近跟进（活动 / 往来邮件的最新时间）与下次跟进（最早的未完成任务） */
function followUpsFor(ids: string[]): Map<
  string,
  { lastTouchAt: number | null; nextTask: { id: string; title: string; dueAt: number | null; overdue: boolean } | null }
> {
  const out = new Map<
    string,
    { lastTouchAt: number | null; nextTask: { id: string; title: string; dueAt: number | null; overdue: boolean } | null }
  >()
  if (!ids.length) return out
  const marks = ids.map(() => '?').join(',')
  const now = Date.now()
  for (const id of ids) out.set(id, { lastTouchAt: null, nextTask: null })
  const touches = db
    .prepare(
      `SELECT customer_id AS id, MAX(t) AS t FROM (
         SELECT customer_id, created_at AS t FROM activities WHERE customer_id IN (${marks})
         UNION ALL SELECT customer_id, date AS t FROM email_messages WHERE customer_id IN (${marks})
       ) GROUP BY customer_id`,
    )
    .all(...ids, ...ids) as unknown as Array<{ id: string; t: number | null }>
  for (const r of touches) {
    const slot = out.get(r.id)
    if (slot && r.t) slot.lastTouchAt = Number(r.t)
  }
  const tasks = db
    .prepare(
      `SELECT id, title, due_at, customer_id FROM tasks WHERE customer_id IN (${marks}) AND status = 'open' AND deleted_at IS NULL
       ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at ASC`,
    )
    .all(...ids) as unknown as Array<{ id: string; title: string; due_at: number | null; customer_id: string }>
  for (const r of tasks) {
    const slot = out.get(r.customer_id)
    if (slot && !slot.nextTask)
      slot.nextTask = { id: r.id, title: r.title, dueAt: r.due_at, overdue: r.due_at !== null && r.due_at < now }
  }
  return out
}

function toCustomer(row: CustomerRow, contacts: Contact[]): Customer {
  return {
    id: row.id,
    company: row.company,
    country: row.country,
    website: row.website,
    stage: row.stage as CustomerStage,
    tags: parseTags(row.tags),
    source: row.source,
    notes: row.notes,
    contacts,
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    visibility: (row.visibility || 'private') as Visibility,
    teamId: row.team_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ActivityRow {
  id: string
  customer_id: string
  type: string
  content: string
  actor_id: string | null
  actor_name: string | null
  created_at: number
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    customerId: row.customer_id,
    type: row.type as Activity['type'],
    content: row.content,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at,
  }
}

function rowById(id: string): CustomerRow | undefined {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as CustomerRow | undefined
}

const assignInput = z
  .object({ ownerId: z.string().min(1).max(80), visibility: z.enum(VISIBILITIES).optional(), teamId: z.string().max(80).nullable().optional() })
  .strict()
const transferInput = z
  .object({
    fromUserId: z.string().min(1).max(80),
    toUserId: z.string().min(1).max(80),
    /** 离职人的邮箱账户：转给接收人（默认）/ 停用后台同步（仍归原负责人）/ 不处理 */
    emailAccounts: z.enum(['transfer', 'disable', 'keep']).default('transfer'),
    /** 工作流、定时任务是否一并转给接收人（默认是）；定时任务之后以接收人的身份和权限运行 */
    workflows: z.boolean().default(true),
    schedules: z.boolean().default(true),
  })
  .strict()

export type HandoverCounts = {
  customers: number
  quotes: number
  deals: number
  orders: number
  tasks: number
  emailAccounts: number
  workflows: number
  schedules: number
}

export type HandoverResult = {
  moved: number
  quotes: number
  deals: number
  orders: number
  tasks: number
  emailAccounts: { mode: 'transfer' | 'disable' | 'keep'; count: number }
  workflows: number
  schedules: number
}

function assertTeam(teamId: string | null | undefined): void {
  const actor = currentActor()
  if (!teamId) return
  if (actor.orgId === 'local') return
  if (!teamService.teamExists(teamId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
  if (!seesAll(actor) && !actor.teamIds.includes(teamId)) throw new AppError(400, 'VALIDATION_ERROR', '只能共享给自己所在的团队')
}

type BusinessRecordCounts = { orders: number; payments: number; quotes: number; deals: number }

/**
 * 客户名下的业务记录数（不受可见性限制）。live=true 只数未删除的（移入回收站前的检查）；
 * live=false 连回收站里的一起数（彻底删除客户时外键会级联到全部记录）。
 */
export function businessRecordCounts(customerId: string, live = true): BusinessRecordCounts {
  const count = (sql: string) => Number((db.prepare(sql).get(customerId) as { n: number }).n)
  const alive = (alias: string) => (live ? ` AND ${alias}.deleted_at IS NULL` : '')
  return {
    orders: count(`SELECT COUNT(*) AS n FROM orders o WHERE o.customer_id = ?${alive('o')}`),
    payments: count(`SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = ?${alive('o')}`),
    quotes: count(`SELECT COUNT(*) AS n FROM quotes q WHERE q.customer_id = ?${alive('q')}`),
    deals: count(`SELECT COUNT(*) AS n FROM deals d WHERE d.customer_id = ?${alive('d')}`),
  }
}

function assertNoBusinessRecords(customerId: string): void {
  const counts = businessRecordCounts(customerId)
  const parts = [
    counts.orders ? `${counts.orders} 个订单` : '',
    counts.payments ? `${counts.payments} 条收款` : '',
    counts.quotes ? `${counts.quotes} 个报价` : '',
    counts.deals ? `${counts.deals} 个商机` : '',
  ].filter(Boolean)
  if (parts.length) {
    throw new AppError(409, 'CUSTOMER_HAS_RECORDS', `该客户名下有 ${parts.join('、')}，不能删除。请先转移或处理这些记录。`)
  }
}

type MovedRecords = { quotes: number; deals: number; orders: number; tasks: number }

/**
 * 转移负责人时连带转移的记录：报价、商机、订单（收款挂在订单下，没有自己的负责人）、未完成的任务。
 * 已完成 / 已取消的任务保留原负责人，作为“谁做过这次跟进”的历史；新负责人仍能通过客户看到它们。
 * where 子句作用在各业务表上，必须在调用方的事务里执行。
 */
function moveRelatedRecords(toUserId: string, where: string, params: string[]): MovedRecords {
  const run = (sql: string) => Number(db.prepare(sql).run(toUserId, ...params).changes)
  return {
    quotes: run(`UPDATE quotes SET owner_id = ? WHERE ${where}`),
    deals: run(`UPDATE deals SET owner_id = ? WHERE ${where}`),
    orders: run(`UPDATE orders SET owner_id = ? WHERE ${where}`),
    tasks: run(`UPDATE tasks SET owner_id = ? WHERE status = 'open' AND ${where}`),
  }
}

/**
 * 交接邮箱账户 / 工作流 / 定时任务（在调用方事务里执行）。
 * - 邮箱转给接收人时，原负责人在这些邮箱里的草稿一并转过去；停用时只关后台同步，账户仍归原负责人。
 * - 定时任务转给接收人后清掉“负责人停用”的暂停标记；追加到原负责人私人会话的任务改为每次新建会话
 *   （接收人无权写那个会话）。下一次触发时间由调用方在事务外重新计算。
 */
function moveMemberAssets(
  orgId: string,
  data: { fromUserId: string; toUserId: string; emailAccounts: 'transfer' | 'disable' | 'keep'; workflows: boolean; schedules: boolean },
): { emailAccounts: { count: number }; workflows: number; movedSchedules: string[]; detachedSessions: number } {
  let emailCount = 0
  if (data.emailAccounts === 'transfer') {
    const accountIds = (
      db.prepare('SELECT id FROM email_accounts WHERE org_id = ? AND owner_id = ?').all(orgId, data.fromUserId) as Array<{ id: string }>
    ).map((row) => row.id)
    if (accountIds.length) {
      const marks = accountIds.map(() => '?').join(', ')
      emailCount = Number(
        db
          .prepare(`UPDATE email_accounts SET owner_id = ?, updated_at = ? WHERE id IN (${marks})`)
          .run(data.toUserId, Date.now(), ...accountIds).changes,
      )
      db.prepare(`UPDATE email_drafts SET owner_id = ? WHERE owner_id = ? AND account_id IN (${marks})`).run(
        data.toUserId,
        data.fromUserId,
        ...accountIds,
      )
    }
  } else if (data.emailAccounts === 'disable') {
    emailCount = Number(
      db
        .prepare('UPDATE email_accounts SET sync_enabled = 0, updated_at = ? WHERE org_id = ? AND owner_id = ? AND sync_enabled = 1')
        .run(Date.now(), orgId, data.fromUserId).changes,
    )
  }
  const workflows = data.workflows
    ? Number(
        db.prepare('UPDATE workflows SET owner_id = ?, updated_at = ? WHERE org_id = ? AND owner_id = ?').run(data.toUserId, Date.now(), orgId, data.fromUserId)
          .changes,
      )
    : 0
  const movedSchedules: string[] = []
  let detachedSessions = 0
  if (data.schedules) {
    const rows = db.prepare('SELECT id, target FROM schedules WHERE org_id = ? AND owner_id = ?').all(orgId, data.fromUserId) as Array<{
      id: string
      target: string
    }>
    const ownsSession = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND owner_id = ?')
    for (const row of rows) {
      let target = row.target
      try {
        const parsed = JSON.parse(row.target) as { type?: string; sessionMode?: string; sessionId?: string | null }
        if (parsed.type === 'prompt' && parsed.sessionMode === 'append' && parsed.sessionId && !ownsSession.get(parsed.sessionId, data.toUserId)) {
          target = JSON.stringify({ ...parsed, sessionMode: 'new', sessionId: null })
          detachedSessions += 1
        }
      } catch {
        // 目标损坏：原样转移，运行时会记失败
      }
      db.prepare('UPDATE schedules SET owner_id = ?, owner_paused = 0, target = ?, updated_at = ? WHERE id = ?').run(
        data.toUserId,
        target,
        Date.now(),
        row.id,
      )
      movedSchedules.push(row.id)
    }
  }
  return { emailAccounts: { count: emailCount }, workflows, movedSchedules, detachedSessions }
}

function describeMoved(m: MovedRecords): string {
  return `连带 ${m.quotes} 个报价、${m.deals} 个商机、${m.orders} 个订单、${m.tasks} 个未完成任务`
}

type ContactInput = z.infer<typeof contactInput>

function writeContacts(customerId: string, contacts: ContactInput[]): void {
  db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(customerId)
  const insert = db.prepare(
    `INSERT INTO contacts (id, customer_id, name, title, email, phone, whatsapp, is_primary, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // 只保留一个主联系人；都没有标记时第一个为主联系人
  let primaryIndex = contacts.findIndex((contact) => contact.isPrimary)
  if (primaryIndex < 0 && contacts.length > 0) primaryIndex = 0
  const used = new Set<string>()
  contacts.forEach((contact, index) => {
    let id = contact.id && /^[\w-]+$/.test(contact.id) && !used.has(contact.id) ? contact.id : newId('ct')
    // 其他客户名下已存在同 id 时换新 id
    const owner = db.prepare('SELECT customer_id FROM contacts WHERE id = ?').get(id) as unknown as
      | { customer_id: string }
      | undefined
    if (owner && owner.customer_id !== customerId) id = newId('ct')
    used.add(id)
    insert.run(
      id,
      customerId,
      contact.name,
      contact.title,
      contact.email,
      contact.phone,
      contact.whatsapp,
      index === primaryIndex ? 1 : 0,
      index,
    )
  })
}


export type DuplicateReason = 'company' | 'email' | 'emailDomain' | 'phone' | 'website'

export interface CustomerDuplicate {
  /** 仅当前用户可见时返回 */
  id?: string
  company: string
  ownerName: string
  matchedBy: DuplicateReason[]
}

type DuplicateCandidate = { company: string; website?: string; contacts?: Array<{ email?: string; phone?: string; whatsapp?: string }> }

/** 去掉 LIKE 通配符 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function findDuplicates(candidate: DuplicateCandidate, excludeId?: string): CustomerDuplicate[] {
  const orgId = currentActor().orgId
  const hits = new Map<string, Set<DuplicateReason>>()
  const add = (ids: Array<{ id: string }>, reason: DuplicateReason) => {
    for (const { id } of ids) {
      if (id === excludeId) continue
      const set = hits.get(id) ?? new Set<DuplicateReason>()
      set.add(reason)
      hits.set(id, set)
    }
  }
  const live = 'c.org_id = ? AND c.deleted_at IS NULL'
  const norm = companyNorm(candidate.company)
  if (norm) {
    add(db.prepare(`SELECT c.id FROM customers c WHERE ${live} AND c.company_norm = ? LIMIT 20`).all(orgId, norm) as unknown as Array<{ id: string }>, 'company')
  }
  const site = websiteKey(candidate.website ?? '')
  const emails = new Set<string>()
  const domains = new Set<string>()
  const phones = new Set<string>()
  for (const contact of candidate.contacts ?? []) {
    const email = (contact.email ?? '').trim().toLowerCase()
    if (email.includes('@')) {
      emails.add(email)
      const domain = companyEmailDomain(email)
      if (domain) domains.add(domain)
    }
    for (const value of [contact.phone, contact.whatsapp]) {
      const key = phoneKey(value ?? '')
      if (key) phones.add(key)
    }
  }
  if (site) {
    add(db.prepare(`SELECT c.id FROM customers c WHERE ${live} AND c.website_key = ? LIMIT 20`).all(orgId, site) as unknown as Array<{ id: string }>, 'website')
    if (companyEmailDomain(`x@${site}`)) domains.add(site)
  }
  for (const email of emails) {
    add(
      db
        .prepare(`SELECT DISTINCT c.id FROM contacts t JOIN customers c ON c.id = t.customer_id WHERE ${live} AND lower(t.email) = ? LIMIT 20`)
        .all(orgId, email) as unknown as Array<{ id: string }>,
      'email',
    )
  }
  for (const domain of domains) {
    add(
      db
        .prepare(
          `SELECT DISTINCT c.id FROM customers c WHERE ${live} AND (c.website_key = ? OR EXISTS (
             SELECT 1 FROM contacts t WHERE t.customer_id = c.id AND lower(t.email) LIKE ? ESCAPE '\\'))
           LIMIT 20`,
        )
        .all(orgId, domain, `%@${likeEscape(domain)}`) as unknown as Array<{ id: string }>,
      'emailDomain',
    )
  }
  const digits = (column: string) =>
    `replace(replace(replace(replace(replace(replace(replace(${column}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), '/', '')`
  for (const key of phones) {
    add(
      db
        .prepare(
          `SELECT DISTINCT c.id FROM contacts t JOIN customers c ON c.id = t.customer_id WHERE ${live}
             AND ((length(${digits('t.phone')}) >= 7 AND ${digits('t.phone')} LIKE ? ESCAPE '\\')
               OR (length(${digits('t.whatsapp')}) >= 7 AND ${digits('t.whatsapp')} LIKE ? ESCAPE '\\'))
           LIMIT 20`,
        )
        .all(orgId, `%${likeEscape(key)}`, `%${likeEscape(key)}`) as unknown as Array<{ id: string }>,
      'phone',
    )
  }
  const order: DuplicateReason[] = ['company', 'website', 'email', 'emailDomain', 'phone']
  const result: CustomerDuplicate[] = []
  for (const [id, reasons] of hits) {
    const row = rowById(id)
    if (!row) continue
    // 同一个完整邮箱已经命中时不再重复列出域名
    const matchedBy = order.filter((reason) => reasons.has(reason) && !(reason === 'emailDomain' && reasons.has('email')))
    result.push({
      ...(canSee(row) ? { id } : {}),
      company: row.company,
      ownerName: teamService.userName(row.owner_id),
      matchedBy,
    })
  }
  result.sort((a, b) => order.indexOf(a.matchedBy[0]!) - order.indexOf(b.matchedBy[0]!))
  return result.slice(0, 5)
}

const DUPLICATE_LABELS: Record<DuplicateReason, string> = {
  company: '公司名',
  website: '网站',
  email: '联系人邮箱',
  emailDomain: '邮箱域名',
  phone: '电话',
}

function assertNoDuplicate(candidate: DuplicateCandidate): void {
  const duplicates = findDuplicates(candidate)
  if (!duplicates.length) return
  const first = duplicates[0]!
  throw new AppError(
    409,
    'CUSTOMER_DUPLICATE',
    `可能与已有客户「${first.company}」（负责人 ${first.ownerName}）重复（${first.matchedBy.map((r) => DUPLICATE_LABELS[r]).join('、')}相同）`,
    undefined,
    { duplicates },
  )
}

export const customerService = {
  list(input: unknown): { items: Customer[]; total: number } {
    const query = parse(listQueryInput, input)
    const scope = liveClause('c')
    const where: string[] = [scope.sql]
    const params: Array<string | number> = [...scope.params]
    if (query.ownerId) {
      where.push('c.owner_id = ?')
      params.push(query.ownerId)
    }
    if (query.visibility) {
      where.push('c.visibility = ?')
      params.push(query.visibility)
    }
    if (query.query?.trim()) {
      const like = `%${query.query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(
        `(lower(c.company) LIKE ? ESCAPE '\\' OR lower(c.website) LIKE ? ESCAPE '\\' OR lower(c.country) LIKE ? ESCAPE '\\'
          OR lower(c.notes) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM contacts t WHERE t.customer_id = c.id AND (lower(t.name) LIKE ? ESCAPE '\\' OR lower(t.email) LIKE ? ESCAPE '\\')))`,
      )
      params.push(like, like, like, like, like, like)
    }
    if (query.stage) {
      where.push('c.stage = ?')
      params.push(query.stage)
    }
    if (query.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(c.tags) j WHERE lower(j.value) = ?)')
      params.push(query.tag.toLowerCase())
    }
    if (query.country?.trim()) {
      where.push('lower(c.country) = ?')
      params.push(query.country.trim().toLowerCase())
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM customers c ${clause}`).get(...params) as unknown as { n: number }).n,
    )
    const rows = db
      .prepare(`SELECT c.* FROM customers c ${clause} ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as unknown as CustomerRow[]
    const contacts = contactsFor(rows.map((row) => row.id))
    const follow = followUpsFor(rows.map((row) => row.id))
    return {
      items: rows.map((row) => ({ ...toCustomer(row, contacts.get(row.id) ?? []), ...follow.get(row.id) })),
      total,
    }
  },

  /** 列表侧栏筛选项：当前用户可见范围内的国家 / 负责人 / 标签计数，以及总数与本月新增 */
  facets(): {
    total: number
    newThisMonth: number
    countries: Array<{ value: string; count: number }>
    owners: Array<{ id: string; name: string; count: number }>
    tags: Array<{ value: string; count: number }>
  } {
    const scope = liveClause('c')
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${scope.sql}`).get(...scope.params) as unknown as { n: number }).n,
    )
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const newThisMonth = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${scope.sql} AND c.created_at >= ?`)
          .get(...scope.params, monthStart) as unknown as { n: number }
      ).n,
    )
    const countries = (
      db
        .prepare(
          `SELECT c.country AS value, COUNT(*) AS n FROM customers c WHERE ${scope.sql} AND trim(c.country) <> ''
           GROUP BY lower(c.country) ORDER BY n DESC, value ASC LIMIT 30`,
        )
        .all(...scope.params) as unknown as Array<{ value: string; n: number }>
    ).map((r) => ({ value: r.value, count: Number(r.n) }))
    const owners = (
      db
        .prepare(`SELECT c.owner_id AS id, COUNT(*) AS n FROM customers c WHERE ${scope.sql} GROUP BY c.owner_id ORDER BY n DESC LIMIT 30`)
        .all(...scope.params) as unknown as Array<{ id: string; n: number }>
    ).map((r) => ({ id: r.id, name: teamService.userName(r.id), count: Number(r.n) }))
    const tags = (
      db
        .prepare(
          `SELECT j.value AS value, COUNT(*) AS n FROM customers c, json_each(c.tags) j WHERE ${scope.sql}
           GROUP BY lower(j.value) ORDER BY n DESC, value ASC LIMIT 30`,
        )
        .all(...scope.params) as unknown as Array<{ value: string; n: number }>
    ).map((r) => ({ value: String(r.value), count: Number(r.n) }))
    return { total, newThisMonth, countries, owners, tags }
  },

  /** CSV 导出（当前用户可见范围 + 同列表筛选；UTF-8 BOM 便于 Excel；防公式注入） */
  exportCsv(input: unknown): { csv: string; count: number } {
    requirePermission('data:export')
    const filters = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const header = ['company', 'country', 'website', 'stage', 'tags', 'source', 'owner', 'contact_name', 'contact_title', 'contact_email', 'contact_phone', 'contacts_count', 'notes', 'created_at', 'updated_at']
    const cell = (value: unknown): string => {
      let text = String(value ?? '')
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const lines = [header.join(',')]
    let count = 0
    for (let page = 1; page <= 250; page += 1) {
      const batch = customerService.list({ ...filters, page, pageSize: 200 })
      for (const c of batch.items) {
        const primary = c.contacts.find((x) => x.isPrimary) ?? c.contacts[0]
        lines.push(
          [c.company, c.country, c.website, c.stage, c.tags.join(';'), c.source, c.ownerName, primary?.name, primary?.title, primary?.email, primary?.phone, c.contacts.length, c.notes, new Date(c.createdAt).toISOString(), new Date(c.updatedAt).toISOString()]
            .map(cell)
            .join(','),
        )
        count += 1
      }
      if (page * 200 >= batch.total) break
    }
    return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, count }
  },

  get(id: string): Customer | undefined {
    const row = rowById(id)
    if (!row) return undefined
    return toCustomer(row, contactsFor([id]).get(id) ?? [])
  },

  /** 当前用户可见才返回，否则 404（不泄露存在性） */
  require(id: string): Customer {
    const row = rowById(id)
    if (!row || !canSee(row)) throw notFound('客户')
    return customerService.get(id)!
  },

  /** 可见且可修改，否则 404 / 403 */
  requireWritable(id: string): Customer {
    const row = rowById(id)
    if (!row || !canSee(row)) throw notFound('客户')
    assertCanModify(row, '客户')
    return customerService.get(id)!
  },

  isVisible(id: string): boolean {
    const row = rowById(id)
    return Boolean(row && canSee(row))
  },

  /**
   * 新建客户。先在整个组织范围内查重（不受可见性限制）：命中时 409 CUSTOMER_DUPLICATE，
   * details.duplicates 只带公司名与负责人（当前用户看得见时附 id），用户确认后带 force=true 再提交。
   */
  create(input: unknown): Customer {
    const { force, ...data } = parse(customerCreateInput, input)
    assertTeam(data.teamId)
    return transaction(() => {
      if (!force) assertNoDuplicate(data)
      return customerService.insert(data)
    })
  },

  /** 整个组织范围内可能重复的客户（不含回收站），按命中依据汇总，最多 5 个 */
  findDuplicates: findDuplicates,

  /** 已校验数据直接写入（导入复用） */
  insert(data: z.infer<typeof customerCreateInput>, id = newId('cus'), now = Date.now()): Customer {
    const owner = ownershipForNew({ visibility: data.visibility, teamId: data.teamId })
    db.prepare(
      `INSERT INTO customers (id, company, company_key, company_norm, country, website, website_key, stage, tags, source, notes, created_at, updated_at,
         org_id, owner_id, visibility, team_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.company,
      companyKey(data.company),
      companyNorm(data.company),
      data.country,
      data.website,
      websiteKey(data.website),
      data.stage,
      JSON.stringify(uniqueTags(data.tags)),
      data.source,
      data.notes,
      now,
      now,
      owner.orgId,
      owner.ownerId,
      owner.visibility,
      owner.teamId,
    )
    writeContacts(id, data.contacts)
    return customerService.get(id)!
  },

  update(id: string, input: unknown): Customer {
    const patch = parse(customerPatchInput, input)
    const current = customerService.requireWritable(id)
    if (patch.teamId !== undefined) assertTeam(patch.teamId)
    const nextVisibility = patch.visibility ?? current.visibility
    const nextTeam = patch.teamId !== undefined ? patch.teamId : current.teamId
    if (nextVisibility === 'team' && !nextTeam) throw new AppError(400, 'VALIDATION_ERROR', '共享给团队时必须指定团队（teamId）')
    return transaction(() => {
      if (patch.visibility !== undefined || patch.teamId !== undefined) {
        db.prepare('UPDATE customers SET visibility = ?, team_id = ? WHERE id = ?').run(nextVisibility, nextTeam, id)
      }
      const next = {
        company: patch.company ?? current.company,
        country: patch.country ?? current.country,
        website: patch.website ?? current.website,
        stage: patch.stage ?? current.stage,
        tags: uniqueTags(patch.tags ?? current.tags),
        source: patch.source ?? current.source,
        notes: patch.notes ?? current.notes,
      }
      db.prepare(
        `UPDATE customers SET company = ?, company_key = ?, company_norm = ?, country = ?, website = ?, website_key = ?, stage = ?,
           tags = ?, source = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.company,
        companyKey(next.company),
        companyNorm(next.company),
        next.country,
        next.website,
        websiteKey(next.website),
        next.stage,
        JSON.stringify(next.tags),
        next.source,
        next.notes,
        Date.now(),
        id,
      )
      if (patch.contacts) writeContacts(id, patch.contacts)
      return customerService.get(id)!
    })
  },

  /**
   * 删除客户 = 移入回收站：联系人、跟进记录保留，未删除的任务随客户一起移入回收站（恢复客户时一起恢复）。
   * 名下有订单 / 收款 / 报价 / 商机时拒绝删除（409 CUSTOMER_HAS_RECORDS）。审计里存一份删除前的快照。
   */
  remove(id: string): void {
    requireDelete('customer:delete')
    const customer = customerService.requireWritable(id)
    transaction(() => {
      assertNoBusinessRecords(id)
      const tasks = db.prepare('SELECT * FROM tasks WHERE customer_id = ? AND deleted_at IS NULL').all(id) as unknown as Array<Record<string, unknown>>
      const at = trash.mark('customer', id)
      if (!at) throw notFound('客户')
      const actor = currentActor()
      db.prepare('UPDATE tasks SET deleted_at = ?, deleted_by = ? WHERE customer_id = ? AND deleted_at IS NULL').run(at, actor.id || null, id)
      trash.audit('customer', id, `客户「${customer.company}」移入回收站`, { ...customer, tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })) })
    })
  },

  /** 分配 / 转移负责人（契约 5.6），连带转移该客户的报价、商机、订单与未完成任务 */
  assign(id: string, input: unknown): Customer {
    const data = parse(assignInput, input)
    const actor = currentActor()
    const row = rowById(id)
    if (!row || !canSee(row)) throw notFound('客户')
    assertCanModify(row, '客户')
    if (!teamService.isOrgMember(data.ownerId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '负责人不存在或已停用')
    if (data.teamId) assertTeam(data.teamId)
    const visibility = data.visibility ?? (row.visibility as Visibility)
    const teamId = data.teamId !== undefined ? data.teamId : row.team_id
    if (visibility === 'team' && !teamId) throw new AppError(400, 'VALIDATION_ERROR', '共享给团队时必须指定团队（teamId）')
    const related = transaction(() => {
      db.prepare('UPDATE customers SET owner_id = ?, visibility = ?, team_id = ?, updated_at = ? WHERE id = ?').run(
        data.ownerId,
        visibility,
        teamId,
        Date.now(),
        id,
      )
      const moved = moveRelatedRecords(data.ownerId, 'customer_id = ?', [id])
      if (row.owner_id !== data.ownerId) {
        customerService.recordActivity(
          id,
          'note',
          `负责人由「${teamService.userName(row.owner_id)}」转给「${teamService.userName(data.ownerId)}」`,
        )
      }
      return moved
    })
    auditService.record({
      action: 'customer.transfer',
      entityType: 'customer',
      entityId: id,
      summary: `客户「${row.company}」转给 ${teamService.userName(data.ownerId)}（${describeMoved(related)}）`,
      meta: { from: row.owner_id, to: data.ownerId, ...related },
    })
    return customerService.get(id)!
  },

  /** 离职交接前的预览：某人在本组织名下各类记录的数量（不含回收站） */
  handoverPreview(fromUserId: string): HandoverCounts {
    const actor = currentActor()
    const count = (sql: string) => Number((db.prepare(sql).get(actor.orgId, fromUserId) as { n: number }).n)
    return {
      customers: count('SELECT COUNT(*) AS n FROM customers WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL'),
      quotes: count('SELECT COUNT(*) AS n FROM quotes WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL'),
      deals: count('SELECT COUNT(*) AS n FROM deals WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL'),
      orders: count('SELECT COUNT(*) AS n FROM orders WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL'),
      tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND owner_id = ? AND status = 'open' AND deleted_at IS NULL"),
      emailAccounts: count('SELECT COUNT(*) AS n FROM email_accounts WHERE org_id = ? AND owner_id = ?'),
      workflows: count('SELECT COUNT(*) AS n FROM workflows WHERE org_id = ? AND owner_id = ?'),
      schedules: count('SELECT COUNT(*) AS n FROM schedules WHERE org_id = ? AND owner_id = ?'),
    }
  },

  /**
   * 离职交接：把某人名下的全部客户（及报价、商机、订单、未完成任务）转给另一人；
   * 按选项一并转移邮箱账户（或停用其后台同步）、工作流和定时任务。全部在一个事务里完成。
   */
  transferAll(input: unknown): HandoverResult {
    const data = parse(transferInput, input)
    const actor = currentActor()
    if (data.fromUserId === data.toUserId) throw new AppError(400, 'VALIDATION_ERROR', '接收人不能是交接人本人')
    if (!teamService.isOrgMember(data.toUserId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '接收人不存在或已停用')
    if (data.schedules && !data.workflows) {
      const dependent = (
        db.prepare('SELECT target FROM schedules WHERE org_id = ? AND owner_id = ?').all(actor.orgId, data.fromUserId) as Array<{ target: string }>
      ).some((row) => {
        try {
          return (JSON.parse(row.target) as { type?: string }).type === 'workflow'
        } catch {
          return false
        }
      })
      if (dependent) throw new AppError(400, 'VALIDATION_ERROR', '有定时任务运行的是工作流，转移定时任务时需要一并转移工作流')
    }
    const { moved, related, extra } = transaction(() => {
      const ids = (
        db
          .prepare('SELECT id FROM customers WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL')
          .all(actor.orgId, data.fromUserId) as unknown as {
          id: string
        }[]
      ).map((r) => r.id)
      // 回收站里的记录不参与交接（恢复后仍归原负责人，可再单独转移）
      const result = db
        .prepare('UPDATE customers SET owner_id = ?, updated_at = ? WHERE org_id = ? AND owner_id = ? AND deleted_at IS NULL')
        .run(data.toUserId, Date.now(), actor.orgId, data.fromUserId)
      // 交接范围：被转客户名下的全部记录 + 原负责人在本组织名下的其它记录（不留下没人能改的孤儿记录）
      const byCustomer = ids.length ? `customer_id IN (${ids.map(() => '?').join(', ')})` : '0'
      const related = moveRelatedRecords(data.toUserId, `org_id = ? AND deleted_at IS NULL AND (owner_id = ? OR ${byCustomer})`, [
        actor.orgId,
        data.fromUserId,
        ...ids,
      ])
      return { moved: Number(result.changes), related, extra: moveMemberAssets(actor.orgId, data) }
    })
    if (extra.movedSchedules.length) rescheduleSchedules(extra.movedSchedules.map((id) => scheduleRow(id)!).filter(Boolean))
    const receiver = teamService.userName(data.toUserId)
    auditService.record({
      action: 'customer.transfer',
      entityType: 'user',
      entityId: data.fromUserId,
      summary: `批量转移 ${moved} 个客户给 ${receiver}（${describeMoved(related)}）`,
      meta: { from: data.fromUserId, to: data.toUserId, moved, ...related },
    })
    if (extra.emailAccounts.count > 0) {
      auditService.record({
        action: data.emailAccounts === 'transfer' ? 'email_account.transfer' : 'email_account.disable_sync',
        entityType: 'user',
        entityId: data.fromUserId,
        summary:
          data.emailAccounts === 'transfer'
            ? `离职交接：${extra.emailAccounts.count} 个邮箱账户转给 ${receiver}`
            : `离职交接：停用 ${teamService.userName(data.fromUserId)} 的 ${extra.emailAccounts.count} 个邮箱账户的后台同步`,
        meta: { from: data.fromUserId, to: data.toUserId, mode: data.emailAccounts, count: extra.emailAccounts.count },
      })
    }
    if (extra.workflows > 0) {
      auditService.record({
        action: 'workflow.transfer',
        entityType: 'user',
        entityId: data.fromUserId,
        summary: `离职交接：${extra.workflows} 个工作流转给 ${receiver}`,
        meta: { from: data.fromUserId, to: data.toUserId, count: extra.workflows },
      })
    }
    if (extra.movedSchedules.length > 0) {
      auditService.record({
        action: 'schedule.transfer',
        entityType: 'user',
        entityId: data.fromUserId,
        summary: `离职交接：${extra.movedSchedules.length} 个定时任务转给 ${receiver}，之后以其身份运行${
          extra.detachedSessions ? `（${extra.detachedSessions} 个原本追加到原负责人会话的任务改为每次新建会话）` : ''
        }`,
        meta: { from: data.fromUserId, to: data.toUserId, count: extra.movedSchedules.length, detachedSessions: extra.detachedSessions },
      })
    }
    return {
      moved,
      ...related,
      emailAccounts: { mode: data.emailAccounts, count: extra.emailAccounts.count },
      workflows: extra.workflows,
      schedules: extra.movedSchedules.length,
    }
  },

  touch(id: string): void {
    db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  },

  setStageIfEarlier(id: string, stage: CustomerStage): void {
    const current = customerService.get(id)
    if (!current) return
    const order = CUSTOMER_STAGES.indexOf(current.stage)
    if (current.stage !== 'lost' && order < CUSTOMER_STAGES.indexOf(stage)) {
      db.prepare('UPDATE customers SET stage = ?, updated_at = ? WHERE id = ?').run(stage, Date.now(), id)
    }
  },

  activities(customerId: string): Activity[] {
    customerService.require(customerId)
    const rows = db
      .prepare('SELECT * FROM activities WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(customerId) as unknown as ActivityRow[]
    return rows.map(toActivity)
  },

  addActivity(customerId: string, input: unknown): Activity {
    customerService.require(customerId)
    const data = parse(activityInput, input)
    return customerService.recordActivity(customerId, data.type, data.content)
  },

  recordActivity(customerId: string, type: Activity['type'], content: string): Activity {
    const actor = currentActor()
    const activity: Activity = {
      id: newId('act'),
      customerId,
      type,
      content,
      actorId: actor.id || null,
      actorName: actor.name || null,
      createdAt: Date.now(),
    }
    db.prepare(
      'INSERT INTO activities (id, customer_id, type, content, created_at, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(activity.id, customerId, type, content, activity.createdAt, activity.actorId, activity.actorName)
    customerService.touch(customerId)
    return activity
  },

  recentActivities(limit = 10): Activity[] {
    const scope = liveClause('c')
    const rows = db
      .prepare(
        `SELECT a.* FROM activities a JOIN customers c ON c.id = a.customer_id WHERE ${scope.sql}
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      )
      .all(...scope.params, limit) as unknown as ActivityRow[]
    return rows.map(toActivity)
  },

  /** CSV/XLSX 在客户端解析成 rows，这里按 mapping 取字段、去重、创建或合并 */
  import(input: unknown): { created: number; merged: number; skipped: number; errors: Array<{ row: number; message: string }> } {
    requirePermission('data:write')
    requirePermission('customer:import')
    const data = parse(importInput, input)
    const result = { created: 0, merged: 0, skipped: 0, errors: [] as Array<{ row: number; message: string }> }

    const cell = (row: Record<string, string | number | null>, field: (typeof IMPORT_FIELDS)[number]): string => {
      const column = data.mapping[field]
      if (!column) return ''
      const value = row[column]
      return value === null || value === undefined ? '' : String(value).trim()
    }

    const findExisting = (candidate: { company: string; website: string; email: string }): string | null => {
      if (data.dedupeBy === 'email') {
        if (!candidate.email) return null
        const row = db
          .prepare(
            'SELECT t.customer_id FROM contacts t JOIN customers c ON c.id = t.customer_id WHERE lower(t.email) = ? AND c.org_id = ? AND c.deleted_at IS NULL LIMIT 1',
          )
          .get(candidate.email.toLowerCase(), currentActor().orgId) as unknown as { customer_id: string } | undefined
        return row?.customer_id ?? null
      }
      if (data.dedupeBy === 'website') {
        const key = websiteKey(candidate.website)
        if (!key) return null
        const row = db.prepare('SELECT id FROM customers WHERE website_key = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1').get(key, currentActor().orgId) as unknown as
          | { id: string }
          | undefined
        return row?.id ?? null
      }
      const row = db
        .prepare('SELECT id FROM customers WHERE company_key = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1')
        .get(companyKey(candidate.company), currentActor().orgId) as unknown as { id: string } | undefined
      return row?.id ?? null
    }

    transaction(() => {
      data.rows.forEach((row, index) => {
        const rowNumber = index + 1
        try {
          const email = cell(row, 'contactEmail').toLowerCase()
          const contactRaw = {
            name: cell(row, 'contactName'),
            title: cell(row, 'contactTitle'),
            email,
            phone: cell(row, 'contactPhone'),
            whatsapp: cell(row, 'contactWhatsapp'),
            isPrimary: false,
          }
          const hasContact = Object.values(contactRaw).some((value) => typeof value === 'string' && value)
          const stageRaw = cell(row, 'stage').toLowerCase()
          const candidate = customerCreateInput.safeParse({
            company: cell(row, 'company'),
            country: cell(row, 'country'),
            website: cell(row, 'website'),
            stage: stageRaw && (CUSTOMER_STAGES as readonly string[]).includes(stageRaw) ? stageRaw : 'lead',
            tags: cell(row, 'tags')
              .split(/[,，;；|]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            source: cell(row, 'source') || '导入',
            notes: cell(row, 'notes'),
            contacts: hasContact ? [contactRaw] : [],
          })
          if (!candidate.success) {
            const issue = candidate.error.issues[0]
            const field = issue?.path.join('.') ?? ''
            result.errors.push({
              row: rowNumber,
              message: field.startsWith('company') ? '缺少公司名' : `${field}：${issue?.message ?? '格式不正确'}`,
            })
            return
          }
          const value = candidate.data
          const existingId = findExisting({ company: value.company, website: value.website, email })
          if (!existingId) {
            customerService.insert(value)
            result.created += 1
            return
          }
          if (data.onDuplicate === 'skip' || !canModify(rowById(existingId)!)) {
            result.skipped += 1
            return
          }
          // merge：只补空字段，标签取并集，联系人按邮箱/姓名去重后追加
          const current = customerService.get(existingId)!
          const contacts = [...current.contacts]
          for (const contact of value.contacts) {
            const duplicate = contacts.some(
              (item) =>
                (contact.email && item.email.toLowerCase() === contact.email) ||
                (!contact.email && contact.name && item.name === contact.name),
            )
            if (!duplicate) contacts.push({ ...contact, id: newId('ct'), isPrimary: contacts.length === 0 })
          }
          db.prepare(
            `UPDATE customers SET country = ?, website = ?, website_key = ?, tags = ?, source = ?, notes = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            current.country || value.country,
            current.website || value.website,
            websiteKey(current.website || value.website),
            JSON.stringify(uniqueTags([...current.tags, ...value.tags])),
            current.source || value.source,
            current.notes || value.notes,
            Date.now(),
            existingId,
          )
          writeContacts(existingId, contacts)
          result.merged += 1
        } catch (error) {
          if (error instanceof AppError) {
            result.errors.push({ row: rowNumber, message: error.message })
          } else {
            throw error
          }
        }
      })
    })
    return result
  },
}
