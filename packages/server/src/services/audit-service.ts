import { z } from 'zod'
import { db } from '../db.js'
import { currentContext, type Actor } from '../context.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'

export interface AuditEntry {
  id: string
  at: number
  userId: string | null
  userName: string
  action: string
  entityType: string | null
  entityId: string | null
  summary: string
  ip: string
  meta: Record<string, unknown>
}

interface AuditRow {
  id: string
  at: number
  user_id: string | null
  user_name: string
  action: string
  entity_type: string | null
  entity_id: string | null
  summary: string
  ip: string
  meta: string
}

const listQuery = z.object({
  userId: z.string().max(80).optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(80).optional(),
  entityId: z.string().max(80).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

const SENSITIVE_KEYS = /password|token|secret|apikey|api_key|code/i

function scrub(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(key)) continue
    out[key] = typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value
  }
  return out
}

export interface AuditInput {
  action: string
  entityType?: string | null
  entityId?: string | null
  summary?: string
  meta?: Record<string, unknown>
  /** 默认取当前请求上下文 */
  actor?: Actor | null
  orgId?: string
}

export const auditService = {
  record(input: AuditInput): void {
    const context = currentContext()
    const actor = input.actor === undefined ? context.actor : input.actor
    try {
      db.prepare(
        `INSERT INTO audit_log (id, org_id, at, user_id, user_name, action, entity_type, entity_id, summary, ip, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('aud'),
        input.orgId ?? actor?.orgId ?? 'local',
        Date.now(),
        actor?.id ?? null,
        actor?.name ?? '',
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        (input.summary ?? '').slice(0, 500),
        context.ip,
        JSON.stringify(scrub(input.meta ?? {})),
      )
    } catch (error) {
      // 审计失败不能影响业务请求，但必须留下痕迹
      console.error('[lulux-eta] audit write failed', error)
    }
  },

  list(orgId: string, input: unknown): { items: AuditEntry[]; total: number } {
    const query = parse(listQuery, input)
    const where = ['org_id = ?']
    const params: Array<string | number> = [orgId]
    if (query.userId) {
      where.push('user_id = ?')
      params.push(query.userId)
    }
    if (query.action) {
      if (query.action.endsWith('.')) {
        where.push("action LIKE ? ESCAPE '\\'")
        params.push(`${query.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      } else {
        where.push('action = ?')
        params.push(query.action)
      }
    }
    if (query.entityType) {
      where.push('entity_type = ?')
      params.push(query.entityType)
    }
    if (query.entityId) {
      where.push('entity_id = ?')
      params.push(query.entityId)
    }
    if (query.from !== undefined) {
      where.push('at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      where.push('at <= ?')
      params.push(query.to)
    }
    const clause = `WHERE ${where.join(' AND ')}`
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as { n: number }).n)
    const rows = db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as unknown as AuditRow[]
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        at: row.at,
        userId: row.user_id,
        userName: row.user_name,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        summary: row.summary,
        ip: row.ip,
        meta: (() => {
          try {
            return JSON.parse(row.meta) as Record<string, unknown>
          } catch {
            return {}
          }
        })(),
      })),
    }
  },
}
