import { db } from '../../db.js'
import { LOCAL_ACTOR, runAs, type Actor } from '../../context.js'
import { AppError, messageOf } from '../../errors.js'
import { assertOwnRow } from '../../security/access.js'
import type { EventScope } from '../events.js'
import { newId } from '../../utils/id.js'
import { actorFor } from '../auth-service.js'
import { auditService } from '../audit-service.js'
import { chatOrchestrator, type ChatSink } from '../chat/orchestrator.js'
import { isShuttingDown, SHUTDOWN_INTERRUPTED_MESSAGE } from '../chat/run-registry.js'
import { eventBus } from '../events.js'
import { sessionService } from '../session-service.js'
import { settingsService } from '../settings-service.js'
import { clearNonInteractiveApproval, setNonInteractiveApproval } from '../tool-approval.js'
import { skipMemoryExtractionUntilNow } from '../memory/extractor.js'
import { setSessionOrigin } from '../memory/session-policy.js'
import type { RunStatus } from '../workflow/dag.js'
import { workflowRunner } from '../workflow/workflow-runner.js'
import {
  computeNext,
  scheduleRunRow,
  setScheduleChangeListener,
  toSchedule,
  toScheduleRun,
  visibleScheduleRow,
  type ScheduleRow,
  type ScheduleRun,
} from './schedule-service.js'

/**
 * 进程内调度器：按持久化的 next_run_at 触发。
 * - 定时器对准最近的一次触发（最长 60 秒复查一次），规则变更时立即重排；
 * - 错过的触发（应用关闭 / 休眠期间）：在补跑窗口内（设置 scheduleMissedRunHours，默认 24 小时，0 = 不补跑）
 *   只补跑一次，否则记一条 skipped 并跳到下一次；
 * - 同一任务上一次还没结束时，新的触发记为 skipped；
 * - 以任务负责人的身份运行（账号已删除则失败；账号停用期间任务暂停，owner_paused）；结果经事件总线推送 `schedule.run`（通知铃铛）。
 */

const MAX_TIMER_MS = 60_000
/** 晚于计划时间超过这个值的触发记为补跑（missed） */
const MISSED_GRACE_MS = 2 * 60_000

let timer: NodeJS.Timeout | null = null
let started = false
const running = new Map<string, Promise<ScheduleRun>>()

function missedWindowMs(): number {
  const hours = Number.parseInt(settingsService.get('scheduleMissedRunHours') ?? '24', 10)
  return (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3_600_000
}

/** 任务负责人；账号不存在 / 已停用返回 null（不回退到本机 owner） */
function ownerActor(row: ScheduleRow): Actor | null {
  if (row.owner_id === LOCAL_ACTOR.id) return { ...LOCAL_ACTOR }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.owner_id) as unknown as
    | (Parameters<typeof actorFor>[0] & { disabled: number })
    | undefined
  if (!user || Number(user.disabled) === 1) return null
  return actorFor(user, null)
}

/** 定时任务事件只推给负责人本人（仅本人，契约 §5.6a） */
function scopeOf(row: ScheduleRow): EventScope {
  return { userId: row.owner_id, orgId: row.org_id }
}

function finishScheduleRun(row: ScheduleRow, runId: string, status: RunStatus, error: string | null, extra: { workflowRunId?: string | null; sessionId?: string | null } = {}): ScheduleRun {
  const now = Date.now()
  db.prepare(
    `UPDATE schedule_runs SET status = ?, error = ?, finished_at = ?, workflow_run_id = COALESCE(?, workflow_run_id), session_id = COALESCE(?, session_id) WHERE id = ?`,
  ).run(status, error, now, extra.workflowRunId ?? null, extra.sessionId ?? null, runId)
  db.prepare('UPDATE schedules SET last_status = ?, last_error = ? WHERE id = ?').run(status, error, row.id)
  eventBus.publish('schedule.run', { type: 'schedule.run', scheduleId: row.id, runId, name: row.name, status, error }, scopeOf(row))
  return toScheduleRun(scheduleRunRow(runId)!)
}

/** 记一条不执行的运行（跳过 / 失败），不占用“运行中” */
function recordRun(row: ScheduleRow, status: RunStatus, error: string, missed: boolean): ScheduleRun {
  const now = Date.now()
  const id = newId('schr')
  db.prepare('INSERT INTO schedule_runs (id, schedule_id, status, started_at, finished_at, error, missed) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    row.id,
    status,
    now,
    now,
    error,
    missed ? 1 : 0,
  )
  db.prepare('UPDATE schedules SET last_status = ?, last_error = ? WHERE id = ?').run(status, error, row.id)
  eventBus.publish('schedule.run', { type: 'schedule.run', scheduleId: row.id, runId: id, name: row.name, status, error }, scopeOf(row))
  return toScheduleRun(scheduleRunRow(id)!)
}

/** 提示词目标：在新会话 / 指定会话里运行一次（非交互：写工具自动拒绝） */
async function runPrompt(row: ScheduleRow, runId: string, actor: Actor): Promise<{ status: RunStatus; error: string | null; sessionId: string }> {
  const schedule = toSchedule(row)
  if (schedule.target.type !== 'prompt') throw new Error('目标类型不是提示词')
  const target = schedule.target
  return await runAs(actor, async () => {
    let sessionId: string
    if (target.sessionMode === 'append' && target.sessionId) {
      if (!sessionService.visible(target.sessionId) || !sessionService.writable(target.sessionId) || !sessionService.owned(target.sessionId)) {
        throw new AppError(404, 'SESSION_NOT_FOUND', '要追加的会话不存在或没有权限')
      }
      sessionId = target.sessionId
    } else {
      const date = new Intl.DateTimeFormat('zh-CN', { timeZone: schedule.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
      sessionId = sessionService.create({ title: `[定时] ${schedule.name} · ${date}`.slice(0, 120), agentIds: [target.kernelId] }).id
      // 持久化来源：定时任务会话永不自动提取记忆、不提供记忆工具（run 结束后非交互标记会清掉，提取有空闲延迟）
      setSessionOrigin(sessionId, 'schedule')
    }
    db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(sessionId, runId)
    setNonInteractiveApproval(sessionId, false)
    try {
      const prepared = chatOrchestrator.prepare(sessionId)
      let error: string | null = null
      let replied = false
      const sink: ChatSink = {
        send(event, payload) {
          const data = payload as Record<string, unknown>
          if (event === 'error') error = typeof data.message === 'string' ? data.message : '运行失败'
          if (event === 'done' && !data.aborted) replied = true
        },
      }
      await chatOrchestrator.run(prepared, { mode: 'send', content: target.prompt, appendUser: true }, sink, new AbortController().signal)
      if (!replied && isShuttingDown()) return { status: 'failed', error: SHUTDOWN_INTERRUPTED_MESSAGE, sessionId }
      if (error) return { status: 'failed', error, sessionId }
      if (!replied) return { status: 'failed', error: '没有产生回复', sessionId }
      return { status: 'succeeded', error: null, sessionId }
    } finally {
      clearNonInteractiveApproval(sessionId)
      // 追加到已有会话：这次运行的消息不进入之后的自动提取
      if (target.sessionMode === 'append') skipMemoryExtractionUntilNow(sessionId, actor.id)
    }
  })
}

async function execute(row: ScheduleRow, runId: string, actor: Actor): Promise<ScheduleRun> {
  const schedule = toSchedule(row)
  try {
    if (schedule.target.type === 'workflow') {
      const run = workflowRunner.start(schedule.target.workflowId, {
        input: schedule.target.input ?? '',
        trigger: 'schedule',
        scheduleId: row.id,
        actor,
      })
      db.prepare('UPDATE schedule_runs SET workflow_run_id = ? WHERE id = ?').run(run.id, runId)
      const finished = await workflowRunner.wait(run.id)
      return finishScheduleRun(row, runId, finished.status, finished.error, { workflowRunId: run.id })
    }
    const result = await runPrompt(row, runId, actor)
    return finishScheduleRun(row, runId, result.status, result.error, { sessionId: result.sessionId })
  } catch (error) {
    return finishScheduleRun(row, runId, 'failed', messageOf(error))
  }
}

/** 开始一次运行（后台执行），返回刚创建的 ScheduleRun */
function fire(row: ScheduleRow, options: { missed: boolean; manual: boolean }): ScheduleRun {
  if (running.has(row.id)) return recordRun(row, 'skipped', '上一次运行尚未结束', options.missed)
  const actor = ownerActor(row)
  if (!actor) return recordRun(row, 'failed', '任务负责人的账号不存在或已停用', options.missed)
  const now = Date.now()
  const id = newId('schr')
  db.prepare("INSERT INTO schedule_runs (id, schedule_id, status, started_at, missed) VALUES (?, ?, 'running', ?, ?)").run(id, row.id, now, options.missed ? 1 : 0)
  db.prepare("UPDATE schedules SET last_run_at = ?, last_status = 'running', last_error = NULL WHERE id = ?").run(now, row.id)
  auditService.record({
    action: options.manual ? 'schedule.run_now' : 'schedule.fire',
    entityType: 'schedule',
    entityId: row.id,
    summary: `${options.manual ? '立即运行' : options.missed ? '补跑' : '触发'}定时任务「${row.name}」`,
    actor,
    orgId: row.org_id,
  })
  eventBus.publish('schedule.run', { type: 'schedule.run', scheduleId: row.id, runId: id, name: row.name, status: 'running', error: null }, scopeOf(row))
  const done = execute(row, id, actor).finally(() => running.delete(row.id))
  running.set(row.id, done)
  return toScheduleRun(scheduleRunRow(id)!)
}

export const scheduler = {
  /** 处理所有到期的任务；返回本次触发 / 跳过的数量 */
  tick(now = Date.now()): { fired: number; skipped: number } {
    const due = db
      .prepare('SELECT * FROM schedules WHERE enabled = 1 AND owner_paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC')
      .all(now) as unknown as ScheduleRow[]
    const window = missedWindowMs()
    let fired = 0
    let skipped = 0
    for (const row of due) {
      const schedule = toSchedule(row)
      const lateness = now - row.next_run_at!
      // 先推进 next_run_at，进程中途退出也不会重复触发
      let next: number | null = null
      try {
        // 一次性任务触发（或错过）一次后即结束
        next = schedule.spec.type === 'once' ? null : computeNext(schedule.spec, schedule.timezone, now, row.anchor_at)
      } catch {
        next = null
      }
      db.prepare('UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?').run(next, next === null && schedule.spec.type === 'once' ? 0 : 1, row.id)
      if (lateness <= window) {
        fire(row, { missed: lateness > MISSED_GRACE_MS, manual: false })
        fired += 1
      } else {
        recordRun(row, 'skipped', `错过了 ${new Date(row.next_run_at!).toISOString()} 的运行（超出补跑窗口）`, true)
        skipped += 1
      }
    }
    return { fired, skipped }
  },

  /** 立即运行一次（不影响 nextRunAt） */
  runNow(id: string): ScheduleRun {
    const row = visibleScheduleRow(id)
    assertOwnRow(row, '定时任务')
    return fire(row, { missed: false, manual: true })
  },

  /** 等待某任务当前的运行结束（测试用） */
  async waitIdle(id: string): Promise<void> {
    const current = running.get(id)
    if (current) await current
  },

  arm(): void {
    if (!started) return
    if (timer) clearTimeout(timer)
    const row = db.prepare('SELECT MIN(next_run_at) AS t FROM schedules WHERE enabled = 1 AND owner_paused = 0 AND next_run_at IS NOT NULL').get() as { t: number | null }
    const delay = row.t === null ? MAX_TIMER_MS : Math.max(0, Math.min(MAX_TIMER_MS, row.t - Date.now()))
    timer = setTimeout(() => {
      timer = null
      try {
        scheduler.tick()
      } catch (error) {
        console.warn('[lulux-eta] scheduler tick failed:', messageOf(error))
      }
      scheduler.arm()
    }, delay)
    timer.unref()
  },

  start(): void {
    if (started) return
    started = true
    workflowRunner.recover()
    db.prepare("UPDATE schedule_runs SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued', 'running')").run(SHUTDOWN_INTERRUPTED_MESSAGE, Date.now())
    db.prepare("UPDATE schedules SET last_status = 'failed', last_error = ? WHERE last_status IN ('queued', 'running')").run(SHUTDOWN_INTERRUPTED_MESSAGE)
    try {
      scheduler.tick()
    } catch (error) {
      console.warn('[lulux-eta] scheduler startup tick failed:', messageOf(error))
    }
    scheduler.arm()
  },

  stop(): void {
    started = false
    if (timer) clearTimeout(timer)
    timer = null
    workflowRunner.abortAll()
  },
}

setScheduleChangeListener(() => scheduler.arm())

