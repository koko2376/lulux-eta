import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/** 删除会话时清理 <dataDir>/workspace/<sessionId> 与 <kernels>/<id>/home/<sessionId> */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server.close()
})

async function newSession(): Promise<string> {
  const res = await server.request('POST', '/api/sessions', { body: { agentIds: ['builtin'] } })
  expect(res.status).toBeLessThan(300)
  return res.json.session.id as string
}

/** 模拟内置工具写过工作区、两个 scoped 内核为会话建过 HOME */
function seedFiles(sessionId: string): string[] {
  const dirs = [
    join(server.home, 'workspace', sessionId),
    join(server.home, 'kernels', 'claude-code', 'home', sessionId),
    join(server.home, 'kernels', 'codex', 'home', sessionId),
  ]
  for (const dir of dirs) {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'file.txt'), 'x')
  }
  return dirs
}

describe('删除会话清理磁盘文件', () => {
  it('DELETE /api/sessions/:id 删除该会话的工作区与内核 HOME，不动其他会话与内核安装', async () => {
    const target = await newSession()
    const other = await newSession()
    const targetDirs = seedFiles(target)
    const otherDirs = seedFiles(other)
    const installed = join(server.home, 'kernels', 'codex', 'node_modules', 'pkg.json')
    mkdirSync(join(server.home, 'kernels', 'codex', 'node_modules'), { recursive: true })
    writeFileSync(installed, '{}')

    const res = await server.request('DELETE', `/api/sessions/${target}`)
    expect(res.status).toBe(204)

    for (const dir of targetDirs) expect(existsSync(dir), dir).toBe(false)
    for (const dir of otherDirs) expect(existsSync(dir), dir).toBe(true)
    expect(existsSync(installed)).toBe(true)
    expect(existsSync(join(server.home, 'kernels', 'codex', 'home'))).toBe(true)
  })

  it('会话不存在时 404，且不删除任何目录', async () => {
    const dir = join(server.home, 'workspace', 'ghost-session')
    mkdirSync(dir, { recursive: true })
    const res = await server.request('DELETE', '/api/sessions/ghost-session')
    expect(res.status).toBe(404)
    expect(existsSync(dir)).toBe(true)
  })

  it('没有任何目录时删除照常成功', async () => {
    const id = await newSession()
    expect((await server.request('DELETE', `/api/sessions/${id}`)).status).toBe(204)
  })

  it('清空全部会话时逐个清理目录', async () => {
    const a = await newSession()
    const b = await newSession()
    const dirs = [...seedFiles(a), ...seedFiles(b)]
    const res = await server.request('DELETE', '/api/data/sessions')
    expect(res.status, res.text).toBeLessThan(300)
    for (const dir of dirs) expect(existsSync(dir), dir).toBe(false)
  })

  it('removeSessionFiles 拒绝非法 id（不会越出数据目录）', async () => {
    const { removeSessionFiles } = await import('../src/services/session-files.js')
    const outside = join(server.home, 'keep')
    mkdirSync(outside, { recursive: true })
    expect(removeSessionFiles('../keep')).toEqual([])
    expect(removeSessionFiles('..')).toEqual([])
    expect(removeSessionFiles('')).toEqual([])
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(join(server.home, 'workspace'))).toBe(true)
  })
})
