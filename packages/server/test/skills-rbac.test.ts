import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * server 模式下 Skill 系统的 RBAC（契约 §8.3 / §8.5）：
 * - 读（列表、详情、文件）：所有登录角色可用；
 * - 写（安装 / 启停 / 删除 / 按 Agent 配置）：owner/admin 允许，member/viewer 403；
 * - Agent 自配置工具（skill_install/create/update）只对 owner/admin 暴露；member 只拿到只读的 skill_list/skill_view；
 * - 会话文件上传：viewer 403。
 */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''

type Who = { token: string; id: string; role: string }
let owner: Who
let admin: Who
let member: Who
let viewer: Who

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

async function mockCall(path: string, body?: unknown): Promise<any> {
  const get = path === '/__mock/requests'
  const res = await fetch(`${mockBase}${path}`, { method: get ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: get ? undefined : JSON.stringify(body ?? {}) })
  return res.json()
}

async function invite(role: string, email: string): Promise<Who> {
  const created = await as(owner, 'POST', '/api/team/invites', { role })
  expect(created.status, created.text).toBe(201)
  const accepted = await as(null, 'POST', '/api/auth/invites/accept', { code: created.json.code, email, password: PASSWORD, name: email.split('@')[0] })
  expect(accepted.status, accepted.text).toBe(201)
  return { token: accepted.json.token, id: accepted.json.user.id, role }
}

async function zipOf(files: Record<string, string>): Promise<string> {
  const { writeZip } = await import('../src/services/skills/zip.js')
  return writeZip(Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) }))).toString('base64')
}
const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n正文\n`

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`

  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  expect(ok.status, ok.text).toBe(201)
  owner = { token: ok.json.token, id: ok.json.user.id, role: 'owner' }
  admin = await invite('admin', 'admin@acme.com')
  member = await invite('member', 'member@acme.com')
  viewer = await invite('viewer', 'viewer@acme.com')

  const provider = await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  expect(provider.status, provider.text).toBe(201)
  expect((await as(owner, 'PATCH', '/api/settings', { autoTitle: false, toolApproval: 'auto', toolLoading: 'all' })).status).toBe(200)
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('server 模式 Skill RBAC：REST', () => {
  it('读接口所有角色可用', async () => {
    for (const who of [owner, admin, member, viewer]) {
      const list = await as(who, 'GET', '/api/skills')
      expect(list.status, `${who.role} ${list.text}`).toBe(200)
      expect(list.json.skills.length).toBeGreaterThanOrEqual(38)
      expect((await as(who, 'GET', '/api/skills/quote-calculator')).status).toBe(200)
    }
    expect((await as(null, 'GET', '/api/skills')).status).toBe(401)
  })

  it('安装 / 启停 / 删除 / 按 Agent 配置：member、viewer 403；owner、admin 允许', async () => {
    const zip = await zipOf({ 'rbac-skill/SKILL.md': md('rbac-skill', 'RBAC 测试用的技能说明') })
    for (const who of [member, viewer]) {
      const install = await as(who, 'POST', '/api/skills/install/zip', { dataBase64: zip })
      expect(install.status, `${who.role} install`).toBe(403)
      expect((await as(who, 'POST', '/api/skills/install/url', { url: 'https://github.com/acme/skills' })).status).toBe(403)
      expect((await as(who, 'PATCH', '/api/skills/inquiry-triage', { enabled: false })).status, `${who.role} patch`).toBe(403)
      expect((await as(who, 'PUT', '/api/agents/builtin/skills', { mode: 'none', skills: [] })).status, `${who.role} agent skills`).toBe(403)
      expect((await as(who, 'DELETE', '/api/skills/inquiry-triage')).status, `${who.role} delete`).toBe(403)
    }
    expect((await as(owner, 'GET', '/api/skills/inquiry-triage')).json.enabled).toBe(true)

    const byAdmin = await as(admin, 'POST', '/api/skills/install/zip', { dataBase64: zip })
    expect(byAdmin.status, byAdmin.text).toBe(201)
    expect((await as(admin, 'PATCH', '/api/skills/rbac-skill', { enabled: false })).json.skill.enabled).toBe(false)
    expect((await as(owner, 'PATCH', '/api/skills/rbac-skill', { enabled: true })).json.skill.enabled).toBe(true)
    expect((await as(admin, 'PUT', '/api/agents/builtin/skills', { mode: 'selected', skills: ['translate-polish'] })).status).toBe(200)
    expect((await as(owner, 'PUT', '/api/agents/builtin/skills', { mode: 'all', skills: [] })).status).toBe(200)
    expect((await as(member, 'DELETE', '/api/skills/rbac-skill')).status).toBe(403)
    expect((await as(owner, 'DELETE', '/api/skills/rbac-skill')).status).toBe(204)
    // 写操作留审计
    const audit = await as(owner, 'GET', '/api/audit?action=skill.install')
    if (audit.status === 200) expect(JSON.stringify(audit.json)).toContain('rbac-skill')
  })

  it('会话文件：member 可向自己的会话上传并列出；viewer 上传 403', async () => {
    const session = await as(member, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(session.status, session.text).toBe(201)
    const id = session.json.session.id
    const up = await as(member, 'POST', `/api/chat/sessions/${id}/files`, { path: 'in/data.csv', dataBase64: Buffer.from('a,b\n1,2\n').toString('base64') })
    expect(up.status, up.text).toBe(201)
    expect(up.json).toMatchObject({ path: 'in/data.csv', size: 8 })
    expect((await as(member, 'POST', `/api/chat/sessions/${id}/files`, { path: 'in/data.csv', dataBase64: 'eA==' })).status).toBe(409)
    expect((await as(member, 'POST', `/api/chat/sessions/${id}/files`, { path: '../escape.txt', dataBase64: 'eA==' })).status).toBe(400)
    const listed = await as(member, 'GET', `/api/chat/sessions/${id}/files/list`)
    expect(listed.status, listed.text).toBe(200)
    expect(JSON.stringify(listed.json)).toContain('data.csv')
    const download = await as(member, 'GET', `/api/chat/sessions/${id}/files?path=in/data.csv`)
    expect(download.text).toBe('a,b\n1,2\n')
    expect((await as(viewer, 'POST', `/api/chat/sessions/${id}/files`, { path: 'x.txt', dataBase64: 'eA==' })).status).toBe(403)
  })
})

describe('server 模式 Skill RBAC：Agent 工具暴露', () => {
  async function toolsSeenBy(who: Who): Promise<string[]> {
    await mockCall('/__mock/reset')
    await mockCall('/__mock/script', { responses: [{ text: '好' }] })
    const session = await as(who, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(session.status, session.text).toBe(201)
    const res = await as(who, 'POST', '/api/chat', { sessionId: session.json.session.id, content: '你好' })
    expect(res.status, res.text).toBe(200)
    const reqs = await mockCall('/__mock/requests')
    return (reqs[0].tools ?? []).map((t: any) => t.function.name)
  }

  it('owner/admin 有 skill_install/create/update；member 只有只读 skill 工具；MCP 未开启时谁都没有 mcp_*', async () => {
    for (const who of [owner, admin]) {
      const tools = await toolsSeenBy(who)
      expect(tools, who.role).toEqual(expect.arrayContaining(['skill_list', 'skill_view', 'skill_install', 'skill_create', 'skill_update']))
      expect(tools.some((t) => t.startsWith('mcp_')), who.role).toBe(false)
    }
    const tools = await toolsSeenBy(member)
    expect(tools).toEqual(expect.arrayContaining(['skill_list', 'skill_view']))
    for (const name of ['skill_install', 'skill_create', 'skill_update', 'mcp_add', 'mcp_update', 'mcp_remove']) expect(tools).not.toContain(name)
    // server 模式默认禁用 MCP/脚本：run_skill_script 也不暴露
    expect(tools).not.toContain('run_skill_script')
  })

  it('viewer 不能对话（data:write）', async () => {
    const session = await as(viewer, 'POST', '/api/sessions', { agentIds: ['builtin'] })
    expect(session.status).toBe(403)
  })
})
