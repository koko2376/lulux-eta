import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** server 模式：自动备份的审计记在组织下（审计页可见）；目录只有 owner 能改，删除限 owner / admin */
const PASSWORD = 'correct horse battery'
type Who = { token: string; id: string }
let server: TestServer
let owner: Who
let admin: Who
let member: Who
const as = (who: Who, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who.token })

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await server.request('POST', '/api/auth/invites/accept', { token: null, body: { code: created.json.code, email, password: PASSWORD, name: email } })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await server.request('POST', '/api/auth/setup', { token: null, body: { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' } })
  owner = { token: ok.json.token, id: ok.json.user.id }
  admin = await invite('admin', 'admin@acme.com')
  member = await invite('member', 'member@acme.com')
}, 30_000)
afterAll(async () => {
  await server?.close()
})

it('自动备份的审计出现在组织审计页', async () => {
  const { backupService } = await import('../src/services/backup-service.js')
  expect(backupService.tick()).toBe(true)
  const items = (await as(owner, 'GET', '/api/audit?action=backup.auto')).json.items
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ action: 'backup.auto', userId: null })
  expect(items[0].meta.size).toBeGreaterThan(0)
})

it('备份目录只有 owner 能改；admin 能下载和删除；member 不能删除', async () => {
  expect((await as(admin, 'PUT', '/api/data/backups/location', { dir: '/tmp/x' })).status).toBe(403)
  expect((await as(member, 'PUT', '/api/data/backups/location', { dir: '/tmp/x' })).status).toBe(403)
  const created = (await as(admin, 'POST', '/api/data/backups')).json
  expect((await as(admin, 'GET', `/api/data/backups/${created.name}/download`)).status).toBe(200)
  expect((await as(member, 'DELETE', `/api/data/backups/${created.name}`)).status).toBe(403)
  expect((await as(member, 'GET', '/api/data/backups')).status).toBe(403)
  expect((await as(admin, 'DELETE', `/api/data/backups/${created.name}`)).status).toBe(204)
  const list = (await as(owner, 'GET', '/api/data/backups')).json
  expect(list.location.dataDir).toBe(server.home)
})
