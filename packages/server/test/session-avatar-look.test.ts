import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** 会话形象编号：新建时 1..6 轮换，侧栏相邻的同内核会话不撞形象 */
beforeAll(() => {
  process.env.LULUX_ETA_HOME = mkdtempSync(join(tmpdir(), 'lulux-look-'))
})
afterAll(() => {
  delete process.env.LULUX_ETA_HOME
})

describe('avatarLook', () => {
  it('连续新建按 1..6 轮换，同一毫秒建的也不重复', async () => {
    const { sessionService } = await import('../src/services/session-service.js')
    const looks = Array.from({ length: 8 }, () => sessionService.create({ agentIds: ['builtin'] }).avatarLook)
    expect(looks).toEqual([1, 2, 3, 4, 5, 6, 1, 2])
  })

  it('读出来的会话带同一个编号', async () => {
    const { sessionService } = await import('../src/services/session-service.js')
    const s = sessionService.create({ agentIds: ['builtin'] })
    expect(sessionService.get(s.id)!.avatarLook).toBe(s.avatarLook)
    expect(sessionService.list().find((x) => x.id === s.id)!.avatarLook).toBe(s.avatarLook)
  })

  it('迁移给旧会话按创建先后补编号', async () => {
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE sessions SET avatar_look = NULL').run()
    const { MIGRATIONS } = await import('../src/db/migrations.js')
    const m = MIGRATIONS.find((x) => x.name === 'session_avatar_look')!
    db.exec('ALTER TABLE sessions DROP COLUMN avatar_look')
    m.up(db)
    const rows = db.prepare('SELECT avatar_look FROM sessions ORDER BY created_at, id').all() as { avatar_look: number }[]
    expect(rows.length).toBe(9)
    expect(new Set(rows.map((r) => r.avatar_look))).toEqual(new Set([1, 2, 3, 4, 5, 6]))
  })
})

describe('avatarLook 迁移性能', () => {
  it('2 万个会话的回填在 2 秒内完成', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS } = await import('../src/db/migrations.js')
    const m = MIGRATIONS.find((x) => x.name === 'session_avatar_look')!
    const mem = new DatabaseSync(':memory:')
    mem.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, owner_id TEXT, created_at INTEGER)')
    const ins = mem.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    mem.exec('BEGIN')
    for (let i = 0; i < 20000; i++) ins.run(`s${i}`, `u${i % 3}`, i)
    mem.exec('COMMIT')
    const t = Date.now()
    m.up(mem as never)
    expect(Date.now() - t).toBeLessThan(2000)
    const looks = mem.prepare("SELECT avatar_look FROM sessions WHERE owner_id = 'u0' ORDER BY created_at LIMIT 7").all() as { avatar_look: number }[]
    expect(looks.map((r) => r.avatar_look)).toEqual([1, 2, 3, 4, 5, 6, 1])
  })
})
