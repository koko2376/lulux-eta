import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './migrations.js'
import { ensureBackupDir, locateBackup } from './backup-dir.js'

/**
 * 备份恢复（docs/API-CONTRACT.md §10.5）：
 * 1. `POST /api/data/backups/:name/restore` 校验快照（文件名、integrity_check、schema 版本不高于本程序、必需表）并写入
 *    `<dataDir>/restore-pending.json`（含 SHA-256）；
 * 2. 下次启动、打开数据库之前 `applyPendingRestore()`：再次校验 SHA-256 与完整性 → 把当前库 checkpoint 后复制为
 *    `backups/before-restore-<ts>.db` → 用快照替换 `lulux-eta.db`（删除 -wal/-shm）→ 打开验证；
 *    任一步失败就用 before-restore 副本回滚，结果写 `<dataDir>/restore-result.json`（`GET /api/data/restore` 返回）。
 */
export const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.db$/
const REQUIRED_TABLES = ['schema_migrations', 'settings', 'customers']

export interface RestorePending {
  name: string
  sha256: string
  size: number
  schemaVersion: number
  requestedAt: number
  requestedBy: string
}

export interface RestoreResult {
  ok: boolean
  name: string
  at: number
  /** 恢复前的库副本（失败回滚 / 想撤销时使用） */
  previous: string | null
  rolledBack: boolean
  error: string | null
}

export function pendingFile(home: string): string {
  return join(home, 'restore-pending.json')
}
export function resultFile(home: string): string {
  return join(home, 'restore-result.json')
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function maxSupportedVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version))
}

/** 只读打开快照并校验；返回 schema 版本。失败抛 Error（消息给用户看） */
export function inspectBackup(file: string): { schemaVersion: number } {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('备份文件不存在')
  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(file, { readOnly: true })
    const check = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    const verdict = check.map((row) => String(Object.values(row)[0])).join('; ')
    if (verdict !== 'ok') throw new Error(`备份文件损坏：${verdict.slice(0, 200)}`)
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    )
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table))
    if (missing.length > 0) throw new Error(`不是 LULUX ETA 的数据库（缺少表：${missing.join(', ')}）`)
    const row = database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
    const schemaVersion = Number(row.v ?? 0)
    if (schemaVersion > maxSupportedVersion()) {
      throw new Error(`备份来自更新版本的 LULUX ETA（数据库版本 ${schemaVersion} > ${maxSupportedVersion()}），请先升级程序`)
    }
    return { schemaVersion }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(/备份|LULUX/.test(message) ? message : `无法读取备份文件：${message}`)
  } finally {
    database?.close()
  }
}

function removeSidecars(dbFile: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(dbFile + suffix, { force: true })
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 启动时（打开数据库之前）执行待恢复。没有待恢复时返回 null。
 * `verify` 用于在替换后做应用层检查（打开 + 迁移），抛错即回滚。
 */
export function applyPendingRestore(home: string, dbFile: string, verify?: (file: string) => void): RestoreResult | null {
  const pendingPath = pendingFile(home)
  if (!existsSync(pendingPath)) return null
  let pending: RestorePending | null = null
  const result: RestoreResult = { ok: false, name: '', at: Date.now(), previous: null, rolledBack: false, error: null }
  const finish = (): RestoreResult => {
    rmSync(pendingPath, { force: true })
    writeFileSync(resultFile(home), JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  }
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as RestorePending
    if (!pending || typeof pending.name !== 'string' || !BACKUP_NAME.test(pending.name)) throw new Error('待恢复记录无效')
    result.name = pending.name
    const source = locateBackup(home, pending.name)
    if (!existsSync(source)) throw new Error('备份文件已不存在')
    if (sha256File(source) !== pending.sha256) throw new Error('备份文件在确认恢复后被修改（SHA-256 不一致），已取消恢复')
    inspectBackup(source)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return finish()
  }

  // 1) 当前库先 checkpoint，再整体复制为 before-restore 副本
  const previous = join(ensureBackupDir(home), `before-restore-${stamp()}.db`)
  try {
    if (existsSync(dbFile)) {
      const current = new DatabaseSync(dbFile)
      try {
        current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        current.prepare('VACUUM INTO ?').run(previous)
      } finally {
        current.close()
      }
      result.previous = basename(previous)
    }
  } catch (error) {
    result.error = `无法备份当前数据库，已取消恢复：${error instanceof Error ? error.message : String(error)}`
    return finish()
  }

  // 2) 复制到临时文件再原子替换
  const temp = `${dbFile}.restore-${process.pid}`
  try {
    copyFileSync(locateBackup(home, pending.name), temp)
    removeSidecars(dbFile)
    renameSync(temp, dbFile)
    // 3) 替换后验证：完整性 + 应用层（打开 / 迁移）
    inspectBackup(dbFile)
    verify?.(dbFile)
    result.ok = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    rmSync(temp, { force: true })
    if (result.previous) {
      try {
        removeSidecars(dbFile)
        copyFileSync(previous, dbFile)
        result.rolledBack = true
      } catch (rollbackError) {
        result.error += `；回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}（请手动用 backups/${result.previous} 替换）`
      }
    }
  }
  return finish()
}

export function readRestoreState(home: string): { pending: RestorePending | null; lastResult: RestoreResult | null } {
  const read = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }
  return { pending: read<RestorePending>(pendingFile(home)), lastResult: read<RestoreResult>(resultFile(home)) }
}
