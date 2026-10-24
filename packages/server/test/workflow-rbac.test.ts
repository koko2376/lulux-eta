import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** server 模式：工作流 / 定时任务的行级可见性与权限（与任务、客户一致） */
const ORIGIN = 'https://lulux.example.com'
const PASSWORD = 'correct horse battery'
let server: TestServer
let mock: ChildProcess
let mockBase = ''
type Who = { token: string; id: string; role: string }
let owner: Who
let member: Who
let member2: Who
let viewer: Who

const as = (who: Who | null, method: string, path: string, body?: unknown) => server.request(method, path, { body, token: who ? who.token : null })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  return { token: accepted.json.token, id: accepted.json.user.id, role }
}
const graph = { nodes: [{ id: 'a', name: 'A', kernelId: 'builtin', prompt: 'hi', joinStrategy: 'all', allowWrite: false, position: { x: 0, y: 0 } }], edges: [] }

async function waitRun(who: Who, runId: string): Promise<any> {
  for (let i = 0; i < 300; i += 1) {
    const res = await as(who, 'GET', `/api/workflow-runs/${runId}`)
    if (['succeeded', 'failed', 'cancelled'].includes(res.json.status)) return res.json
    await sleep(40)
  }
  throw new Error('run did not finish')
}

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: ORIGIN })
  const setupToken = readFileSync(join(server.home, 'setup-token'), 'utf8').trim()
  const ok = await as(null, 'POST', '/api/auth/setup', { setupToken, email: 'owner@acme.com', password: PASSWORD, name: 'Owner', orgName: 'Acme' })
  owner = { token: ok.json.token, id: ok.json.user.id, role: 'owner' }
  member = await invite('member', 'member@acme.com')
  member2 = await invite('member', 'member2@acme.com')
  viewer = await invite('viewer', 'viewer@acme.com')
  await as(owner, 'POST', '/api/providers', { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' })
  await as(owner, 'PATCH', '/api/settings', { autoTitle: false, llmMaxRetries: 0, skillAutoPreload: false })
}, 60_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('工作流 RBAC（server 模式）——仅本人（契约 §5.6a）', () => {
  it('工作流只有负责人自己可见可改可运行；owner/admin 也看不到；不支持共享；viewer 不能写', async () => {
    const ownersWf = (await as(owner, 'POST', '/api/workflows', { name: 'Owner 私有', ...graph })).json
    const mine = await as(member, 'POST', '/api/workflows', { name: 'Member 的', ...graph })
    expect(mine.status, mine.text).toBe(201)
    expect(mine.json).toMatchObject({ ownerId: member.id, visibility: 'private' })

    expect((await as(member, 'GET', `/api/workflows/${ownersWf.id}`)).status).toBe(404)
    expect((await as(member, 'GET', '/api/workflows')).json.map((w: any) => w.id)).not.toContain(ownersWf.id)
    expect((await as(member2, 'GET', `/api/workflows/${mine.json.id}`)).status).toBe(404)
    expect((await as(member2, 'POST', `/api/workflows/${mine.json.id}/run`, {})).status).toBe(404)
    // owner 也看不到、改不了成员的工作流
    const ownerList = (await as(owner, 'GET', '/api/workflows')).json.map((w: any) => w.id)
    expect(ownerList).toContain(ownersWf.id)
    expect(ownerList).not.toContain(mine.json.id)
    expect((await as(owner, 'GET', `/api/workflows/${mine.json.id}`)).status).toBe(404)
    expect((await as(owner, 'PATCH', `/api/workflows/${mine.json.id}`, { description: 'owner 改过' })).status).toBe(404)
    expect((await as(owner, 'DELETE', `/api/workflows/${mine.json.id}`)).status).toBe(404)
    expect((await as(owner, 'POST', `/api/workflows/${mine.json.id}/duplicate`)).status).toBe(404)
    expect((await as(owner, 'GET', `/api/workflows/${mine.json.id}/export`)).status).toBe(404)

    // 不能共享
    const share = await as(member, 'PATCH', `/api/workflows/${mine.json.id}`, { visibility: 'org' })
    expect(share.status).toBe(400)
    expect((await as(member, 'POST', '/api/workflows', { name: 't', visibility: 'team', ...graph })).status).toBe(400)
    expect((await as(member2, 'GET', `/api/workflows/${mine.json.id}`)).status).toBe(404)

    // viewer：不能写；预览可用
    expect((await as(viewer, 'GET', `/api/workflows/${mine.json.id}`)).status).toBe(404)
    expect((await as(viewer, 'POST', '/api/workflows', { name: 'v', ...graph })).status).toBe(403)
    expect((await as(viewer, 'POST', '/api/schedules/preview', { spec: { type: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai' })).status).toBe(200)

    // 运行记录只有负责人可见；别人（含 owner）不能看 / 取消
    const run = await as(member, 'POST', `/api/workflows/${mine.json.id}/run`, {})
    expect(run.status, run.text).toBe(200)
    const finished = await waitRun(member, run.json.id)
    expect(finished.status).toBe('succeeded')
    for (const who of [member2, owner]) {
      expect((await as(who, 'GET', `/api/workflow-runs/${run.json.id}`)).status).toBe(404)
      expect((await as(who, 'GET', `/api/workflows/${mine.json.id}/runs`)).status).toBe(404)
      expect((await as(who, 'POST', `/api/workflow-runs/${run.json.id}/cancel`)).status).toBe(404)
    }
    // 节点的隐藏会话属于运行者；别人（含 owner）打不开
    const sessionId = finished.nodes[0].sessionId
    expect((await as(member, 'GET', `/api/sessions/${sessionId}`)).status).toBe(200)
    expect((await as(member2, 'GET', `/api/sessions/${sessionId}`)).status).toBe(404)
    expect((await as(owner, 'GET', `/api/sessions/${sessionId}`)).status).toBe(404)
    expect((await as(member, 'GET', '/api/sessions')).json.sessions.map((s: any) => s.id)).not.toContain(sessionId)
  })

  it('定时任务：只能指向自己的工作流；别人（含 owner）看不到 / 不能运行；以负责人身份运行', async () => {
    const ownersWf = (await as(owner, 'POST', '/api/workflows', { name: 'Owner 的', ...graph })).json
    const mineWf = (await as(member, 'POST', '/api/workflows', { name: 'Member 定时', ...graph })).json
    const spec = { type: 'daily', time: '09:00' }

    const hidden = await as(member, 'POST', '/api/schedules', { name: 'x', target: { type: 'workflow', workflowId: ownersWf.id }, spec })
    expect(hidden.status).toBe(400)
    expect(hidden.json.error.code).toBe('WORKFLOW_NOT_FOUND')
    expect((await as(viewer, 'POST', '/api/schedules', { name: 'v', target: { type: 'workflow', workflowId: mineWf.id }, spec })).status).toBe(403)

    const sch = await as(member, 'POST', '/api/schedules', { name: 'Member 的定时', target: { type: 'workflow', workflowId: mineWf.id }, spec, timezone: 'Asia/Shanghai' })
    expect(sch.status, sch.text).toBe(201)
    expect(sch.json.ownerId).toBe(member.id)
    for (const who of [member2, owner]) {
      expect((await as(who, 'GET', `/api/schedules/${sch.json.id}`)).status).toBe(404)
      expect((await as(who, 'GET', '/api/schedules')).json.map((s: any) => s.id)).not.toContain(sch.json.id)
      expect((await as(who, 'POST', `/api/schedules/${sch.json.id}/run-now`)).status).toBe(404)
      expect((await as(who, 'PATCH', `/api/schedules/${sch.json.id}`, { enabled: false })).status).toBe(404)
      expect((await as(who, 'DELETE', `/api/schedules/${sch.json.id}`)).status).toBe(404)
      expect((await as(who, 'GET', `/api/schedules/${sch.json.id}/runs`)).status).toBe(404)
    }
    // 不能共享
    expect((await as(member, 'PATCH', `/api/schedules/${sch.json.id}`, { visibility: 'org' })).status).toBe(400)

    // 负责人自己立即运行：以 member 身份运行
    const now = await as(member, 'POST', `/api/schedules/${sch.json.id}/run-now`)
    expect(now.status, now.text).toBe(200)
    let run: any
    for (let i = 0; i < 300; i += 1) {
      run = (await as(member, 'GET', `/api/schedules/${sch.json.id}/runs`)).json.find((r: any) => r.id === now.json.id)
      if (run && run.status !== 'running') break
      await sleep(40)
    }
    expect(run.status, run.error).toBe('succeeded')
    const wfRun = (await as(member, 'GET', `/api/workflow-runs/${run.workflowRunId}`)).json
    expect(wfRun).toMatchObject({ trigger: 'schedule', scheduleId: sch.json.id })
    const session = await as(member, 'GET', `/api/sessions/${wfRun.nodes[0].sessionId}`)
    expect(session.status).toBe(200)
    expect(session.json.session.ownerId).toBe(member.id)

    // 负责人被停用：触发记为失败，不会以别人的身份运行
    const { db } = await import('../src/db.js')
    const { scheduler } = await import('../src/services/schedule/scheduler.js')
    const { runAs } = await import('../src/context.js')
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(member.id)
    const orgId = (db.prepare('SELECT org_id FROM users WHERE id = ?').get(member.id) as { org_id: string }).org_id
    // 停用后账号无法登录：用服务层以负责人身份触发一次（与定时触发同一路径）
    const blocked = runAs({ id: member.id, name: 'member', email: '', role: 'member', orgId, teamIds: [], sessionId: null }, () => scheduler.runNow(sch.json.id))
    expect(blocked).toMatchObject({ status: 'failed', error: '任务负责人的账号不存在或已停用' })
    db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(member.id)
  })
})
