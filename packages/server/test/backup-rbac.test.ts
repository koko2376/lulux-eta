import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：整库备份只给 owner / admin。
 * 单独授予「导出数据」的 member 只能导出自己可见的数据，拿不到整库快照（别人的私有数据、密码哈希、加密凭据）。
 */
const PASSWORD = 'correct horse battery'
type Who = { token: string; id: string }
let server: TestServer
let owner: Who
let admin: Who
let member: Who
const as = (who: Who, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who.token })

async function invite(role: 'member' | 'admin', email: string): Promise<Who> {
  const inv = await as(owner, 'POST', '/api/team/invites', { role })
  const acc = await server.request('POST', '/api/auth/invites/accept', { token: null, body: { code: inv.json.code, email, password: PASSWORD, name: email } })
  expect(acc.status, acc.text).toBeLessThan(300)
  return { token: acc.json.token, id: acc.json.user.id }
}

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await server.request('POST', '/api/auth/setup', { token: null, body: { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' } })
  owner = { token: ok.json.token, id: ok.json.user.id }
  member = await invite('member', 'm@acme.com')
  admin = await invite('admin', 'a@acme.com')
  const c = await as(owner, 'POST', '/api/customers', { company: 'OwnerPrivateCo', visibility: 'private' })
  expect(c.status, c.text).toBeLessThan(300)
  const mine = await as(member, 'POST', '/api/customers', { company: 'MemberOwnCo', visibility: 'private' })
  expect(mine.status, mine.text).toBeLessThan(300)
  const grant = await as(owner, 'PUT', `/api/team/members/${member.id}/permissions`, { overrides: { 'data:export': 'grant' } })
  expect(grant.status, grant.text).toBe(200)
}, 60_000)
afterAll(async () => server?.close())

describe('备份权限', () => {
  it('被授予导出数据的 member 不能列出 / 创建 / 下载 / 恢复整库备份', async () => {
    const backup = await as(owner, 'POST', '/api/data/backups')
    expect(backup.status, backup.text).toBe(201)
    const name = backup.json.name as string

    expect((await as(member, 'GET', '/api/data/backups')).status).toBe(403)
    expect((await as(member, 'POST', '/api/data/backups')).status).toBe(403)
    const dl = await server.request('GET', `/api/data/backups/${name}/download`, { token: member.token })
    expect(dl.status).toBe(403)
    expect(dl.text).not.toContain('OwnerPrivateCo')
    expect((await as(member, 'POST', `/api/data/backups/${name}/restore`)).status).toBe(403)
    expect((await as(member, 'GET', '/api/data/restore')).status).toBe(403)
  })

  it('member 的数据导出只含自己可见的数据，不含别人的私有客户和密码哈希', async () => {
    const res = await as(member, 'GET', '/api/data/export')
    expect(res.status, res.text).toBe(200)
    expect(res.text).toContain('MemberOwnCo')
    expect(res.text).not.toContain('OwnerPrivateCo')
    expect(res.text).not.toMatch(/scrypt\$/)
  })

  it('owner 能看到备份目录；admin 能管理备份但看不到服务器路径', async () => {
    const ownerList = await as(owner, 'GET', '/api/data/backups')
    expect(ownerList.status).toBe(200)
    expect(ownerList.json.location?.dataDir).toBe(server.home)

    const adminList = await as(admin, 'GET', '/api/data/backups')
    expect(adminList.status, adminList.text).toBe(200)
    expect(adminList.json.backups.length).toBeGreaterThan(0)
    expect(adminList.json.location).toBeUndefined()
    expect(adminList.text).not.toContain(server.home)
    const created = await as(admin, 'POST', '/api/data/backups')
    expect(created.status, created.text).toBe(201)
  })
})
