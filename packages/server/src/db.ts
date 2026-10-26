import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBackupDir } from './db/backup-dir.js'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'
import { runMigrations } from './db/migrations.js'
import { applyPendingRestore } from './db/restore.js'
import { encryptSecret, initKeyring, isEncrypted, type Keyring } from './security/secrets.js'
import { SETTINGS_SCHEMA } from './settings-schema.js'

export function openDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  return database
}

export function ensureDefaultSettings(database: DatabaseSync): void {
  const insert = database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const item of SETTINGS_SCHEMA) insert.run(item.key, item.default)
}

/** 旧版本明文保存的 API Key 在启动时自动加密；已加密的跳过 */
export function encryptPlaintextProviderKeys(database: DatabaseSync, keyring: Keyring): number {
  // 主密钥暂时不可用：旧的明文 Key 先保持原样，下次能解锁时再加密
  if (keyring.locked) return 0
  const rows = database
    .prepare("SELECT id, api_key FROM providers WHERE api_key <> ''")
    .all() as unknown as Array<{ id: string; api_key: string }>
  const update = database.prepare('UPDATE providers SET api_key = ? WHERE id = ?')
  let count = 0
  for (const row of rows) {
    if (isEncrypted(row.api_key)) continue
    update.run(encryptSecret(row.api_key, keyring), row.id)
    count += 1
  }
  return count
}

mkdirSync(config.home, { recursive: true })

export const keyring = initKeyring(config.home)

// 备份恢复：在打开数据库之前用选定的快照替换库（校验 SHA-256 / 完整性，失败自动回滚，见 db/restore.ts）
const restored = applyPendingRestore(config.home, join(config.home, 'lulux-eta.db'), (file) => {
  const probe = openDatabase(file)
  try {
    runMigrations(probe)
  } finally {
    probe.close()
  }
})
if (restored) {
  console.log(
    restored.ok
      ? `[lulux-eta] database restored from backup ${restored.name} (previous copy: backups/${restored.previous ?? '-'})`
      : `[lulux-eta] database restore from ${restored.name || '?'} failed${restored.rolledBack ? ' (rolled back)' : ''}: ${restored.error}`,
  )
}

export const db = openDatabase(join(config.home, 'lulux-eta.db'))

runMigrations(db, { backupDir: ensureBackupDir(config.home) })
ensureDefaultSettings(db)
encryptPlaintextProviderKeys(db, keyring)
