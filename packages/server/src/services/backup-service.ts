import { accessSync, constants, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, parse as parsePath, resolve } from 'node:path'
import { config } from '../config.js'
import { db } from '../db.js'
import { AppError } from '../errors.js'
import { auditService } from './audit-service.js'
import { settingsService } from './settings-service.js'
import { currentActor } from '../context.js'
import { backupDirPath, customBackupDir, defaultBackupDir, ensureBackupDir, locateBackup, saveBackupDir } from '../db/backup-dir.js'
import { BACKUP_NAME, inspectBackup, pendingFile, readRestoreState, sha256File, type RestorePending } from '../db/restore.js'

/**
 * 数据库快照备份（整库，含邮件、团队、审计、技能状态；密钥仍为加密形态）。
 * - 自动：每 autoBackupHours 小时一次（0 关闭，默认 24），保留最近 autoBackupKeep 份（默认 7）；
 * - 手动：POST /api/data/backups；列表：GET /api/data/backups（data:export，owner/admin）。
 * - 恢复：退出应用后用快照文件替换 <dataDir>/lulux.db（见契约 §10.5）。导入前的 before-import-* 快照不参与轮转。
 * - 备份目录默认 <dataDir>/backups，owner 可改到别的磁盘（desktop 用文件夹选择框，server 填服务器上的路径）；
 *   和数据目录在同一块盘上时界面给出提醒。改目录后旧快照留在原处，列表里一并显示。
 * - 下载：GET /api/data/backups/:name/download（data:export）；删除：DELETE /api/data/backups/:name（owner / admin）。
 */
const PREFIX = 'auto-'

export interface BackupFile {
  name: string
  size: number
  createdAt: number
  kind: 'auto' | 'manual' | 'before-import' | 'before-restore' | 'pre-migration' | 'other'
  /** 在当前备份目录里（false：在改目录之前的默认目录里） */
  inCurrentDir: boolean
}

export interface BackupLocation {
  /** 当前生效的备份目录 */
  dir: string
  defaultDir: string
  /** 是否用的是自定义目录 */
  custom: boolean
  /** 设置的自定义目录（不可用时 dir 会退回默认目录） */
  configuredDir: string | null
  dataDir: string
  /** 备份目录和数据目录在同一块磁盘（同一个文件系统）上 */
  sameDisk: boolean
}

function dir(): string {
  return ensureBackupDir(config.home)
}

function deviceOf(path: string): number | null {
  try {
    return statSync(path).dev
  } catch {
    return null
  }
}

function filesIn(path: string, inCurrentDir: boolean): BackupFile[] {
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((name) => name.endsWith('.db') && BACKUP_NAME.test(name))
    .map((name) => {
      const stat = statSync(join(path, name))
      return { name, size: stat.size, createdAt: stat.mtimeMs, kind: kindOf(name), inCurrentDir }
    })
}

/** 系统目录不能作为备份目录 */
const FORBIDDEN_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr']

/** Windows 系统目录（大小写不敏感）：系统目录与程序安装目录 */
function windowsSystemDirs(): string[] {
  const drive = process.env.SystemDrive || 'C:'
  return [
    process.env.SystemRoot || `${drive}\\Windows`,
    process.env.ProgramFiles || `${drive}\\Program Files`,
    process.env['ProgramFiles(x86)'] || `${drive}\\Program Files (x86)`,
  ].map((d) => resolve(d).toLowerCase())
}

function isSystemDir(path: string): boolean {
  if (FORBIDDEN_DIRS.some((d) => path === d || path.startsWith(`${d}/`))) return true
  if (process.platform !== 'win32') return false
  const lower = path.toLowerCase()
  return windowsSystemDirs().some((d) => lower === d || lower.startsWith(`${d}\\`))
}

function validateBackupDir(input: string): string {
  const raw = input.trim()
  if (!raw) throw new AppError(400, 'VALIDATION_ERROR', '请填写备份目录')
  if (raw.length > 1000 || raw.includes('\0')) throw new AppError(400, 'VALIDATION_ERROR', '备份目录不正确')
  if (!isAbsolute(raw)) throw new AppError(400, 'VALIDATION_ERROR', '备份目录必须是绝对路径')
  const path = resolve(normalize(raw))
  if (parsePath(path).root === path) throw new AppError(400, 'VALIDATION_ERROR', '不能把磁盘根目录作为备份目录')
  if (isSystemDir(path)) throw new AppError(400, 'VALIDATION_ERROR', '不能使用系统目录作为备份目录')
  if (path === resolve(config.home)) throw new AppError(400, 'VALIDATION_ERROR', '备份目录不能是数据目录本身，请选择子目录或其他磁盘')
  try {
    mkdirSync(path, { recursive: true })
  } catch (error) {
    throw new AppError(400, 'BACKUP_DIR_INVALID', `无法创建备份目录：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!statSync(path).isDirectory()) throw new AppError(400, 'BACKUP_DIR_INVALID', '备份目录不是文件夹')
  const probe = join(path, `.lulux-write-test-${process.pid}`)
  try {
    accessSync(path, constants.W_OK)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
  } catch (error) {
    throw new AppError(400, 'BACKUP_DIR_INVALID', `备份目录不可写：${error instanceof Error ? error.message : String(error)}`)
  }
  return path
}

function requireBackupName(name: string): void {
  if (!BACKUP_NAME.test(name)) throw new AppError(400, 'INVALID_BACKUP_NAME', '备份文件名不正确')
}

/** 自动备份等后台审计记到哪个组织：server 模式是唯一的组织，desktop 是 local */
function backgroundOrgId(): string {
  if (config.mode !== 'server') return 'local'
  try {
    const row = db.prepare('SELECT id FROM orgs ORDER BY created_at LIMIT 1').get() as { id: string } | undefined
    return row?.id ?? 'local'
  } catch {
    return 'local'
  }
}

function kindOf(name: string): BackupFile['kind'] {
  if (name.startsWith(PREFIX)) return 'auto'
  if (name.startsWith('manual-')) return 'manual'
  if (name.startsWith('before-import-')) return 'before-import'
  if (name.startsWith('before-restore-')) return 'before-restore'
  if (name.startsWith('pre-migration-')) return 'pre-migration'
  return 'other'
}

let timer: NodeJS.Timeout | null = null

export const backupService = {
  list(): BackupFile[] {
    const current = dir()
    const files = filesIn(current, true)
    const fallback = defaultBackupDir(config.home)
    if (resolve(fallback) !== resolve(current)) {
      const seen = new Set(files.map((f) => f.name))
      files.push(...filesIn(fallback, false).filter((f) => !seen.has(f.name)))
    }
    return files.sort((a, b) => b.createdAt - a.createdAt)
  },

  location(): BackupLocation {
    const current = dir()
    const configured = customBackupDir(config.home)
    const a = deviceOf(current)
    const b = deviceOf(config.home)
    return {
      dir: current,
      defaultDir: defaultBackupDir(config.home),
      custom: configured !== null && resolve(configured) === resolve(current),
      configuredDir: configured,
      dataDir: config.home,
      sameDisk: a !== null && a === b,
    }
  },

  /** 修改备份目录（null 恢复默认）。路由层已限定 owner */
  setLocation(input: unknown): BackupLocation {
    const value = input && typeof input === 'object' ? (input as { dir?: unknown }).dir : undefined
    if (value !== null && typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'dir 必须是字符串或 null')
    const before = backupDirPath(config.home)
    const next = value === null || value.trim() === '' ? null : validateBackupDir(value)
    saveBackupDir(config.home, next)
    const location = backupService.location()
    auditService.record({
      action: 'backup.location',
      entityType: 'backup',
      entityId: null,
      summary: next ? `修改备份目录为 ${next}` : '备份目录恢复为默认',
      meta: { from: before, to: location.dir, sameDisk: location.sameDisk },
    })
    return location
  },

  /** 下载用：校验文件名并返回路径 */
  file(name: string): { path: string; size: number } {
    requireBackupName(name)
    const path = locateBackup(config.home, name)
    if (!existsSync(path)) throw new AppError(404, 'NOT_FOUND', '备份文件不存在')
    return { path, size: statSync(path).size }
  },

  open(path: string) {
    return createReadStream(path)
  },

  remove(name: string): void {
    const { path } = backupService.file(name)
    const pending = readRestoreState(config.home).pending
    if (pending?.name === name) throw new AppError(409, 'BACKUP_PENDING_RESTORE', '这个快照已选为下次启动时恢复，请先取消恢复')
    rmSync(path, { force: true })
  },

  create(kind: 'auto' | 'manual' = 'manual'): BackupFile {
    const name = `${kind === 'auto' ? PREFIX : 'manual-'}${new Date().toISOString().replace(/[:.]/g, '-')}.db`
    const file = join(dir(), name)
    try {
      db.prepare('VACUUM INTO ?').run(file)
    } catch (error) {
      throw new AppError(500, 'BACKUP_FAILED', `备份失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (kind === 'auto') backupService.prune()
    const stat = statSync(file)
    return { name, size: stat.size, createdAt: stat.mtimeMs, kind, inCurrentDir: true }
  },

  /**
   * 选择一个快照在下次启动时恢复：校验文件名、完整性、schema 版本，记录 SHA-256（启动时再比对）。
   * 返回待恢复记录；客户端提示“重启应用后生效”。
   */
  requestRestore(name: string): { pending: RestorePending; restartRequired: true } {
    requireBackupName(name)
    const file = locateBackup(config.home, name)
    let schemaVersion = 0
    try {
      schemaVersion = inspectBackup(file).schemaVersion
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AppError(message === '备份文件不存在' ? 404 : 400, message === '备份文件不存在' ? 'NOT_FOUND' : 'BACKUP_INVALID', message)
    }
    const pending: RestorePending = {
      name,
      sha256: sha256File(file),
      size: statSync(file).size,
      schemaVersion,
      requestedAt: Date.now(),
      requestedBy: currentActor().id,
    }
    writeFileSync(pendingFile(config.home), JSON.stringify(pending, null, 2), { mode: 0o600 })
    return { pending, restartRequired: true }
  },

  cancelRestore(): boolean {
    const had = readRestoreState(config.home).pending !== null
    rmSync(pendingFile(config.home), { force: true })
    return had
  },

  restoreState() {
    return readRestoreState(config.home)
  },

  /** 只轮转自动备份 */
  prune(): number {
    const keep = Math.max(1, Number(settingsService.get('autoBackupKeep') || 7))
    const autos = backupService.list().filter((b) => b.kind === 'auto' && b.inCurrentDir)
    let removed = 0
    for (const old of autos.slice(keep)) {
      rmSync(join(dir(), old.name), { force: true })
      removed += 1
    }
    return removed
  },

  /** 距上次自动备份超过间隔则备份；返回是否执行 */
  tick(now = Date.now()): boolean {
    const hours = Number(settingsService.get('autoBackupHours') || 0)
    if (!hours) return false
    const last = backupService.list().find((b) => b.kind === 'auto')
    if (last && now - last.createdAt < hours * 3600_000) return false
    try {
      const file = backupService.create('auto')
      auditService.record({
        action: 'backup.auto',
        entityType: 'backup',
        entityId: file.name,
        summary: `自动备份 ${file.name}`,
        meta: { size: file.size, dir: dir() },
        actor: null,
        orgId: backgroundOrgId(),
      })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[lulux-eta] auto backup failed:', message)
      auditService.record({ action: 'backup.auto_failed', entityType: 'backup', entityId: null, summary: `自动备份失败：${message}`, actor: null, orgId: backgroundOrgId() })
      return false
    }
  },

  start(): void {
    if (timer) return
    // 启动 1 分钟后检查一次，之后每 30 分钟检查一次
    setTimeout(() => backupService.tick(), 60_000).unref()
    timer = setInterval(() => backupService.tick(), 30 * 60_000)
    timer.unref()
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
