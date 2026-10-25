import { z } from 'zod'
import { canonicalAgentId } from '../../agents.js'
import { db } from '../../db.js'
import { currentActor } from '../../context.js'
import { AppError, notFound } from '../../errors.js'
import { assertOwnRow, can, requirePermission, isOwnRow, ownerOnlyClause, type OwnedRow, type Visibility } from '../../security/access.js'
import { newId } from '../../utils/id.js'
import { parse } from '../../validation.js'
import { isKnownKernelAgentId } from '../agent-service.js'
import { onMemberStatusChange } from '../member-events.js'
import { sessionService } from '../session-service.js'
import { settingsService } from '../settings-service.js'
import { isValidTimeZone, nextFire, normalizeSpec, previewFires, SpecError, type ScheduleSpec } from './schedule-spec.js'
import type { RunStatus } from '../workflow/dag.js'
import { workflowRow } from '../workflow/workflow-service.js'

/**
 * 定时任务：触发规则（once / interval / daily / weekly / cron，按 IANA 时区）+ 目标（工作流 / 一段提示词）。
 * 可见性与权限同工作流。nextRunAt 持久化，调度器（scheduler.ts）按它触发。
 */

export type ScheduleTarget =
  | { type: 'workflow'; workflowId: string; input?: string }
  | { type: 'prompt'; kernelId: string; prompt: string; sessionMode: 'new' | 'append'; sessionId?: string | null }

export interface Schedule {
  id: string
  name: string
  target: ScheduleTarget
  spec: ScheduleSpec
  timezone: string
  enabled: boolean
  /** 负责人账号已停用：任务暂停，账号启用后自动恢复 */
  ownerPaused: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: RunStatus | null
  lastError: string | null
  ownerId: string
  visibility: Visibility
  teamId: string | null
  createdAt: number
  updatedAt: number
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  status: RunStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
  workflowRunId: string | null
  sessionId: string | null
  /** 补跑（应用关闭期间错过的那一次） */
  missed: boolean
}

export interface ScheduleRow extends OwnedRow {
  id: string
  name: string
  target: string
  spec: string
  timezone: string
  enabled: number
  owner_paused?: number
  anchor_at: number
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  last_error: string | null
  visibility: string
  team_id: string | null
  created_at: number
  updated_at: number
}

interface ScheduleRunRow {
  id: string
  schedule_id: string
  status: string
  started_at: number
  finished_at: number | null
  error: string | null
  workflow_run_id: string | null
  session_id: string | null
  missed: number
}

const specInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: z.number().int().positive() }),
  z.object({ type: z.literal('interval'), minutes: z.number().int() }),
  z.object({ type: z.literal('daily'), time: z.string().max(10) }),
  z.object({ type: z.literal('weekly'), days: z.array(z.number().int()).max(7), time: z.string().max(10) }),
  z.object({ type: z.literal('cron'), expr: z.string().min(1).max(200) }),
])

const targetInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workflow'), workflowId: z.string().min(1).max(80), input: z.string().max(100_000).optional() }),
  z.object({
    type: z.literal('prompt'),
    kernelId: z.string().min(1).max(80),
    prompt: z.string().trim().min(1, '提示词不能为空').max(100_000),
    sessionMode: z.enum(['new', 'append']).default('new'),
    sessionId: z.string().max(80).nullable().optional(),
  }),
])

const timezoneInput = z.string().trim().max(80)

export const scheduleCreateInput = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(120),
    target: targetInput,
    spec: specInput,
    timezone: timezoneInput.optional(),
    enabled: z.boolean().default(true),
    visibility: z.literal('private', { message: '仅本人可见，不支持共享（team / org）' }).optional(),
    teamId: z.null().optional(),
  })
  .strip()

export const schedulePatchInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    target: targetInput,
    spec: specInput,
    timezone: timezoneInput,
    enabled: z.boolean(),
    visibility: z.literal('private', { message: '仅本人可见，不支持共享（team / org）' }),
    teamId: z.null(),
  })
  .partial()
  .strip()

export const previewInput = z.object({ spec: specInput, timezone: timezoneInput.optional(), count: z.number().int().min(1).max(20).optional() })

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 默认时区：设置里的 timezone，否则系统时区 */
export function defaultTimeZone(): string {
  const configured = settingsService.get('timezone') ?? ''
  if (configured && isValidTimeZone(configured)) return configured
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function checkTimeZone(zone: string | undefined): string {
  const tz = zone || defaultTimeZone()
  if (!isValidTimeZone(tz)) throw new AppError(400, 'INVALID_TIMEZONE', `不是有效的 IANA 时区名：${tz}`)
  return tz
}

export function checkSpec(spec: ScheduleSpec, timezone: string, now = Date.now(), requireFuture = true): ScheduleSpec {
  let normalized: ScheduleSpec
  try {
    normalized = normalizeSpec(spec)
  } catch (error) {
    if (error instanceof SpecError) throw new AppError(400, 'INVALID_SCHEDULE', error.message)
    throw error
  }
  if (requireFuture && normalized.type === 'once' && normalized.at <= now) {
    throw new AppError(400, 'INVALID_SCHEDULE', '一次性任务的时间已经过去')
  }
  if (normalized.type === 'cron' && nextFire(normalized, timezone, now) === null) {
    throw new AppError(400, 'INVALID_SCHEDULE', 'cron 表达式永远不会触发')
  }
  return normalized
}

/** 目标校验：工作流可见且自己能运行；提示词的内核已知；追加模式的会话可写 */
function checkTarget(target: z.infer<typeof targetInput>): ScheduleTarget {
  if (target.type === 'workflow') {
    const row = workflowRow(target.workflowId)
    if (!row || !isOwnRow(row)) throw new AppError(400, 'WORKFLOW_NOT_FOUND', '工作流不存在')
    if (!can('data:write')) throw new AppError(403, 'FORBIDDEN', '只能为自己负责的工作流设置定时任务')
    return { type: 'workflow', workflowId: target.workflowId, ...(target.input ? { input: target.input } : {}) }
  }
  const kernelId = canonicalAgentId(target.kernelId)
  if (!isKnownKernelAgentId(kernelId)) throw new AppError(400, 'UNKNOWN_KERNEL', `内核不存在：${target.kernelId}`)
  if (target.sessionMode === 'append') {
    if (!target.sessionId) throw new AppError(400, 'VALIDATION_ERROR', '追加到会话时需要 sessionId')
    if (!sessionService.visible(target.sessionId)) throw new AppError(400, 'SESSION_NOT_FOUND', '会话不存在')
    // 定时任务仅本人：只能追加到自己创建的会话（不能往别人建的群里定时发消息）
    if (!sessionService.writable(target.sessionId) || !sessionService.owned(target.sessionId)) throw new AppError(403, 'FORBIDDEN', '只能追加到自己的会话')
  }
  return {
    type: 'prompt',
    kernelId,
    prompt: target.prompt,
    sessionMode: target.sessionMode,
    sessionId: target.sessionMode === 'append' ? target.sessionId! : null,
  }
}

export function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    target: parseJson<ScheduleTarget>(row.target, { type: 'workflow', workflowId: '' }),
    spec: parseJson<ScheduleSpec>(row.spec, { type: 'interval', minutes: 60 }),
    timezone: row.timezone,
    enabled: Number(row.enabled) === 1,
    ownerPaused: Number(row.owner_paused ?? 0) === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as RunStatus | null) ?? null,
    lastError: row.last_error,
    ownerId: row.owner_id,
    visibility: (row.visibility as Visibility) ?? 'private',
    teamId: row.team_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toScheduleRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    workflowRunId: row.workflow_run_id,
    sessionId: row.session_id,
    missed: Number(row.missed) === 1,
  }
}

export function scheduleRow(id: string): ScheduleRow | undefined {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as ScheduleRow | undefined
}

export function visibleScheduleRow(id: string): ScheduleRow {
  const row = scheduleRow(id)
  if (!row || !isOwnRow(row)) throw notFound('定时任务')
  return row
}

export function scheduleRunRow(id: string): ScheduleRunRow | undefined {
  return db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as unknown as ScheduleRunRow | undefined
}

/** 规则下一次触发（启用时）；一次性任务过期为 null */
export function computeNext(spec: ScheduleSpec, timezone: string, after: number, anchor: number): number | null {
  return nextFire(spec, timezone, after, anchor)
}

/** 变更通知（调度器重新安排定时器）；由 scheduler.ts 注册，避免循环依赖 */
let onChange: () => void = () => undefined
export function setScheduleChangeListener(listener: () => void): void {
  onChange = listener
}

/**
 * 重新计算下一次触发时间（从现在起，暂停期间错过的触发不补跑）：负责人账号重新启用、或交接给新负责人后调用。
 * 只处理启用且未暂停的任务；返回实际改动的条数。
 */
export function rescheduleSchedules(rows: ScheduleRow[], now = Date.now()): number {
  let changed = 0
  for (const row of rows) {
    if (Number(row.enabled) !== 1 || Number(row.owner_paused ?? 0) === 1) continue
    const schedule = toSchedule(row)
    let next: number | null = null
    try {
      next =
        schedule.spec.type === 'once'
          ? schedule.spec.at > now
            ? schedule.spec.at
            : null
          : computeNext(schedule.spec, schedule.timezone, now, row.anchor_at)
    } catch {
      next = null
    }
    if (next !== row.next_run_at) {
      db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next, row.id)
      changed += 1
    }
  }
  onChange()
  return changed
}

export function rescheduleOwner(ownerId: string, now = Date.now()): number {
  const rows = db.prepare('SELECT * FROM schedules WHERE owner_id = ?').all(ownerId) as unknown as ScheduleRow[]
  return rescheduleSchedules(rows, now)
}

onMemberStatusChange((userId, disabled) => {
  if (disabled) onChange()
  else rescheduleOwner(userId)
})

export const scheduleService = {
  list(): Schedule[] {
    const scope = ownerOnlyClause('s')
    const rows = db
      .prepare(`SELECT s.* FROM schedules s WHERE ${scope.sql} ORDER BY s.created_at DESC`)
      .all(...scope.params) as unknown as ScheduleRow[]
    return rows.map(toSchedule)
  },

  get(id: string): Schedule {
    return toSchedule(visibleScheduleRow(id))
  },

  create(input: unknown): Schedule {
    requirePermission('workflow:manage')
    const data = parse(scheduleCreateInput, input)
    const timezone = checkTimeZone(data.timezone)
    const now = Date.now()
    const spec = checkSpec(data.spec as ScheduleSpec, timezone, now)
    const target = checkTarget(data.target)
    const actor = currentActor()
    const owner = { orgId: actor.orgId, ownerId: actor.id, visibility: 'private' as const, teamId: null }
    const id = newId('sch')
    const next = data.enabled ? computeNext(spec, timezone, now, now) : null
    db.prepare(
      `INSERT INTO schedules (id, name, target, spec, timezone, enabled, anchor_at, next_run_at, org_id, owner_id, visibility, team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, data.name, JSON.stringify(target), JSON.stringify(spec), timezone, data.enabled ? 1 : 0, now, next, owner.orgId, owner.ownerId, owner.visibility, owner.teamId, now, now)
    onChange()
    return scheduleService.get(id)
  },

  update(id: string, input: unknown): Schedule {
    requirePermission('workflow:manage')
    const patch = parse(schedulePatchInput, input)
    const row = visibleScheduleRow(id)
    assertOwnRow(row, '定时任务')
    const current = toSchedule(row)
    const now = Date.now()
    const timezone = patch.timezone !== undefined ? checkTimeZone(patch.timezone) : current.timezone
    const specChanged = patch.spec !== undefined || patch.timezone !== undefined
    const spec = patch.spec !== undefined ? checkSpec(patch.spec as ScheduleSpec, timezone, now) : current.spec
    const target = patch.target !== undefined ? checkTarget(patch.target) : current.target
    const enabled = patch.enabled ?? current.enabled
    // 改了规则 → 间隔重新从现在起算；重新启用 → 从现在算下一次（不补跑停用期间的）
    const anchor = specChanged ? now : row.anchor_at
    let next = row.next_run_at
    if (!enabled) next = null
    else if (specChanged || !current.enabled || next === null) next = computeNext(spec, timezone, now, anchor)
    const visibility = 'private'
    const teamId = null
    db.prepare(
      `UPDATE schedules SET name = ?, target = ?, spec = ?, timezone = ?, enabled = ?, anchor_at = ?, next_run_at = ?, visibility = ?, team_id = ?, updated_at = ? WHERE id = ?`,
    ).run(patch.name ?? row.name, JSON.stringify(target), JSON.stringify(spec), timezone, enabled ? 1 : 0, anchor, next, visibility, teamId, now, id)
    onChange()
    return scheduleService.get(id)
  },

  remove(id: string): void {
    requirePermission('workflow:manage')
    const row = visibleScheduleRow(id)
    assertOwnRow(row, '定时任务')
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
    onChange()
  },

  runs(id: string, limit = 20): ScheduleRun[] {
    visibleScheduleRow(id)
    const rows = db
      .prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(id, Math.max(1, Math.min(100, limit))) as unknown as ScheduleRunRow[]
    return rows.map(toScheduleRun)
  },

  preview(input: unknown, now = Date.now()): { next: number[] } {
    const data = parse(previewInput, input)
    const timezone = checkTimeZone(data.timezone)
    const spec = checkSpec(data.spec as ScheduleSpec, timezone, now, false)
    return { next: previewFires(spec, timezone, now, data.count ?? 5, now) }
  },

  /** 工作流被删除：指向它的定时任务停用并记下原因 */
  disableForWorkflow(workflowId: string): void {
    const rows = db.prepare("SELECT id, target FROM schedules WHERE target LIKE '%\"workflow\"%'").all() as Array<{ id: string; target: string }>
    for (const row of rows) {
      const target = parseJson<ScheduleTarget>(row.target, { type: 'workflow', workflowId: '' })
      if (target.type === 'workflow' && target.workflowId === workflowId) {
        db.prepare("UPDATE schedules SET enabled = 0, next_run_at = NULL, last_error = '目标工作流已删除', updated_at = ? WHERE id = ?").run(Date.now(), row.id)
      }
    }
    onChange()
  },
}
