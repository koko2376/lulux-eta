import { z } from 'zod'
import { db } from '../db.js'
import { notFound } from '../errors.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'

export const RULE_FIELDS = ['subject', 'body', 'from', 'domain'] as const
export const RULE_OPS = ['contains', 'not_contains', 'regex'] as const
export const RULE_ACTIONS = ['inquiry', 'spam', 'review'] as const

export interface RuleCondition {
  field: (typeof RULE_FIELDS)[number]
  op: (typeof RULE_OPS)[number]
  value: string
}

export interface InquiryRule {
  id: string
  name: string
  enabled: boolean
  conditions: RuleCondition[]
  action: (typeof RULE_ACTIONS)[number]
  priority: number
  createdAt: number
  updatedAt: number
}

const conditionInput = z
  .object({
    field: z.enum(RULE_FIELDS),
    op: z.enum(RULE_OPS),
    value: z.string().min(1, '条件值不能为空').max(500),
  })
  .superRefine((condition, ctx) => {
    if (condition.op !== 'regex') return
    try {
      new RegExp(condition.value, 'i')
    } catch {
      ctx.addIssue({ code: 'custom', message: '正则表达式无效', path: ['value'] })
    }
  })

const shape = {
  name: z.string().trim().min(1, '规则名不能为空').max(200),
  enabled: z.boolean(),
  conditions: z.array(conditionInput).min(1, '至少需要一个条件').max(20),
  action: z.enum(RULE_ACTIONS),
  priority: z.number().int().min(-1000).max(1000),
}

export const ruleCreateInput = z.object({
  ...shape,
  enabled: shape.enabled.default(true),
  priority: shape.priority.default(0),
})
export const rulePatchInput = z.object(shape).partial().strict()

export const ruleTestInput = z.object({
  subject: z.string().max(2000).default(''),
  body: z.string().max(100_000).default(''),
  from: z.string().max(500).default(''),
})

interface RuleRow {
  id: string
  name: string
  enabled: number
  conditions: string
  action: string
  priority: number
  created_at: number
  updated_at: number
}

function toRule(row: RuleRow): InquiryRule {
  let conditions: RuleCondition[] = []
  try {
    const parsed = JSON.parse(row.conditions) as unknown
    conditions = Array.isArray(parsed) ? (parsed as RuleCondition[]) : []
  } catch {
    conditions = []
  }
  return {
    id: row.id,
    name: row.name,
    enabled: Number(row.enabled) === 1,
    conditions,
    action: row.action as InquiryRule['action'],
    priority: Number(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 正文过长时只匹配前 20k 字符，限制正则的最坏耗时 */
const MATCH_LIMIT = 20_000

function domainOf(from: string): string {
  const match = /@([^>\s]+)>?\s*$/.exec(from.trim())
  return (match?.[1] ?? '').toLowerCase()
}

function matches(condition: RuleCondition, mail: { subject: string; body: string; from: string }): boolean {
  const source =
    condition.field === 'domain' ? domainOf(mail.from) : String(mail[condition.field] ?? '').slice(0, MATCH_LIMIT)
  const haystack = source.toLowerCase()
  const needle = condition.value.toLowerCase()
  switch (condition.op) {
    case 'contains':
      return haystack.includes(needle)
    case 'not_contains':
      return !haystack.includes(needle)
    case 'regex':
      try {
        return new RegExp(condition.value, 'i').test(source)
      } catch {
        return false
      }
  }
}

export const inquiryRuleService = {
  /** 按 priority 从大到小、同优先级按创建时间排序；第一个全部条件命中的启用规则生效 */
  list(): InquiryRule[] {
    return (
      db.prepare('SELECT * FROM inquiry_rules ORDER BY priority DESC, created_at ASC').all() as unknown as RuleRow[]
    ).map(toRule)
  },

  get(id: string): InquiryRule | undefined {
    const row = db.prepare('SELECT * FROM inquiry_rules WHERE id = ?').get(id) as unknown as RuleRow | undefined
    return row ? toRule(row) : undefined
  },

  create(input: unknown): InquiryRule {
    const data = parse(ruleCreateInput, input)
    const now = Date.now()
    const id = newId('rule')
    db.prepare(
      `INSERT INTO inquiry_rules (id, name, enabled, conditions, action, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, data.name, data.enabled ? 1 : 0, JSON.stringify(data.conditions), data.action, data.priority, now, now)
    return inquiryRuleService.get(id)!
  },

  update(id: string, input: unknown): InquiryRule {
    const patch = parse(rulePatchInput, input)
    const current = inquiryRuleService.get(id)
    if (!current) throw notFound('询盘规则')
    const next = { ...current, ...patch }
    db.prepare(
      'UPDATE inquiry_rules SET name = ?, enabled = ?, conditions = ?, action = ?, priority = ?, updated_at = ? WHERE id = ?',
    ).run(next.name, next.enabled ? 1 : 0, JSON.stringify(next.conditions), next.action, next.priority, Date.now(), id)
    return inquiryRuleService.get(id)!
  },

  remove(id: string): void {
    const result = db.prepare('DELETE FROM inquiry_rules WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw notFound('询盘规则')
  },

  /** 没有规则命中时判定为 review（人工确认） */
  test(input: unknown): { verdict: InquiryRule['action']; matchedRuleId: string | null } {
    const mail = parse(ruleTestInput, input)
    for (const rule of inquiryRuleService.list()) {
      if (!rule.enabled || rule.conditions.length === 0) continue
      if (rule.conditions.every((condition) => matches(condition, mail))) {
        return { verdict: rule.action, matchedRuleId: rule.id }
      }
    }
    return { verdict: 'review', matchedRuleId: null }
  },
}
