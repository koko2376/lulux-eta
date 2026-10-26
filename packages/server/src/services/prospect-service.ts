import { z } from 'zod'
import { db } from '../db.js'
import { AppError, notFound } from '../errors.js'
import { newId } from '../utils/id.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'
import { currentActor } from '../context.js'
import {
  assertCanModify,
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
import { customerService, websiteKey } from './customer-service.js'
import { companyNorm, companyEmailDomain } from '../utils/customer-keys.js'

/**
 * 开发客户 / 潜客（prospects）。
 *
 * 权限直接复用客户（customers）的那一套，不新增权限位：
 * - 读 / 写：data:write（列表 / 详情按行级可见性，admin / owner 看全部）
 * - 删除：customer:delete（潜客删除同样进回收站，实体名 'prospect'，标签「潜客」）
 * 这样权限清单、默认角色与成员权限编辑器都不用改；以后要单列 prospect:delete 时
 * 只需在 access.ts 加权限位并替换这里的 requireDelete 参数。
 */

export const PROSPECT_STATUSES = ['new', 'contacted', 'converted', 'ignored'] as const
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export const EVIDENCE_KINDS = ['customs', 'bill_of_lading', 'website', 'search', 'directory', 'import', 'manual'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export const PROSPECT_FLAGS = ['forwarder', 'sanctions_hit', 'customer_exists', 'stale', 'name_conflict', 'website_down'] as const
export type ProspectFlag = (typeof PROSPECT_FLAGS)[number]

export interface ProspectEvidence {
  kind: EvidenceKind
  /** 来源系统，如 hmrc / importyeti / csv / web */
  source: string
  url: string
  title: string
  snippet: string
  observedAt: number
  /** 这条证据支撑了哪些字段 */
  fields: string[]
}

export interface ProspectScoreReason {
  key: string
  label: string
  points: number
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
  scoreReasons: ProspectScoreReason[]
  status: ProspectStatus
  customerId: string | null
  searchQuery: string
  notes: string
  ownerId: string
  ownerName: string
  visibility: Visibility
  teamId: string | null
  createdAt: number
  updatedAt: number
}

export interface CustomerMatch {
  id: string
  company: string
}

/** create / update 的返回：查重命中现有客户时附上它（同时 flags 里会有 customer_exists） */
export type ProspectWithMatch = Prospect & { matchedCustomer?: CustomerMatch }

export type ProspectUpsertResult = { prospect: Prospect; created: boolean; matchedCustomer?: CustomerMatch }

export type ProspectConvertResult =
  | { converted: true; prospect: Prospect; customer: { id: string; company: string } }
  | {
      converted: false
      duplicate: true
      message: string
      matches: Array<{ customerId?: string; company: string; owner: string; matchedBy: string[] }>
    }

// ── 规范化 ───────────────────────────────────────────

/** 只接受 http/https 的公开链接；没有写协议的按 https 补全。坏链接返回空串。 */
function normalizeLink(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.hostname ? url.toString() : ''
  } catch {
    return ''
  }
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  const out: T[] = []
  for (const value of values) {
    const trimmed = String(value).trim()
    if (trimmed && !out.includes(trimmed as T)) out.push(trimmed as T)
  }
  return out
}

function parseJson<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

// ── 校验 ─────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max)

const countryInput = z
  .string()
  .max(20)
  .refine((value) => {
    const normalized = value.trim().toUpperCase()
    return normalized === '' || /^[A-Z]{2}$/.test(normalized)
  }, '国家代码必须是 2 位字母（ISO 3166-1 alpha-2）')
  .transform((value) => value.trim().toUpperCase())

const linkInput = (max: number, label: string) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() === '' || normalizeLink(value) !== '', `${label}只支持 http:// 或 https:// 地址`)
    .transform(normalizeLink)

const hsCodeItem = z
  .string()
  .max(40)
  .refine((value) => {
    const cleaned = value.replace(/[\s.]/g, '')
    return cleaned === '' || /^\d{2,10}$/.test(cleaned)
  }, 'HS 编码必须是 2–10 位数字')

const hsCodesInput = z
  .array(hsCodeItem)
  .max(100)
  .transform((items) => uniqueStrings(items.map((item) => item.replace(/[\s.]/g, '')).filter(Boolean)).slice(0, 50))

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const emailItem = z
  .string()
  .max(320)
  .refine((value) => {
    const email = value.trim().toLowerCase()
    return email === '' || EMAIL_RE.test(email)
  }, '邮箱格式不正确')

const emailsInput = z
  .array(emailItem)
  .max(100)
  .transform((items) => uniqueStrings(items.map((item) => item.trim().toLowerCase()).filter(Boolean)).slice(0, 20))

const phonesInput = z
  .array(z.string().max(64))
  .max(100)
  .transform((items) => uniqueStrings(items.map((item) => item.trim()).filter(Boolean)).slice(0, 20))

const socialLinksInput = z
  .array(linkInput(2000, '社交链接'))
  .max(50)
  .transform((items) => uniqueStrings(items.filter(Boolean)).slice(0, 20))

const evidenceInput = z
  .array(
    z.object({
      kind: z.enum(EVIDENCE_KINDS),
      source: text(100).default(''),
      url: linkInput(2000, '证据链接').default(''),
      title: text(500).default(''),
      snippet: z.string().max(20_000).transform((value) => value.trim().slice(0, 1000)).default(''),
      observedAt: z.number().int().nonnegative().optional(),
      fields: z.array(text(60)).max(50).default([]),
    }),
  )
  .max(200)
  .transform((items) => {
    // snippet 截断到 1000；同一条证据（类型 + 来源 + 链接 + 标题相同）只留一条，最多 50 条
    const out: ProspectEvidence[] = []
    for (const item of items) {
      if (out.length >= 50) break
      const evidence: ProspectEvidence = { ...item, snippet: item.snippet.slice(0, 1000), observedAt: item.observedAt ?? Date.now() }
      const duplicate = out.some(
        (existing) =>
          existing.kind === evidence.kind && existing.source === evidence.source && existing.url === evidence.url && existing.title === evidence.title,
      )
      if (!duplicate) out.push(evidence)
    }
    return out
  })

const flagsInput = z.array(z.enum(PROSPECT_FLAGS)).max(PROSPECT_FLAGS.length).transform((items) => uniqueStrings(items))

const prospectShape = {
  company: text(300).min(1, '公司名不能为空'),
  country: countryInput,
  website: linkInput(500, '网站'),
  address: text(500),
  products: text(2000),
  hsCodes: hsCodesInput,
  emails: emailsInput,
  phones: phonesInput,
  socialLinks: socialLinksInput,
  lastImportAt: z.number().int().nonnegative().nullable(),
  shipments: z.number().int().min(0).max(1_000_000).nullable(),
  evidence: evidenceInput,
  flags: flagsInput,
  status: z.enum(PROSPECT_STATUSES),
  searchQuery: text(500),
  notes: z.string().max(20_000),
  visibility: z.enum(VISIBILITIES),
  teamId: z.string().max(80).nullable(),
}

export const prospectCreateInput = z.object({
  ...prospectShape,
  country: prospectShape.country.default(''),
  website: prospectShape.website.default(''),
  address: prospectShape.address.default(''),
  products: prospectShape.products.default(''),
  hsCodes: prospectShape.hsCodes.default([]),
  emails: prospectShape.emails.default([]),
  phones: prospectShape.phones.default([]),
  socialLinks: prospectShape.socialLinks.default([]),
  lastImportAt: prospectShape.lastImportAt.default(null),
  shipments: prospectShape.shipments.default(null),
  evidence: prospectShape.evidence.default([]),
  flags: prospectShape.flags.default([]),
  status: prospectShape.status.default('new'),
  searchQuery: prospectShape.searchQuery.default(''),
  notes: prospectShape.notes.default(''),
  visibility: prospectShape.visibility.optional(),
  teamId: prospectShape.teamId.optional(),
})

export const prospectPatchInput = z.object(prospectShape).partial().strict()

export const prospectListInput = z.object({
  q: z.string().max(200).optional(),
  country: z.string().max(20).optional(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  hasCustomsEvidence: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1')
    .optional(),
  flag: z.enum(PROSPECT_FLAGS).optional(),
  sort: z.enum(['score', 'updated', 'lastImport']).default('score'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type ProspectListInput = z.infer<typeof prospectListInput>
export type ProspectCreateInput = z.infer<typeof prospectCreateInput>

// ── 计分（纯函数） ───────────────────────────────────

export interface ProspectScoreInput {
  hsCodes: string[]
  evidence: Array<{ kind: string; source?: string }>
  lastImportAt: number | null
  shipments: number | null
  website: string
  emails: string[]
  flags: string[]
}

const digits = (value: string): string => value.replace(/\D+/g, '')
const CUSTOMS_KINDS = new Set<string>(['customs', 'bill_of_lading'])
const DAY = 86_400_000

/**
 * 潜客评分 0–100。targetHs 是本次开发的目标 HS 编码（下一步接入搜索时传入）；
 * 不传 / 为空时 HS 项不加分。create / update / upsert 自动以潜客自身的 hsCodes 作为目标。
 */
export function scoreProspect(
  input: ProspectScoreInput,
  options: { targetHs?: string[]; now?: number } = {},
): { score: number; reasons: ProspectScoreReason[] } {
  const flags = new Set(input.flags)
  if (flags.has('sanctions_hit')) {
    // 命中制裁名单：直接判 0 分，不再算其它项
    return { score: 0, reasons: [{ key: 'sanctions_hit', label: '命中制裁名单', points: 0 }] }
  }
  const reasons: ProspectScoreReason[] = []
  const add = (key: string, label: string, points: number) => reasons.push({ key, label, points })

  // HS 匹配：前 6 位 +30 / 前 4 位 +20 / 前 2 位 +8，取最佳一档
  const targets = (options.targetHs ?? []).map(digits).filter((code) => code.length >= 2)
  let hsTier = 0
  for (const own of input.hsCodes.map(digits).filter(Boolean)) {
    for (const target of targets) {
      if (target.length >= 6 && own.length >= 6 && own.slice(0, 6) === target.slice(0, 6)) hsTier = Math.max(hsTier, 6)
      else if (target.length >= 4 && own.length >= 4 && own.slice(0, 4) === target.slice(0, 4)) hsTier = Math.max(hsTier, 4)
      else if (own.slice(0, 2) === target.slice(0, 2)) hsTier = Math.max(hsTier, 2)
    }
  }
  if (hsTier === 6) add('hs_match', 'HS 编码前 6 位匹配', 30)
  else if (hsTier === 4) add('hs_match', 'HS 编码前 4 位匹配', 20)
  else if (hsTier === 2) add('hs_match', 'HS 编码前 2 位匹配', 8)

  if (input.evidence.some((item) => CUSTOMS_KINDS.has(item.kind))) add('customs_evidence', '有海关 / 提单记录', 20)

  if (input.lastImportAt) {
    const age = (options.now ?? Date.now()) - input.lastImportAt
    if (age >= 0 && age <= 180 * DAY) add('recent_import', '最近 180 天内有进口记录', 15)
    else if (age >= 0 && age <= 365 * DAY) add('recent_import', '最近一年内有进口记录', 8)
  }

  if (input.shipments !== null && input.shipments >= 10) add('shipments', '进口记录多（≥ 10 次或 10 个月）', 10)
  else if (input.shipments !== null && input.shipments >= 3) add('shipments', '有多次进口记录（≥ 3）', 5)

  if (input.website) add('website', '有官网', 8)
  if (input.emails.some((email) => companyEmailDomain(email) !== '')) add('company_email', '有企业邮箱', 7)
  else if (input.emails.length > 0) add('company_email', '只有免费邮箱', 2)

  const sources = new Set(input.evidence.map((item) => item.source ?? '').filter(Boolean))
  if (sources.size >= 3) add('evidence_sources', '证据来源 ≥ 3 种', 5)

  if (flags.has('forwarder')) add('forwarder', '货代 / 同行', -30)
  if (flags.has('stale')) add('stale', '信息已过时', -10)
  if (flags.has('website_down')) add('website_down', '官网无法访问', -8)
  if (flags.has('name_conflict')) add('name_conflict', '公司名冲突', -10)

  const total = reasons.reduce((sum, reason) => sum + reason.points, 0)
  return { score: Math.max(0, Math.min(100, total)), reasons }
}

// ── 行映射 ───────────────────────────────────────────

interface ProspectRow {
  id: string
  company: string
  company_key: string
  country: string
  website: string
  website_key: string
  address: string
  products: string
  hs_codes: string
  emails: string
  phones: string
  social_links: string
  last_import_at: number | null
  shipments: number | null
  evidence: string
  flags: string
  score: number
  score_reasons: string
  status: string
  customer_id: string | null
  search_query: string
  notes: string
  org_id: string
  owner_id: string
  visibility: string
  team_id: string | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

function toProspect(row: ProspectRow): Prospect {
  return {
    id: row.id,
    company: row.company,
    country: row.country,
    website: row.website,
    address: row.address,
    products: row.products,
    hsCodes: parseJson<string>(row.hs_codes),
    emails: parseJson<string>(row.emails),
    phones: parseJson<string>(row.phones),
    socialLinks: parseJson<string>(row.social_links),
    lastImportAt: row.last_import_at === null ? null : Number(row.last_import_at),
    shipments: row.shipments === null ? null : Number(row.shipments),
    evidence: parseJson<ProspectEvidence>(row.evidence),
    flags: parseJson<ProspectFlag>(row.flags),
    score: Number(row.score),
    scoreReasons: parseJson<ProspectScoreReason>(row.score_reasons),
    status: (PROSPECT_STATUSES as readonly string[]).includes(row.status) ? (row.status as ProspectStatus) : 'new',
    customerId: row.customer_id ?? null,
    searchQuery: row.search_query,
    notes: row.notes,
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    visibility: (row.visibility || 'private') as Visibility,
    teamId: row.team_id ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function rowById(id: string): ProspectRow | undefined {
  return db.prepare('SELECT * FROM prospects WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as ProspectRow | undefined
}

const STATUS_LABELS: Record<ProspectStatus, string> = {
  new: '新潜客',
  contacted: '已联系',
  converted: '已转客户',
  ignored: '已忽略',
}

// ── 与客户的查重 ─────────────────────────────────────

function assertTeam(teamId: string | null | undefined): void {
  const actor = currentActor()
  if (!teamId) return
  if (actor.orgId === 'local') return
  if (!teamService.teamExists(teamId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
  if (!seesAll(actor) && !actor.teamIds.includes(teamId)) throw new AppError(400, 'VALIDATION_ERROR', '只能共享给自己所在的团队')
}

/**
 * 同组织、当前用户可见的客户里按公司名（customers.company_norm）或网站（website_key）查一个。
 * 客户表上的 company_norm 就是 companyNorm() 的结果，与 prospects.company_key 同一算法。
 */
function matchCustomer(company: string, website: string): CustomerMatch | null {
  const key = companyNorm(company)
  const site = websiteKey(website)
  const scope = liveClause('c')
  if (key) {
    const row = db
      .prepare(`SELECT c.id, c.company FROM customers c WHERE ${scope.sql} AND c.company_norm = ? LIMIT 1`)
      .get(...scope.params, key) as unknown as CustomerMatch | undefined
    if (row) return { id: row.id, company: row.company }
  }
  if (site) {
    const row = db
      .prepare(`SELECT c.id, c.company FROM customers c WHERE ${scope.sql} AND c.website_key = ? LIMIT 1`)
      .get(...scope.params, site) as unknown as CustomerMatch | undefined
    if (row) return { id: row.id, company: row.company }
  }
  return null
}

/** 用最新的查重结果维护 customer_exists 标记 */
function withCustomerFlag(flags: ProspectFlag[], match: CustomerMatch | null): ProspectFlag[] {
  const rest = flags.filter((flag) => flag !== 'customer_exists')
  return match ? [...rest, 'customer_exists'] : rest
}

// ── 写入 ─────────────────────────────────────────────

function scoreOf(data: {
  hsCodes: string[]
  evidence: ProspectEvidence[]
  lastImportAt: number | null
  shipments: number | null
  website: string
  emails: string[]
  flags: ProspectFlag[]
  searchQuery: string
}): { score: number; reasons: ProspectScoreReason[] } {
  // 目标 HS 只来自产生这条潜客的搜索（search_query 里的 4–10 位数字）；没有目标时 HS 项不加分，
  // 不能拿潜客自己的 HS 当目标（那样任何带 HS 的潜客都白拿 30 分）
  return scoreProspect(data, { targetHs: targetHsOf(data.searchQuery) })
}

/** search_query 里写成 “hs:8413.70” / “HS 841370,8414” 的部分才算目标 HS（年份、数量等数字不会误判） */
export function targetHsOf(searchQuery: string): string[] {
  const out: string[] = []
  for (const m of searchQuery.matchAll(/\bhs\s*[:：]?\s*([\d.\s,，/]+)/gi)) {
    for (const part of m[1].split(/[,，/]|\s{2,}/)) {
      const code = part.replace(/[.\s]/g, '')
      if (/^\d{2,10}$/.test(code)) out.push(code)
    }
  }
  return uniqueStrings(out).slice(0, 20)
}

function insertRow(data: ProspectCreateInput, id: string, now: number): { prospect: Prospect; matchedCustomer: CustomerMatch | null } {
  const owner = ownershipForNew({ visibility: data.visibility, teamId: data.teamId })
  const match = matchCustomer(data.company, data.website)
  const flags = withCustomerFlag(data.flags, match)
  const scored = scoreOf({ ...data, flags })
  db.prepare(
    `INSERT INTO prospects (id, company, company_key, country, website, website_key, address, products, hs_codes, emails, phones, social_links,
       last_import_at, shipments, evidence, flags, score, score_reasons, status, customer_id, search_query, notes,
       created_at, updated_at, org_id, owner_id, visibility, team_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.company,
    companyNorm(data.company),
    data.country,
    data.website,
    websiteKey(data.website),
    data.address,
    data.products,
    JSON.stringify(data.hsCodes),
    JSON.stringify(data.emails),
    JSON.stringify(data.phones),
    JSON.stringify(data.socialLinks),
    data.lastImportAt,
    data.shipments,
    JSON.stringify(data.evidence),
    JSON.stringify(flags),
    scored.score,
    JSON.stringify(scored.reasons),
    data.status,
    data.searchQuery,
    data.notes,
    now,
    now,
    owner.orgId,
    owner.ownerId,
    owner.visibility,
    owner.teamId,
  )
  return { prospect: toProspect(rowById(id)!), matchedCustomer: match }
}

function mergeEvidence(current: ProspectEvidence[], incoming: ProspectEvidence[]): ProspectEvidence[] {
  const out = [...current]
  for (const item of incoming) {
    if (out.length >= 50) break
    const duplicate = out.some(
      (existing) => existing.kind === item.kind && existing.source === item.source && existing.url === item.url && existing.title === item.title,
    )
    if (!duplicate) out.push(item)
  }
  return out
}

/** upsert 合并：数组去重并集，证据追加，日期 / 次数取最大，标量只补空值 */
function mergeRow(current: ProspectRow, data: ProspectCreateInput, now: number): CustomerMatch | null {
  const hsCodes = uniqueStrings([...parseJson<string>(current.hs_codes), ...data.hsCodes]).slice(0, 50)
  const emails = uniqueStrings([...parseJson<string>(current.emails), ...data.emails]).slice(0, 20)
  const phones = uniqueStrings([...parseJson<string>(current.phones), ...data.phones]).slice(0, 20)
  const socialLinks = uniqueStrings([...parseJson<string>(current.social_links), ...data.socialLinks]).slice(0, 20)
  const evidence = mergeEvidence(parseJson<ProspectEvidence>(current.evidence), data.evidence)
  const mergedFlags = uniqueStrings([...parseJson<ProspectFlag>(current.flags), ...data.flags])
  const company = current.company || data.company
  const website = current.website || data.website
  const match = matchCustomer(company, website)
  const flags = withCustomerFlag(mergedFlags, match)
  const lastImportAt =
    current.last_import_at === null
      ? data.lastImportAt
      : data.lastImportAt === null
        ? Number(current.last_import_at)
        : Math.max(Number(current.last_import_at), data.lastImportAt)
  const shipments =
    current.shipments === null
      ? data.shipments
      : data.shipments === null
        ? Number(current.shipments)
        : Math.max(Number(current.shipments), data.shipments)
  const scored = scoreOf({ hsCodes, evidence, lastImportAt, shipments, website, emails, flags, searchQuery: current.search_query || data.searchQuery })
  db.prepare(
    `UPDATE prospects SET company = ?, company_key = ?, country = ?, website = ?, website_key = ?, address = ?, products = ?, hs_codes = ?,
       emails = ?, phones = ?, social_links = ?, last_import_at = ?, shipments = ?, evidence = ?, flags = ?, score = ?, score_reasons = ?,
       search_query = ?, notes = ?, updated_at = ? WHERE id = ?`,
  ).run(
    company,
    companyNorm(company),
    current.country || data.country,
    website,
    websiteKey(website),
    current.address || data.address,
    current.products || data.products,
    JSON.stringify(hsCodes),
    JSON.stringify(emails),
    JSON.stringify(phones),
    JSON.stringify(socialLinks),
    lastImportAt,
    shipments,
    JSON.stringify(evidence),
    JSON.stringify(flags),
    scored.score,
    JSON.stringify(scored.reasons),
    current.search_query || data.searchQuery,
    current.notes || data.notes,
    now,
    current.id,
  )
  return match
}

function findExisting(company: string, website: string): ProspectRow | undefined {
  const scope = liveClause('p')
  const key = companyNorm(company)
  if (key) {
    const row = db
      .prepare(`SELECT p.* FROM prospects p WHERE ${scope.sql} AND p.company_key = ? ORDER BY p.updated_at DESC LIMIT 1`)
      .get(...scope.params, key) as unknown as ProspectRow | undefined
    if (row) return row
  }
  const site = websiteKey(website)
  if (site) {
    return db
      .prepare(`SELECT p.* FROM prospects p WHERE ${scope.sql} AND p.website_key = ? ORDER BY p.updated_at DESC LIMIT 1`)
      .get(...scope.params, site) as unknown as ProspectRow | undefined
  }
  return undefined
}

/** 证据摘要（转客户时拼进备注），最多 5 条，含链接 */
function evidenceSummary(prospect: Prospect): string {
  const lines = prospect.evidence.slice(0, 5).map((item) => {
    const title = item.title || item.source || item.kind
    return `- [${item.kind}] ${title}${item.url ? `（${item.url}）` : ''}`
  })
  return lines.length ? `证据来源：\n${lines.join('\n')}` : ''
}

function convertContacts(prospect: Prospect) {
  const emails = prospect.emails.slice(0, 20)
  if (emails.length === 0) return []
  return emails.map((email, index) => ({
    name: '',
    title: '',
    email,
    phone: prospect.phones[index] ?? prospect.phones[0] ?? '',
    whatsapp: '',
    isPrimary: index === 0,
  }))
}

// ── 服务 ─────────────────────────────────────────────

/** 有海关 / 提单证据的线索（列表筛选与侧栏计数共用） */
const CUSTOMS_EVIDENCE_SQL = `EXISTS (SELECT 1 FROM json_each(p.evidence) e WHERE json_extract(e.value, '$.kind') IN ('customs', 'bill_of_lading'))`

export const prospectService = {
  /** 当前用户可见的潜客；筛选全部在 SQL 里做（不把整表取到 JS 再过滤） */
  list(input: unknown): { items: Prospect[]; total: number } {
    const query = parse(prospectListInput, input)
    const scope = liveClause('p')
    const where: string[] = [scope.sql]
    const params: Array<string | number> = [...scope.params]
    if (query.q?.trim()) {
      const like = `%${query.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(
        `(lower(p.company) LIKE ? ESCAPE '\\' OR lower(p.website) LIKE ? ESCAPE '\\' OR lower(p.products) LIKE ? ESCAPE '\\'
          OR lower(p.hs_codes) LIKE ? ESCAPE '\\')`,
      )
      params.push(like, like, like, like)
    }
    if (query.country?.trim()) {
      where.push('upper(p.country) = ?')
      params.push(query.country.trim().toUpperCase())
    }
    if (query.status) {
      where.push('p.status = ?')
      params.push(query.status)
    }
    if (query.minScore !== undefined) {
      where.push('p.score >= ?')
      params.push(query.minScore)
    }
    if (query.flag) {
      where.push('EXISTS (SELECT 1 FROM json_each(p.flags) f WHERE f.value = ?)')
      params.push(query.flag)
    }
    if (query.hasCustomsEvidence !== undefined) {
      where.push(query.hasCustomsEvidence ? CUSTOMS_EVIDENCE_SQL : `NOT ${CUSTOMS_EVIDENCE_SQL}`)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM prospects p ${clause}`).get(...params) as unknown as { n: number }).n)
    const order =
      query.sort === 'updated'
        ? 'p.updated_at DESC, p.rowid DESC'
        : query.sort === 'lastImport'
          ? '(p.last_import_at IS NULL) ASC, p.last_import_at DESC, p.updated_at DESC'
          : 'p.score DESC, p.updated_at DESC, p.rowid DESC'
    const rows = db
      .prepare(`SELECT p.* FROM prospects p ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as unknown as ProspectRow[]
    return { items: rows.map(toProspect), total }
  },

  get(id: string): Prospect | undefined {
    const row = rowById(id)
    return row ? toProspect(row) : undefined
  },

  /** 当前用户可见才返回，否则 404（不泄露存在性） */
  require(id: string): Prospect {
    const row = rowById(id)
    if (!row || !canSee(row)) throw notFound('潜客')
    return toProspect(row)
  },

  /** 可见且可修改，否则 404 / 403 */
  requireWritable(id: string): Prospect {
    const row = rowById(id)
    if (!row || !canSee(row)) throw notFound('潜客')
    assertCanModify(row, '潜客')
    return toProspect(row)
  },

  isVisible(id: string): boolean {
    const row = rowById(id)
    return Boolean(row && canSee(row))
  },

  /** 新建潜客；命中现有客户时只打 customer_exists 标记并返回 matchedCustomer，不阻止创建 */
  create(input: unknown): ProspectWithMatch {
    requirePermission('data:write')
    const data = parse(prospectCreateInput, input)
    assertTeam(data.teamId)
    const id = newId('prs')
    return transaction(() => {
      const { prospect, matchedCustomer } = insertRow(data, id, Date.now())
      auditService.record({
        action: 'prospect.create',
        entityType: 'prospect',
        entityId: id,
        summary: `新建潜客「${prospect.company}」`,
        meta: { score: prospect.score, matchedCustomer: matchedCustomer?.id ?? null },
      })
      return matchedCustomer ? { ...prospect, matchedCustomer } : prospect
    })
  },

  /** 已校验数据直接写入（导入复用）；不做审计、不查重 */
  insert(data: ProspectCreateInput, id = newId('prs'), now = Date.now()): Prospect {
    return insertRow(data, id, now).prospect
  },

  update(id: string, input: unknown): ProspectWithMatch {
    const patch = parse(prospectPatchInput, input)
    const current = prospectService.requireWritable(id)
    if (patch.teamId !== undefined) assertTeam(patch.teamId)
    const nextVisibility = patch.visibility ?? current.visibility
    const nextTeam = patch.teamId !== undefined ? patch.teamId : current.teamId
    if (nextVisibility === 'team' && !nextTeam) throw new AppError(400, 'VALIDATION_ERROR', '共享给团队时必须指定团队（teamId）')
    return transaction(() => {
      if (patch.visibility !== undefined || patch.teamId !== undefined) {
        db.prepare('UPDATE prospects SET visibility = ?, team_id = ? WHERE id = ?').run(nextVisibility, nextTeam, id)
      }
      const next = {
        company: patch.company ?? current.company,
        country: patch.country ?? current.country,
        website: patch.website ?? current.website,
        address: patch.address ?? current.address,
        products: patch.products ?? current.products,
        hsCodes: patch.hsCodes ?? current.hsCodes,
        emails: patch.emails ?? current.emails,
        phones: patch.phones ?? current.phones,
        socialLinks: patch.socialLinks ?? current.socialLinks,
        lastImportAt: patch.lastImportAt !== undefined ? patch.lastImportAt : current.lastImportAt,
        shipments: patch.shipments !== undefined ? patch.shipments : current.shipments,
        evidence: patch.evidence ?? current.evidence,
        notes: patch.notes ?? current.notes,
        searchQuery: patch.searchQuery ?? current.searchQuery,
      }
      const match = matchCustomer(next.company, next.website)
      const flags = withCustomerFlag(patch.flags ?? current.flags, match)
      const status = patch.status ?? current.status
      const scored = scoreOf({ ...next, flags })
      db.prepare(
        `UPDATE prospects SET company = ?, company_key = ?, country = ?, website = ?, website_key = ?, address = ?, products = ?, hs_codes = ?,
           emails = ?, phones = ?, social_links = ?, last_import_at = ?, shipments = ?, evidence = ?, flags = ?, score = ?, score_reasons = ?,
           status = ?, search_query = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.company,
        companyNorm(next.company),
        next.country,
        next.website,
        websiteKey(next.website),
        next.address,
        next.products,
        JSON.stringify(next.hsCodes),
        JSON.stringify(next.emails),
        JSON.stringify(next.phones),
        JSON.stringify(next.socialLinks),
        next.lastImportAt,
        next.shipments,
        JSON.stringify(next.evidence),
        JSON.stringify(flags),
        scored.score,
        JSON.stringify(scored.reasons),
        status,
        next.searchQuery,
        next.notes,
        Date.now(),
        id,
      )
      auditService.record({
        action: 'prospect.update',
        entityType: 'prospect',
        entityId: id,
        summary: `更新潜客「${next.company}」`,
        meta: { fields: Object.keys(patch), score: scored.score },
      })
      const prospect = toProspect(rowById(id)!)
      return match ? { ...prospect, matchedCustomer: match } : prospect
    })
  },

  /**
   * 按公司名（company_key）或网站（website_key，非空时）合并同组织内已有潜客：
   * 数组去重并集、证据按 (kind, source, url, title) 去重追加、日期 / 次数取最大，
   * 标量字段只补空值（不覆盖用户已填的内容）。命中不到时新建。
   */
  upsert(input: unknown): ProspectUpsertResult {
    requirePermission('data:write')
    const data = parse(prospectCreateInput, input)
    assertTeam(data.teamId)
    return transaction(() => {
      const existing = findExisting(data.company, data.website)
      if (!existing) {
        const id = newId('prs')
        const { prospect, matchedCustomer } = insertRow(data, id, Date.now())
        auditService.record({
          action: 'prospect.create',
          entityType: 'prospect',
          entityId: id,
          summary: `新建潜客「${prospect.company}」`,
          meta: { upsert: true, score: prospect.score, matchedCustomer: matchedCustomer?.id ?? null },
        })
        return matchedCustomer ? { prospect, created: true, matchedCustomer } : { prospect, created: true }
      }
      // 命中但无权修改（别人共享到组织的潜客）：明确拒绝，避免悄悄写别人的记录
      assertCanModify(existing, '潜客')
      const match = mergeRow(existing, data, Date.now())
      const prospect = toProspect(rowById(existing.id)!)
      auditService.record({
        action: 'prospect.update',
        entityType: 'prospect',
        entityId: existing.id,
        summary: `合并潜客「${prospect.company}」`,
        meta: { upsert: true, merged: true, score: prospect.score, matchedCustomer: match?.id ?? null },
      })
      return match ? { prospect, created: false, matchedCustomer: match } : { prospect, created: false }
    })
  },

  /** 删除 = 移入回收站（实体 'prospect'，与客户共用删除权限），审计里留删除前快照 */
  remove(id: string): void {
    requireDelete('customer:delete')
    const prospect = prospectService.requireWritable(id)
    transaction(() => {
      const at = trash.mark('prospect', id)
      if (!at) throw notFound('潜客')
      trash.audit('prospect', id, `潜客「${prospect.company}」移入回收站`, prospect)
    })
  },

  setStatus(id: string, status: unknown): Prospect {
    const next = parse(z.enum(PROSPECT_STATUSES), status)
    const current = prospectService.requireWritable(id)
    db.prepare('UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), id)
    auditService.record({
      action: 'prospect.update',
      entityType: 'prospect',
      entityId: id,
      summary: `潜客「${current.company}」状态改为${STATUS_LABELS[next]}`,
      meta: { from: current.status, to: next },
    })
    return toProspect(rowById(id)!)
  },

  /**
   * 转为客户：复用 customerService 的查重与创建。查重命中且未 force 时只返回 duplicate 报告；
   * 创建成功后客户 source='prospect'、备注拼上证据摘要，潜客标记 converted 并关联 customer_id。
   */
  convertToCustomer(id: string, input: unknown): ProspectConvertResult {
    const { force } = parse(z.object({ force: z.boolean().optional() }).strict(), input)
    const prospect = prospectService.requireWritable(id)
    if (prospect.status === 'converted' && prospect.customerId) {
      throw new AppError(409, 'PROSPECT_ALREADY_CONVERTED', '该潜客已经转为客户，不能重复转换')
    }
    const contacts = convertContacts(prospect)
    // 与新建客户同一套查重（全组织范围，只暴露公司名与负责人）
    const duplicates = customerService.findDuplicates({ company: prospect.company, website: prospect.website, contacts })
    if (duplicates.length > 0 && !force) {
      return {
        converted: false,
        duplicate: true,
        message: '组织内可能已有这个客户，未创建。请确认是否仍然转为新客户（force=true）。',
        matches: duplicates.map((item) => ({
          ...(item.id ? { customerId: item.id } : {}),
          company: item.company,
          owner: item.ownerName,
          matchedBy: item.matchedBy,
        })),
      }
    }
    return transaction(() => {
      const summary = evidenceSummary(prospect)
      const notes = [prospect.notes, summary].filter(Boolean).join('\n\n').slice(0, 20_000)
      const customer = customerService.create({
        company: prospect.company,
        country: prospect.country,
        website: prospect.website,
        source: 'prospect',
        notes,
        contacts,
        visibility: prospect.visibility,
        teamId: prospect.teamId,
        force: true,
      })
      db.prepare('UPDATE prospects SET status = ?, customer_id = ?, updated_at = ? WHERE id = ?').run('converted', customer.id, Date.now(), id)
      auditService.record({
        action: 'prospect.convert',
        entityType: 'prospect',
        entityId: id,
        summary: `潜客「${prospect.company}」转为客户`,
        meta: { customerId: customer.id, force: Boolean(force) },
      })
      return { converted: true as const, prospect: toProspect(rowById(id)!), customer: { id: customer.id, company: customer.company } }
    })
  },

  /** 界面侧栏：可见范围内的数量（按状态 / 是否命中客户） */
  counts(): { total: number; byStatus: Record<ProspectStatus, number>; customerExists: number; byFlag: Record<'sanctions_hit' | 'forwarder' | 'customer_exists', number>; customs: number; web: number } {
    const scope = liveClause('p')
    const byStatus = Object.fromEntries(PROSPECT_STATUSES.map((status) => [status, 0])) as Record<ProspectStatus, number>
    const rows = db
      .prepare(`SELECT p.status AS status, COUNT(*) AS n FROM prospects p WHERE ${scope.sql} GROUP BY p.status`)
      .all(...scope.params) as unknown as Array<{ status: string; n: number }>
    let total = 0
    for (const row of rows) {
      const n = Number(row.n)
      total += n
      if ((PROSPECT_STATUSES as readonly string[]).includes(row.status)) byStatus[row.status as ProspectStatus] = n
    }
    const countWhere = (extra: string, params: unknown[] = []): number =>
      Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM prospects p WHERE ${scope.sql} AND ${extra}`).get(...scope.params, ...(params as never[])) as unknown as { n: number }).n,
      )
    const hasFlag = 'EXISTS (SELECT 1 FROM json_each(p.flags) f WHERE f.value = ?)'
    const byFlag = {
      sanctions_hit: countWhere(hasFlag, ['sanctions_hit']),
      forwarder: countWhere(hasFlag, ['forwarder']),
      customer_exists: countWhere(hasFlag, ['customer_exists']),
    }
    const customs = countWhere(CUSTOMS_EVIDENCE_SQL)
    return { total, byStatus, customerExists: byFlag.customer_exists, byFlag, customs, web: total - customs }
  },
}
