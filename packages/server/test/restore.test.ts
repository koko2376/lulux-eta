import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 备份恢复（docs/API-CONTRACT.md §10.5）：选择快照 → 下次启动替换库，带 SHA-256 / 完整性校验与回滚 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
}, 90_000)
afterAll(async () => {
  await server?.close()
})

describe('恢复接口', () => {
  it('校验文件名 / 存在性 / 完整性；写入待恢复；可查询与取消；审计', async () => {
    await server.request('POST', '/api/customers', { body: { company: 'Before Backup Co' } })
    const backup = (await server.request('POST', '/api/data/backups', { body: {} })).json
    expect((await server.request('POST', '/api/data/backups/..%2Flulux-eta.db/restore', { body: {} })).status).toBeGreaterThanOrEqual(400)
    expect((await server.request('POST', '/api/data/backups/missing.db/restore', { body: {} })).status).toBe(404)
    writeFileSync(join(server.home, 'backups', 'garbage.db'), 'not a sqlite file at all')
    const bad = await server.request('POST', '/api/data/backups/garbage.db/restore', { body: {} })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('BACKUP_INVALID')

    const ok = await server.request('POST', `/api/data/backups/${backup.name}/restore`, { body: {} })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.json).toMatchObject({ restartRequired: true, pending: { name: backup.name } })
    expect(ok.json.pending.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect((await server.request('GET', '/api/data/restore')).json.pending.name).toBe(backup.name)
    expect((await server.request('DELETE', '/api/data/restore')).json).toEqual({ cancelled: true })
    expect((await server.request('GET', '/api/data/restore')).json.pending).toBeNull()
    const { db } = await import('../src/db.js')
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'backup.restore_request'").get() as { n: number }).n).toBe(1)
  })
})

describe('启动时替换（applyPendingRestore）', () => {
  async function fixture() {
    const { runMigrations } = await import('../src/db/migrations.js')
    const home = mkdtempSync(join(tmpdir(), 'lulux-restore-'))
    mkdirSync(join(home, 'backups'))
    const make = (file: string, company: string) => {
      const d = new DatabaseSync(file)
      d.exec('PRAGMA journal_mode = WAL')
      runMigrations(d)
      d.prepare("INSERT INTO customers (id, company, created_at, updated_at) VALUES ('c1', ?, 1, 1)").run(company)
      d.close()
    }
    const dbFile = join(home, 'lulux-eta.db')
    make(dbFile, 'CURRENT')
    make(join(home, 'backups', 'manual-x.db'), 'FROM-BACKUP')
    const { sha256File, pendingFile } = await import('../src/db/restore.js')
    const pending = (sha = sha256File(join(home, 'backups', 'manual-x.db'))) =>
      writeFileSync(pendingFile(home), JSON.stringify({ name: 'manual-x.db', sha256: sha, size: 1, schemaVersion: 1, requestedAt: 1, requestedBy: 'local' }))
    const company = () => {
      const d = new DatabaseSync(dbFile, { readOnly: true })
      try {
        return (d.prepare("SELECT company FROM customers WHERE id = 'c1'").get() as { company: string }).company
      } finally {
        d.close()
      }
    }
    return { home, dbFile, pending, company }
  }

  it('成功替换，留下 before-restore 副本，写结果并清除待恢复', async () => {
    const { applyPendingRestore, readRestoreState } = await import('../src/db/restore.js')
    const f = await fixture()
    expect(applyPendingRestore(f.home, f.dbFile)).toBeNull()
    f.pending()
    const result = applyPendingRestore(f.home, f.dbFile)!
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, name: 'manual-x.db', rolledBack: false })
    expect(f.company()).toBe('FROM-BACKUP')
    expect(existsSync(join(f.home, 'backups', result.previous!))).toBe(true)
    const state = readRestoreState(f.home)
    expect(state.pending).toBeNull()
    expect(state.lastResult?.ok).toBe(true)
    // 副本就是恢复前的库
    const prev = new DatabaseSync(join(f.home, 'backups', result.previous!), { readOnly: true })
    expect((prev.prepare("SELECT company FROM customers WHERE id = 'c1'").get() as { company: string }).company).toBe('CURRENT')
    prev.close()
  })

  it('SHA-256 不一致（确认后被篡改）→ 不替换', async () => {
    const { applyPendingRestore } = await import('../src/db/restore.js')
    const f = await fixture()
    f.pending('0'.repeat(64))
    const result = applyPendingRestore(f.home, f.dbFile)!
    expect(result.ok).toBe(false)
    expect(result.error).toContain('SHA-256')
    expect(f.company()).toBe('CURRENT')
  })

  it('替换后验证失败 → 回滚到原库', async () => {
    const { applyPendingRestore } = await import('../src/db/restore.js')
    const f = await fixture()
    f.pending()
    const result = applyPendingRestore(f.home, f.dbFile, () => {
      throw new Error('migration exploded')
    })!
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(result.error).toContain('migration exploded')
    expect(f.company()).toBe('CURRENT')
    expect(JSON.parse(readFileSync(join(f.home, 'restore-result.json'), 'utf8')).rolledBack).toBe(true)
  })

  it('来自更新版本的快照被拒绝', async () => {
    const { inspectBackup } = await import('../src/db/restore.js')
    const f = await fixture()
    const newer = join(f.home, 'backups', 'newer.db')
    copyFileSync(join(f.home, 'backups', 'manual-x.db'), newer)
    const d = new DatabaseSync(newer)
    d.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', 1)").run()
    d.close()
    expect(() => inspectBackup(newer)).toThrow(/更新版本/)
  })
})
