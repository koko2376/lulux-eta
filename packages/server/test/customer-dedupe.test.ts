import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'
import { companyNorm, companyEmailDomain, phoneKey } from '../src/utils/customer-keys.js'

/** 新建客户查重：全组织范围（不受可见性限制），只暴露公司名与负责人；force 仍然创建；Agent 工具只报告不创建 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string }
let owner: Who
let alice: Who
let bob: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}
async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id }
}
async function agentCall(who: Who, toolCalls: unknown[]) {
  const session = await as(who, 'POST', '/api/sessions', { agentIds: ['builtin'] })
  expect(session.status, session.text).toBe(201)
  await fetch(`${mockBase}/__mock/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: [{ toolCalls }, { text: 'ok' }] }),
  })
  const res = await as(who, 'POST', '/api/chat', { sessionId: session.json.session.id, content: 'go' })
  return parseSse(res.text).filter((e) => e.event === 'tool_result').map((e) => e.data)
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id }
  alice = await invite('member', 'alice@acme.com')
  bob = await invite('member', 'bob@acme.com')
  await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, toolApproval: 'auto', llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('规范化键', () => {
  it('公司名去组织形式与标点', () => {
    expect(companyNorm('ACME Trading Co., Ltd.')).toBe(companyNorm('acme trading'))
    expect(companyNorm('Müller GmbH')).toBe(companyNorm('MÜLLER'))
    expect(companyNorm('温州华达阀门有限公司')).toBe(companyNorm('温州华达阀门'))
    expect(companyNorm('Limited')).toBe('limited')
    expect(companyNorm('Acme')).not.toBe(companyNorm('Acme Valves'))
  })
  it('免费邮箱不按域名查重；电话取末 8 位', () => {
    expect(companyEmailDomain('a@gmail.com')).toBe('')
    expect(companyEmailDomain('a@QQ.com')).toBe('')
    expect(companyEmailDomain('a@globex.com')).toBe('globex.com')
    expect(phoneKey('+86 138-0000-1234')).toBe(phoneKey('13800001234'))
    expect(phoneKey('12-34')).toBe('')
  })
})

describe('新建客户查重', () => {
  it('同名（规范化后）命中他人私有客户：409，只给公司名与负责人', async () => {
    const a = await as(alice, 'POST', '/api/customers', {
      company: 'Hooli Trading Co., Ltd.',
      notes: 'secret notes',
      contacts: [{ name: 'Gavin', email: 'gavin@hooli-secret.io', phone: '+1 650 555 0100' }],
    })
    expect(a.status, a.text).toBe(201)
    const dup = await as(bob, 'POST', '/api/customers', { company: 'hooli trading' })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe('CUSTOMER_DUPLICATE')
    expect(dup.json.error.message).toContain('alice')
    const d = dup.json.error.details.duplicates
    expect(d).toHaveLength(1)
    expect(d[0]).toEqual({ company: 'Hooli Trading Co., Ltd.', ownerName: 'alice', matchedBy: ['company'] })
    expect(dup.text).not.toContain('secret')
    expect(dup.text).not.toContain('gavin')
    expect(dup.text).not.toContain(a.json.id)
    // 负责人本人 / 管理员看得见时附 id
    const mine = await as(alice, 'POST', '/api/customers', { company: 'HOOLI TRADING LIMITED' })
    expect(mine.status).toBe(409)
    expect(mine.json.error.details.duplicates[0].id).toBe(a.json.id)
    // 仍然创建
    const forced = await as(bob, 'POST', '/api/customers', { company: 'hooli trading', force: true })
    expect(forced.status, forced.text).toBe(201)
    expect(forced.json).not.toHaveProperty('force')
  })

  it('公司邮箱域名 / 网站 / 电话命中；免费邮箱只认完整地址', async () => {
    const base = await as(alice, 'POST', '/api/customers', {
      company: 'Globex Industrial',
      website: 'https://www.globex-ind.com/about',
      contacts: [{ name: 'Hank', email: 'hank@globex-ind.com', phone: '+86 138-0000-1234' }, { name: 'Free', email: 'buyer.free@gmail.com' }],
    })
    expect(base.status, base.text).toBe(201)
    const byDomain = await as(bob, 'POST', '/api/customers', { company: 'Different Name A', contacts: [{ email: 'other@globex-ind.com' }] })
    expect(byDomain.status).toBe(409)
    expect(byDomain.json.error.details.duplicates[0].matchedBy).toContain('emailDomain')
    const bySite = await as(bob, 'POST', '/api/customers', { company: 'Different Name B', website: 'globex-ind.com' })
    expect(bySite.status).toBe(409)
    expect(bySite.json.error.details.duplicates[0].matchedBy).toContain('website')
    const byPhone = await as(bob, 'POST', '/api/customers', { company: 'Different Name C', contacts: [{ phone: '13800001234' }] })
    expect(byPhone.status).toBe(409)
    expect(byPhone.json.error.details.duplicates[0].matchedBy).toEqual(['phone'])
    const freeOther = await as(bob, 'POST', '/api/customers', { company: 'Different Name D', contacts: [{ email: 'someone@gmail.com' }] })
    expect(freeOther.status, freeOther.text).toBe(201)
    const freeSame = await as(bob, 'POST', '/api/customers', { company: 'Different Name E', contacts: [{ email: 'Buyer.Free@gmail.com' }] })
    expect(freeSame.status).toBe(409)
    expect(freeSame.json.error.details.duplicates[0].matchedBy).toEqual(['email'])
  })

  it('跨组织不查重；编辑客户不受影响', async () => {
    const x = await as(alice, 'POST', '/api/customers', { company: 'Edit Target Ltd' })
    expect(x.status).toBe(201)
    const patched = await as(alice, 'PATCH', `/api/customers/${x.json.id}`, { company: 'Edit Target Limited' })
    expect(patched.status).toBe(200)
  })

  it('Agent create_customer 命中时不创建，只报告公司名与负责人', async () => {
    const before = (await as(owner, 'GET', '/api/customers?query=initrode')).json.total
    await as(alice, 'POST', '/api/customers', { company: 'Initrode GmbH' })
    const r = await agentCall(bob, [{ id: 'a', name: 'create_customer', arguments: { company: 'INITRODE' } }])
    expect(r[0].ok, r[0].result).toBe(true)
    const result = JSON.parse(r[0].result)
    expect(result.created).toBe(false)
    expect(result.duplicate).toBe(true)
    expect(result.matches).toEqual([{ company: 'Initrode GmbH', owner: 'alice', matchedBy: ['company'] }])
    expect((await as(owner, 'GET', '/api/customers?query=initrode')).json.total).toBe(before + 1)
    const forced = await agentCall(bob, [{ id: 'b', name: 'create_customer', arguments: { company: 'INITRODE', force: true } }])
    expect(JSON.parse(forced[0].result).created).toBe(true)
    expect((await as(owner, 'GET', '/api/customers?query=initrode')).json.total).toBe(before + 2)
  })
})
