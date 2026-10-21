import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'

let mod: typeof import('../src/db.js')
let migrations: typeof import('../src/db/migrations.js')
let secrets: typeof import('../src/security/secrets.js')

beforeAll(async () => {
  process.env.LULUX_ETA_HOME = mkdtempSync(join(tmpdir(), 'lulux-mig-home-'))
  mod = await import('../src/db.js')
  migrations = await import('../src/db/migrations.js')
  secrets = await import('../src/security/secrets.js')
})

/** 2026-10 之前版本的建表语句（没有 schema_migrations、没有新列、旧 Agent id、明文 Key） */
function createLegacyDb(file: string): void {
  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
    CREATE TABLE session_members (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, agent_id));
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO providers VALUES ('prov_1', 'Old', 'openai', 'https://api.example.com/v1', 'sk-legacy-plaintext-key', 'gpt-x', 1);
    INSERT INTO sessions VALUES ('ses_1', '旧会话', NULL, 1, 2);
    INSERT INTO sessions VALUES ('ses_orphan', '无成员', NULL, 1, 2);
    INSERT INTO session_members VALUES ('ses_1', 'hermes', 0);
    INSERT INTO session_members VALUES ('ses_1', 'claude', 1);
    INSERT INTO messages VALUES ('msg_1', 'ses_1', 'user', 'hi', 1);
    INSERT INTO mcp_servers VALUES ('mcp_1', 'planted', 'touch', '["/tmp/x"]', '{}', 1, 1);
    INSERT INTO settings VALUES ('defaultAgentId', 'grok');
    INSERT INTO settings VALUES ('theme', 'light');
  `)
  legacy.close()
}

describe('版本化迁移', () => {
  it('从旧库升级：补列、改 Agent id、加密 Key、记录版本、留快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lulux-mig-'))
    const file = join(dir, 'lulux-eta.db')
    createLegacyDb(file)

    const db = mod.openDatabase(file)
    const result = migrations.runMigrations(db, { backupDir: join(dir, 'backups') })
    expect(result.applied).toEqual(migrations.MIGRATIONS.map((m) => m.version))
    expect(result.backupFile).not.toBeNull()
    expect(existsSync(result.backupFile!)).toBe(true)
    expect(migrations.currentVersion(db)).toBe(Math.max(...migrations.MIGRATIONS.map((m) => m.version)))

    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols('messages')).toEqual(expect.arrayContaining(['sender_agent_id', 'tool_trace', 'runtime', 'tool_rounds']))
    expect(cols('providers')).toContain('models')
    expect(cols('sessions')).toContain('group_name')
    expect(cols('mcp_servers')).toContain('approved_hash')
    // 本机账户（迁移 14）：升级后为空 —— 没有账户时照旧免登录
    expect(db.prepare('SELECT COUNT(*) AS n FROM local_accounts').get()).toEqual({ n: 0 })
    for (const table of ['customers', 'contacts', 'activities', 'products', 'quotes', 'inquiry_rules', 'quote_templates', 'app_meta', 'local_accounts', 'local_sessions']) {
      expect(cols(table).length).toBeGreaterThan(0)
    }

    const members = db.prepare('SELECT session_id, agent_id FROM session_members ORDER BY session_id, position').all()
    // 迁移 2：hermes/claude → lux-trade/lux-writer；迁移 13：persona 全部并入内置内核（同会话合并为一个成员）
    expect(members).toEqual([
      { session_id: 'ses_1', agent_id: 'builtin' },
      { session_id: 'ses_orphan', agent_id: 'builtin' },
    ])
    expect((db.prepare("SELECT value FROM settings WHERE key='defaultAgentId'").get() as { value: string }).value).toBe(
      'builtin',
    )
    const senders = db.prepare('SELECT DISTINCT sender_agent_id AS id FROM messages WHERE sender_agent_id IS NOT NULL').all() as Array<{ id: string }>
    expect(senders.every((row) => row.id === 'builtin')).toBe(true)
    // 旧 MCP 记录没有确认指纹 → 不会自动启动
    expect((db.prepare("SELECT approved_hash FROM mcp_servers WHERE id='mcp_1'").get() as { approved_hash: null }).approved_hash).toBeNull()

    const ring = secrets.loadKeyring(dir)
    expect(mod.encryptPlaintextProviderKeys(db, ring)).toBe(1)
    const key = (db.prepare("SELECT api_key FROM providers WHERE id='prov_1'").get() as { api_key: string }).api_key
    expect(key.startsWith('enc:v1:')).toBe(true)
    expect(secrets.decryptSecret(key, ring)).toBe('sk-legacy-plaintext-key')
    // 幂等
    expect(mod.encryptPlaintextProviderKeys(db, ring)).toBe(0)
    expect(migrations.runMigrations(db, { backupDir: join(dir, 'backups') }).applied).toEqual([])
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
    db.close()
  })

  it('全新库从零建表，不留快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lulux-mig-new-'))
    const db = mod.openDatabase(join(dir, 'new.db'))
    const result = migrations.runMigrations(db, { backupDir: join(dir, 'backups') })
    expect(result.applied.length).toBe(migrations.MIGRATIONS.length)
    expect(result.backupFile).toBeNull()
    db.close()
  })

  it('迁移失败时回滚且不记录版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lulux-mig-fail-'))
    const db = mod.openDatabase(join(dir, 'f.db'))
    migrations.runMigrations(db)
    const bad = [
      ...migrations.MIGRATIONS,
      {
        version: 999,
        name: 'broken',
        up(d: DatabaseSync) {
          d.exec('CREATE TABLE half_done (id TEXT)')
          d.exec('THIS IS NOT SQL')
        },
      },
    ]
    expect(() => migrations.runMigrations(db, {}, bad)).toThrow(/999/)
    expect(migrations.currentVersion(db)).toBe(Math.max(...migrations.MIGRATIONS.map((m) => m.version)))
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").get()).toBeUndefined()
    db.close()
  })
})
