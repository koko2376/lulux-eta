import { z } from 'zod'
import { currentActor } from '../context.js'
import { db } from '../db.js'
import { seesAll, liveClause, visibilityClause } from '../security/access.js'
import { parse } from '../validation.js'
import { canReadMailbox } from './email/mailbox-access.js'
import { CUSTOMER_STAGES, customerService } from './customer-service.js'
import { sessionService } from './session-service.js'

const DAY = 86_400_000

/** range：today / 7d / 30d；tz：客户端相对 UTC 的分钟偏移（东八区 = 480），用于按本地自然日切分 */
const summaryQuery = z.object({
  range: z.enum(['today', '7d', '30d']).default('today'),
  tz: z.coerce.number().int().min(-840).max(840).optional(),
})

export type WorkbenchRange = z.infer<typeof summaryQuery>['range']

function dayStart(ms: number, tzMin: number): number {
  const off = tzMin * 60_000
  return Math.floor((ms + off) / DAY) * DAY - off
}

function dayKey(ms: number, tzMin: number): string {
  return new Date(ms + tzMin * 60_000).toISOString().slice(0, 10)
}

/** 当前用户能看到的任务（与 taskService.list 的可见性一致） */
function taskScope(): { sql: string; params: Array<string | number> } {
  const actor = currentActor()
  if (seesAll(actor)) return { sql: 't.org_id = ? AND t.deleted_at IS NULL', params: [actor.orgId] }
  const scope = liveClause('c')
  return {
    sql: `t.org_id = ? AND t.deleted_at IS NULL AND (t.owner_id = ? OR (t.customer_id IS NOT NULL AND ${scope.sql}))`,
    params: [actor.orgId, actor.id, ...scope.params],
  }
}

function overview(range: WorkbenchRange, tzMin: number, now = Date.now()) {
  const today = dayStart(now, tzMin)
  const tomorrow = today + DAY
  const spanDays = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const from = today - (spanDays - 1) * DAY
  const prevFrom = from - spanDays * DAY
  const chartDays = range === '30d' ? 30 : 7
  const chartFrom = today - (chartDays - 1) * DAY

  // ── 邮箱：只算收件箱 ──
  const accScope = visibilityClause('a')
  const accounts = (
    db
      .prepare(`SELECT a.id, a.org_id, a.owner_id, a.visibility, a.team_id, a.email, a.state, a.last_sync_at FROM email_accounts a WHERE ${accScope.sql} ORDER BY a.created_at`)
      .all(...accScope.params) as unknown as Array<{
      id: string
      org_id: string
      owner_id: string
      visibility: string
      team_id: string | null
      email: string
      state: string
      last_sync_at: number | null
    }>
  )
    // 成员私有邮箱的内容（数量、主题）只在组织允许管理员查看时计入
    .filter((a) => canReadMailbox(a))
    .map((a) => ({ id: a.id, email: a.email, state: a.state, lastSyncAt: a.last_sync_at }))
  const ids = accounts.map((a) => a.id)
  const inIds = ids.map(() => '?').join(',')
  const emptyCounts = { total: 0, inquiry: 0, customerReply: 0, other: 0 }
  const countMail = (start: number, end: number): typeof emptyCounts => {
    if (!ids.length) return { ...emptyCounts }
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN m.verdict = 'inquiry' THEN 1 ELSE 0 END) AS inquiry,
                SUM(CASE WHEN (m.verdict IS NULL OR m.verdict <> 'inquiry') AND m.customer_id IS NOT NULL THEN 1 ELSE 0 END) AS reply
         FROM email_messages m WHERE m.account_id IN (${inIds}) AND m.folder = 'inbox' AND m.date >= ? AND m.date < ?`,
      )
      .get(...ids, start, end) as unknown as { total: number; inquiry: number | null; reply: number | null }
    const total = Number(row.total)
    const inquiry = Number(row.inquiry ?? 0)
    const customerReply = Number(row.reply ?? 0)
    return { total, inquiry, customerReply, other: Math.max(0, total - inquiry - customerReply) }
  }
  const current = countMail(from, tomorrow)
  const previous = countMail(prevFrom, from)
  const daily: Array<{ date: string; total: number; inquiry: number }> = []
  for (let i = 0; i < chartDays; i += 1) daily.push({ date: dayKey(chartFrom + i * DAY, tzMin), total: 0, inquiry: 0 })
  let inquiryCountries = 0
  let inquiryNewCustomers = 0
  let unreadInquiries = 0
  if (ids.length) {
    const rows = db
      .prepare(
        `SELECT m.date AS date, m.verdict AS verdict FROM email_messages m
         WHERE m.account_id IN (${inIds}) AND m.folder = 'inbox' AND m.date >= ? AND m.date < ?`,
      )
      .all(...ids, chartFrom, tomorrow) as unknown as Array<{ date: number; verdict: string | null }>
    for (const row of rows) {
      const index = Math.floor((dayStart(Number(row.date), tzMin) - chartFrom) / DAY)
      const slot = daily[index]
      if (!slot) continue
      slot.total += 1
      if (row.verdict === 'inquiry') slot.inquiry += 1
    }
    const inq = db
      .prepare(
        `SELECT COUNT(DISTINCT CASE WHEN c.country <> '' THEN lower(c.country) END) AS countries,
                COUNT(DISTINCT CASE WHEN c.created_at >= ? THEN c.id END) AS fresh
         FROM email_messages m LEFT JOIN customers c ON c.id = m.customer_id AND c.deleted_at IS NULL
         WHERE m.account_id IN (${inIds}) AND m.folder = 'inbox' AND m.verdict = 'inquiry' AND m.date >= ? AND m.date < ?`,
      )
      .get(from, ...ids, from, tomorrow) as unknown as { countries: number; fresh: number }
    inquiryCountries = Number(inq.countries)
    inquiryNewCustomers = Number(inq.fresh)
    unreadInquiries = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM email_messages m WHERE m.account_id IN (${inIds}) AND m.folder = 'inbox' AND m.verdict = 'inquiry' AND m.seen = 0`)
          .get(...ids) as unknown as { n: number }
      ).n,
    )
  }

  // ── 客户：新增 / 久未联系 ──
  const scope = liveClause('c')
  const countNew = (start: number, end: number): number =>
    Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${scope.sql} AND c.created_at >= ? AND c.created_at < ?`)
          .get(...scope.params, start, end) as unknown as { n: number }
      ).n,
    )
  const staleBefore = now - 7 * DAY
  const staleSql = `SELECT * FROM (
      SELECT c.id AS id, c.company AS company, c.stage AS stage,
        MAX(c.created_at,
            COALESCE((SELECT MAX(a.created_at) FROM activities a WHERE a.customer_id = c.id), 0),
            COALESCE((SELECT MAX(m.date) FROM email_messages m WHERE m.customer_id = c.id), 0)) AS last_touch
      FROM customers c WHERE ${scope.sql} AND c.stage NOT IN ('won', 'lost')
    ) WHERE last_touch < ? ORDER BY last_touch ASC`
  const staleRows = db.prepare(staleSql).all(...scope.params, staleBefore) as unknown as Array<{
    id: string
    company: string
    stage: string
    last_touch: number
  }>

  // ── 跟进任务 ──
  const ts = taskScope()
  const taskCount = (extra: string, ...params: Array<string | number>): number =>
    Number(
      (
        db
          .prepare(`SELECT COUNT(DISTINCT COALESCE(t.customer_id, t.id)) AS n FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id WHERE ${ts.sql} AND ${extra}`)
          .get(...ts.params, ...params) as unknown as { n: number }
      ).n,
    )
  const dueOpen = taskCount("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ?", tomorrow)
  const overdue = taskCount("t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ?", now)
  const doneInRange = taskCount("t.status = 'done' AND t.done_at >= ? AND t.done_at < ?", from, tomorrow)
  const openTotal = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id WHERE ${ts.sql} AND t.status = 'open'`)
        .get(...ts.params) as unknown as { n: number }
    ).n,
  )
  const taskRows = db
    .prepare(
      `SELECT t.id, t.title, t.due_at, t.priority, t.customer_id, c.company, c.country, c.stage
       FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
       WHERE ${ts.sql} AND t.status = 'open'
       ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ASC, t.created_at DESC LIMIT 6`,
    )
    .all(...ts.params) as unknown as Array<{
    id: string
    title: string
    due_at: number | null
    priority: string
    customer_id: string | null
    company: string | null
    country: string | null
    stage: string | null
  }>

  return {
    range,
    from,
    to: now,
    days: spanDays,
    mail: {
      accounts,
      current,
      previous,
      daily,
      inquiryCountries,
      inquiryNewCustomers,
      unreadInquiries,
    },
    newCustomers: {
      current: countNew(from, tomorrow),
      previous: countNew(prevFrom, from),
      week: countNew(today - 6 * DAY, tomorrow),
    },
    stale: {
      count: staleRows.length,
      items: staleRows.slice(0, 5).map((r) => ({ id: r.id, company: r.company, stage: r.stage, lastTouchAt: Number(r.last_touch) })),
    },
    followUps: {
      due: dueOpen,
      overdue,
      done: doneInRange,
      openTotal,
      items: taskRows.map((r) => ({
        id: r.id,
        title: r.title,
        dueAt: r.due_at,
        overdue: r.due_at !== null && r.due_at < now,
        priority: r.priority,
        customerId: r.customer_id,
        company: r.company,
        country: r.country,
        stage: r.stage,
      })),
    },
  }
}

export const workbenchService = {
  summary(input: unknown = {}) {
    const query = parse(summaryQuery, input)
    const tzMin = query.tz ?? -new Date().getTimezoneOffset()
    const byStage: Record<string, number> = Object.fromEntries(CUSTOMER_STAGES.map((stage) => [stage, 0]))
    const scope = liveClause('c')
    const stageRows = db.prepare(`SELECT c.stage AS stage, COUNT(*) AS n FROM customers c WHERE ${scope.sql} GROUP BY c.stage`).all(...scope.params) as unknown as Array<{
      stage: string
      n: number
    }>
    let customerTotal = 0
    for (const row of stageRows) {
      byStage[row.stage] = Number(row.n)
      customerTotal += Number(row.n)
    }

    const statusRows = db
      .prepare(
        `SELECT q.status AS status, COUNT(*) AS n FROM quotes q JOIN customers c ON c.id = q.customer_id
         WHERE ${scope.sql} AND q.deleted_at IS NULL GROUP BY q.status`,
      )
      .all(...scope.params) as unknown as Array<{
      status: string
      n: number
    }>
    const statusCount = (status: string): number => Number(statusRows.find((row) => row.status === status)?.n ?? 0)
    const amountRows = db
      .prepare(
        `SELECT q.currency AS currency, SUM(q.subtotal) AS amount FROM quotes q JOIN customers c ON c.id = q.customer_id
         WHERE q.status <> 'rejected' AND q.deleted_at IS NULL AND ${scope.sql} GROUP BY q.currency`,
      )
      .all(...scope.params) as unknown as Array<{ currency: string; amount: number }>

    const recentSessions = sessionService
      .list()
      .slice(0, 5)
      .map((session) => ({
        id: session.id,
        title: session.title,
        groupName: session.groupName,
        agentIds: session.agentIds,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        preview: session.preview.slice(0, 120),
      }))

    return {
      customers: { total: customerTotal, byStage },
      quotes: {
        total: statusRows.reduce((sum, row) => sum + Number(row.n), 0),
        draft: statusCount('draft'),
        sent: statusCount('sent'),
        accepted: statusCount('accepted'),
        amountByCurrency: Object.fromEntries(
          amountRows.map((row) => [row.currency, Math.round(Number(row.amount) * 100) / 100]),
        ),
      },
      recentActivities: customerService.recentActivities(10),
      recentSessions,
      overview: overview(query.range, tzMin),
    }
  },
}
