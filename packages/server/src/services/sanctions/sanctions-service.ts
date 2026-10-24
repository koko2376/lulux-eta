import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { settingsService } from '../settings-service.js'
import { fetchWithProxy } from '../http-client.js'
import { transaction } from '../../utils/tx.js'
import { auditService } from '../audit-service.js'
import { currentActor, type Actor, LOCAL_ACTOR } from '../../context.js'
import { parseCustomCsv, parseEu, parseOfac, parseUn, type SanctionsEntry } from './parse.js'
import { nameKey, SanctionsIndex, type ScreeningEntry, type ScreeningResult } from './match.js'

const OFAC_SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV'
const OFAC_ALT_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV'
const EU_URL = 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw'
const UN_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'

interface ListStatus {
  list: string
  updatedAt: number | null
  entryCount: number
  sourceUrl: string
  error: string | null
}

interface ScreenOptions {
  country?: string
  threshold?: number
  limit?: number
}

function toScreeningEntry(row: SanctionsEntry): ScreeningEntry {
  return {
    id: row.id,
    list: row.list,
    ref: row.ref,
    name: row.name,
    primaryName: row.primaryName,
    entityType: row.entityType,
    programs: row.programs,
    countries: row.countries,
    isAlias: row.isAlias,
    nameKey: row.nameKey,
  }
}

function dbRowToEntry(row: Record<string, unknown>): SanctionsEntry {
  return {
    id: String(row.id),
    list: String(row.list) as SanctionsEntry['list'],
    ref: String(row.ref),
    name: String(row.name),
    nameKey: String(row.name_key),
    entityType: String(row.entity_type),
    programs: String(row.programs),
    countries: parseCountries(row.countries),
    remarks: String(row.remarks),
    isAlias: Number(row.is_alias),
    primaryName: String(row.primary_name),
  }
}

function parseCountries(raw: unknown): string[] {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      return raw ? [raw] : []
    }
  }
  return []
}

function sourceUrl(list: SanctionsEntry['list']): string {
  switch (list) {
    case 'ofac': return OFAC_SDN_URL
    case 'eu': return EU_URL
    case 'un': return UN_URL
    case 'custom': return ''
  }
}

const MAX_DOWNLOAD = 80 * 1024 * 1024
export const OFFICIAL_LISTS = ['ofac', 'eu', 'un'] as const

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithProxy(url, {
    method: 'GET',
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_DOWNLOAD) throw new Error('名单文件超过 80MB 上限')
  if (!response.body) return ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > MAX_DOWNLOAD) throw new Error('名单文件超过 80MB 上限')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

/** 下载并解析一份官方名单；OFAC 的别名表 ALT.CSV 取不到时只用主表 */
async function download(list: (typeof OFFICIAL_LISTS)[number]): Promise<SanctionsEntry[]> {
  if (list === 'ofac') {
    const sdn = await fetchText(OFAC_SDN_URL)
    const alt = await fetchText(OFAC_ALT_URL).catch(() => '')
    return parseOfac(sdn, alt)
  }
  if (list === 'eu') return parseEu(await fetchText(EU_URL))
  return parseUn(await fetchText(UN_URL))
}

let cachedIndex: SanctionsIndex | null = null
function index(): SanctionsIndex {
  if (!cachedIndex) cachedIndex = new SanctionsIndex(allEntries().map(toScreeningEntry))
  return cachedIndex
}
function invalidate(): void {
  cachedIndex = null
}

function allEntries(): SanctionsEntry[] {
  return (db.prepare('SELECT * FROM sanctions_entries').all() as unknown[]).map((row) => dbRowToEntry(row as Record<string, unknown>))
}

function countFor(list: SanctionsEntry['list']): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM sanctions_entries WHERE list = ?').get(list) as { n: number }).n)
}

function replaceEntries(list: SanctionsEntry['list'], entries: SanctionsEntry[]): void {
  const del = db.prepare('DELETE FROM sanctions_entries WHERE list = ?')
  const insert = db.prepare(
    `INSERT INTO sanctions_entries
      (id, list, ref, name, name_key, entity_type, programs, countries, remarks, is_alias, primary_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  invalidate()
  del.run(list)
  for (const e of entries) {
    insert.run(e.id, e.list, e.ref, e.name, e.nameKey, e.entityType, e.programs, JSON.stringify(e.countries), e.remarks, e.isAlias, e.primaryName)
  }
}

function setStatus(list: SanctionsEntry['list'], updatedAt: number | null, entryCount: number, error: string | null): void {
  const stmt = db.prepare(
    `INSERT INTO sanctions_lists (list, updated_at, entry_count, source_url, error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(list) DO UPDATE SET updated_at = excluded.updated_at,
       entry_count = excluded.entry_count, source_url = excluded.source_url, error = excluded.error`,
  )
  stmt.run(list, updatedAt, entryCount, sourceUrl(list), error)
}

export const sanctionsService = {
  /** 逐个下载；单个失败不影响其他名单，也不清旧数据（错误记在状态里）。全部失败才抛错。 */
  async refresh(list: (typeof OFFICIAL_LISTS)[number] | 'all', actor: Actor = currentActor()): Promise<{ updated: string[]; failed: Array<{ list: string; error: string }> }> {
    const targets: Array<(typeof OFFICIAL_LISTS)[number]> = list === 'all' ? [...OFFICIAL_LISTS] : [list]
    const updated: string[] = []
    const failed: Array<{ list: string; error: string }> = []
    for (const l of targets) {
      try {
        const entries = await download(l)
        if (entries.length === 0) throw new Error('解析结果为空（格式可能已变化）')
        transaction(() => {
          replaceEntries(l, entries)
          setStatus(l, Date.now(), entries.length, null)
        })
        updated.push(l)
        auditService.record({
          action: 'sanctions.refresh',
          entityType: 'sanctions_list',
          entityId: l,
          summary: `更新制裁名单 ${l}，共 ${entries.length} 条`,
          actor,
        })
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
        const row = db.prepare('SELECT updated_at FROM sanctions_lists WHERE list = ?').get(l) as { updated_at: number | null } | undefined
        setStatus(l, row?.updated_at ?? null, countFor(l), message)
        failed.push({ list: l, error: message })
        auditService.record({
          action: 'sanctions.refresh.failed',
          entityType: 'sanctions_list',
          entityId: l,
          summary: `更新制裁名单 ${l} 失败：${message}`,
          actor,
        })
      }
    }
    if (updated.length === 0 && failed.length > 0) {
      throw new AppError(502, 'SANCTIONS_DOWNLOAD_FAILED', `制裁名单下载失败：${failed.map((f) => `${f.list} ${f.error}`).join('；')}`)
    }
    return { updated, failed }
  },

  importCustom(csvText: string, actor: Actor = currentActor()): { count: number } {
    const entries = parseCustomCsv(csvText)
    transaction(() => {
      replaceEntries('custom', entries)
      setStatus('custom', Date.now(), entries.length, null)
    })
    auditService.record({
      action: 'sanctions.import',
      entityType: 'sanctions_list',
      entityId: 'custom',
      summary: `导入自定义制裁名单，共 ${entries.length} 条`,
      actor,
    })
    return { count: entries.length }
  },

  status(): ListStatus[] {
    const rows = db.prepare('SELECT * FROM sanctions_lists').all() as unknown[]
    return rows.map((row) => {
      const r = row as Record<string, unknown>
      return {
        list: String(r.list),
        updatedAt: typeof r.updated_at === 'number' ? r.updated_at : null,
        entryCount: Number(r.entry_count ?? 0),
        sourceUrl: String(r.source_url ?? ''),
        error: r.error === null ? null : String(r.error),
      }
    })
  },

  screen(name: string, opts: ScreenOptions = {}): {
    hits: ScreeningResult[]
    checkedLists: string[]
    listsMissing: string[]
    disclaimer: string
  } {
    const hits = index().screen(name, { country: opts.country, threshold: opts.threshold, limit: opts.limit })
    const status = sanctionsService.status()
    const checkedLists = status.filter((s) => s.entryCount > 0).map((s) => s.list)
    const listsMissing = OFFICIAL_LISTS.filter((l) => !status.some((s) => s.list === l && s.entryCount > 0))
    return {
      hits,
      checkedLists,
      listsMissing,
      disclaimer: '仅为名称相似度初筛，命中需人工核实官方原文',
    }
  },
}

export { nameKey }

let autoUpdateTimer: NodeJS.Timeout | null = null

function shouldAutoUpdate(): boolean {
  if (process.env.NODE_ENV === 'test') return false
  return settingsService.get('sanctionsAutoUpdate') === '1'
}

const DAY_MS = 24 * 60 * 60 * 1000
let autoRunning = false

/** 开了“每天自动更新”时：任一官方名单从没下载过或超过 24 小时没更新，就整体刷新一次（每小时检查） */
async function tickAutoUpdate(): Promise<void> {
  if (!shouldAutoUpdate() || autoRunning) return
  const status = sanctionsService.status()
  const stale = OFFICIAL_LISTS.some((list) => {
    const row = status.find((item) => item.list === list)
    return !row?.updatedAt || Date.now() - row.updatedAt > DAY_MS
  })
  if (!stale) return
  autoRunning = true
  try {
    await sanctionsService.refresh('all', LOCAL_ACTOR)
  } catch (error) {
    console.warn('[lulux-eta] 制裁名单自动更新失败：', error instanceof Error ? error.message : String(error))
  } finally {
    autoRunning = false
  }
}

export function startAutoUpdate(): void {
  if (autoUpdateTimer) return
  // 启动 1 分钟后先检查一次，之后每小时检查（是否到期由 tickAutoUpdate 判断）
  setTimeout(() => void tickAutoUpdate(), 60_000).unref()
  autoUpdateTimer = setInterval(() => {
    void tickAutoUpdate()
  }, 60 * 60 * 1000)
  autoUpdateTimer.unref()
}

export function stopAutoUpdate(): void {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer)
    autoUpdateTimer = null
  }
}
