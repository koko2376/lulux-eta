import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { currentActor } from '../../context.js'
import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { eventBus } from '../events.js'
import { composeSkillMarkdown, parseSkillMarkdown, type SkillMeta } from './format.js'
import { buildPackage, hashFiles, normalizeEntryPath, readSkillDirectory, SkillPackageError, type SkillFile, type SkillPackage } from './package.js'
import { assertSkillName, backupsRoot, builtinSkillsDir, resolveSkillFile, skillDir, skillsRoot } from './paths.js'
import { writeZip } from './zip.js'

export type SkillSource = 'builtin' | 'user' | 'agent' | 'imported'
export type SkillInstaller = 'user' | 'agent' | 'system'

export interface Skill {
  name: string
  description: string
  source: SkillSource
  enabled: boolean
  category: string | null
  keywords: string[]
  version: string | null
  author: string | null
  license: string | null
  upstream: { source: string; commit: string | null } | null
  requires: SkillMeta['requires']
  hasScripts: boolean
  /** 内置 skill 只读：不可删除、不可经 Agent 修改 */
  readOnly: boolean
  /** 内置 skill 的本地副本被改动过（启动同步不会覆盖） */
  modified: boolean
  /** 内置 skill：安装包带来了新版本但因本地改动未覆盖 */
  updateAvailable: boolean
  origin: string
  installedBy: SkillInstaller
  useCount: number
  lastUsedAt: number | null
  installedAt: number
  updatedAt: number
  /** SKILL.md 无法解析时的错误（此时 skill 不会出现在对话索引里） */
  error: string | null
}

export interface SkillFileInfo {
  path: string
  size: number
}

export interface SkillDetail extends Skill {
  files: SkillFileInfo[]
  content: string
  body: string
  frontmatter: Record<string, unknown>
}

interface SkillRow {
  name: string
  source: SkillSource
  enabled: number
  origin: string
  installed_by: SkillInstaller
  has_scripts: number
  content_hash: string
  builtin_hash: string | null
  use_count: number
  last_used_at: number | null
  installed_at: number
  updated_at: number
}

export interface InstallOptions {
  source: SkillSource
  origin?: string
  installedBy?: SkillInstaller
  overwrite?: boolean
  /** 覆盖前备份（Agent 修改时总是备份） */
  backup?: boolean
}

export interface BuiltinSyncReport {
  added: string[]
  updated: string[]
  keptModified: string[]
  removed: string[]
  restored: string[]
}

const BACKUP_KEEP = 10
const metaCache = new Map<string, { mtimeMs: number; size: number; meta: SkillMeta | null; error: string | null }>()
let ready = false
let shippedHashes: Map<string, { hash: string; dir: string }> | null = null

function now(): number {
  return Date.now()
}

function publish(name: string, action: string): void {
  try {
    const actor = currentActor()
    eventBus.publish('skills.changed', { name, action }, { org_id: actor.orgId, owner_id: actor.id, visibility: 'org', team_id: null })
  } catch {
    // 事件只是通知
  }
}

function readMeta(name: string): { meta: SkillMeta | null; error: string | null } {
  const file = join(skillDir(name), 'SKILL.md')
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { meta: null, error: 'SKILL.md 不存在' }
  }
  const cached = metaCache.get(name)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
  let entry: { mtimeMs: number; size: number; meta: SkillMeta | null; error: string | null }
  try {
    const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'), name)
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, meta: parsed.meta, error: null }
  } catch (error) {
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, meta: null, error: error instanceof Error ? error.message : String(error) }
  }
  metaCache.set(name, entry)
  return entry
}

function dirFiles(name: string): SkillFile[] {
  const dir = skillDir(name)
  if (!existsSync(dir)) return []
  return readSkillDirectory(dir)
    .filter((entry) => !entry.isSymlink)
    .map((entry) => ({ path: entry.path, data: entry.data }))
}

function currentHash(name: string): string {
  try {
    return hashFiles(dirFiles(name))
  } catch {
    return ''
  }
}

function toSkill(row: SkillRow): Skill {
  const { meta, error } = readMeta(row.name)
  const shipped = row.source === 'builtin' ? shippedHashes?.get(row.name) : undefined
  const modified = row.source === 'builtin' && Boolean(row.builtin_hash) && row.content_hash !== row.builtin_hash
  return {
    name: row.name,
    description: meta?.description ?? '',
    source: row.source,
    enabled: Number(row.enabled) === 1,
    category: meta?.category ?? null,
    keywords: meta?.keywords ?? [],
    version: meta?.version ?? null,
    author: meta?.author ?? null,
    license: meta?.license ?? null,
    upstream: meta?.upstream ?? null,
    requires: meta?.requires ?? { tools: [], mcp: [], npm: [], python: false },
    hasScripts: Number(row.has_scripts) === 1,
    readOnly: row.source === 'builtin',
    modified,
    updateAvailable: Boolean(modified && shipped && shipped.hash !== row.builtin_hash),
    origin: row.origin,
    installedBy: row.installed_by,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    installedAt: Number(row.installed_at),
    updatedAt: Number(row.updated_at),
    error,
  }
}

function getRow(name: string): SkillRow | undefined {
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as unknown as SkillRow | undefined
}

function allRows(): SkillRow[] {
  return db.prepare('SELECT * FROM skills ORDER BY name').all() as unknown as SkillRow[]
}

/** 把文件写入 <root>/.staging 再整体换入，保证不会留下半个 skill */
function writeTree(name: string, files: SkillFile[], backup: boolean): string | null {
  const root = skillsRoot()
  const staging = join(root, '.staging', `${name}-${randomBytes(4).toString('hex')}`)
  mkdirSync(staging, { recursive: true })
  try {
    for (const file of files) {
      // 再校验一次（调用方都经过 buildPackage，这里兜底）：路径必须落在临时目录内
      const rel = normalizeEntryPath(file.path)
      const abs = resolve(staging, ...rel.split('/'))
      const within = relative(staging, abs)
      if (!rel || within.startsWith('..') || isAbsolute(within)) throw new SkillPackageError(`路径超出 skill 目录：${file.path}`, 'SKILL_PATH_INVALID')
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, file.data, { flag: 'wx' })
    }
    const target = skillDir(name)
    let backupPath: string | null = null
    if (existsSync(target)) {
      if (backup) {
        backupPath = join(backupsRoot(), name, `${new Date().toISOString().replace(/[:.]/g, '-')}`)
        mkdirSync(dirname(backupPath), { recursive: true })
        renameSync(target, backupPath)
        pruneBackups(name)
      } else {
        rmSync(target, { recursive: true, force: true })
      }
    }
    renameSync(staging, target)
    metaCache.delete(name)
    return backupPath
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function pruneBackups(name: string): void {
  const dir = join(backupsRoot(), name)
  if (!existsSync(dir)) return
  const entries = readdirSync(dir).sort()
  for (const old of entries.slice(0, Math.max(0, entries.length - BACKUP_KEEP))) rmSync(join(dir, old), { recursive: true, force: true })
}

function shippedSkills(): Map<string, { hash: string; dir: string }> {
  const map = new Map<string, { hash: string; dir: string }>()
  const root = builtinSkillsDir()
  if (!root) return map
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    try {
      const pkg = buildPackage(readSkillDirectory(dir), { expectedName: entry.name })
      map.set(pkg.name, { hash: pkg.hash, dir })
    } catch (error) {
      console.warn(`[lulux-eta] 内置 skill ${entry.name} 无效，已跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return map
}

function writeManifest(map: Map<string, { hash: string }>): void {
  try {
    const manifest = Object.fromEntries([...map].map(([name, info]) => [name, info.hash]))
    mkdirSync(skillsRoot(), { recursive: true })
    writeFileSync(join(skillsRoot(), '.builtin-manifest.json'), `${JSON.stringify({ updatedAt: now(), skills: manifest }, null, 2)}\n`)
  } catch {
    // 清单只是诊断信息
  }
}

export const skillService = {
  /**
   * 启动同步（首次访问时执行一次）：
   * 1. 内置 skill：新增的复制进来；已有副本若未被修改（当前哈希 = 上次同步写入的哈希）且安装包版本变化则覆盖；
   *    被修改的保留并标记 updateAvailable；安装包里删掉的内置 skill，未修改则删除、修改过则转为 user；
   * 2. 目录与数据库对齐：手动放进 <dataDir>/skills 的目录登记为 user；目录不在了的记录删除。
   */
  ensureReady(): void {
    if (ready) return
    ready = true
    mkdirSync(skillsRoot(), { recursive: true })
    try {
      skillService.syncBuiltins()
    } catch (error) {
      console.warn('[lulux-eta] builtin skills sync failed:', error instanceof Error ? error.message : String(error))
    }
    skillService.reconcile()
  },

  syncBuiltins(): BuiltinSyncReport {
    const report: BuiltinSyncReport = { added: [], updated: [], keptModified: [], removed: [], restored: [] }
    const shipped = shippedSkills()
    shippedHashes = shipped
    const t = now()
    for (const [name, info] of shipped) {
      const row = getRow(name)
      const target = skillDir(name)
      if (row && row.source !== 'builtin') {
        // 同名的用户 skill 先装上了：不覆盖用户的，内置这份不生效
        console.warn(`[lulux-eta] 内置 skill ${name} 与已安装的 ${row.source} skill 同名，保留已安装的`)
        continue
      }
      if (!row || !existsSync(target)) {
        const pkg = buildPackage(readSkillDirectory(info.dir), { expectedName: name })
        writeTree(name, pkg.files, false)
        db.prepare(
          `INSERT INTO skills (name, source, enabled, origin, installed_by, has_scripts, content_hash, builtin_hash, installed_at, updated_at)
           VALUES (?, 'builtin', 1, 'builtin', 'system', ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET has_scripts = excluded.has_scripts, content_hash = excluded.content_hash,
             builtin_hash = excluded.builtin_hash, updated_at = excluded.updated_at`,
        ).run(name, pkg.hasScripts ? 1 : 0, pkg.hash, pkg.hash, t, t)
        ;(row ? report.restored : report.added).push(name)
        continue
      }
      const local = currentHash(name)
      if (local !== row.content_hash) {
        db.prepare('UPDATE skills SET content_hash = ? WHERE name = ?').run(local, name)
        row.content_hash = local
      }
      if (row.builtin_hash === info.hash) continue
      if (local === row.builtin_hash) {
        const pkg = buildPackage(readSkillDirectory(info.dir), { expectedName: name })
        writeTree(name, pkg.files, false)
        db.prepare('UPDATE skills SET has_scripts = ?, content_hash = ?, builtin_hash = ?, updated_at = ? WHERE name = ?').run(
          pkg.hasScripts ? 1 : 0,
          pkg.hash,
          pkg.hash,
          t,
          name,
        )
        report.updated.push(name)
      } else {
        report.keptModified.push(name)
      }
    }
    for (const row of allRows().filter((r) => r.source === 'builtin' && !shipped.has(r.name))) {
      // 没有内置目录（如测试环境或打包遗漏）时不做删除，避免误删
      if (shipped.size === 0) break
      const local = currentHash(row.name)
      if (local && local !== row.builtin_hash) {
        db.prepare("UPDATE skills SET source = 'user', builtin_hash = NULL, updated_at = ? WHERE name = ?").run(t, row.name)
      } else {
        rmSync(skillDir(row.name), { recursive: true, force: true })
        db.prepare('DELETE FROM skills WHERE name = ?').run(row.name)
        report.removed.push(row.name)
      }
    }
    writeManifest(shipped)
    return report
  },

  reconcile(): void {
    const root = skillsRoot()
    const t = now()
    const dirs = new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name),
    )
    for (const row of allRows()) {
      if (!dirs.has(row.name)) db.prepare('DELETE FROM skills WHERE name = ?').run(row.name)
    }
    for (const name of dirs) {
      if (getRow(name)) continue
      try {
        assertSkillName(name)
      } catch {
        continue
      }
      const files = dirFiles(name)
      db.prepare(
        `INSERT INTO skills (name, source, enabled, origin, installed_by, has_scripts, content_hash, installed_at, updated_at)
         VALUES (?, 'user', 1, 'local', 'user', ?, ?, ?, ?)`,
      ).run(name, files.some((f) => f.path.startsWith('scripts/')) ? 1 : 0, hashFiles(files), t, t)
    }
  },

  list(filter: { query?: string; category?: string; source?: string; enabled?: boolean } = {}): Skill[] {
    skillService.ensureReady()
    const query = filter.query?.trim().toLowerCase()
    return allRows()
      .map(toSkill)
      .filter((skill) => {
        if (filter.category && (skill.category ?? 'other') !== filter.category) return false
        if (filter.source && skill.source !== filter.source) return false
        if (filter.enabled !== undefined && skill.enabled !== filter.enabled) return false
        if (query) {
          const hay = `${skill.name}\n${skill.description}\n${skill.keywords.join(' ')}\n${skill.category ?? ''}`.toLowerCase()
          if (!query.split(/\s+/).every((word) => hay.includes(word))) return false
        }
        return true
      })
  },

  get(name: string): Skill | undefined {
    skillService.ensureReady()
    try {
      assertSkillName(name)
    } catch {
      return undefined
    }
    const row = getRow(name)
    return row ? toSkill(row) : undefined
  },

  require(name: string): Skill {
    const skill = skillService.get(name)
    if (!skill) throw new AppError(404, 'SKILL_NOT_FOUND', `找不到 skill：${String(name).slice(0, 80)}`)
    return skill
  },

  detail(name: string): SkillDetail {
    const skill = skillService.require(name)
    const files = dirFiles(name).map((file) => ({ path: file.path, size: file.data.length }))
    files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
    const content = readFileSync(join(skillDir(name), 'SKILL.md'), 'utf8')
    let body = content
    let frontmatter: Record<string, unknown> = {}
    try {
      const parsed = parseSkillMarkdown(content, name)
      body = parsed.body
      frontmatter = parsed.meta.raw
    } catch {
      // error 字段已说明
    }
    return { ...skill, files, content, body, frontmatter }
  },

  files(name: string): SkillFileInfo[] {
    skillService.require(name)
    return dirFiles(name).map((file) => ({ path: file.path, size: file.data.length }))
  },

  /** 读取 skill 内文件（文本 ≤ limit 字节；二进制只返回大小） */
  readFile(name: string, path: string, limit = 256 * 1024): { path: string; size: number; binary: boolean; content: string; truncated: boolean } {
    skillService.require(name)
    const { abs, rel } = resolveSkillFile(name, path)
    const stat = statSync(abs)
    if (!stat.isFile()) throw new SkillPackageError(`不是文件：${rel}`, 'SKILL_FILE_NOT_FOUND')
    const data = readFileSync(abs)
    const head = data.subarray(0, Math.min(data.length, 8000))
    const binary = head.includes(0)
    if (binary) return { path: rel, size: stat.size, binary: true, content: '', truncated: false }
    const truncated = data.length > limit
    return { path: rel, size: stat.size, binary: false, content: data.subarray(0, limit).toString('utf8'), truncated }
  },

  setEnabled(name: string, enabled: boolean): Skill {
    skillService.require(name)
    db.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE name = ?').run(enabled ? 1 : 0, now(), name)
    publish(name, enabled ? 'enabled' : 'disabled')
    return skillService.require(name)
  },

  remove(name: string): void {
    const skill = skillService.require(name)
    if (skill.source === 'builtin') throw new AppError(400, 'SKILL_BUILTIN_READONLY', '内置 skill 不能删除，只能禁用')
    rmSync(skillDir(name), { recursive: true, force: true })
    db.prepare('DELETE FROM skills WHERE name = ?').run(name)
    metaCache.delete(name)
    publish(name, 'deleted')
  },

  /** 把内置 skill 恢复为安装包里的版本（丢弃本地改动） */
  resetBuiltin(name: string): Skill {
    const skill = skillService.require(name)
    if (skill.source !== 'builtin') throw new AppError(400, 'SKILL_NOT_BUILTIN', '只有内置 skill 可以恢复默认')
    const info = (shippedHashes ?? shippedSkills()).get(name)
    if (!info) throw new AppError(404, 'SKILL_NOT_FOUND', '安装包里没有这个内置 skill')
    const pkg = buildPackage(readSkillDirectory(info.dir), { expectedName: name })
    writeTree(name, pkg.files, true)
    db.prepare('UPDATE skills SET has_scripts = ?, content_hash = ?, builtin_hash = ?, updated_at = ? WHERE name = ?').run(
      pkg.hasScripts ? 1 : 0,
      pkg.hash,
      pkg.hash,
      now(),
      name,
    )
    publish(name, 'updated')
    return skillService.require(name)
  },

  install(pkg: SkillPackage, options: InstallOptions): { skill: Skill; replaced: boolean; backup: string | null } {
    skillService.ensureReady()
    const existing = getRow(pkg.name)
    if (existing?.source === 'builtin') {
      throw new AppError(409, 'SKILL_BUILTIN_CONFLICT', `「${pkg.name}」是内置 skill，不能被覆盖；请换一个 name`)
    }
    if (existing && !options.overwrite) {
      throw new AppError(409, 'SKILL_EXISTS', `已存在同名 skill「${pkg.name}」；如需覆盖请设置 overwrite`)
    }
    const backup = writeTree(pkg.name, pkg.files, Boolean(existing) && options.backup !== false)
    const t = now()
    db.prepare(
      `INSERT INTO skills (name, source, enabled, origin, installed_by, has_scripts, content_hash, installed_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET source = excluded.source, origin = excluded.origin, installed_by = excluded.installed_by,
         has_scripts = excluded.has_scripts, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
    ).run(pkg.name, options.source, options.origin ?? '', options.installedBy ?? 'user', pkg.hasScripts ? 1 : 0, pkg.hash, t, t)
    publish(pkg.name, existing ? 'updated' : 'installed')
    return { skill: skillService.require(pkg.name), replaced: Boolean(existing), backup }
  },

  /** Agent 自写 skill（来源 agent） */
  createByAgent(input: {
    name: string
    description: string
    body: string
    keywords?: string[]
    category?: string
    files?: Array<{ path: string; content: string }>
  }): Skill {
    assertSkillName(input.name)
    if (getRow(input.name)) throw new AppError(409, 'SKILL_EXISTS', `已存在同名 skill「${input.name}」，请用 skill_update 修改或换个名字`)
    const markdown = composeSkillMarkdown({
      name: input.name,
      description: input.description,
      body: input.body,
      keywords: input.keywords,
      category: input.category,
      author: 'LULUX Agent',
      version: '1.0.0',
    })
    const entries = [
      { path: 'SKILL.md', data: Buffer.from(markdown, 'utf8') },
      ...(input.files ?? []).filter((f) => f.path !== 'SKILL.md').map((f) => ({ path: f.path, data: Buffer.from(f.content, 'utf8') })),
    ]
    const pkg = buildPackage(entries, { expectedName: input.name })
    return skillService.install(pkg, { source: 'agent', origin: 'agent', installedBy: 'agent' }).skill
  },

  /** Agent 修改自己的（或用户的）skill；修改前把旧版本备份到 .backups */
  updateByAgent(input: {
    name: string
    description?: string
    body?: string
    keywords?: string[]
    files?: Array<{ path: string; content: string }>
    deleteFiles?: string[]
  }): { skill: Skill; backup: string | null } {
    const skill = skillService.require(input.name)
    if (skill.source === 'builtin') throw new AppError(400, 'SKILL_BUILTIN_READONLY', '内置 skill 是只读的；需要改动请用 skill_create 另建一个')
    const current = new Map(dirFiles(input.name).map((file) => [file.path, file.data]))
    let markdown = current.get('SKILL.md')?.toString('utf8') ?? ''
    if (input.description !== undefined || input.body !== undefined || input.keywords !== undefined) {
      let parsed
      try {
        parsed = parseSkillMarkdown(markdown, input.name)
      } catch {
        parsed = null
      }
      const raw = (parsed?.meta.raw ?? {}) as Record<string, unknown>
      const metadata = raw.metadata && typeof raw.metadata === 'object' ? (raw.metadata as Record<string, unknown>) : {}
      markdown = composeSkillMarkdown({
        name: input.name,
        description: input.description ?? parsed?.meta.description ?? '',
        body: input.body ?? parsed?.body ?? '',
        keywords: input.keywords ?? parsed?.meta.keywords,
        category: parsed?.meta.category ?? undefined,
        author: parsed?.meta.author ?? undefined,
        license: parsed?.meta.license ?? undefined,
        version: bumpVersion(parsed?.meta.version ?? null),
        requires: parsed?.meta.requires,
        extra: Object.fromEntries(
          Object.entries(metadata).filter(([key]) => !['keywords', 'version', 'author', 'category', 'requires', 'tags'].includes(key)),
        ) as never,
      })
      current.set('SKILL.md', Buffer.from(markdown, 'utf8'))
    }
    for (const path of input.deleteFiles ?? []) {
      if (path === 'SKILL.md') throw new AppError(400, 'VALIDATION_ERROR', '不能删除 SKILL.md')
      current.delete(path.replace(/\\/g, '/'))
    }
    for (const file of input.files ?? []) {
      if (file.path === 'SKILL.md') current.set('SKILL.md', Buffer.from(file.content, 'utf8'))
      else current.set(file.path, Buffer.from(file.content, 'utf8'))
    }
    const pkg = buildPackage(
      [...current].map(([path, data]) => ({ path, data })),
      { expectedName: input.name },
    )
    const result = skillService.install(pkg, {
      source: skill.source,
      origin: skill.origin,
      installedBy: skill.installedBy,
      overwrite: true,
      backup: true,
    })
    return { skill: result.skill, backup: result.backup }
  },

  exportZip(name: string): Buffer {
    skillService.require(name)
    return writeZip(dirFiles(name).map((file) => ({ path: `${name}/${file.path}`, data: file.data })))
  },

  recordUse(name: string, kind: 'view' | 'script' | 'preload', sessionId?: string | null, agentId?: string | null): void {
    try {
      const t = now()
      db.prepare('UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?').run(t, name)
      db.prepare('INSERT INTO skill_usage (skill, kind, session_id, agent_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        name,
        kind,
        sessionId ?? null,
        agentId ?? null,
        currentActor().id,
        t,
      )
    } catch (error) {
      console.warn('[lulux-eta] skill usage record failed:', error instanceof Error ? error.message : String(error))
    }
  },

  usage(name: string): { total: number; byKind: Record<string, number>; last30Days: number } {
    skillService.require(name)
    const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM skill_usage WHERE skill = ? GROUP BY kind').all(name) as unknown as Array<{ kind: string; n: number }>
    const recent = db.prepare('SELECT COUNT(*) AS n FROM skill_usage WHERE skill = ? AND created_at >= ?').get(name, now() - 30 * 86400_000) as unknown as { n: number }
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]))
    return { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, last30Days: Number(recent.n) }
  },

  /** 内置副本目录（只读源），测试与 CLI 同步用 */
  shippedDir(name: string): string | null {
    return (shippedHashes ?? shippedSkills()).get(name)?.dir ?? null
  },

  copyTo(name: string, target: string): void {
    cpSync(skillDir(name), target, {
      recursive: true,
      // 不复制符号链接（脚本运行时可能在 skill 目录里留下指向目录外的链接）
      filter: (src) => !/[\\/](\.backups|\.git|node_modules|__pycache__)([\\/]|$)/.test(src) && !lstatSync(src).isSymbolicLink(),
    })
  },

  /** 测试用：重新执行启动同步 */
  resetForTests(): void {
    ready = false
    shippedHashes = null
    metaCache.clear()
  },
}

function bumpVersion(version: string | null): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!match) return '1.0.1'
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

export type { SkillPackage }
