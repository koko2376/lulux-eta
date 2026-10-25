import { db } from '../../db.js'
import { currentActor } from '../../context.js'
import { seesAll } from '../../security/access.js'
import type { MessageUsage, Provider } from '../../types.js'
import { newId } from '../../utils/id.js'
import { estimateCost, priceFor } from './pricing.js'
import type { Usage } from './types.js'

/**
 * 每次上游调用一行（对话轮次、续写、摘要、标题、邮件 AI…）。
 * 费用在写入时按当时的单价估算并固化，之后改单价不影响历史记录。
 */
export type UsagePurpose = 'chat' | 'continuation' | 'compaction' | 'title' | 'completion' | 'memory'

export interface UsageRecordInput {
  provider: Pick<Provider, 'id' | 'name'>
  model: string
  usage: Usage
  estimated: boolean
  purpose: UsagePurpose
  sessionId?: string | null
  messageId?: string | null
  agentId?: string | null
}

export interface UsageRecord {
  id: string
  sessionId: string | null
  messageId: string | null
  agentId: string | null
  providerId: string
  providerName: string
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimated: boolean
  cost: number | null
  currency: string | null
  ownerId: string
  createdAt: number
}

interface UsageRow {
  id: string
  session_id: string | null
  message_id: string | null
  agent_id: string | null
  provider_id: string
  provider_name: string
  model: string
  purpose: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated: number
  cost: number | null
  currency: string | null
  owner_id: string
  created_at: number
}

function toRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    model: row.model,
    purpose: row.purpose,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    estimated: Boolean(row.estimated),
    cost: row.cost === null ? null : Number(row.cost),
    currency: row.currency,
    ownerId: row.owner_id,
    createdAt: Number(row.created_at),
  }
}

export interface UsageQuery {
  from?: number
  to?: number
  sessionId?: string
  providerId?: string
  model?: string
  agentId?: string
  purpose?: string
  /** admin/owner 看全组织；其他人只看自己的 */
  all?: boolean
}

/** 会话只属于本人（契约 §5.6a）：admin 看全组织用量时，别人的会话不显示标题 / id，合并成一行 */
export const OTHER_SESSIONS_KEY = '__others__'
function hideForeignSessions<T extends { key: string; label: string } & UsageTotals>(groups: T[]): T[] {
  const actor = currentActor()
  const mine = (key: string): boolean => {
    if (!key) return true
    const row = db
      .prepare(
        `SELECT 1 FROM sessions s WHERE s.id = ? AND s.org_id = ? AND (s.owner_id = ? OR EXISTS (
           SELECT 1 FROM session_participants p WHERE p.session_id = s.id AND p.user_id = ?))`,
      )
      .get(key, actor.orgId, actor.id, actor.id)
    return Boolean(row)
  }
  const kept: T[] = []
  let others: T | null = null
  for (const group of groups) {
    if (mine(group.key)) {
      kept.push(group)
      continue
    }
    if (!others) {
      others = { ...group, key: OTHER_SESSIONS_KEY, label: '其他成员的会话', cost: { ...group.cost } }
      continue
    }
    const merged: T = others
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'estimatedCalls', 'unpricedCalls'] as const) {
      merged[field] = (merged[field] + group[field]) as T[typeof field]
    }
    for (const [currency, cost] of Object.entries(group.cost)) merged.cost[currency] = round6((merged.cost[currency] ?? 0) + cost)
  }
  return others ? [...kept, others] : kept
}

export const GROUP_BY = ['day', 'model', 'provider', 'session', 'agent', 'purpose', 'member'] as const
export type UsageGroupBy = (typeof GROUP_BY)[number]

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCalls: number
  /** 按币种汇总的估算费用；没有配置单价的调用不计入 */
  cost: Record<string, number>
  /** 没有单价、无法估算费用的调用数 */
  unpricedCalls: number
}

function where(query: UsageQuery): { sql: string; params: Array<string | number> } {
  const actor = currentActor()
  const parts = ['u.org_id = ?']
  const params: Array<string | number> = [actor.orgId]
  if (!(query.all && seesAll(actor))) {
    parts.push('u.owner_id = ?')
    params.push(actor.id)
  }
  if (query.from !== undefined) {
    parts.push('u.created_at >= ?')
    params.push(query.from)
  }
  if (query.to !== undefined) {
    parts.push('u.created_at < ?')
    params.push(query.to)
  }
  const eq: Array<[keyof UsageQuery, string]> = [
    ['sessionId', 'session_id'],
    ['providerId', 'provider_id'],
    ['model', 'model'],
    ['agentId', 'agent_id'],
    ['purpose', 'purpose'],
  ]
  for (const [key, column] of eq) {
    const value = query[key]
    if (typeof value === 'string' && value) {
      parts.push(`u.${column} = ?`)
      params.push(value)
    }
  }
  return { sql: parts.join(' AND '), params }
}

const SUMS = `COUNT(*) AS calls,
  COALESCE(SUM(u.input_tokens),0) AS input_tokens,
  COALESCE(SUM(u.output_tokens),0) AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens),0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens),0) AS cache_write_tokens,
  COALESCE(SUM(u.reasoning_tokens),0) AS reasoning_tokens,
  COALESCE(SUM(u.estimated),0) AS estimated_calls,
  COALESCE(SUM(CASE WHEN u.cost IS NULL THEN 1 ELSE 0 END),0) AS unpriced_calls`

interface SumRow {
  calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_calls: number
  unpriced_calls: number
}

function totalsOf(row: SumRow | undefined, cost: Record<string, number>): UsageTotals {
  return {
    calls: Number(row?.calls ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    reasoningTokens: Number(row?.reasoning_tokens ?? 0),
    estimatedCalls: Number(row?.estimated_calls ?? 0),
    cost,
    unpricedCalls: Number(row?.unpriced_calls ?? 0),
  }
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

export const usageService = {
  record(input: UsageRecordInput): UsageRecord {
    const actor = currentActor()
    const priced = estimateCost(input.usage, priceFor(input.provider.name, input.model))
    const row: UsageRow = {
      id: newId('use'),
      session_id: input.sessionId ?? null,
      message_id: input.messageId ?? null,
      agent_id: input.agentId ?? null,
      provider_id: input.provider.id,
      provider_name: input.provider.name,
      model: input.model,
      purpose: input.purpose,
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      cache_read_tokens: input.usage.cacheReadTokens,
      cache_write_tokens: input.usage.cacheWriteTokens,
      reasoning_tokens: input.usage.reasoningTokens,
      estimated: input.estimated ? 1 : 0,
      cost: priced?.cost ?? null,
      currency: priced?.currency ?? null,
      owner_id: actor.id,
      created_at: Date.now(),
    }
    db.prepare(
      `INSERT INTO llm_usage (id, org_id, owner_id, session_id, message_id, agent_id, provider_id, provider_name, model, purpose,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated, cost, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, actor.orgId, row.owner_id, row.session_id, row.message_id, row.agent_id, row.provider_id, row.provider_name,
      row.model, row.purpose, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens,
      row.reasoning_tokens, row.estimated, row.cost, row.currency, row.created_at,
    )
    return toRecord(row)
  },

  /** 回复落库后把本次回复的记录关联到消息 */
  attachMessage(ids: string[], messageId: string): void {
    if (ids.length === 0) return
    db.prepare(`UPDATE llm_usage SET message_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(messageId, ...ids)
  },

  /** 多条记录汇总成消息上的 usage */
  summarize(records: UsageRecord[]): MessageUsage | null {
    if (records.length === 0) return null
    const currencies = new Set(records.map((r) => r.currency).filter(Boolean))
    const allPriced = records.every((r) => r.cost !== null)
    return {
      inputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
      cacheReadTokens: records.reduce((s, r) => s + r.cacheReadTokens, 0),
      cacheWriteTokens: records.reduce((s, r) => s + r.cacheWriteTokens, 0),
      reasoningTokens: records.reduce((s, r) => s + r.reasoningTokens, 0),
      estimated: records.some((r) => r.estimated),
      calls: records.length,
      cost: allPriced && currencies.size === 1 ? round6(records.reduce((s, r) => s + (r.cost ?? 0), 0)) : null,
      currency: allPriced && currencies.size === 1 ? [...currencies][0]! : null,
    }
  },

  summary(query: UsageQuery, groupBy: UsageGroupBy | null, tzOffsetMinutes = 0) {
    const w = where(query)
    const totalRow = db.prepare(`SELECT ${SUMS} FROM llm_usage u WHERE ${w.sql}`).get(...w.params) as unknown as SumRow
    const costRows = db
      .prepare(`SELECT u.currency AS currency, SUM(u.cost) AS cost FROM llm_usage u WHERE ${w.sql} AND u.cost IS NOT NULL GROUP BY u.currency`)
      .all(...w.params) as unknown as Array<{ currency: string; cost: number }>
    const totals = totalsOf(totalRow, Object.fromEntries(costRows.map((r) => [r.currency, round6(Number(r.cost))])))

    if (!groupBy) return { totals, groups: [] }
    const offset = Math.trunc(tzOffsetMinutes) * 60
    const keyExpr: Record<UsageGroupBy, string> = {
      day: `strftime('%Y-%m-%d', u.created_at / 1000 + ${offset}, 'unixepoch')`,
      model: 'u.model',
      provider: 'u.provider_id',
      session: "COALESCE(u.session_id, '')",
      agent: "COALESCE(u.agent_id, '')",
      purpose: 'u.purpose',
      member: 'u.owner_id',
    }
    const labelExpr: Record<UsageGroupBy, string> = {
      day: keyExpr.day,
      model: 'MAX(u.model)',
      provider: 'MAX(u.provider_name)',
      session: "COALESCE(MAX(s.title), '')",
      agent: "COALESCE(MAX(u.agent_id), '')",
      purpose: 'MAX(u.purpose)',
      // 成员：显示名，账号已删除时退回邮箱 / id
      member: 'COALESCE(MAX(m.name), MAX(m.email), u.owner_id)',
    }
    const join =
      groupBy === 'session'
        ? 'LEFT JOIN sessions s ON s.id = u.session_id'
        : groupBy === 'member'
          ? 'LEFT JOIN users m ON m.id = u.owner_id AND m.org_id = u.org_id'
          : ''
    const rows = db
      .prepare(
        `SELECT ${keyExpr[groupBy]} AS k, ${labelExpr[groupBy]} AS label, ${SUMS} FROM llm_usage u ${join}
         WHERE ${w.sql} GROUP BY k ORDER BY ${groupBy === 'day' ? 'k ASC' : 'calls DESC'} LIMIT 500`,
      )
      .all(...w.params) as unknown as Array<SumRow & { k: string; label: string }>
    const groupCosts = db
      .prepare(
        `SELECT ${keyExpr[groupBy]} AS k, u.currency AS currency, SUM(u.cost) AS cost FROM llm_usage u
         WHERE ${w.sql} AND u.cost IS NOT NULL GROUP BY k, u.currency`,
      )
      .all(...w.params) as unknown as Array<{ k: string; currency: string; cost: number }>
    const costMap = new Map<string, Record<string, number>>()
    for (const row of groupCosts) {
      const entry = costMap.get(row.k) ?? {}
      entry[row.currency] = round6(Number(row.cost))
      costMap.set(row.k, entry)
    }
    const groups = rows.map((row) => ({ key: row.k, label: row.label || row.k, ...totalsOf(row, costMap.get(row.k) ?? {}) }))
    return { totals, groups: groupBy === 'session' ? hideForeignSessions(groups) : groups }
  },

  records(query: UsageQuery, page = 1, pageSize = 50): { items: UsageRecord[]; total: number } {
    const w = where(query)
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM llm_usage u WHERE ${w.sql}`).get(...w.params) as { n: number }).n)
    const rows = db
      .prepare(`SELECT u.* FROM llm_usage u WHERE ${w.sql} ORDER BY u.created_at DESC, u.rowid DESC LIMIT ? OFFSET ?`)
      .all(...w.params, pageSize, (page - 1) * pageSize) as unknown as UsageRow[]
    return { items: rows.map(toRecord), total }
  },

  forMessage(messageId: string): UsageRecord[] {
    const rows = db.prepare('SELECT * FROM llm_usage WHERE message_id = ? ORDER BY created_at ASC').all(messageId) as unknown as UsageRow[]
    return rows.map(toRecord)
  },
}
