import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** server 模式：按模型设置思考强度属于“管理模型与密钥”（providers:write），成员不能改 */
const PASSWORD = 'correct horse battery'
let server: TestServer
let owner: string
let member: string
let providerId = ''

const as = (token: string | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token })

beforeAll(async () => {
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = ok.json.token
  const invite = await as(owner, 'POST', '/api/team/invites', { role: 'member' })
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: invite.json.code, email: 'm@acme.com', password: PASSWORD, name: 'm' })
  member = accepted.json.token
  const created = await as(owner, 'POST', '/api/providers', { name: 'Relay', kind: 'openai', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test-123456', model: 'house-model', models: ['house-model'] })
  expect(created.status, created.text).toBe(201)
  providerId = created.json.provider.id
}, 60_000)

afterAll(async () => {
  await server?.close()
})

describe('按模型思考强度：权限', () => {
  it('成员 403，所有者可改并写审计', async () => {
    const body = { model: 'house-model', reasoning: 'openai' }
    expect((await as(member, 'PUT', `/api/providers/${providerId}/model-caps`, body)).status).toBe(403)
    const res = await as(owner, 'PUT', `/api/providers/${providerId}/model-caps`, body)
    expect(res.status, res.text).toBe(200)
    expect(res.json.provider.modelReasoning['house-model'].manual).toBe('openai')
    const audit = (await as(owner, 'GET', '/api/audit?action=provider.update')).json
    const items = Array.isArray(audit) ? audit : audit.items
    expect(items.some((a: any) => a.action === 'provider.update' && a.entityId === providerId)).toBe(true)
  })
})
