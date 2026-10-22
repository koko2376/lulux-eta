import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSse, startTestServer, type TestServer } from './helpers.js'

/**
 * 回归：script-runner 的 serverNodeModules() 曾用 require.resolve('pdfkit/package.json')，
 * pdfkit 的 exports 不导出该路径 → 永远 null → 技能脚本 NODE_PATH 缺 pdfkit → PI PDF 生成失败。
 */
let server: TestServer
let mock: ChildProcess
let mockBase = ''
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

beforeAll(async () => {
  const port = await freePort()
  mock = spawn(process.execPath, [fileURLToPath(new URL('../../../tools/dev/mock-openai.js', import.meta.url)), String(port)], { stdio: 'pipe' })
  await new Promise<void>((ready) => mock.stdout!.once('data', () => ready()))
  mockBase = `http://127.0.0.1:${port}`
  server = await startTestServer()
  await server.request('POST', '/api/providers', { body: { name: 'Mock', kind: 'openai', baseUrl: `${mockBase}/v1`, apiKey: 'sk-mock-key-123456', model: 'mock-model' } })
  await server.request('PATCH', '/api/settings', { body: { autoTitle: false, toolApproval: 'auto', llmMaxRetries: 0, skillAutoPreload: false } })
}, 90_000)

afterAll(async () => {
  mock?.kill()
  await server?.close()
})

describe('服务端 node_modules 解析（技能脚本 NODE_PATH）', () => {
  it('开发态能找到 pdfkit（exports 不导出 package.json 也行）', async () => {
    const { serverNodeModulesDirs } = await import('../src/services/skills/script-runner.js')
    const dirs = serverNodeModulesDirs()
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs.some((d) => {
      try {
        return JSON.parse(readFileSync(join(d, 'pdfkit', 'package.json'), 'utf8')).name === 'pdfkit'
      } catch {
        return false
      }
    })).toBe(true)
  })

  it('打包后的单文件 CJS 布局（resources/server/index.cjs + resources/server/node_modules/*）', async () => {
    const { serverNodeModulesDirs, nodeModulesOf } = await import('../src/services/skills/script-runner.js')
    const root = mkdtempSync(join(tmpdir(), 'lulux-bundle-'))
    const serverDir = join(root, 'resources', 'server')
    const nm = join(serverDir, 'node_modules')
    // 与 pdfkit 一样：exports 只导出入口，不导出 package.json
    for (const [name, main] of [['pdfkit', 'js/pdfkit.js'], ['docx', 'dist/index.cjs'], ['pdf-parse', 'index.js']] as const) {
      mkdirSync(join(nm, name, main, '..'), { recursive: true })
      writeFileSync(join(nm, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main, exports: { '.': `./${main}` } }))
      writeFileSync(join(nm, name, main), 'module.exports = {}')
    }
    writeFileSync(join(serverDir, 'index.cjs'), '')
    expect(serverNodeModulesDirs(join(serverDir, 'index.cjs'))).toEqual([nm])
    expect(nodeModulesOf(join(nm, '@scope', 'pkg', 'lib', 'a.js'), '@scope/pkg')).toBe(nm)
    expect(nodeModulesOf(join(nm, 'pdfkit', 'js', 'pdfkit.js'), 'pdfkit')).toBe(nm)
    // 没有任何依赖的目录
    const empty = mkdtempSync(join(tmpdir(), 'lulux-empty-'))
    writeFileSync(join(empty, 'index.cjs'), '')
    expect(serverNodeModulesDirs(join(empty, 'index.cjs')).every((d) => !d.startsWith(empty))).toBe(true)
  })
})

describe('Agent：skill_view → run_skill_script 生成 PI PDF', () => {
  it('trade-documents 脚本用服务端自带 pdfkit 生成 PI.pdf，产物可下载', async () => {
    const example = readFileSync(fileURLToPath(new URL('../skills/trade-documents/templates/document-input.example.json', import.meta.url)), 'utf8')
    await fetch(`${mockBase}/__mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        responses: [
          { toolCalls: [{ id: 'v1', name: 'skill_view', arguments: { name: 'trade-documents' } }] },
          { toolCalls: [{ id: 'r1', name: 'run_skill_script', arguments: { skill: 'trade-documents', script: 'trade_docs.cjs', args: ['--type', 'PI'], stdin: example } }] },
          { text: 'PI 已生成。' },
        ],
      }),
    })
    // 需审批会话：脚本先弹审批卡片（全局默认 auto = 完全权限时会直接运行）
    const session = await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'], permissionLevel: 'ask' } })
    const sessionId = session.json.session.id
    const pending = server.request('POST', '/api/chat', { body: { sessionId, content: '按示例数据生成 PI' } })
    let requestId = ''
    for (let i = 0; i < 300 && !requestId; i += 1) {
      await sleep(50)
      requestId = (await server.request('GET', `/api/chat/pending?sessionId=${sessionId}`)).json.requests[0]?.requestId ?? ''
    }
    expect(requestId).not.toBe('')
    await server.request('POST', '/api/chat/tool-decision', { body: { requestId, approved: true } })
    const events = parseSse((await pending).text)
    const results = events.filter((e) => e.event === 'tool_result').map((e) => e.data)
    expect(results.map((r) => r.name)).toEqual(['skill_view', 'run_skill_script'])
    expect(results[0].ok).toBe(true)
    const run = JSON.parse(results[1].result)
    expect(run.stderr ?? '').not.toContain('Cannot find module')
    expect(run.ok, JSON.stringify(run).slice(0, 600)).toBe(true)
    expect(run.installedDependencies).toEqual([])
    const pdf = events.filter((e) => e.event === 'artifact').map((e) => e.data.artifact).find((a) => a.mime === 'application/pdf')
    expect(pdf, JSON.stringify(run.files)).toBeTruthy()
    const file = await server.request('GET', pdf.downloadUrl)
    expect(file.status).toBe(200)
    expect(file.text.startsWith('%PDF')).toBe(true)
  }, 90_000)
})
