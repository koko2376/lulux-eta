import { z } from 'zod'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError, notFound } from '../errors.js'
import { assertCanModify, requireDelete, seesAll, liveClause, type OwnedRow } from '../security/access.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'
import { CUSTOMER_STAGES, customerService } from './customer-service.js'
import { eventBus } from './events.js'
import { trash } from './trash.js'
import { dealService } from './deal-service.js'
import { orderService } from './order-service.js'

/**
 * CRM 任务 / 跟进提醒。
 * 可见性：自己负责的任务；admin/owner 看全部；关联客户可见的任务对能看到客户的人可见（随客户，契约 5.6）。
 * 可写：负责人本人或 admin/owner（且有 data:write）。
 */
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const

export interface Task {
  id: string
  title: string
  notes: string
  customerId: string | null
  customerName: string | null
  quoteId: string | null
  dueAt: number | null
  status: (typeof TASK_STATUSES)[number]
  priority: (typeof TASK_PRIORITIES)[number]
  source: string
  ownerId: string
  overdue: boolean
  createdAt: number
  updatedAt: number
  doneAt: number | null
}

interface TaskRow {
  id: string
  title: string
  notes: string
  customer_id: string | null
  quote_id: string | null
  due_at: number | null
  status: string
  priority: string
  source: string
  org_id: string
  owner_id: string
  created_at: number
  updated_at: number
  done_at: number | null
  company?: string | null
}

/** 截止时间：毫秒时间戳、ISO 日期/时间字符串 */
const dueInput = z.union([z.number().int().positive(), z.string().trim().min(1).max(40)]).transform((value, ctx) => {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: 'custom', message: '截止时间格式不正确（ISO 日期，如 2026-10-25 或 2026-10-25T09:00:00+08:00）' })
    return z.NEVER
  }
  return ms
})

export const taskCreateInput = z
  .object({
    title: z.string().trim().min(1, '标题不能为空').max(300),
    notes: z.string().max(5000).default(''),
    customerId: z.string().max(80).nullable().optional(),
    quoteId: z.string().max(80).nullable().optional(),
    dueAt: dueInput.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).default('normal'),
    source: z.string().max(40).optional(),
  })
  .strict()

export const taskPatchInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(5000),
    dueAt: dueInput.nullable(),
    priority: z.enum(TASK_PRIORITIES),
    status: z.enum(TASK_STATUSES),
  })
  .partial()
  .strict()

export const taskListInput = z.object({
  status: z.enum([...TASK_STATUSES, 'all']).default('open'),
  customerId: z.string().max(80).optional(),
  /** overdue：已过期未完成；today：今天到期（含已过期）；week：7 天内 */
  due: z.enum(['overdue', 'today', 'week']).optional(),
  mine: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

function toTask(row: TaskRow, now = Date.now()): Task {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    customerId: row.customer_id,
    customerName: row.company ?? null,
    quoteId: row.quote_id,
    dueAt: row.due_at,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    source: row.source,
    ownerId: row.owner_id,
    overdue: row.status === 'open' && row.due_at !== null && row.due_at < now,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
  }
}

function rowById(id: string): TaskRow | undefined {
  return db
    .prepare('SELECT t.*, c.company AS company FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id WHERE t.id = ? AND t.deleted_at IS NULL')
    .get(id) as unknown as TaskRow | undefined
}

function taskVisible(row: TaskRow): boolean {
  const actor = currentActor()
  if (row.org_id !== actor.orgId) return false
  if (seesAll(actor) || row.owner_id === actor.id) return true
  return Boolean(row.customer_id && customerService.isVisible(row.customer_id))
}

function startOfTomorrow(now: number): number {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export const taskService = {
  list(input: unknown): { items: Task[]; total: number } {
    const query = parse(taskListInput, input)
    const actor = currentActor()
    const now = Date.now()
    const scope = liveClause('c')
    const mine = query.mine === true || query.mine === '1' || query.mine === 'true'
    const where: string[] = ['t.org_id = ?', 't.deleted_at IS NULL']
    const params: Array<string | number> = [actor.orgId]
    if (mine || !seesAll(actor)) {
      if (mine) {
        where.push('t.owner_id = ?')
        params.push(actor.id)
      } else {
        where.push(`(t.owner_id = ? OR (t.customer_id IS NOT NULL AND ${scope.sql}))`)
        params.push(actor.id, ...scope.params)
      }
    }
    if (query.status !== 'all') {
      where.push('t.status = ?')
      params.push(query.status)
    }
    if (query.customerId) {
      where.push('t.customer_id = ?')
      params.push(query.customerId)
    }
    if (query.due) {
      where.push("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ?")
      params.push(query.due === 'overdue' ? now : query.due === 'today' ? startOfTomorrow(now) : now + 7 * 86_400_000)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const from = 'FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id'
    const total = Number((db.prepare(`SELECT COUNT(*) AS n ${from} ${clause}`).get(...params) as unknown as { n: number }).n)
    const rows = db
      .prepare(
        `SELECT t.*, c.company AS company ${from} ${clause}
         ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ASC, t.created_at DESC LIMIT ?`,
      )
      .all(...params, query.limit) as unknown as TaskRow[]
    return { items: rows.map((row) => toTask(row, now)), total }
  },

  require(id: string): Task {
    const row = rowById(id)
    if (!row || !taskVisible(row)) throw notFound('任务')
    return toTask(row)
  },

  create(input: unknown): Task {
    const data = parse(taskCreateInput, input)
    const actor = currentActor()
    if (data.customerId) {
      // 能看到客户就能给它建跟进任务（与共享客户可加 Activity 一致）
      customerService.require(data.customerId)
    }
    if (data.quoteId) {
      const quote = db.prepare('SELECT customer_id FROM quotes WHERE id = ? AND deleted_at IS NULL').get(data.quoteId) as unknown as { customer_id: string } | undefined
      if (!quote || !customerService.isVisible(quote.customer_id)) throw new AppError(400, 'QUOTE_NOT_FOUND', '报价单不存在')
    }
    const now = Date.now()
    const id = newId('tsk')
    db.prepare(
      `INSERT INTO tasks (id, title, notes, customer_id, quote_id, due_at, status, priority, source, org_id, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.title,
      data.notes,
      data.customerId ?? null,
      data.quoteId ?? null,
      data.dueAt ?? null,
      data.priority,
      data.source ?? 'user',
      actor.orgId,
      actor.id,
      now,
      now,
    )
    return taskService.require(id)
  },

  update(id: string, input: unknown): Task {
    const patch = parse(taskPatchInput, input)
    const row = rowById(id)
    if (!row || !taskVisible(row)) throw notFound('任务')
    assertCanModify(row as OwnedRow, '任务')
    const now = Date.now()
    const status = patch.status ?? row.status
    const doneAt = status === 'done' ? (row.done_at ?? now) : null
    db.prepare(
      `UPDATE tasks SET title = ?, notes = ?, due_at = ?, priority = ?, status = ?, done_at = ?, updated_at = ?,
         reminded_at = CASE WHEN ? THEN NULL ELSE reminded_at END WHERE id = ?`,
    ).run(
      patch.title ?? row.title,
      patch.notes ?? row.notes,
      patch.dueAt !== undefined ? patch.dueAt : row.due_at,
      patch.priority ?? row.priority,
      status,
      doneAt,
      now,
      patch.dueAt !== undefined ? 1 : 0,
      id,
    )
    if (patch.status === 'done' && row.status !== 'done' && row.customer_id) {
      customerService.recordActivity(row.customer_id, 'note', `完成跟进任务：${patch.title ?? row.title}`)
    }
    return taskService.require(id)
  },

  /** 删除 = 移入回收站，审计里存删除前的快照 */
  remove(id: string): void {
    requireDelete('task:delete')
    const row = rowById(id)
    if (!row || !taskVisible(row)) throw notFound('任务')
    assertCanModify(row as OwnedRow, '任务')
    if (!trash.mark('task', id)) throw notFound('任务')
    trash.audit('task', id, `任务「${row.title}」移入回收站`, toTask(row))
  },
}

/**
 * 到期提醒：把已到期（或 leadMinutes 内到期）、未完成、未提醒过的任务经 /api/events 推给负责人（事件 `task.due`），
 * 每条只推一次（reminded_at）；改到期时间会重新提醒。定时器每分钟一次（index.ts 启动）。
 */
let reminderTimer: NodeJS.Timeout | null = null
export const taskReminders = {
  tick(now = Date.now(), leadMinutes = 0): number {
    const rows = db
      .prepare(
        `SELECT t.*, c.company AS company FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
         WHERE t.status = 'open' AND t.deleted_at IS NULL AND t.due_at IS NOT NULL AND t.due_at <= ? AND t.reminded_at IS NULL LIMIT 200`,
      )
      .all(now + leadMinutes * 60_000) as unknown as TaskRow[]
    for (const row of rows) {
      db.prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').run(now, row.id)
      eventBus.publish('task.due', { task: toTask(row, now) }, { userId: row.owner_id, orgId: row.org_id })
    }
    return rows.length
  },
  start(): void {
    if (reminderTimer) return
    reminderTimer = setInterval(() => {
      try {
        taskReminders.tick()
      } catch (error) {
        console.warn('[lulux-eta] task reminders failed:', error instanceof Error ? error.message : String(error))
      }
    }, 60_000)
    reminderTimer.unref()
  },
  stop(): void {
    if (reminderTimer) clearInterval(reminderTimer)
    reminderTimer = null
  },
}

/** 销售漏斗统计（按当前用户可见范围） */
export const pipelineService = {
  stats(input: unknown = {}) {
    const { staleDays } = parse(z.object({ staleDays: z.coerce.number().int().min(1).max(365).default(14) }), input)
    const scope = liveClause('c')
    const now = Date.now()
    const stageRows = db
      .prepare(`SELECT c.stage AS stage, COUNT(*) AS n FROM customers c WHERE ${scope.sql} GROUP BY c.stage`)
      .all(...scope.params) as unknown as Array<{ stage: string; n: number }>
    const count = (stage: string): number => Number(stageRows.find((row) => row.stage === stage)?.n ?? 0)
    const total = stageRows.reduce((sum, row) => sum + Number(row.n), 0)
    // 漏斗：到达某阶段（或更后阶段，lost 不计入“到达”）
    const order = CUSTOMER_STAGES.filter((stage) => stage !== 'lost')
    const reached = (stage: string): number => order.slice(order.indexOf(stage as (typeof order)[number])).reduce((sum, s) => sum + count(s), 0)
    const funnel = order.map((stage, index) => {
      const n = reached(stage)
      const prev = index === 0 ? total : reached(order[index - 1]!)
      return { stage, count: count(stage), reached: n, conversionFromPrevious: prev > 0 ? Math.round((n / prev) * 1000) / 10 : null }
    })
    const quoteRows = db
      .prepare(
        `SELECT q.status AS status, q.currency AS currency, COUNT(*) AS n, SUM(q.subtotal) AS amount
         FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE ${scope.sql} AND q.deleted_at IS NULL GROUP BY q.status, q.currency`,
      )
      .all(...scope.params) as unknown as Array<{ status: string; currency: string; n: number; amount: number }>
    const quotes: Record<string, { count: number; amountByCurrency: Record<string, number> }> = {}
    for (const row of quoteRows) {
      const entry = (quotes[row.status] ??= { count: 0, amountByCurrency: {} })
      entry.count += Number(row.n)
      entry.amountByCurrency[row.currency] = Math.round(Number(row.amount) * 100) / 100
    }
    const stale = db
      .prepare(
        `SELECT c.id, c.company, c.stage, c.updated_at FROM customers c
         WHERE ${scope.sql} AND c.stage NOT IN ('won', 'lost') AND c.updated_at < ?
         ORDER BY c.updated_at ASC LIMIT 20`,
      )
      .all(...scope.params, now - staleDays * 86_400_000) as unknown as Array<{ id: string; company: string; stage: string; updated_at: number }>
    const tasks = taskService.list({ status: 'open', limit: 500 }).items
    const decided = count('won') + count('lost')
    return {
      customers: { total, byStage: Object.fromEntries(CUSTOMER_STAGES.map((stage) => [stage, count(stage)])) },
      funnel,
      winRate: decided > 0 ? Math.round((count('won') / decided) * 1000) / 10 : null,
      quotes,
      tasks: { open: tasks.length, overdue: tasks.filter((task) => task.overdue).length },
      // 商机漏斗（按金额加权，按币种分别汇总）与应收（docs/API-CONTRACT.md §10.3）
      deals: dealService.stats(),
      receivables: orderService.receivableSummary(),
      staleCustomers: {
        days: staleDays,
        items: stale.map((row) => ({ id: row.id, company: row.company, stage: row.stage, lastUpdatedAt: new Date(row.updated_at).toISOString() })),
      },
    }
  },
}
