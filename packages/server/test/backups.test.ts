import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 备份目录 / 保留份数 / 下载 / 删除（desktop 模式，本机用户即 owner） */
let server: TestServer
const api = (method: string, path: string, body?: unknown) => server.request(method, path, { body })

beforeAll(async () => {
  server = await startTestServer()
}, 30_000)
afterAll(async () => {
  await server?.close()
})

describe('备份目录', () => {
  it('默认在数据目录下，和数据目录同盘时 sameDisk=true', async () => {
    const res = await api('GET', '/api/data/backups')
    expect(res.status).toBe(200)
    expect(res.json.location).toMatchObject({ dir: join(server.home, 'backups'), custom: false, configuredDir: null, dataDir: server.home })
    expect(res.json.location.sameDisk).toBe(statSync(server.home).dev === statSync(join(server.home, 'backups')).dev)
  })

  it('校验：必须是绝对路径、不能是根目录 / 系统目录 / 数据目录本身', async () => {
    for (const dir of ['relative/backups', '/', '/etc/lulux', server.home]) {
      const res = await api('PUT', '/api/data/backups/location', { dir })
      expect(res.status, dir).toBe(400)
    }
    const file = join(mkdtempSync(join(tmpdir(), 'lulux-file-')), 'not-a-dir')
    writeFileSync(file, 'x')
    expect((await api('PUT', '/api/data/backups/location', { dir: file })).json.error.code).toBe('BACKUP_DIR_INVALID')
    expect((await api('PUT', '/api/data/backups/location', { dir: 12 })).status).toBe(400)
  })

  it('改到别的目录：新备份写到新目录，旧快照仍可见；改动写审计；可恢复默认', async () => {
    const old = (await api('POST', '/api/data/backups')).json
    const target = join(mkdtempSync(join(tmpdir(), 'lulux-bk-')), 'nested', 'backups')
    const set = await api('PUT', '/api/data/backups/location', { dir: target })
    expect(set.status, set.text).toBe(200)
    expect(set.json).toMatchObject({ dir: target, custom: true, configuredDir: target })
    expect(JSON.parse(readFileSync(join(server.home, 'backup-location.json'), 'utf8'))).toEqual({ dir: target })

    const created = (await api('POST', '/api/data/backups')).json
    expect(existsSync(join(target, created.name))).toBe(true)
    const list = (await api('GET', '/api/data/backups')).json.backups
    expect(list.find((b: any) => b.name === created.name)).toMatchObject({ inCurrentDir: true })
    expect(list.find((b: any) => b.name === old.name)).toMatchObject({ inCurrentDir: false })

    const audit = (await api('GET', '/api/audit?action=backup.location')).json.items
    expect(audit[0].meta).toMatchObject({ to: target })

    // 恢复默认目录
    const reset = await api('PUT', '/api/data/backups/location', { dir: null })
    expect(reset.json).toMatchObject({ dir: join(server.home, 'backups'), custom: false })
    // 切到自定义目录后，默认目录里的旧快照仍可选择恢复
    await api('PUT', '/api/data/backups/location', { dir: target })
    const restore = await api('POST', `/api/data/backups/${old.name}/restore`)
    expect(restore.status, restore.text).toBe(200)
    await api('DELETE', '/api/data/restore')
  })
})

describe('下载 / 删除', () => {
  it('下载返回整个快照文件；不合法的文件名 400，不存在 404', async () => {
    const created = (await api('POST', '/api/data/backups')).json
    const res = await api('GET', `/api/data/backups/${created.name}/download`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toContain(created.name)
    expect(Number(res.headers['content-length'])).toBe(created.size)
    expect(res.text.startsWith('SQLite format 3')).toBe(true)
    expect((await api('GET', '/api/data/backups/..%2Fsecrets.db/download')).status).toBe(400)
    expect((await api('GET', '/api/data/backups/nope.db/download')).status).toBe(404)
    expect((await api('GET', '/api/audit?action=backup.download')).json.items[0].entityId).toBe(created.name)
  })

  it('删除快照并写审计；已选为“下次启动恢复”的快照不能删', async () => {
    const a = (await api('POST', '/api/data/backups')).json
    expect((await api('DELETE', `/api/data/backups/${a.name}`)).status).toBe(204)
    expect((await api('GET', '/api/data/backups')).json.backups.map((b: any) => b.name)).not.toContain(a.name)
    expect((await api('GET', '/api/audit?action=backup.delete')).json.items[0].entityId).toBe(a.name)

    const b = (await api('POST', '/api/data/backups')).json
    expect((await api('POST', `/api/data/backups/${b.name}/restore`)).status).toBe(200)
    expect((await api('DELETE', `/api/data/backups/${b.name}`)).json.error.code).toBe('BACKUP_PENDING_RESTORE')
    await api('DELETE', '/api/data/restore')
    expect((await api('DELETE', `/api/data/backups/${b.name}`)).status).toBe(204)
  })

  it('保留份数只轮转当前目录里的自动备份', async () => {
    expect((await api('PATCH', '/api/settings', { autoBackupKeep: 2, autoBackupHours: 1 })).status).toBe(200)
    const { backupService } = await import('../src/services/backup-service.js')
    for (let i = 0; i < 4; i += 1) {
      backupService.create('auto')
      await new Promise((r) => setTimeout(r, 15))
    }
    const autos = backupService.list().filter((b) => b.kind === 'auto')
    expect(autos).toHaveLength(2)
    expect(autos.every((b) => b.inCurrentDir)).toBe(true)
  })
})
