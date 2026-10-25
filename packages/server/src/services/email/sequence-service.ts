import { z } from 'zod'
import { currentActor, runAs } from '../../context.js'
import { db } from '../../db.js'
import { AppError, messageOf, notFound } from '../../errors.js'
import { assertCanModify, requirePermission, seesAll } from '../../security/access.js'
import { newId } from '../../utils/id.js'
import { transaction } from '../../utils/tx.js'
import { parse } from '../../validation.js'
import { actorForUserId } from '../auth-service.js'
import { customerService } from '../customer-service.js'
import { eventBus } from '../events.js'
import { prospectService } from '../prospect-service.js'
import { sanctionsService } from '../sanctions/sanctions-service.js'
import { timezoneForCountry } from '../trade/country-tz.js'
import { offsetMinutes, systemTimeZone, validTimeZone } from '../tools/time.js'
import { accountService } from './account-service.js'
import { draftService } from './draft-service.js'
import { FREE_MAIL_DOMAINS } from './presets.js'
import { freshReplyText } from './reply-text.js'

/**
 * 开发信序列：多步跟进信，按对方时区的工作时间排期；对方回信（同公司也算）、退订、退信即停发。
 * 每一步到点时生成一封草稿进入“待确认”，由用户确认后发出；只有用户在序列上开启“批量确认（自动发送）”才会直接发，
 * 且受每日上限约束。Agent 工具不能开启自动发送。
 */

export interface SequenceStep {
  /** 距离加入序列（第 1 步）或上一步发出后的天数 */
  delayDays: number
  subject: string
  body: string
}

export type SequenceStatus = 'active' | 'paused'
export type EnrollmentStatus = 'active' | 'paused' | 'replied' | 'unsubscribed' | 'bounced' | 'completed' | 'stopped'
export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'

export interface Sequence {
  id: string
  ownerId: string
  name: string
  accountId: string
  accountEmail: string
  steps: SequenceStep[]
  windowStart: number
  windowEnd: number
  skipWeekends: boolean
  stopOnCompanyReply: boolean
  includeOptout: boolean
  autoSend: boolean
  dailyLimit: number
  status: SequenceStatus
  stats: { total: number; active: number; replied: number; unsubscribed: number; bounced: number; completed: number; pending: number; sent: number }
  createdAt: number
  updatedAt: number
}

export interface Enrollment {
  id: string
  sequenceId: string
  email: string
  name: string
  company: string
  country: string
  timezone: string
  customerId: string | null
  prospectId: string | null
  status: EnrollmentStatus
  currentStep: number
  nextSendAt: number | null
  lastSentAt: number | null
  stopReason: string
  createdAt: number
}

export interface SequenceSend {
  id: string
  enrollmentId: string
  sequenceId: string
  sequenceName: string
  email: string
  name: string
  company: string
  stepIndex: number
  draftId: string | null
  status: SendStatus
  subject: string
  preview: string
  scheduledAt: number
  sentAt: number | null
  error: string
  /** 模板变量缺值（如联系人没有公司名，已留空），确认前看一眼 */
  missingVars: string[]
}

interface SequenceRow {
  id: string
  org_id: string
  owner_id: string
  name: string
  account_id: string
  steps_json: string
  window_start: number
  window_end: number
  skip_weekends: number
  stop_on_company_reply: number
  include_optout: number
  auto_send: number
  daily_limit: number
  status: string
  created_at: number
  updated_at: number
}

interface EnrollmentRow {
  id: string
  sequence_id: string
  email: string
  name: string
  company: string
  country: string
  timezone: string
  customer_id: string | null
  prospect_id: string | null
  status: string
  current_step: number
  next_send_at: number | null
  last_sent_at: number | null
  stop_reason: string
  created_at: number
  updated_at: number
}

interface SendRow {
  id: string
  enrollment_id: string
  step_index: number
  draft_id: string | null
  status: string
  subject: string
  scheduled_at: number
  sent_at: number | null
  sent_message_id: string | null
  error: string
  warning: string
  created_at: number
}

const MAX_STEPS = 10
const DAY = 86_400_000

// ── 校验 ─────────────────────────────────────────────

const stepInput = z
  .object({
    delayDays: z.number().int().min(0).max(90),
    subject: z.string().trim().min(1, '每一步都要有主题').max(500),
    body: z.string().trim().min(1, '每一步都要有正文').max(20_000),
  })
  .strict()

const hour = z.number().int().min(0).max(24)

const sequenceShape = {
  name: z.string().trim().min(1, '请填写序列名称').max(120),
  accountId: z.string().trim().max(80).optional(),
  steps: z.array(stepInput).min(1, '至少要有一步').max(MAX_STEPS, `最多 ${MAX_STEPS} 步`),
  windowStart: hour.default(9),
  windowEnd: hour.default(17),
  skipWeekends: z.boolean().default(true),
  stopOnCompanyReply: z.boolean().default(true),
  includeOptout: z.boolean().default(true),
  autoSend: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(500).default(50),
}

const createInput = z.object(sequenceShape).strict()
const patchInput = z
  .object({
    ...sequenceShape,
    status: z.enum(['active', 'paused']),
  })
  .partial()
  .strict()

const contactInput = z
  .object({
    email: z.string().trim().toLowerCase().email('邮箱格式不对').max(320),
    name: z.string().trim().max(200).optional(),
    company: z.string().trim().max(300).optional(),
    country: z.string().trim().max(100).optional(),
    timezone: z.string().trim().max(64).optional(),
    customerId: z.string().trim().max(80).optional(),
    prospectId: z.string().trim().max(80).optional(),
  })
  .strict()

const enrollInput = z
  .object({
    contacts: z.array(contactInput).max(500).default([]),
    customerIds: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
    prospectIds: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
    /** 制裁初筛命中也照样加入（用户已人工核实） */
    force: z.boolean().default(false),
  })
  .strict()

// ── 工具函数 ─────────────────────────────────────────

/** 列表预览：压成一行，超长时在词边界截断并加省略号（不在单词中间截断） */
export function previewText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

function json<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function domainOf(email: string): string {
  return email.split('@')[1]?.trim().toLowerCase() ?? ''
}

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return Math.abs(h)
}

function localParts(instant: number, zone: string): { y: number; m: number; d: number; h: number; mi: number; weekday: number } {
  const shifted = new Date(instant + offsetMinutes(instant, zone) * 60_000)
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate(), h: shifted.getUTCHours(), mi: shifted.getUTCMinutes(), weekday: shifted.getUTCDay() }
}

function zonedInstant(y: number, m: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, m, d, h, mi)
  let instant = guess - offsetMinutes(guess, zone) * 60_000
  instant = guess - offsetMinutes(instant, zone) * 60_000
  return instant
}

/**
 * 把时刻挪进对方时区的发送窗口（工作日 windowStart–windowEnd 点）：已在窗口内原样返回；
 * 否则挪到下一个窗口开头，加 0–29 分钟的固定抖动（按 key 算，避免整点齐发）。
 */
export function nextWindowSlot(base: number, zone: string, windowStart: number, windowEnd: number, skipWeekends: boolean, key = ''): number {
  const start = Math.min(windowStart, windowEnd)
  const end = Math.max(windowStart, windowEnd)
  const allDay = start === 0 && end === 24
  const jitter = hash(key) % 30
  for (let dayShift = 0; dayShift < 14; dayShift++) {
    const anchor = localParts(base + dayShift * DAY, zone)
    const weekend = anchor.weekday === 0 || anchor.weekday === 6
    if (skipWeekends && weekend) continue
    if (dayShift === 0) {
      const minutes = anchor.h * 60 + anchor.mi
      if (allDay || (minutes >= start * 60 && minutes < end * 60)) return base
      if (minutes < start * 60) return zonedInstant(anchor.y, anchor.m, anchor.d, start, jitter, zone)
      continue
    }
    return zonedInstant(anchor.y, anchor.m, anchor.d, allDay ? 9 : start, jitter, zone)
  }
  return base
}

const VAR = /\{\{\s*(firstName|name|company|country|senderName)\s*(?:\|([^}]*))?\}\}/g

/** 渲染模板变量 {{firstName}} {{name}} {{company}} {{country}} {{senderName}}，支持缺省值 {{firstName|there}} */
export function renderTemplate(template: string, vars: Record<string, string>, missing?: Set<string>): string {
  return template.replace(VAR, (_all, key: string, fallback: string | undefined) => {
    const value = (vars[key] ?? '').trim()
    if (!value && fallback === undefined) missing?.add(key)
    return value || (fallback ?? '').trim()
  })
}

const OPTOUT_FOOTER = "\n\n--\nIf you'd rather not receive further emails from us, just reply \"unsubscribe\"."

function firstNameOf(name: string): string {
  const clean = name.trim()
  if (!clean || clean.includes('@')) return ''
  return clean.split(/\s+/)[0] ?? ''
}

// ── 行转换 ───────────────────────────────────────────

function statsOf(id: string): Sequence['stats'] {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ? GROUP BY status').all(id) as Array<{ status: string; n: number }>
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>
  const sends = db
    .prepare('SELECT s.status, COUNT(*) AS n FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id WHERE e.sequence_id = ? GROUP BY s.status')
    .all(id) as Array<{ status: string; n: number }>
  const sendBy = Object.fromEntries(sends.map((r) => [r.status, Number(r.n)])) as Record<string, number>
  return {
    total: rows.reduce((sum, r) => sum + Number(r.n), 0),
    active: by.active ?? 0,
    replied: by.replied ?? 0,
    unsubscribed: by.unsubscribed ?? 0,
    bounced: by.bounced ?? 0,
    completed: by.completed ?? 0,
    pending: sendBy.pending ?? 0,
    sent: sendBy.sent ?? 0,
  }
}

function toSequence(row: SequenceRow): Sequence {
  const account = db.prepare('SELECT email FROM email_accounts WHERE id = ?').get(row.account_id) as { email: string } | undefined
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    accountId: row.account_id,
    accountEmail: account?.email ?? '',
    steps: json<SequenceStep[]>(row.steps_json, []),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    skipWeekends: row.skip_weekends === 1,
    stopOnCompanyReply: row.stop_on_company_reply === 1,
    includeOptout: row.include_optout === 1,
    autoSend: row.auto_send === 1,
    dailyLimit: row.daily_limit,
    status: row.status as SequenceStatus,
    stats: statsOf(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    email: row.email,
    name: row.name,
    company: row.company,
    country: row.country,
    timezone: row.timezone,
    customerId: row.customer_id,
    prospectId: row.prospect_id,
    status: row.status as EnrollmentStatus,
    currentStep: row.current_step,
    nextSendAt: row.next_send_at,
    lastSentAt: row.last_sent_at,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
  }
}

function toSend(row: SendRow & { sequence_id: string; sequence_name: string; email: string; name: string; company: string; text_body?: string | null }): SequenceSend {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    sequenceId: row.sequence_id,
    sequenceName: row.sequence_name,
    email: row.email,
    name: row.name,
    company: row.company,
    stepIndex: row.step_index,
    draftId: row.draft_id,
    status: row.status as SendStatus,
    subject: row.subject,
    preview: previewText(row.text_body ?? '', 200),
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    error: row.error,
    missingVars: (row.warning ?? '').split(',').filter(Boolean),
  }
}

const SEND_SELECT = `SELECT s.*, e.sequence_id, q.name AS sequence_name, e.email, e.name, e.company, d.text_body
  FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id JOIN sequences q ON q.id = e.sequence_id
  LEFT JOIN email_drafts d ON d.id = s.draft_id`

function sequenceRow(id: string): SequenceRow | undefined {
  return db.prepare('SELECT * FROM sequences WHERE id = ?').get(id) as unknown as SequenceRow | undefined
}

/** 当前用户能看到的序列：成员只看自己的，管理员看本组织全部 */
function scopeClause(alias = 'q'): { sql: string; params: string[] } {
  const actor = currentActor()
  if (seesAll(actor)) return { sql: `${alias}.org_id = ?`, params: [actor.orgId] }
  return { sql: `${alias}.org_id = ? AND ${alias}.owner_id = ?`, params: [actor.orgId, actor.id] }
}

function visible(row: SequenceRow | undefined): row is SequenceRow {
  if (!row) return false
  const actor = currentActor()
  return row.org_id === actor.orgId && (seesAll(actor) || row.owner_id === actor.id)
}

function publishChange(sequenceId: string): void {
  const row = sequenceRow(sequenceId)
  if (row) eventBus.publish('sequence.changed', { sequenceId }, { org_id: row.org_id, owner_id: row.owner_id, visibility: 'private', team_id: null } as never)
}

// ── 退订名单 ─────────────────────────────────────────

function isSuppressed(orgId: string, email: string): boolean {
  return Boolean(db.prepare('SELECT 1 AS ok FROM email_suppressions WHERE org_id = ? AND email = ?').get(orgId, email.toLowerCase()))
}

function suppress(orgId: string, email: string, reason: string): void {
  db.prepare('INSERT OR IGNORE INTO email_suppressions (org_id, email, reason, created_at) VALUES (?, ?, ?, ?)').run(orgId, email.toLowerCase(), reason.slice(0, 300), Date.now())
}

// ── 推进 ─────────────────────────────────────────────

function stopEnrollment(id: string, status: EnrollmentStatus, reason: string): void {
  db.prepare('UPDATE sequence_enrollments SET status = ?, stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE id = ?').run(status, reason.slice(0, 300), Date.now(), id)
  // 还没发的待确认草稿一并作废（草稿删掉，避免误发）
  const pending = db.prepare("SELECT id, draft_id FROM sequence_sends WHERE enrollment_id = ? AND status IN ('pending', 'failed')").all(id) as Array<{ id: string; draft_id: string | null }>
  for (const send of pending) {
    db.prepare("UPDATE sequence_sends SET status = 'skipped', error = ? WHERE id = ?").run(reason.slice(0, 300), send.id)
    if (send.draft_id) db.prepare("DELETE FROM email_drafts WHERE id = ? AND status IN ('draft', 'failed')").run(send.draft_id)
  }
}

/** 一步发完（或跳过）后推进到下一步；没有下一步就完成 */
function advance(enrollment: EnrollmentRow, sequence: SequenceRow, sentAt: number | null): void {
  const steps = json<SequenceStep[]>(sequence.steps_json, [])
  const nextIndex = enrollment.current_step + 1
  const lastSent = sentAt ?? enrollment.last_sent_at
  if (nextIndex >= steps.length) {
    db.prepare("UPDATE sequence_enrollments SET status = 'completed', current_step = ?, last_sent_at = ?, next_send_at = NULL, updated_at = ? WHERE id = ?").run(
      nextIndex,
      lastSent,
      Date.now(),
      enrollment.id,
    )
    return
  }
  const base = (sentAt ?? Date.now()) + steps[nextIndex]!.delayDays * DAY
  const next = nextWindowSlot(base, enrollment.timezone, sequence.window_start, sequence.window_end, sequence.skip_weekends === 1, `${enrollment.id}:${nextIndex}`)
  db.prepare('UPDATE sequence_enrollments SET current_step = ?, last_sent_at = ?, next_send_at = ?, updated_at = ? WHERE id = ?').run(nextIndex, lastSent, next, Date.now(), enrollment.id)
}

function markSent(send: SendRow, sentAt: number, sentMessageId: string | null): void {
  const enrollment = db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(send.enrollment_id) as unknown as EnrollmentRow | undefined
  db.prepare("UPDATE sequence_sends SET status = 'sent', sent_at = ?, sent_message_id = ?, error = '' WHERE id = ?").run(sentAt, sentMessageId, send.id)
  if (!enrollment) return
  const sequence = sequenceRow(enrollment.sequence_id)
  if (!sequence) return
  // 发出前对方已回信 / 退订：只记发送，不再推进
  if (enrollment.status !== 'active' && enrollment.status !== 'paused') return
  advance(enrollment, sequence, sentAt)
}

function renderStep(sequence: SequenceRow, enrollment: EnrollmentRow, index: number): { subject: string; body: string; missing: string[] } {
  const step = json<SequenceStep[]>(sequence.steps_json, [])[index]
  if (!step) throw new AppError(400, 'BAD_ARGS', '序列步骤不存在')
  const account = db.prepare('SELECT display_name, email FROM email_accounts WHERE id = ?').get(sequence.account_id) as { display_name: string; email: string } | undefined
  const vars = {
    firstName: firstNameOf(enrollment.name),
    name: enrollment.name,
    company: enrollment.company,
    country: enrollment.country,
    senderName: account?.display_name || '',
  }
  const missing = new Set<string>()
  let body = renderTemplate(step.body, vars, missing)
  if (sequence.include_optout === 1) body += OPTOUT_FOOTER
  return { subject: renderTemplate(step.subject, vars, missing), body, missing: [...missing] }
}

/** 到点的一步：生成草稿 + 待确认记录（以序列负责人身份）；开启自动发送时直接发 */
async function queueStep(sequence: SequenceRow, enrollment: EnrollmentRow): Promise<{ queued: boolean; sent: boolean }> {
  if (isSuppressed(sequence.org_id, enrollment.email)) {
    stopEnrollment(enrollment.id, 'unsubscribed', '在退订名单里')
    return { queued: false, sent: false }
  }
  const { subject, body, missing } = renderStep(sequence, enrollment, enrollment.current_step)
  const draft = draftService.create(
    {
      accountId: sequence.account_id,
      to: [{ name: enrollment.name, address: enrollment.email }],
      subject,
      text: body,
      ...(enrollment.customer_id && customerService.isVisible(enrollment.customer_id) ? { customerId: enrollment.customer_id } : {}),
    },
    'sequence',
  )
  const sendId = newId('sqs')
  db.prepare(
    `INSERT INTO sequence_sends (id, enrollment_id, step_index, draft_id, status, subject, scheduled_at, warning, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(sendId, enrollment.id, enrollment.current_step, draft.id, subject, enrollment.next_send_at ?? Date.now(), missing.join(','), Date.now())
  // 待确认期间不再重复排期
  db.prepare('UPDATE sequence_enrollments SET next_send_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), enrollment.id)
  if (sequence.auto_send === 1) {
    const send = db.prepare('SELECT * FROM sequence_sends WHERE id = ?').get(sendId) as unknown as SendRow
    // 发送失败只计入已生成，不计入已发出
    const ok = await deliver(send).then(
      () => true,
      () => false,
    )
    return { queued: true, sent: ok }
  }
  return { queued: true, sent: false }
}

/** 真正发出一封（草稿发送）；失败记错误并暂停该联系人，等用户处理 */
async function deliver(send: SendRow): Promise<SequenceSend> {
  if (!send.draft_id) throw new AppError(400, 'BAD_ARGS', '这封没有草稿，无法发送')
  // 原子抢占：并发确认（双击 / 重试）只有一个能发；停发逻辑会跳过发送中的记录
  const claimed = db.prepare("UPDATE sequence_sends SET status = 'sending', error = '' WHERE id = ? AND status IN ('pending', 'failed')").run(send.id)
  if (Number(claimed.changes) === 0) throw new AppError(409, 'SEQUENCE_STATE', '这封已经处理过了')
  try {
    const result = await draftService.send(send.draft_id)
    markSent(send, result.draft.sentAt ?? Date.now(), result.message.messageId || null)
  } catch (error) {
    const message = messageOf(error)
    db.prepare("UPDATE sequence_sends SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'").run(message.slice(0, 500), send.id)
    db.prepare("UPDATE sequence_enrollments SET status = 'paused', stop_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(
      `发送失败：${message}`.slice(0, 300),
      Date.now(),
      send.enrollment_id,
    )
    throw error
  }
  return sendById(send.id)
}

function sendById(id: string): SequenceSend {
  return toSend(db.prepare(`${SEND_SELECT} WHERE s.id = ?`).get(id) as never)
}

/** 本序列最近 24 小时发出的封数（每日上限按序列算） */
function sentLast24h(sequenceId: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id WHERE e.sequence_id = ? AND s.status = 'sent' AND s.sent_at > ?`)
        .get(sequenceId, Date.now() - DAY) as { n: number }
    ).n,
  )
}

/** 本序列最近 24 小时生成的封数（人工确认模式的每日上限：每天最多生成这么多待确认草稿） */
function queuedLast24h(sequenceId: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id WHERE e.sequence_id = ? AND s.created_at > ?`)
        .get(sequenceId, Date.now() - DAY) as { n: number }
    ).n,
  )
}

let recoveredSending = false
/**
 * 进程在“发送中”途中退出（崩溃 / 关机）：启动后第一次调度时收拾残留的 sending 记录。
 * 草稿其实已发出 → 记为已发；否则记为失败等用户确认重发（不自动重发，避免对方收到两封）。
 */
function recoverInterruptedSends(): void {
  if (recoveredSending) return
  recoveredSending = true
  const rows = db
    .prepare(
      `SELECT s.*, d.status AS draft_status, d.sent_at AS draft_sent_at, m.message_id AS rfc_id
       FROM sequence_sends s LEFT JOIN email_drafts d ON d.id = s.draft_id LEFT JOIN email_messages m ON m.id = d.sent_message_id
       WHERE s.status = 'sending'`,
    )
    .all() as unknown as Array<SendRow & { draft_status: string | null; draft_sent_at: number | null; rfc_id: string | null }>
  for (const row of rows) {
    if (row.draft_status === 'sent') markSent(row, row.draft_sent_at ?? Date.now(), row.rfc_id)
    else db.prepare("UPDATE sequence_sends SET status = 'failed', error = '上次发送被中断，请确认对方没收到后再发' WHERE id = ? AND status = 'sending'").run(row.id)
  }
}

/** 待确认草稿被用户在邮箱里直接发出 / 删掉：同步回序列 */
function reconcileDrafts(): void {
  const rows = db
    .prepare(
      `SELECT s.*, d.status AS draft_status, d.sent_at AS draft_sent_at, m.message_id AS rfc_id
       FROM sequence_sends s LEFT JOIN email_drafts d ON d.id = s.draft_id LEFT JOIN email_messages m ON m.id = d.sent_message_id
       WHERE s.status IN ('pending', 'failed')`,
    )
    .all() as unknown as Array<SendRow & { draft_status: string | null; draft_sent_at: number | null; rfc_id: string | null }>
  for (const row of rows) {
    if (row.draft_status === 'sent') markSent(row, row.draft_sent_at ?? Date.now(), row.rfc_id)
    else if (row.draft_status === null) {
      db.prepare("UPDATE sequence_sends SET status = 'skipped', error = '草稿已被删除' WHERE id = ?").run(row.id)
      const enrollment = db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(row.enrollment_id) as unknown as EnrollmentRow | undefined
      const sequence = enrollment ? sequenceRow(enrollment.sequence_id) : undefined
      if (enrollment && sequence && enrollment.status === 'active') advance(enrollment, sequence, null)
    }
  }
}

let ticking = false

/** 调度：每分钟一次。到点的联系人生成草稿进待确认；自动发送的序列直接发（受每日上限）。 */
export async function tickSequences(now = Date.now()): Promise<{ queued: number; sent: number }> {
  if (ticking) return { queued: 0, sent: 0 }
  ticking = true
  const result = { queued: 0, sent: 0 }
  try {
    recoverInterruptedSends()
    reconcileDrafts()
    const due = db
      .prepare(
        `SELECT e.* FROM sequence_enrollments e JOIN sequences q ON q.id = e.sequence_id
         WHERE e.status = 'active' AND q.status = 'active' AND e.next_send_at IS NOT NULL AND e.next_send_at <= ?
         AND NOT EXISTS (SELECT 1 FROM sequence_sends s WHERE s.enrollment_id = e.id AND s.status IN ('pending', 'failed', 'sending'))
         ORDER BY e.next_send_at LIMIT 200`,
      )
      .all(now) as unknown as EnrollmentRow[]
    for (const enrollment of due) {
      const sequence = sequenceRow(enrollment.sequence_id)
      if (!sequence) continue
      // 自动发送：每天最多发出 daily_limit 封；人工确认：每天最多生成 daily_limit 封待确认，免得一次堆几百封
      const used = sequence.auto_send === 1 ? sentLast24h(sequence.id) : queuedLast24h(sequence.id)
      if (used >= sequence.daily_limit) continue
      // 错过的时刻（关机 / 休眠 / 暂停后恢复）：现在不在对方的发送时段里，就挪到下一个时段，这一轮不生成也不发
      const slot = nextWindowSlot(now, enrollment.timezone, sequence.window_start, sequence.window_end, sequence.skip_weekends === 1, `${enrollment.id}:${enrollment.current_step}`)
      if (slot > now) {
        db.prepare('UPDATE sequence_enrollments SET next_send_at = ?, updated_at = ? WHERE id = ?').run(slot, Date.now(), enrollment.id)
        continue
      }
      try {
        const outcome = await runAs(actorForUserId(sequence.owner_id), () => queueStep(sequence, enrollment))
        if (outcome.queued) result.queued += 1
        if (outcome.sent) result.sent += 1
        publishChange(sequence.id)
      } catch (error) {
        console.warn('[lulux-eta] 开发信序列排期失败：', messageOf(error))
        db.prepare("UPDATE sequence_enrollments SET status = 'paused', stop_reason = ?, updated_at = ? WHERE id = ?").run(
          `生成草稿失败：${messageOf(error)}`.slice(0, 300),
          Date.now(),
          enrollment.id,
        )
      }
    }
  } finally {
    ticking = false
  }
  return result
}

// ── 回信 / 退订 / 退信检测（邮件同步后调用） ───────────

const UNSUBSCRIBE = /\b(?:unsubscribe|remove me|take me off|stop (?:emailing|sending|contacting)|do not (?:email|contact)|don'?t (?:email|contact) (?:me|us))\b|退订|不要再发|取消订阅|darse de baja|désinscri|abmelden|отписаться/i
/** 模糊的拒绝（“不感兴趣”）：只记为已回信并提示人工确认，不直接拉进退订名单 */
const SOFT_DECLINE = /\bnot interested\b|不感兴趣|暂不需要/i
/** 退订只看回信新写部分的前这么多字 */
const FRESH_LIMIT = 800
const BOUNCE_FROM = /^(?:mailer-daemon|postmaster|mail-daemon|bounce|bounces)@/i

/**
 * 收件同步后：发件人（或同公司域名）在某个进行中的序列里 → 标记已回信并停发；正文是退订意思 → 加入退订名单；
 * 退信（MAILER-DAEMON）里出现序列联系人地址 → 标记退信。只看发到同一邮箱账户的序列。
 */
export function handleInboundForSequences(mail: { accountId: string; date: number; fromAddress: string; subject: string; text: string; inReplyTo: string | null; references: string[] }): void {
  const from = mail.fromAddress.trim().toLowerCase()
  if (!from) return
  const sequences = db.prepare("SELECT * FROM sequences WHERE account_id = ?").all(mail.accountId) as unknown as SequenceRow[]
  if (sequences.length === 0) return
  const seqIds = sequences.map((s) => s.id)
  const placeholders = seqIds.map(() => '?').join(',')
  // 只认加入序列之后收到的邮件（首次同步拉到的旧邮件不算回信）
  const live = "e.status IN ('active', 'paused') AND e.created_at <= ?"

  if (BOUNCE_FROM.test(from)) {
    const body = `${mail.subject}\n${mail.text}`.toLowerCase()
    const tokens = new Set(body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])
    const rows = (db.prepare(`SELECT e.* FROM sequence_enrollments e WHERE e.sequence_id IN (${placeholders}) AND ${live}`).all(...seqIds, mail.date) as unknown as EnrollmentRow[]).filter(
      (row) => tokens.has(row.email),
    )
    // 一封退信里出现很多个联系人地址，多半是引用了群发原文，不据此判退信
    if (rows.length > 3) return
    for (const row of rows) {
      {
        stopEnrollment(row.id, 'bounced', '退信：地址无效或拒收')
        const seq = sequences.find((s) => s.id === row.sequence_id)!
        suppress(seq.org_id, row.email, '退信')
        publishChange(row.sequence_id)
      }
    }
    return
  }

  // 只看对方新写的部分：引用的原文、签名、我们自己的退订脚注都不算（否则正面回信也会因引用脚注被判退订）
  const fresh = freshReplyText(mail.text, [OPTOUT_FOOTER]).slice(0, FRESH_LIMIT)
  const unsubscribe = UNSUBSCRIBE.test(`${mail.subject}\n${fresh}`)
  const softDecline = !unsubscribe && SOFT_DECLINE.test(fresh)
  const domain = domainOf(from)
  const companyDomain = domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : ''
  const refs = [mail.inReplyTo, ...mail.references].filter((x): x is string => Boolean(x))
  const byThread = refs.length
    ? (db
        .prepare(
          `SELECT DISTINCT e.* FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id
           WHERE e.sequence_id IN (${placeholders}) AND s.sent_message_id IN (${refs.map(() => '?').join(',')})`,
        )
        .all(...seqIds, ...refs) as unknown as EnrollmentRow[])
    : []
  const byAddress = db
    .prepare(`SELECT e.* FROM sequence_enrollments e WHERE e.sequence_id IN (${placeholders}) AND lower(e.email) = ? AND e.created_at <= ? AND e.status IN ('active', 'paused')`)
    .all(...seqIds, from, mail.date) as unknown as EnrollmentRow[]
  const byCompany = companyDomain
    ? (db
        .prepare(`SELECT e.* FROM sequence_enrollments e WHERE e.sequence_id IN (${placeholders}) AND e.email LIKE ? ESCAPE '\\' AND ${live}`)
        .all(...seqIds, `%@${companyDomain.replace(/[\\%_]/g, (c) => `\\${c}`)}`, mail.date) as unknown as EnrollmentRow[])
    : []
  const seen = new Set<string>()
  for (const [row, how] of [...byThread.map((r) => [r, 'thread'] as const), ...byAddress.map((r) => [r, 'address'] as const), ...byCompany.map((r) => [r, 'company'] as const)]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const seq = sequences.find((s) => s.id === row.sequence_id)!
    if (how === 'company' && seq.stop_on_company_reply !== 1) continue
    if (unsubscribe && how !== 'company') {
      suppress(seq.org_id, row.email, '对方回复退订')
      if (row.status === 'active' || row.status === 'paused') stopEnrollment(row.id, 'unsubscribed', '对方回复要求退订')
    } else if (row.status === 'active' || row.status === 'paused') {
      // 同公司别人回信要求退订：把这个发件人记进退订名单，联系人按“同公司已回信”停发
      if (unsubscribe && how === 'company') suppress(seq.org_id, from, '同公司回复退订')
      stopEnrollment(row.id, 'replied', how === 'company' ? `同公司 ${from} 已回信` : softDecline ? '对方已回信（表示不感兴趣，请人工确认是否加入退订名单）' : '对方已回信')
    } else continue
    publishChange(row.sequence_id)
  }
  // 序列已结束 / 不在进行中的人回复退订，也记入退订名单（以后不会再被加入序列）
  if (unsubscribe && byAddress.length === 0 && (byThread.length > 0 || db.prepare(`SELECT 1 AS ok FROM sequence_enrollments WHERE sequence_id IN (${placeholders}) AND lower(email) = ?`).get(...seqIds, from))) {
    suppress(sequences[0]!.org_id, from, '回复退订')
  }
}

// ── 对外服务 ─────────────────────────────────────────

function requireSequence(id: string): SequenceRow {
  const row = sequenceRow(id)
  if (!visible(row)) throw notFound('序列')
  return row
}

function requireWritable(id: string): SequenceRow {
  const row = requireSequence(id)
  requirePermission('data:write')
  assertCanModify({ org_id: row.org_id, owner_id: row.owner_id, visibility: 'private', team_id: null }, '序列')
  return row
}

function screenCompany(company: string, email: string): string | null {
  const domain = domainOf(email)
  const name = company.trim() || (domain && !FREE_MAIL_DOMAINS.has(domain) ? domain.split('.')[0]! : '')
  if (!name) return null
  try {
    const hit = sanctionsService.screen(name, { threshold: 0.92, limit: 1 }).hits[0]
    return hit ? hit.primaryName || hit.name : null
  } catch {
    return null
  }
}

export const sequenceService = {
  list(): Sequence[] {
    const scope = scopeClause('q')
    return (db.prepare(`SELECT q.* FROM sequences q WHERE ${scope.sql} ORDER BY q.updated_at DESC`).all(...scope.params) as unknown as SequenceRow[]).map(toSequence)
  },

  get(id: string): Sequence {
    return toSequence(requireSequence(id))
  },

  create(input: unknown, opts: { allowAutoSend?: boolean } = { allowAutoSend: true }): Sequence {
    requirePermission('data:write')
    const data = parse(createInput, input)
    if (data.windowStart >= data.windowEnd) throw new AppError(400, 'BAD_ARGS', '发送时段的开始要早于结束')
    const account = data.accountId ? accountService.requireWritableRow(data.accountId) : accountService.defaultRow()
    if (!account) throw new AppError(400, 'NO_EMAIL_ACCOUNT', '请先添加一个邮箱账户')
    const actor = currentActor()
    const id = newId('seq')
    const now = Date.now()
    db.prepare(
      `INSERT INTO sequences (id, org_id, owner_id, name, account_id, steps_json, window_start, window_end, skip_weekends, stop_on_company_reply, include_optout, auto_send, daily_limit, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      actor.orgId,
      actor.id,
      data.name,
      account.id,
      JSON.stringify(data.steps),
      data.windowStart,
      data.windowEnd,
      data.skipWeekends ? 1 : 0,
      data.stopOnCompanyReply ? 1 : 0,
      data.includeOptout ? 1 : 0,
      data.autoSend && opts.allowAutoSend ? 1 : 0,
      data.dailyLimit,
      now,
      now,
    )
    return sequenceService.get(id)
  },

  update(id: string, input: unknown, opts: { allowAutoSend?: boolean } = { allowAutoSend: true }): Sequence {
    const row = requireWritable(id)
    const data = parse(patchInput, input)
    if (data.autoSend === true && !opts.allowAutoSend) throw new AppError(403, 'FORBIDDEN', '自动发送只能由用户在界面上开启')
    const windowStart = data.windowStart ?? row.window_start
    const windowEnd = data.windowEnd ?? row.window_end
    if (windowStart >= windowEnd) throw new AppError(400, 'BAD_ARGS', '发送时段的开始要早于结束')
    const accountId = data.accountId ? accountService.requireWritableRow(data.accountId).id : row.account_id
    db.prepare(
      `UPDATE sequences SET name = ?, account_id = ?, steps_json = ?, window_start = ?, window_end = ?, skip_weekends = ?, stop_on_company_reply = ?,
         include_optout = ?, auto_send = ?, daily_limit = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).run(
      data.name ?? row.name,
      accountId,
      data.steps ? JSON.stringify(data.steps) : row.steps_json,
      windowStart,
      windowEnd,
      data.skipWeekends === undefined ? row.skip_weekends : data.skipWeekends ? 1 : 0,
      data.stopOnCompanyReply === undefined ? row.stop_on_company_reply : data.stopOnCompanyReply ? 1 : 0,
      data.includeOptout === undefined ? row.include_optout : data.includeOptout ? 1 : 0,
      data.autoSend === undefined ? row.auto_send : data.autoSend ? 1 : 0,
      data.dailyLimit ?? row.daily_limit,
      data.status ?? row.status,
      Date.now(),
      id,
    )
    // 步骤变少：被删掉那几步的待确认 / 失败草稿作废，已走到末尾之后的联系人直接完成
    if (data.steps) {
      const count = data.steps.length
      const orphans = db
        .prepare(
          `SELECT s.id, s.draft_id FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id
           WHERE e.sequence_id = ? AND s.status IN ('pending', 'failed') AND s.step_index >= ?`,
        )
        .all(id, count) as Array<{ id: string; draft_id: string | null }>
      for (const o of orphans) {
        db.prepare("UPDATE sequence_sends SET status = 'skipped', error = '这一步已从序列删除' WHERE id = ?").run(o.id)
        if (o.draft_id) db.prepare("DELETE FROM email_drafts WHERE id = ? AND status IN ('draft', 'failed')").run(o.draft_id)
      }
      db.prepare("UPDATE sequence_enrollments SET status = 'completed', next_send_at = NULL, updated_at = ? WHERE sequence_id = ? AND status IN ('active', 'paused') AND current_step >= ?").run(
        Date.now(),
        id,
        count,
      )
    }
    // 改了发送时段 / 周末规则：已排期的联系人按新规则重新排（不提前，只挪进新时段）
    const skipWeekends = data.skipWeekends === undefined ? row.skip_weekends === 1 : data.skipWeekends
    if (windowStart !== row.window_start || windowEnd !== row.window_end || skipWeekends !== (row.skip_weekends === 1)) {
      const scheduled = db
        .prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND status = 'active' AND next_send_at IS NOT NULL")
        .all(id) as unknown as EnrollmentRow[]
      const reschedule = db.prepare('UPDATE sequence_enrollments SET next_send_at = ?, updated_at = ? WHERE id = ?')
      for (const e of scheduled) {
        const next = nextWindowSlot(e.next_send_at!, e.timezone, windowStart, windowEnd, skipWeekends, `${e.id}:${e.current_step}`)
        reschedule.run(next, Date.now(), e.id)
      }
    }
    // 整条序列从暂停恢复：暂停期间错过的时刻按对方时区的发送时段重新排，不在凌晨 / 周末补发
    if (data.status === 'active' && row.status !== 'active') {
      const now = Date.now()
      const overdue = db
        .prepare("SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND status = 'active' AND next_send_at IS NOT NULL AND next_send_at < ?")
        .all(id, now) as unknown as EnrollmentRow[]
      const reschedule = db.prepare('UPDATE sequence_enrollments SET next_send_at = ?, updated_at = ? WHERE id = ?')
      for (const e of overdue) {
        reschedule.run(nextWindowSlot(now, e.timezone, windowStart, windowEnd, skipWeekends, `${e.id}:${e.current_step}`), now, e.id)
      }
    }
    publishChange(id)
    return sequenceService.get(id)
  },

  remove(id: string): void {
    requireWritable(id)
    transaction(() => {
      const drafts = db
        .prepare(`SELECT s.draft_id FROM sequence_sends s JOIN sequence_enrollments e ON e.id = s.enrollment_id WHERE e.sequence_id = ? AND s.status IN ('pending', 'failed')`)
        .all(id) as Array<{ draft_id: string | null }>
      for (const d of drafts) if (d.draft_id) db.prepare("DELETE FROM email_drafts WHERE id = ? AND status IN ('draft', 'failed')").run(d.draft_id)
      db.prepare('DELETE FROM sequences WHERE id = ?').run(id)
    })
  },

  enrollments(id: string): Enrollment[] {
    requireSequence(id)
    return (db.prepare('SELECT * FROM sequence_enrollments WHERE sequence_id = ? ORDER BY created_at DESC').all(id) as unknown as EnrollmentRow[]).map(toEnrollment)
  },

  /** 加入联系人：直接给邮箱，或给客户 / 潜客 id（取主联系人邮箱）。退订、重复、制裁命中（未 force）的跳过并说明原因。 */
  enroll(id: string, input: unknown): { enrolled: Enrollment[]; skipped: Array<{ email: string; reason: string }> } {
    const row = requireWritable(id)
    const data = parse(enrollInput, input)
    const contacts: Array<z.infer<typeof contactInput>> = [...data.contacts]
    const skipped: Array<{ email: string; reason: string }> = []
    for (const customerId of data.customerIds) {
      const customer = customerService.isVisible(customerId) ? customerService.get(customerId) : undefined
      if (!customer) {
        skipped.push({ email: customerId, reason: '客户不存在' })
        continue
      }
      const contact = customer.contacts.find((c) => c.isPrimary && c.email) ?? customer.contacts.find((c) => c.email)
      if (!contact?.email) {
        skipped.push({ email: customer.company, reason: '客户没有联系人邮箱' })
        continue
      }
      contacts.push({ email: contact.email.toLowerCase(), name: contact.name, company: customer.company, country: customer.country, customerId })
    }
    for (const prospectId of data.prospectIds) {
      // 只认当前用户看得见的（同组织、有权限的）潜客，别人的 / 别的组织的一律当不存在
      const prospect = prospectService.isVisible(prospectId) ? prospectService.get(prospectId) : undefined
      if (!prospect) {
        skipped.push({ email: prospectId, reason: '潜客不存在' })
        continue
      }
      const email = prospect.emails[0] ?? ''
      if (!email) {
        skipped.push({ email: prospect.company, reason: '潜客没有邮箱' })
        continue
      }
      contacts.push({ email: email.toLowerCase(), name: '', company: prospect.company, country: prospect.country, prospectId })
    }
    const steps = json<SequenceStep[]>(row.steps_json, [])
    const enrolled: Enrollment[] = []
    const seen = new Set<string>()
    for (const contact of contacts) {
      const email = contact.email.trim().toLowerCase()
      if (!z.string().email().safeParse(email).success) {
        skipped.push({ email, reason: '邮箱格式不对' })
        continue
      }
      if (seen.has(email)) continue
      seen.add(email)
      if (isSuppressed(row.org_id, email)) {
        skipped.push({ email, reason: '在退订名单里' })
        continue
      }
      if (db.prepare('SELECT 1 AS ok FROM sequence_enrollments WHERE sequence_id = ? AND email = ?').get(id, email)) {
        skipped.push({ email, reason: '已经在这个序列里' })
        continue
      }
      const other = db
        .prepare(
          `SELECT q.name FROM sequence_enrollments e JOIN sequences q ON q.id = e.sequence_id WHERE e.email = ? AND e.status IN ('active', 'paused') AND q.org_id = ? LIMIT 1`,
        )
        .get(email, row.org_id) as { name: string } | undefined
      if (other) {
        skipped.push({ email, reason: `正在序列「${other.name}」里，避免同时收到两套开发信` })
        continue
      }
      if (!data.force) {
        const hit = screenCompany(contact.company ?? '', email)
        if (hit) {
          skipped.push({ email, reason: `制裁初筛命中「${hit}」，核实后可强制加入` })
          continue
        }
      }
      let timezone = contact.timezone && validTimeZone(contact.timezone) ? contact.timezone : ''
      if (contact.timezone && !timezone) {
        skipped.push({ email, reason: `时区「${contact.timezone}」不认识（例：Europe/Berlin）` })
        continue
      }
      timezone ||= timezoneForCountry(contact.country) ?? systemTimeZone()
      const enrollId = newId('sqe')
      const now = Date.now()
      const first = nextWindowSlot(now + steps[0]!.delayDays * DAY, timezone, row.window_start, row.window_end, row.skip_weekends === 1, `${enrollId}:0`)
      db.prepare(
        `INSERT INTO sequence_enrollments (id, sequence_id, email, name, company, country, timezone, customer_id, prospect_id, status, current_step, next_send_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      ).run(enrollId, id, email, contact.name ?? '', contact.company ?? '', contact.country ?? '', timezone, contact.customerId ?? null, contact.prospectId ?? null, first, now, now)
      enrolled.push(toEnrollment(db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(enrollId) as unknown as EnrollmentRow))
    }
    publishChange(id)
    return { enrolled, skipped }
  },

  /** 暂停 / 恢复 / 停止某个联系人 */
  setEnrollmentStatus(enrollmentId: string, status: 'active' | 'paused' | 'stopped'): Enrollment {
    const row = db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(enrollmentId) as unknown as EnrollmentRow | undefined
    if (!row) throw notFound('序列联系人')
    const sequence = requireWritable(row.sequence_id)
    if (status === 'stopped') stopEnrollment(row.id, 'stopped', '手动停止')
    else if (status === 'paused') {
      if (row.status !== 'active') throw new AppError(409, 'SEQUENCE_STATE', '只能暂停进行中的联系人')
      db.prepare("UPDATE sequence_enrollments SET status = 'paused', stop_reason = '手动暂停', updated_at = ? WHERE id = ?").run(Date.now(), row.id)
    } else {
      if (row.status !== 'paused') throw new AppError(409, 'SEQUENCE_STATE', '只能恢复已暂停的联系人')
      if (isSuppressed(sequence.org_id, row.email)) throw new AppError(409, 'SEQUENCE_STATE', '对方在退订名单里，不能恢复')
      const hasOpen = db.prepare("SELECT 1 AS ok FROM sequence_sends WHERE enrollment_id = ? AND status IN ('pending', 'failed')").get(row.id)
      const next = hasOpen
        ? null
        : nextWindowSlot(Math.max(Date.now(), row.next_send_at ?? 0), row.timezone, sequence.window_start, sequence.window_end, sequence.skip_weekends === 1, `${row.id}:${row.current_step}`)
      db.prepare("UPDATE sequence_enrollments SET status = 'active', stop_reason = '', next_send_at = COALESCE(?, next_send_at), updated_at = ? WHERE id = ?").run(next, Date.now(), row.id)
    }
    publishChange(row.sequence_id)
    return toEnrollment(db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(row.id) as unknown as EnrollmentRow)
  },

  /** 待确认 / 已发 / 失败的发送记录 */
  sends(filter: { status?: SendStatus; sequenceId?: string; limit?: number } = {}): SequenceSend[] {
    const scope = scopeClause('q')
    const where = [scope.sql]
    const params: Array<string | number> = [...scope.params]
    if (filter.status) {
      where.push('s.status = ?')
      params.push(filter.status)
    }
    if (filter.sequenceId) {
      where.push('q.id = ?')
      params.push(filter.sequenceId)
    }
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500))
    return (db.prepare(`${SEND_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.scheduled_at ASC LIMIT ?`).all(...params) as never[]).map(toSend)
  },

  /** 确认发送（可批量）；逐封发，失败的返回原因，不影响其它 */
  async approve(ids: string[]): Promise<{ sent: SequenceSend[]; failed: Array<{ id: string; error: string }> }> {
    requirePermission('email:send')
    const sent: SequenceSend[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of [...new Set(ids)].slice(0, 200)) {
      const row = db.prepare('SELECT * FROM sequence_sends WHERE id = ?').get(id) as unknown as SendRow | undefined
      const enrollment = row ? (db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(row.enrollment_id) as unknown as EnrollmentRow | undefined) : undefined
      const sequence = enrollment ? sequenceRow(enrollment.sequence_id) : undefined
      if (!row || !enrollment || !visible(sequence)) {
        failed.push({ id, error: '发送记录不存在' })
        continue
      }
      if (row.status !== 'pending' && row.status !== 'failed') {
        failed.push({ id, error: row.status === 'sent' ? '已经发出' : '已跳过' })
        continue
      }
      if (enrollment.status !== 'active' && enrollment.status !== 'paused') {
        failed.push({ id, error: '对方已回信 / 退订，已停发' })
        continue
      }
      if (isSuppressed(sequence.org_id, enrollment.email)) {
        stopEnrollment(enrollment.id, 'unsubscribed', '在退订名单里')
        failed.push({ id, error: '对方在退订名单里' })
        continue
      }
      try {
        if (enrollment.status === 'paused') db.prepare("UPDATE sequence_enrollments SET status = 'active', stop_reason = '' WHERE id = ?").run(enrollment.id)
        sent.push(await deliver(row))
      } catch (error) {
        failed.push({ id, error: messageOf(error) })
      }
      publishChange(sequence.id)
    }
    return { sent, failed }
  },

  /** 跳过某一步（草稿删除，联系人推进到下一步） */
  skip(id: string): SequenceSend {
    const row = db.prepare('SELECT * FROM sequence_sends WHERE id = ?').get(id) as unknown as SendRow | undefined
    const enrollment = row ? (db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(row.enrollment_id) as unknown as EnrollmentRow | undefined) : undefined
    if (!row || !enrollment) throw notFound('发送记录')
    const sequence = requireWritable(enrollment.sequence_id)
    if (row.status !== 'pending' && row.status !== 'failed') throw new AppError(409, 'SEQUENCE_STATE', '这封已经处理过了')
    db.prepare("UPDATE sequence_sends SET status = 'skipped', error = '手动跳过' WHERE id = ?").run(id)
    if (row.draft_id) db.prepare("DELETE FROM email_drafts WHERE id = ? AND status IN ('draft', 'failed')").run(row.draft_id)
    if (enrollment.status === 'active' || enrollment.status === 'paused') {
      if (enrollment.status === 'paused') db.prepare("UPDATE sequence_enrollments SET status = 'active', stop_reason = '' WHERE id = ?").run(enrollment.id)
      advance({ ...enrollment, status: 'active' }, sequence, null)
    }
    publishChange(sequence.id)
    return sendById(id)
  },

  suppressions(): Array<{ email: string; reason: string; createdAt: number }> {
    return (
      db.prepare('SELECT email, reason, created_at FROM email_suppressions WHERE org_id = ? ORDER BY created_at DESC LIMIT 1000').all(currentActor().orgId) as Array<{
        email: string
        reason: string
        created_at: number
      }>
    ).map((r) => ({ email: r.email, reason: r.reason, createdAt: r.created_at }))
  },

  /** 加入退订名单：所有序列里的该地址立即停发 */
  addSuppression(input: unknown): { email: string; stopped: number } {
    requirePermission('data:write')
    const data = parse(z.object({ email: z.string().trim().toLowerCase().email('邮箱格式不对').max(320), reason: z.string().trim().max(300).optional() }).strict(), input)
    const orgId = currentActor().orgId
    suppress(orgId, data.email, data.reason || '手动加入')
    const rows = db
      .prepare(`SELECT e.id, e.sequence_id FROM sequence_enrollments e JOIN sequences q ON q.id = e.sequence_id WHERE q.org_id = ? AND e.email = ? AND e.status IN ('active', 'paused')`)
      .all(orgId, data.email) as Array<{ id: string; sequence_id: string }>
    for (const r of rows) {
      stopEnrollment(r.id, 'unsubscribed', '已加入退订名单')
      publishChange(r.sequence_id)
    }
    return { email: data.email, stopped: rows.length }
  },

  removeSuppression(email: string): void {
    requirePermission('data:write')
    db.prepare('DELETE FROM email_suppressions WHERE org_id = ? AND email = ?').run(currentActor().orgId, email.trim().toLowerCase())
  },

  /** 预览某一步给某联系人渲染出的邮件 */
  preview(id: string, input: unknown): { subject: string; body: string } {
    const row = requireSequence(id)
    const data = parse(z.object({ stepIndex: z.number().int().min(0).max(MAX_STEPS), name: z.string().max(200).optional(), company: z.string().max(300).optional(), country: z.string().max(100).optional() }).strict(), input)
    const { subject, body } = renderStep(row, { name: data.name ?? 'Anna Schmidt', company: data.company ?? 'Example GmbH', country: data.country ?? 'DE' } as EnrollmentRow, data.stepIndex)
    return { subject, body }
  },
}

class SequenceScheduler {
  private timer: NodeJS.Timeout | null = null
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void tickSequences().catch((error) => console.warn('[lulux-eta] 开发信调度失败：', messageOf(error))), 60_000)
    this.timer.unref()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export const sequenceScheduler = new SequenceScheduler()
