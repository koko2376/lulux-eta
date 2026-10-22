import { z } from 'zod'
import { currentActor, type Actor } from '../../context.js'
import { db } from '../../db.js'
import { AppError, notFound } from '../../errors.js'
import { newId } from '../../utils/id.js'
import { transaction } from '../../utils/tx.js'
import { parse } from '../../validation.js'
import { checkMemoryContent, normalizeMemoryText, sanitizeStoredMemory } from './guard.js'

/**
 * 长期记忆（契约 §6.12）：每个账号一份，两个分区——
 * - profile「用户画像」：用户是谁、公司、主营产品、目标市场、沟通与文风偏好；
 * - notes「记忆」：其他值得跨会话记住的事实与约定。
 * 每个分区是一组条目，按字符预算（profile 2,000 / notes 4,000，按条目正文字符数合计）限制总量，
 * 满了就拒绝新增并把现有条目告诉模型，让它合并 / 删掉旧条目后再写（与 Hermes Agent 的做法一致）。
 *
 * 隔离：所有读写都以“当前账号”（currentActor().id）为键，没有任何按别人 id 读写的入口；
 * admin / owner 也读不到别人的记忆。本机模式下是 local 账号。
 *
 * 快照：会话里某个账号第一次发言时，把他的记忆渲染成一段文字冻结在 memory_snapshots；
 * 之后同一会话的每一轮都用这份快照（会话中途写入的记忆从下一个会话开始生效），保证系统提示前缀稳定、命中缓存。
 */
export const MEMORY_SECTIONS = ['profile', 'notes'] as const
export type MemorySection = (typeof MEMORY_SECTIONS)[number]
export const MEMORY_BUDGETS: Record<MemorySection, number> = { profile: 2000, notes: 4000 }
/** 单条上限：一条记忆应当是一句话 / 一小段 */
export const MEMORY_ENTRY_MAX = 500
export const MEMORY_SOURCES = ['user', 'agent', 'auto', 'import'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export const SECTION_LABEL: Record<MemorySection, string> = { profile: '用户画像', notes: '记忆' }

export interface MemoryEntry {
  id: string
  section: MemorySection
  content: string
  source: MemorySource
  sourceSessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface MemoryPrefs {
  enabled: boolean
  autoExtract: boolean
  /** 群聊中使用我的记忆：多人群聊里也把我的记忆快照放进系统提示（默认关） */
  groupMemory: boolean
}

export interface MemorySectionState {
  entries: MemoryEntry[]
  used: number
  limit: number
}

export interface MemoryState extends MemoryPrefs {
  profile: MemorySectionState
  notes: MemorySectionState
  entryMax: number
}

interface EntryRow {
  id: string
  section: string
  content: string
  source: string
  source_session_id: string | null
  created_at: number
  updated_at: number
}

function toEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    section: row.section as MemorySection,
    content: row.content,
    source: (MEMORY_SOURCES as readonly string[]).includes(row.source) ? (row.source as MemorySource) : 'user',
    sourceSessionId: row.source_session_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 记忆的主人：当前账号。没有身份（未登录的 viewer 占位）时拒绝 */
function owner(actor: Actor = currentActor()): Actor {
  if (!actor.id) throw new AppError(401, 'UNAUTHORIZED', '请先登录')
  return actor
}

/** 宽松匹配用的折叠：引号 / 破折号 / 空白统一、忽略大小写（模型复述条目时常改动这些） */
function fold(text: string): string {
  return text
    .replace(/["'`\u2018\u2019\u201c\u201d\u300c\u300d]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export class MemoryError extends AppError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly detail: { section?: MemorySection; entries?: MemoryEntry[]; used?: number; limit?: number } = {},
  ) {
    super(status, code, message)
  }
}

const contentField = z.string().max(4000)
const sectionField = z.enum(MEMORY_SECTIONS)

function clean(raw: string): string {
  const content = normalizeMemoryText(raw)
  if (!content) throw new MemoryError(400, 'VALIDATION_ERROR', '记忆内容不能为空')
  if (content.length > MEMORY_ENTRY_MAX) {
    throw new MemoryError(400, 'MEMORY_ENTRY_TOO_LONG', `单条记忆最多 ${MEMORY_ENTRY_MAX} 字（当前 ${content.length} 字），请拆成更短的条目`)
  }
  // 原文（含隐藏字符）和清洗后的文本都要过检查：`Ignore\u180Eall …` 清洗后粘成一个词，原文换成空格后才露出来
  const verdict = [checkMemoryContent(content), checkMemoryContent(raw)].find((item) => !item.ok)
  if (verdict) throw new MemoryError(422, 'MEMORY_REJECTED', verdict.message!)
  return content
}

function rows(ownerId: string, section?: MemorySection): MemoryEntry[] {
  const list = section
    ? db
        .prepare('SELECT * FROM memory_entries WHERE owner_id = ? AND section = ? ORDER BY created_at, id')
        .all(ownerId, section)
    : db.prepare('SELECT * FROM memory_entries WHERE owner_id = ? ORDER BY created_at, id').all(ownerId)
  return (list as unknown as EntryRow[]).map(toEntry)
}

const usedOf = (entries: MemoryEntry[]): number => entries.reduce((sum, entry) => sum + entry.content.length, 0)

function fullError(section: MemorySection, entries: MemoryEntry[], adding: number): MemoryError {
  const limit = MEMORY_BUDGETS[section]
  const used = usedOf(entries)
  return new MemoryError(
    409,
    'MEMORY_FULL',
    `「${SECTION_LABEL[section]}」已用 ${used}/${limit} 字，再写入 ${adding} 字会超出预算。请先用 memory_replace 合并 / 精简，或用 memory_remove 删掉过时的条目，再重试。`,
    { section, entries, used, limit },
  )
}

/** 按 id 或 old_text（在某个分区内唯一匹配）找到条目 */
function locate(ownerId: string, input: { id?: string; oldText?: string; section?: MemorySection }): MemoryEntry {
  if (input.id) {
    const entry = rows(ownerId).find((item) => item.id === input.id)
    if (!entry) throw new MemoryError(404, 'NOT_FOUND', '记忆条目不存在')
    return entry
  }
  const needle = fold(input.oldText ?? '')
  if (!needle) throw new MemoryError(400, 'VALIDATION_ERROR', '请提供要修改的条目 id 或 old_text（条目里的一段原文）')
  const pool = rows(ownerId, input.section)
  const hits = pool.filter((entry) => fold(entry.content).includes(needle))
  if (hits.length === 0) {
    throw new MemoryError(404, 'MEMORY_NO_MATCH', `没有找到包含「${input.oldText!.slice(0, 60)}」的记忆条目`, { entries: pool })
  }
  if (hits.length > 1) {
    // 完全相同的那条优先
    const exact = hits.filter((entry) => fold(entry.content) === needle)
    if (exact.length === 1) return exact[0]!
    throw new MemoryError(409, 'MEMORY_AMBIGUOUS', `有 ${hits.length} 条记忆都包含「${input.oldText!.slice(0, 60)}」，请给出更长、唯一的一段原文`, {
      entries: hits,
    })
  }
  return hits[0]!
}

export const memoryWriteInput = z.object({
  section: sectionField,
  content: contentField,
})

export const memoryPrefsInput = z
  .object({ enabled: z.boolean().optional(), autoExtract: z.boolean().optional(), groupMemory: z.boolean().optional() })
  .refine(
    (value) => value.enabled !== undefined || value.autoExtract !== undefined || value.groupMemory !== undefined,
    '至少提供一个开关',
  )

export const memoryService = {
  prefs(actor: Actor = currentActor()): MemoryPrefs {
    const row = db.prepare('SELECT enabled, auto_extract, group_memory FROM memory_prefs WHERE owner_id = ?').get(actor.id) as unknown as
      | { enabled: number; auto_extract: number; group_memory: number }
      | undefined
    return {
      enabled: row ? Number(row.enabled) === 1 : true,
      autoExtract: row ? Number(row.auto_extract) === 1 : true,
      groupMemory: row ? Number(row.group_memory) === 1 : false,
    }
  },

  setPrefs(input: unknown): MemoryPrefs {
    const me = owner()
    const patch = parse(memoryPrefsInput, input)
    const next = { ...memoryService.prefs(me), ...patch }
    db.prepare(
      `INSERT INTO memory_prefs (owner_id, enabled, auto_extract, group_memory, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET enabled = excluded.enabled, auto_extract = excluded.auto_extract,
         group_memory = excluded.group_memory, updated_at = excluded.updated_at`,
    ).run(me.id, next.enabled ? 1 : 0, next.autoExtract ? 1 : 0, next.groupMemory ? 1 : 0, Date.now())
    return next
  },

  enabled(actor: Actor = currentActor()): boolean {
    return Boolean(actor.id) && memoryService.prefs(actor).enabled
  },

  entries(section?: MemorySection, actor: Actor = currentActor()): MemoryEntry[] {
    return rows(owner(actor).id, section)
  },

  state(): MemoryState {
    const me = owner()
    const all = rows(me.id)
    const sectionState = (section: MemorySection): MemorySectionState => {
      const entries = all.filter((entry) => entry.section === section)
      return { entries, used: usedOf(entries), limit: MEMORY_BUDGETS[section] }
    }
    return { ...memoryService.prefs(me), profile: sectionState('profile'), notes: sectionState('notes'), entryMax: MEMORY_ENTRY_MAX }
  },

  usage(section: MemorySection, actor: Actor = currentActor()): { used: number; limit: number } {
    return { used: usedOf(rows(owner(actor).id, section)), limit: MEMORY_BUDGETS[section] }
  },

  /** 新增；与已有条目完全相同时不重复写，返回 duplicate=true */
  add(input: {
    section: MemorySection
    content: string
    source?: MemorySource
    sessionId?: string | null
  }): { entry: MemoryEntry; duplicate: boolean } {
    const me = owner()
    const section = parse(sectionField, input.section)
    const content = clean(parse(contentField, input.content))
    return transaction(() => {
      const existing = rows(me.id, section)
      const same = existing.find((entry) => fold(entry.content) === fold(content))
      if (same) return { entry: same, duplicate: true }
      if (usedOf(existing) + content.length > MEMORY_BUDGETS[section]) throw fullError(section, existing, content.length)
      const now = Date.now()
      const id = newId('mem')
      db.prepare(
        `INSERT INTO memory_entries (id, org_id, owner_id, section, content, source, source_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, me.orgId || 'local', me.id, section, content, input.source ?? 'user', input.sessionId ?? null, now, now)
      return { entry: rows(me.id, section).find((entry) => entry.id === id)!, duplicate: false }
    })
  },

  /** 整条替换（按 id，或按 old_text 在分区内唯一匹配）；可同时改分区 */
  replace(input: {
    id?: string
    oldText?: string
    section?: MemorySection
    content: string
    toSection?: MemorySection
    source?: MemorySource
    sessionId?: string | null
  }): { entry: MemoryEntry; previous: string } {
    const me = owner()
    const content = clean(parse(contentField, input.content))
    return transaction(() => {
      const target = locate(me.id, input)
      const section = input.toSection ?? target.section
      const others = rows(me.id, section).filter((entry) => entry.id !== target.id)
      if (others.some((entry) => fold(entry.content) === fold(content))) {
        // 改成了和另一条一样：等于合并，删掉这条
        db.prepare('DELETE FROM memory_entries WHERE id = ? AND owner_id = ?').run(target.id, me.id)
        return { entry: others.find((entry) => fold(entry.content) === fold(content))!, previous: target.content }
      }
      if (usedOf(others) + content.length > MEMORY_BUDGETS[section]) throw fullError(section, rows(me.id, section), content.length)
      db.prepare(
        `UPDATE memory_entries SET content = ?, section = ?, source = ?, source_session_id = COALESCE(?, source_session_id), updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      ).run(content, section, input.source ?? target.source, input.sessionId ?? null, Date.now(), target.id, me.id)
      return { entry: rows(me.id, section).find((entry) => entry.id === target.id)!, previous: target.content }
    })
  },

  remove(input: { id?: string; oldText?: string; section?: MemorySection }): MemoryEntry {
    const me = owner()
    const target = locate(me.id, input)
    db.prepare('DELETE FROM memory_entries WHERE id = ? AND owner_id = ?').run(target.id, me.id)
    return target
  },

  /** 设置页：按 id 修改正文（不能改别人的：查不到即 404） */
  update(id: string, content: string): MemoryEntry {
    const me = owner()
    if (!rows(me.id).some((entry) => entry.id === id)) throw notFound('记忆条目')
    return memoryService.replace({ id, content, source: 'user' }).entry
  },

  delete(id: string): void {
    const me = owner()
    const result = db.prepare('DELETE FROM memory_entries WHERE id = ? AND owner_id = ?').run(id, me.id)
    if (Number(result.changes) === 0) throw notFound('记忆条目')
  },

  /** 清空（可只清一个分区）；同时丢掉自己的会话快照，下一轮起不再带旧记忆 */
  clear(section?: MemorySection): number {
    const me = owner()
    const result = section
      ? db.prepare('DELETE FROM memory_entries WHERE owner_id = ? AND section = ?').run(me.id, section)
      : db.prepare('DELETE FROM memory_entries WHERE owner_id = ?').run(me.id)
    db.prepare('DELETE FROM memory_snapshots WHERE owner_id = ?').run(me.id)
    return Number(result.changes)
  },

  /**
   * 渲染成系统提示里的一段（空记忆返回 ''）。
   * 存量条目再清洗一次（迁移 21 上线后、guard 加固前存进来的可能带隐藏字符）：去掉隐藏字符后不再通过安全检查的条目不进快照。
   */
  render(actor: Actor = currentActor()): string {
    if (!actor.id) return ''
    const all = rows(actor.id)
      .filter((entry) => checkMemoryContent(entry.content).ok)
      .map((entry) => ({ ...entry, content: sanitizeStoredMemory(entry.content) }))
      .filter((entry) => entry.content && checkMemoryContent(entry.content).ok)
    const parts: string[] = []
    for (const section of MEMORY_SECTIONS) {
      const entries = all.filter((entry) => entry.section === section)
      if (entries.length === 0) continue
      const pct = Math.round((usedOf(entries) / MEMORY_BUDGETS[section]) * 100)
      parts.push(`### ${SECTION_LABEL[section]}（已用 ${pct}%）\n${entries.map((entry) => `- ${entry.content.replace(/\n+/g, ' ')}`).join('\n')}`)
    }
    return parts.join('\n\n')
  },

  /**
   * 会话快照：本会话里该账号第一次需要时冻结，之后原样返回（会话中途的写入从下一个会话开始生效）。
   * 记忆关闭时返回 ''，也不写快照（重新打开后下一轮会冻结当时的记忆）。
   */
  snapshot(sessionId: string, actor: Actor = currentActor()): string {
    if (!actor.id || !memoryService.prefs(actor).enabled) return ''
    const existing = db
      .prepare('SELECT content FROM memory_snapshots WHERE session_id = ? AND owner_id = ?')
      .get(sessionId, actor.id) as unknown as { content: string } | undefined
    if (existing) return existing.content
    const content = memoryService.render(actor)
    try {
      db.prepare('INSERT OR IGNORE INTO memory_snapshots (session_id, owner_id, content, created_at) VALUES (?, ?, ?, ?)').run(
        sessionId,
        actor.id,
        content,
        Date.now(),
      )
    } catch {
      // 会话已被删除（外键）：不缓存，直接返回
    }
    return content
  },

  /** 导出自己的记忆（数据导出 / 备份 JSON） */
  exportOwn(): { prefs: MemoryPrefs; entries: Array<Omit<MemoryEntry, 'id'> & { id: string }> } {
    const me = owner()
    return { prefs: memoryService.prefs(me), entries: rows(me.id) }
  },

  /**
   * 导入到当前账号：内容去重、逐条过安全检查与预算（超出预算 / 不合格的跳过），返回导入条数。
   * 不覆盖已有条目，导入条目的 source 记为 import。
   */
  importOwn(input: unknown): { imported: number; skipped: number } {
    owner()
    const data = z
      .object({
        prefs: z.object({ enabled: z.boolean().optional(), autoExtract: z.boolean().optional(), groupMemory: z.boolean().optional() }).optional(),
        entries: z
          .array(z.object({ section: sectionField, content: z.string().max(4000), createdAt: z.number().int().nonnegative().optional() }))
          .max(1000)
          .default([]),
      })
      .safeParse(input)
    if (!data.success) return { imported: 0, skipped: 0 }
    let imported = 0
    let skipped = 0
    const prefs = data.data.prefs
    if (prefs && (prefs.enabled !== undefined || prefs.autoExtract !== undefined || prefs.groupMemory !== undefined)) {
      memoryService.setPrefs(data.data.prefs)
    }
    for (const item of data.data.entries) {
      try {
        const result = memoryService.add({ section: item.section, content: item.content, source: 'import' })
        if (result.duplicate) skipped += 1
        else imported += 1
      } catch {
        skipped += 1
      }
    }
    return { imported, skipped }
  },
}
