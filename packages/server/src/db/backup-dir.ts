import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * 备份目录：默认 <dataDir>/backups，可在设置里改到别的磁盘。
 * 记在 <dataDir>/backup-location.json 而不是数据库里：启动恢复、迁移前备份在打开数据库之前就要用到。
 */
export const BACKUP_LOCATION_FILE = 'backup-location.json'

export function defaultBackupDir(home: string): string {
  return join(home, 'backups')
}

/** 用户设置的目录（没有设置或文件损坏时为 null） */
export function customBackupDir(home: string): string | null {
  const file = join(home, BACKUP_LOCATION_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dir?: unknown }
    return typeof parsed.dir === 'string' && isAbsolute(parsed.dir) ? parsed.dir : null
  } catch {
    return null
  }
}

/** 当前生效的备份目录（不创建） */
export function backupDirPath(home: string): string {
  return customBackupDir(home) ?? defaultBackupDir(home)
}

/** 当前生效的备份目录；自定义目录不可用（例如移动硬盘没插）时退回默认目录，保证备份不中断 */
export function ensureBackupDir(home: string): string {
  const custom = customBackupDir(home)
  if (custom) {
    try {
      mkdirSync(custom, { recursive: true })
      return custom
    } catch (error) {
      console.warn(`[lulux-eta] backup directory ${custom} unavailable, falling back to default:`, error instanceof Error ? error.message : String(error))
    }
  }
  const fallback = defaultBackupDir(home)
  mkdirSync(fallback, { recursive: true })
  return fallback
}

export function saveBackupDir(home: string, dir: string | null): void {
  writeFileSync(join(home, BACKUP_LOCATION_FILE), JSON.stringify({ dir }, null, 2), { mode: 0o600 })
}

/**
 * 找某个快照文件：先看当前目录，再看默认目录（改过目录后旧快照仍在原处）。
 * 找不到时返回当前目录下的路径（调用方再判断是否存在）。
 */
export function locateBackup(home: string, name: string): string {
  const candidates = [backupDirPath(home), defaultBackupDir(home)]
  for (const dir of candidates) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return join(candidates[0]!, name)
}
