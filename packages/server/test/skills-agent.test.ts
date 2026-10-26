import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, TEST_TOKEN, type TestServer } from './helpers.js'

/**
 * Skill 管理 API + Agent 工具端到端（真实 HTTP 服务 + tools/dev/mock-openai.js 编排工具调用）：
 * 安装来源（zip / GitHub / raw / zip URL / 本地文件夹）、导出、启停删除、按 Agent 配置；
 * run_skill_script 审批（auto 模式也必须批准）、本会话记忆、沙箱 cwd/环境变量白名单、超时、输出上限、npm 依赖安装、产物下载；
 * skill_create/skill_update（备份）/skill_install；mcp_add 命令型走原生确认、远程 HTTP 型只走普通审批；
 * 端到端：用户“帮我给这个询盘报个 CIF 价” → skill_view 报价 skill → run_skill_script → create_quote_draft。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
let gh: Server
let ghBase = ''
let confirmCalls: Array<{ command: string; args: string[] }> = []
let confirmAnswer = true

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
  const res = await fetch(`${mockBase}${path}`, {
    method: path === '/__mock/requests' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: path === '/__mock/requests' ? undefined : JSON.stringify(body ?? {}),
  })
  return res.json()
}
const script = (...responses: unknown[]) => mockCall('/__mock/script', { responses })
const mockRequests = (): Promise<any[]> => mockCall('/__mock/requests')
const call = (name: string, args: unknown, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })

/** 新会话；全局默认是“完全权限”（toolApproval=auto），需要审批卡片的用例显式传 'ask'（契约 §6.11） */
async function newSession(agentIds = ['builtin'], permissionLevel?: 'read' | 'ask' | 'full'): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds, ...(permissionLevel ? { permissionLevel } : {}) } })
  return res.json.session.id
}

/** 发起对话；遇到审批按 decide 处理（返回 true/false/'session'），返回 SSE 事件与审批记录 */
async function chatWithApprovals(sessionId: string, content: string, decide: (req: any) => boolean | 'session' = () => true) {
  const pending = server.request('POST', '/api/chat', { body: { sessionId, content } })
  const approvals: any[] = []
  let done = false
  void pending.then(() => (done = true))
  while (!done) {
    const p = await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)
    for (const req of p.json.requests ?? []) {
      approvals.push(req)
      const answer = decide(req)
      await server.request('POST', '/api/chat/tool-decision', { body: { requestId: req.requestId, approved: answer !== false, remember: answer === 'session' ? 'session' : undefined } })
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  const res = await pending
  expect(res.status).toBe(200)
  return { events: parseSse(res.text), approvals }
}

const toolResults = (events: Array<{ event: string; data: any }>) => events.filter((e) => e.event === 'tool_result').map((e) => e.data)
const toolRequests = (events: Array<{ event: string; data: any }>) => events.filter((e) => e.event === 'tool_request').map((e) => e.data)

function zipOf(files: Record<string, string>): Promise<string> {
  return import('../src/services/skills/zip.js').then(({ writeZip }) => writeZip(Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) }))).toString('base64'))
}

const md = (name: string, desc: string, extra = '', body = '正文') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n# ${name}\n${body}\n`

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`

  // 假 GitHub（API + raw）与静态文件服务
  const files: Record<string, string> = {
    'skills/gh-skill/SKILL.md': md('gh-skill', 'GitHub 安装测试技能', 'metadata:\n  keywords: [github测试]\n'),
    'skills/gh-skill/references/a.md': '参考资料',
    'skills/other/SKILL.md': md('other', '另一个技能的说明'),
  }
  const { writeZip } = await import('../src/services/skills/zip.js')
  const zipBuf = writeZip([{ path: 'pack/SKILL.md', data: Buffer.from(md('zip-url-skill', '从 zip 地址安装的技能')) }])
  gh = createHttpServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/repos/acme/skills') return res.end(JSON.stringify({ default_branch: 'main' }))
    if (url.pathname === '/repos/acme/skills/git/trees/main') {
      return res.end(JSON.stringify({ tree: [{ path: 'skills', type: 'tree', mode: '040000' }, ...Object.entries(files).map(([path, c]) => ({ path, type: 'blob', mode: '100644', size: c.length }))] }))
    }
    const raw = /^\/acme\/skills\/main\/(.+)$/.exec(url.pathname)
    if (raw && files[decodeURIComponent(raw[1]!)]) return res.end(files[decodeURIComponent(raw[1]!)])
    if (url.pathname === '/dl/pack.zip') {
      res.setHeader('content-type', 'application/zip')
      return res.end(zipBuf)
    }
    if (url.pathname === '/single/SKILL.md') return res.end(md('single-file', '单文件 raw 地址安装的技能'))
    res.statusCode = 404
    res.end('nf')
  })
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()))
  ghBase = `http://127.0.0.1:${(gh.address() as { port: number }).port}`

  // 假 npm：把要装的包写进 --prefix/node_modules
  const fakeNpm = join(mkdtempSync(join(tmpdir(), 'lulux-fake-npm-')), 'npm.cjs')
  writeFileSync(
    fakeNpm,
    `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const p=a[a.indexOf('--prefix')+1];
     for(const spec of a.slice(1)){if(spec.startsWith('--'))break;const name=spec.replace(/@[^@/]*$/,'');const d=path.join(p,'node_modules',name);fs.mkdirSync(d,{recursive:true});
     fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.js'}));fs.writeFileSync(path.join(d,'index.js'),'module.exports=()=>"fake-ok"')}`,
  )

  process.env.SECRET_TEST_TOKEN = 'super-secret-value'
  server = await startTestServer({
    OPENAI_API_KEY: 'sk-parent-env-secret',
    LULUX_GITHUB_API: ghBase,
    LULUX_GITHUB_RAW: ghBase,
    LULUX_SKILLS_ALLOW_PRIVATE_URL: '1',
    LULUX_KERNEL_NPM: fakeNpm,
  })
  const provider = await server.request('POST', '/api/providers', {
    body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' },
  })
  expect(provider.status).toBe(201)
  const res = await server.request('PATCH', '/api/settings', { body: { autoTitle: false, toolApproval: 'auto', toolLoading: 'all', modelCapabilities: JSON.stringify({ 'mock-model': { contextWindow: 200_000, maxOutput: 8192 } }) } })
  expect(res.status, res.text).toBe(200)
  const { setConfirmChannelForTests } = await import('../src/services/mcp/confirm.js')
  setConfirmChannelForTests({
    available: () => true,
    request: async (spec: { command: string; args: string[] }) => {
      confirmCalls.push({ command: spec.command, args: spec.args })
      return confirmAnswer
    },
  } as never)
}, 60_000)

afterAll(async () => {
  const { mcpRuntime } = await import('../src/services/mcp/runtime.js')
  mcpRuntime.closeAll()
  mock?.kill()
  await new Promise((r) => gh.close(r))
  await server?.close()
})

beforeEach(async () => {
  await mockCall('/__mock/reset')
})

describe('Skill 管理 API', () => {
  it('列表含全部内置 skill 与分类；详情、文件、导出', async () => {
    const list = await server.request('GET', '/api/skills')
    expect(list.status).toBe(200)
    const builtin = list.json.skills.filter((s: any) => s.source === 'builtin')
    expect(builtin.length).toBeGreaterThanOrEqual(38)
    expect(list.json.categories.find((c: any) => c.id === 'trade').count).toBeGreaterThanOrEqual(16)
    const trade = await server.request('GET', '/api/skills?category=trade&query=CIF')
    expect(trade.json.skills.map((s: any) => s.name)).toContain('quote-calculator')

    const detail = await server.request('GET', '/api/skills/quote-calculator')
    expect(detail.json).toMatchObject({ name: 'quote-calculator', source: 'builtin', hasScripts: true, readOnly: true, enabled: true })
    expect(detail.json.files.map((f: any) => f.path)).toContain('scripts/quote_calc.cjs')
    expect(detail.json.content).toContain('Incoterms 2020')

    const file = await server.request('GET', '/api/skills/trade-email-writer/file?path=references/culture.md')
    expect(file.json.content).toContain('Estimado')
    expect((await server.request('GET', '/api/skills/quote-calculator/file?path=../inquiry-triage/SKILL.md')).status).toBe(400)
    expect((await server.request('GET', '/api/skills/nope')).status).toBe(404)

    const exported = await fetch(`${server.base}/api/skills/quote-calculator/export`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })
    expect(exported.headers.get('content-type')).toBe('application/zip')
    const { readZip } = await import('../src/services/skills/zip.js')
    const entries = readZip(Buffer.from(await exported.arrayBuffer()), { maxEntries: 100, maxTotalBytes: 1e7, maxFileBytes: 1e7 })
    expect(entries.map((e) => e.path)).toContain('quote-calculator/scripts/quote_calc.cjs')
  })

  it('安装：zip 上传、冲突 409、overwrite；GitHub 目录、raw 单文件、zip 地址；本地文件夹', async () => {
    const zip = await zipOf({ 'my-skill/SKILL.md': md('my-skill', '上传 zip 安装的技能'), 'my-skill/scripts/hello.cjs': 'console.log("hi")' })
    const created = await server.request('POST', '/api/skills/install/zip', { body: { filename: 'my-skill.zip', dataBase64: zip } })
    expect(created.status, created.text).toBe(201)
    expect(created.json.skill).toMatchObject({ name: 'my-skill', source: 'imported', hasScripts: true, installedBy: 'user' })
    expect((await server.request('POST', '/api/skills/install/zip', { body: { dataBase64: zip } })).json.error.code).toBe('SKILL_EXISTS')
    expect((await server.request('POST', '/api/skills/install/zip', { body: { dataBase64: zip, overwrite: true } })).json.replaced).toBe(true)
    const evil = await zipOf({ 'SKILL.md': md('evil', '恶意技能的说明'), '../../evil.txt': 'x' })
    expect((await server.request('POST', '/api/skills/install/zip', { body: { dataBase64: evil } })).json.error.code).toBe('SKILL_PATH_INVALID')

    const ghRes = await server.request('POST', '/api/skills/install/url', { body: { url: 'https://github.com/acme/skills', subpath: 'skills/gh-skill' } })
    expect(ghRes.status, ghRes.text).toBe(201)
    expect(ghRes.json.skill).toMatchObject({ name: 'gh-skill', origin: 'https://github.com/acme/skills/tree/main/skills/gh-skill' })
    expect((await server.request('GET', '/api/skills/gh-skill/file?path=references/a.md')).json.content).toBe('参考资料')
    const treeRes = await server.request('POST', '/api/skills/install/url', { body: { url: 'https://github.com/acme/skills/tree/main/skills/other' } })
    expect(treeRes.json.skill.name).toBe('other')
    const zipUrl = await server.request('POST', '/api/skills/install/url', { body: { url: `${ghBase}/dl/pack.zip` } })
    expect(zipUrl.json.skill.name).toBe('zip-url-skill')
    const raw = await server.request('POST', '/api/skills/install/url', { body: { url: `${ghBase}/single/SKILL.md` } })
    expect(raw.json.skill.name).toBe('single-file')

    const dir = mkdtempSync(join(tmpdir(), 'lulux-folder-'))
    mkdirSync(join(dir, 'folder-skill'))
    writeFileSync(join(dir, 'folder-skill', 'SKILL.md'), md('folder-skill', '本地文件夹导入的技能'))
    const folder = await server.request('POST', '/api/skills/install/folder', { body: { path: join(dir, 'folder-skill') } })
    expect(folder.status, folder.text).toBe(201)
    expect(folder.json.skill).toMatchObject({ name: 'folder-skill', source: 'user' })
  })

  it('启停与删除：内置只能禁用；导入的可删除；按 Agent 选择启用的 skill', async () => {
    expect((await server.request('PATCH', '/api/skills/inquiry-triage', { body: { enabled: false } })).json.skill.enabled).toBe(false)
    expect((await server.request('PATCH', '/api/skills/inquiry-triage', { body: { enabled: true } })).json.skill.enabled).toBe(true)
    const del = await server.request('DELETE', '/api/skills/inquiry-triage')
    expect(del.status).toBe(400)
    expect(del.json.error.code).toBe('SKILL_BUILTIN_READONLY')
    expect((await server.request('DELETE', '/api/skills/single-file')).status).toBe(204)
    expect((await server.request('GET', '/api/skills/single-file')).status).toBe(404)

    const put = await server.request('PUT', '/api/agents/builtin/skills', { body: { mode: 'selected', skills: ['translate-polish', 'writing-templates'] } })
    expect(put.json).toMatchObject({ mode: 'selected', available: ['translate-polish', 'writing-templates'] })
    expect((await server.request('GET', '/api/agents/builtin/skills')).json.mode).toBe('selected')
    // 只剩一个 Agent（builtin），恢复默认，免得影响后面的用例
    expect((await server.request('PUT', '/api/agents/builtin/skills', { body: { mode: 'all' } })).json.mode).toBe('all')
  })
})

describe('run_skill_script：审批与沙箱', () => {
  let sessionId = ''
  beforeAll(async () => {
    const zip = await zipOf({
      'sandbox-test/SKILL.md': md('sandbox-test', '沙箱测试技能（脚本）', 'metadata:\n  requires:\n    npm: [fake-pkg@1]\n'),
      'sandbox-test/scripts/env.cjs': `const fs=require('fs');fs.writeFileSync('out/result.txt','hello');console.log(JSON.stringify({cwd:process.cwd(),keys:Object.keys(process.env),ws:process.env.LULUX_WORKSPACE,args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')}))`,
      'sandbox-test/scripts/sleep.cjs': 'setInterval(()=>{},1000)',
      'sandbox-test/scripts/spam.cjs': `process.stdout.write('x'.repeat(200000))`,
      'sandbox-test/scripts/dep.cjs': `console.log(require('fake-pkg')())`,
      'sandbox-test/scripts/hello.py': `import os,sys\nprint("py", os.getcwd()==os.environ["LULUX_WORKSPACE"], sys.argv[1])`,
      'sandbox-test/scripts/run.sh': 'echo no',
    })
    const res = await server.request('POST', '/api/skills/install/zip', { body: { dataBase64: zip } })
    expect(res.status, res.text).toBe(201)
    sessionId = await newSession(['builtin'], 'ask')
    mkdirSync(join(server.home, 'workspace', sessionId, 'out'), { recursive: true })
  })

  it('需审批：run_skill_script 弹审批卡片；拒绝则不执行', async () => {
    await script(call('run_skill_script', { skill: 'sandbox-test', script: 'env.cjs' }), { text: '好' })
    const { events, approvals } = await chatWithApprovals(sessionId, '跑一下', () => false)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ name: 'run_skill_script', approvalKind: 'skill_script', canRemember: true, toolKey: 'run_skill_script:sandbox-test' })
    expect(approvals[0].detail).toMatchObject({ skill: 'sandbox-test', script: 'env.cjs', interpreter: 'node', npmToInstall: ['fake-pkg@1'] })
    expect(toolRequests(events)[0]).toMatchObject({ auto: false, approvalKind: 'skill_script' })
    expect(toolResults(events)[0].content ?? JSON.stringify(toolResults(events)[0])).toContain('拒绝')
    expect(existsSync(join(server.home, 'workspace', sessionId, 'out', 'result.txt'))).toBe(false)
  })

  it('批准后在会话工作区运行，环境变量白名单（无父进程密钥），产物事件可下载；本会话记住后同一 skill 不再询问', async () => {
    await script(call('run_skill_script', { skill: 'sandbox-test', script: 'scripts/env.cjs', args: ['--x', '1'], stdin: '{"a":1}' }), { text: '完成' })
    const first = await chatWithApprovals(sessionId, '跑一下', () => 'session')
    expect(first.approvals).toHaveLength(1)
    const result = toolResults(first.events)[0]
    // 工具结果：result 是 JSON 字符串，脚本自身的输出在其 stdout 里
    const toolOutput = JSON.parse(String(result.result))
    expect(toolOutput).toMatchObject({ ok: true, exitCode: 0, installedDependencies: ['fake-pkg@1'] })
    const payload = JSON.parse(String(toolOutput.stdout).trim())
    // 子进程的 cwd 是解析过符号链接的真实路径（macOS 临时目录 /var → /private/var）
    const workspace = realpathSync(join(server.home, 'workspace', sessionId))
    expect(payload.cwd).toBe(workspace)
    expect(payload.ws).toBe(workspace)
    expect(payload.args).toEqual(['--x', '1'])
    expect(payload.stdin).toBe('{"a":1}')
    expect(payload.keys).not.toContain('SECRET_TEST_TOKEN')
    expect(payload.keys).not.toContain('OPENAI_API_KEY')
    expect(payload.keys.some((k: string) => k.startsWith('LULUX_ETA'))).toBe(false)
    expect(payload.keys).toContain('PATH')
    const artifact = first.events.find((e) => e.event === 'artifact')!.data.artifact
    expect(artifact).toMatchObject({ binary: true, path: 'out/result.txt', filename: 'result.txt', size: 5 })
    const download = await fetch(`${server.base}${artifact.downloadUrl}`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })
    expect(await download.text()).toBe('hello')
    expect((await server.request('GET', `/api/chat/sessions/${sessionId}/files?path=../../lulux-eta.db`)).status).toBe(400)

    await script(call('run_skill_script', { skill: 'sandbox-test', script: 'env.cjs' }), { text: '完成' })
    const second = await chatWithApprovals(sessionId, '再跑', () => false)
    expect(second.approvals).toHaveLength(0)
    expect(toolRequests(second.events)[0].auto).toBe(true)
    // 其他 skill 仍需审批
    await script(call('run_skill_script', { skill: 'container-loading', script: 'cbm_calc.cjs', stdin: '{"cartons":[{"length":50,"width":40,"height":30,"grossKg":10,"count":100}]}' }), { text: '完成' })
    const third = await chatWithApprovals(sessionId, '算体积', () => true)
    expect(third.approvals).toHaveLength(1)
    expect(JSON.stringify(toolResults(third.events)[0])).toContain('6 CBM')
    const usage = await server.request('GET', '/api/skills/sandbox-test/usage')
    expect(usage.json.byKind.script).toBeGreaterThanOrEqual(2)
  })

  it('拒绝 scripts/ 以外的文件与路径穿越；不支持的脚本类型；超时；输出上限；npm 依赖首次自动安装', async () => {
    await script(
      call('run_skill_script', { skill: 'sandbox-test', script: '../SKILL.md' }),
      call('run_skill_script', { skill: 'sandbox-test', script: 'scripts/../../quote-calculator/scripts/quote_calc.cjs' }),
      call('run_skill_script', { skill: 'sandbox-test', script: 'run.sh' }),
      call('run_skill_script', { skill: 'sandbox-test', script: 'sleep.cjs', timeoutSeconds: 1 }),
      call('run_skill_script', { skill: 'sandbox-test', script: 'spam.cjs' }),
      call('run_skill_script', { skill: 'sandbox-test', script: 'dep.cjs' }),
      { text: '完成' },
    )
    const { events } = await chatWithApprovals(sessionId, '各种情况', () => true)
    const results = toolResults(events).map((r) => JSON.stringify(r))
    expect(results[0]).toMatch(/scripts\/|穿越/)
    expect(results[1]).toMatch(/穿越|scripts\//)
    expect(results[2]).toContain('不支持的脚本类型')
    expect(results[3]).toContain('超时')
    expect(results[4]).toContain('输出过长')
    // 依赖已在上一个用例首次运行时安装（installedDependencies 断言在那里），这里直接可用
    expect(results[5]).toContain('fake-ok')
    expect(existsSync(join(server.home, 'skill-runtime', 'node_modules', 'fake-pkg', 'package.json'))).toBe(true)
  }, 30_000)

  it('Python 脚本用系统 python3 运行（本机无 python3 时跳过）', async () => {
    const { findPython } = await import('../src/services/skills/script-runner.js')
    if (!findPython()) return
    // 新会话：避免前面用例累积的历史触发上下文压缩（压缩会消耗 mock 的脚本回复）
    const fresh = await newSession(['builtin'], 'ask')
    await script(call('run_skill_script', { skill: 'sandbox-test', script: 'hello.py', args: ['arg1'] }), { text: '完成' })
    const { events } = await chatWithApprovals(fresh, 'python', () => true)
    expect(JSON.stringify(toolResults(events)[0])).toContain('py True arg1')
  })
})

describe('Agent 自配置：技能', () => {
  it('skill_create（来源 agent，需审批）→ skill_update（修改前备份）→ 内置只读', async () => {
    const sessionId = await newSession(['builtin'], 'ask')
    await script(
      call('skill_create', { name: 'agent-skill', description: 'Agent 自己写的测试技能，用于验证', body: '## 步骤\n1. 做事', keywords: ['自写技能'], files: [{ path: 'templates/t.md', content: '模板' }] }),
      call('skill_update', { name: 'agent-skill', body: '## 步骤\n1. 改过的做事步骤', deleteFiles: ['templates/t.md'] }),
      call('skill_update', { name: 'quote-calculator', body: '篡改内置技能的正文内容' }),
      { text: '完成' },
    )
    const { events, approvals } = await chatWithApprovals(sessionId, '把流程写成技能', () => true)
    expect(approvals.map((a) => a.approvalKind)).toEqual(['skill_write', 'skill_write', 'skill_write'])
    expect(approvals[0].detail).toMatchObject({ name: 'agent-skill', files: ['SKILL.md', 'templates/t.md'], hasScripts: false })
    const results = toolResults(events).map((r) => JSON.stringify(r))
    expect(results[1]).toContain('backedUp')
    expect(results[2]).toContain('内置')
    const detail = await server.request('GET', '/api/skills/agent-skill')
    expect(detail.json).toMatchObject({ source: 'agent', installedBy: 'agent' })
    expect(detail.json.content).toContain('改过的做事步骤')
    expect(detail.json.files.map((f: any) => f.path)).toEqual(['SKILL.md'])
    const { backupsRoot } = await import('../src/services/skills/paths.js')
    const { readdirSync } = await import('node:fs')
    // 备份目录布局：<skills>/.backups/<name>/<时间戳>/
    expect(readdirSync(join(backupsRoot(), 'agent-skill')).length).toBeGreaterThan(0)
    const audit = await server.request('GET', '/api/audit?action=skill.create')
    if (audit.status === 200) expect(JSON.stringify(audit.json)).toContain('agent-skill')
  })

  it('参数校验失败时审批卡片仍有说明（detail 不为 null，密钥只给键名），运行时报参数错误', async () => {
    const sessionId = await newSession(['builtin'], 'ask')
    await script(
      call('skill_create', { name: 'Bad Name!', description: '短', body: 'x' }),
      call('mcp_add', { name: 'bad', url: 'not-a-url', headers: { Authorization: 'Bearer leak-me' } }),
      { text: '好' },
    )
    const { events, approvals } = await chatWithApprovals(sessionId, '写个技能', () => true)
    expect(approvals).toHaveLength(2)
    expect(approvals[0].detail).toMatchObject({ invalid: true, arguments: { name: 'Bad Name!', description: '短', body: 'x' } })
    expect(approvals[0].detail.errors.length).toBeGreaterThan(0)
    expect(approvals[1].detail).toMatchObject({ invalid: true, arguments: { name: 'bad', headersKeys: ['Authorization'] } })
    expect(JSON.stringify(approvals[1].detail)).not.toContain('leak-me')
    const results = toolResults(events)
    expect(results.every((r) => r.ok === false)).toBe(true)
    expect(JSON.stringify(results[0])).toContain('参数不正确')
  })

  it('skill_install：从 URL 安装需要审批；拒绝则不安装', async () => {
    const sessionId = await newSession(['builtin'], 'ask')
    await script(call('skill_install', { url: `${ghBase}/dl/pack.zip`, overwrite: true }), { text: '好' })
    const denied = await chatWithApprovals(sessionId, '装技能', () => false)
    expect(denied.approvals[0]).toMatchObject({ approvalKind: 'skill_install', detail: { url: `${ghBase}/dl/pack.zip` } })
    await server.request('DELETE', '/api/skills/zip-url-skill')
    expect((await server.request('GET', '/api/skills/zip-url-skill')).status).toBe(404)
    await script(call('skill_install', { url: `${ghBase}/dl/pack.zip` }), { text: '好' })
    await chatWithApprovals(sessionId, '装技能', () => true)
    expect((await server.request('GET', '/api/skills/zip-url-skill')).json).toMatchObject({ source: 'imported', installedBy: 'agent' })
  })
})

describe('完全权限：skill 脚本直接运行，组织级 MCP 变更仍要确认', () => {
  it('full 会话：run_skill_script / skill_create 不弹卡片；mcp_add 仍弹审批卡片', async () => {
    const sessionId = await newSession(['builtin'], 'full')
    await script(
      call('run_skill_script', { skill: 'container-loading', script: 'cbm_calc.cjs', stdin: '{"cartons":[{"length":50,"width":40,"height":30,"grossKg":10,"count":100}]}' }),
      call('skill_create', { name: 'full-level-skill', description: '完全权限下 Agent 自写的技能', body: '## 步骤\n1. 做事' }),
      call('mcp_add', { name: 'full-level-mcp', url: 'https://example.invalid/mcp' }),
      { text: '好' },
    )
    const { events, approvals } = await chatWithApprovals(sessionId, '跑脚本、写技能、加 MCP', () => false)
    expect(approvals.map((a) => a.name)).toEqual(['mcp_add'])
    const requests = toolRequests(events)
    expect(requests.map((r) => r.auto)).toEqual([true, true, false])
    const results = toolResults(events)
    expect(JSON.stringify(results[0])).toContain('6 CBM')
    expect(results[1].ok).not.toBe(false)
    expect(JSON.stringify(results[2])).toContain('拒绝')
    expect((await server.request('GET', '/api/skills/full-level-skill')).json).toMatchObject({ source: 'agent' })
    expect((await server.request('GET', '/api/mcp/servers')).json.servers.some((s: any) => s.name === 'full-level-mcp')).toBe(false)
    await server.request('DELETE', '/api/skills/full-level-skill')
  })
})

describe('Agent 自配置：MCP', () => {
  it('mcp_add 命令型：普通审批后仍走原生确认；原生确认拒绝 → 不写库；同意 → 添加（createdBy=agent）；“本会话允许”不可用', async () => {
    const sessionId = await newSession()
    confirmCalls = []
    confirmAnswer = false
    await script(call('mcp_add', { name: 'evil-cmd', command: process.execPath, args: ['-e', 'process.exit(0)'] }), { text: '好' })
    const rejected = await chatWithApprovals(sessionId, '加个 MCP', () => 'session')
    expect(rejected.approvals[0]).toMatchObject({ approvalKind: 'mcp_add', canRemember: false, detail: { transport: 'stdio', nativeConfirm: true } })
    expect(confirmCalls).toHaveLength(1)
    expect(JSON.stringify(toolResults(rejected.events)[0])).toMatch(/MCP_COMMAND_REJECTED|拒绝/)
    expect((await server.request('GET', '/api/mcp/servers')).json.servers.some((s: any) => s.name === 'evil-cmd')).toBe(false)

    // 记住会话无效：下一次仍要审批
    confirmAnswer = true
    const mcpScript = join(mkdtempSync(join(tmpdir(), 'lulux-mcp-')), 'mcp.cjs')
    writeFileSync(
      mcpScript,
      `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===undefined)return;let r={};
       if(m.method==='initialize')r={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'t',version:'1'}};
       if(m.method==='tools/list')r={tools:[{name:'ping',description:'ping',inputSchema:{type:'object'}}]};
       process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n')})`,
    )
    await script(call('mcp_add', { name: 'ping-server', command: process.execPath, args: [mcpScript] }), { text: '好' })
    const ok = await chatWithApprovals(sessionId, '加个 MCP', () => true)
    expect(ok.approvals).toHaveLength(1)
    expect(confirmCalls).toHaveLength(2)
    expect(confirmCalls[1]).toEqual({ command: process.execPath, args: [mcpScript] })
    const added = (await server.request('GET', '/api/mcp/servers')).json.servers.find((s: any) => s.name === 'ping-server')
    expect(added).toMatchObject({ transport: 'stdio', createdBy: 'agent', approved: true })
    expect(JSON.stringify(toolResults(ok.events)[0])).toContain('ping')

    // 拒绝审批时连原生确认都不会弹
    await script(call('mcp_remove', { id: added.id }), { text: '好' })
    await chatWithApprovals(sessionId, '删掉', () => false)
    expect((await server.request('GET', '/api/mcp/servers')).json.servers.some((s: any) => s.id === added.id)).toBe(true)
    await script(call('mcp_update', { id: added.id, args: [mcpScript, '--v2'] }), { text: '好' })
    await chatWithApprovals(sessionId, '改参数', () => true)
    expect(confirmCalls).toHaveLength(3)
    await script(call('mcp_list', {}), call('mcp_remove', { id: added.id }), { text: '好' })
    const removed = await chatWithApprovals(sessionId, '列出并删掉', () => true)
    expect(JSON.stringify(toolResults(removed.events)[0])).toContain('ping-server')
    expect((await server.request('GET', '/api/mcp/servers')).json.servers.some((s: any) => s.id === added.id)).toBe(false)
  }, 30_000)

  it('mcp_add 远程 HTTP：只走普通审批（不弹原生确认）；请求头加密存储、接口只返回键名；可用 Streamable HTTP 调用工具', async () => {
    // 最小 Streamable HTTP MCP
    let sessionHeader = ''
    const http = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'DELETE') return res.end()
        expect(req.headers.authorization).toBe('Bearer remote-secret')
        const msg = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        if (msg.id === undefined) {
          res.statusCode = 202
          return res.end()
        }
        let result: unknown = {}
        if (msg.method === 'initialize') {
          res.setHeader('Mcp-Session-Id', 'sess-1')
          result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'remote', version: '1' } }
        } else sessionHeader = String(req.headers['mcp-session-id'] ?? '')
        if (msg.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
        if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: `echo:${JSON.stringify(msg.params.arguments)}` }] }
        if (msg.method === 'tools/call') {
          res.setHeader('content-type', 'text/event-stream')
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      })
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
    const sessionId = await newSession()
    confirmCalls = []
    await script(call('mcp_add', { name: 'remote', url, headers: { Authorization: 'Bearer remote-secret' } }), { text: '好' })
    const { events, approvals } = await chatWithApprovals(sessionId, '加远程 MCP', () => true)
    expect(approvals[0]).toMatchObject({ approvalKind: 'mcp_add', detail: { transport: 'http', url, headerKeys: ['Authorization'], nativeConfirm: false } })
    expect(confirmCalls).toHaveLength(0)
    expect(JSON.stringify(toolResults(events)[0])).toContain('echo')
    const listed = (await server.request('GET', '/api/mcp/servers')).json.servers.find((s: any) => s.name === 'remote')
    expect(listed).toMatchObject({ transport: 'http', url, headerKeys: ['Authorization'] })
    expect(JSON.stringify(listed)).not.toContain('remote-secret')
    const { db } = await import('../src/db.js')
    const row = db.prepare('SELECT headers FROM mcp_servers WHERE id = ?').get(listed.id) as { headers: string }
    expect(row.headers).not.toContain('remote-secret')
    const { mcpRuntime } = await import('../src/services/mcp/runtime.js')
    const toolName = (await mcpRuntime.toolDefinitions()).find((t) => t.serverId === listed.id)!.name
    const out = await mcpRuntime.call(toolName, { q: 1 })
    expect(out).toMatchObject({ ok: true, text: 'echo:{"q":1}' })
    expect(sessionHeader).toBe('sess-1')
    // REST：不能把 http 改成命令
    expect((await server.request('PATCH', `/api/mcp/servers/${listed.id}`, { body: { command: 'node' } })).status).toBe(400)
    await server.request('DELETE', `/api/mcp/servers/${listed.id}`)
    await new Promise((r) => http.close(r))
  })
})

describe('端到端：询盘报 CIF 价', () => {
  it('“帮我给这个询盘报个 CIF 价” → 预加载报价 skill → skill_view → run_skill_script → create_quote_draft', async () => {
    const customer = await server.request('POST', '/api/customers', { body: { company: 'Example GmbH', country: 'DE' } })
    expect(customer.status, customer.text).toBe(201)
    const customerId = customer.json.id ?? customer.json.customer?.id
    const sessionId = await newSession()
    const input = {
      currency: 'USD',
      fx: 7.1,
      items: [{ name: 'LED Panel', spec: '600x600 40W', qty: 2000, unit: 'pcs', costCNY: 52.5, rebateRate: 0.13, cbmPerUnit: 0.0085, kgPerUnit: 1.9 }],
      domestic: { truckingCNY: 1800, portChargesCNY: 1200, customsCNY: 300, docsCNY: 200 },
      freight: { mode: 'container', containers: { '20GP': 1 }, ratePerContainer: { '20GP': 1350 } },
      insurance: { rate: 0.003 },
      margin: 0.15,
      terms: ['FOB', 'CIF'],
      port: { loading: 'Ningbo', destination: 'Hamburg' },
    }
    await script(
      call('skill_view', { name: 'quote-calculator' }),
      call('workspace_write', { path: 'quote-input.json', content: JSON.stringify(input) }),
      call('run_skill_script', { skill: 'quote-calculator', script: 'quote_calc.cjs', args: ['quote-input.json', '--out', 'quote-result.json'] }),
      call('create_quote_draft', { customerId, currency: 'USD', incoterm: 'CIF', port: 'Hamburg', items: [{ name: 'LED Panel', spec: '600x600 40W', qty: 2000, unit: 'pcs', unitPrice: 8.81 }] }),
      { text: '已按 CIF Hamburg 报价 USD 8.81/pc 生成草稿报价单。' },
    )
    const { events, approvals } = await chatWithApprovals(sessionId, '帮我给这个询盘报个 CIF 价：2000 个 LED 面板灯，到汉堡', () => true)
    expect(events.find((e) => e.event === 'skill_preload')?.data.skills).toContain('quote-calculator')
    // 完全权限（全局默认 auto → full）：脚本与业务写工具都直接执行，不弹卡片
    expect(approvals).toEqual([])
    const results = toolResults(events)
    expect(results.map((r) => r.name)).toEqual(['skill_view', 'workspace_write', 'run_skill_script', 'create_quote_draft'])
    expect(results.every((r) => r.ok !== false)).toBe(true)
    expect(JSON.stringify(results[0])).toContain('Incoterms 2020')
    expect(JSON.stringify(results[2])).toContain('CIF Hamburg')
    expect(JSON.stringify(results[2])).toContain('8.81')
    const quoteResult = JSON.parse(readFileSync(join(server.home, 'workspace', sessionId, 'quote-result.json'), 'utf8'))
    expect(quoteResult.quotes.find((q: any) => q.term === 'CIF').items[0].unitPrice).toBe(8.81)
    const quotes = await server.request('GET', `/api/quotes?customerId=${customerId}`)
    expect(Array.isArray(quotes.json) ? quotes.json : (quotes.json.items ?? quotes.json.quotes)).toEqual(expect.arrayContaining([expect.objectContaining({ incoterm: 'CIF', status: 'draft' })]))

    // 系统提示：skill 索引 + 预加载正文；工具列表含 skill 工具
    const reqs = await mockRequests()
    const system = reqs[0].messages[0].content as string
    expect(system).toContain('quote-calculator')
    expect(system).toContain('已预加载的技能说明')
    expect(system).toContain('trade-email-writer')
    const tools = reqs[0].tools.map((t: any) => t.function.name)
    expect(tools).toEqual(expect.arrayContaining(['skill_list', 'skill_view', 'run_skill_script', 'skill_install', 'mcp_add']))
    expect((await server.request('GET', '/api/skills/quote-calculator/usage')).json.byKind).toMatchObject({ view: 1, script: 1, preload: 1 })
  }, 30_000)
})
