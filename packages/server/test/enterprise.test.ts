import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 客户 CSV 导出、整库快照备份（手动 / 自动 + 轮转） */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
}, 90_000)
afterAll(async () => {
  await server?.close()
})

describe('客户 CSV 导出', () => {
  it('UTF-8 BOM、主联系人、筛选、公式注入转义、审计', async () => {
    await server.request('POST', '/api/customers', {
      body: { company: '=HYPERLINK("http://evil")', stage: 'quoted', tags: ['VIP'], contacts: [{ name: 'Zoë, "Z"', email: 'z@x.com', isPrimary: true }] },
    })
    await server.request('POST', '/api/customers', { body: { company: 'Plain Lead Co', stage: 'lead' } })
    const res = await server.request('GET', '/api/customers/export')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('customers-')
    expect(res.text.charCodeAt(0)).toBe(0xfeff)
    const lines = res.text.slice(1).trim().split('\r\n')
    expect(lines[0]).toMatch(/^company,country,website,stage,tags/)
    expect(lines).toHaveLength(3)
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(res.text).toContain('"Zoë, ""Z"""')
    const filtered = await server.request('GET', '/api/customers/export?stage=lead')
    expect(filtered.headers['x-total-count']).toBe('1')
    const { db } = await import('../src/db.js')
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customer.export'").get() as { n: number }).n).toBeGreaterThanOrEqual(2)
  })
})

describe('整库快照备份', () => {
  it('手动备份可列出；自动备份按间隔执行并只轮转自动备份', async () => {
    const created = await server.request('POST', '/api/data/backups', { body: {} })
    expect(created.status, created.text).toBe(201)
    expect(created.json).toMatchObject({ kind: 'manual' })
    expect(created.json.size).toBeGreaterThan(0)
    const { backupService } = await import('../src/services/backup-service.js')
    await server.request('PATCH', '/api/settings', { body: { autoBackupHours: 1, autoBackupKeep: 2 } })
    expect(backupService.tick()).toBe(true)
    expect(backupService.tick()).toBe(false) // 间隔内不重复
    // 模拟时间流逝：连做 3 次自动备份，只保留 2 份
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      expect(backupService.tick(Date.now() + (i + 2) * 3600_000)).toBe(true)
    }
    const list = (await server.request('GET', '/api/data/backups')).json.backups
    expect(list.filter((b: any) => b.kind === 'auto')).toHaveLength(2)
    expect(list.filter((b: any) => b.kind === 'manual')).toHaveLength(1)
    await server.request('PATCH', '/api/settings', { body: { autoBackupHours: 0 } })
    expect(backupService.tick(Date.now() + 999 * 3600_000)).toBe(false)
  })
})

describe('任务到期提醒 task.due', () => {
  it('到期任务只推送一次给负责人；改到期时间后重新提醒；完成的不推', async () => {
    const { eventBus } = await import('../src/services/events.js')
    const { taskReminders } = await import('../src/services/task-service.js')
    const { LOCAL_ACTOR } = await import('../src/context.js')
    const got: any[] = []
    const off = eventBus.subscribe({ actor: LOCAL_ACTOR, send: (event, payload) => event === 'task.due' && got.push(payload), close: () => undefined })
    try {
      const past = Date.now() - 60_000
      const due = (await server.request('POST', '/api/tasks', { body: { title: '到期提醒', dueAt: past } })).json
      const done = (await server.request('POST', '/api/tasks', { body: { title: '已完成的', dueAt: past } })).json
      await server.request('PATCH', `/api/tasks/${done.id}`, { body: { status: 'done' } })
      await server.request('POST', '/api/tasks', { body: { title: '明天', dueAt: Date.now() + 86_400_000 } })
      expect(taskReminders.tick()).toBe(1)
      expect(got.map((p) => p.task.id)).toEqual([due.id])
      expect(got[0].task).toMatchObject({ title: '到期提醒', overdue: true })
      expect(taskReminders.tick()).toBe(0)
      await server.request('PATCH', `/api/tasks/${due.id}`, { body: { dueAt: Date.now() - 1000 } })
      expect(taskReminders.tick()).toBe(1)
      // 提前量：明天的任务在 lead 窗口内才推
      expect(taskReminders.tick(Date.now(), 25 * 60)).toBe(1)
    } finally {
      off()
    }
  })
})
