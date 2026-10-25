import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 内核安装：随包 npm（经 process.execPath 运行 npm-cli.js）、node 垫片、可配置安装源与回退、平台二进制检查。
 */
let server: TestServer

beforeAll(async () => {
  server = await startTestServer({ LULUX_KERNEL_REGISTRY_FALLBACK: '' })
})

afterAll(async () => {
  await server.close()
})

afterEach(async () => {
  delete process.env.LULUX_KERNEL_NPM
  delete process.env.LULUX_NPM_CLI
  await server.request('PATCH', '/api/settings', { body: { kernelRegistry: '' } })
})

/**
 * 假 npm（JS，经 process.execPath 运行）：
 * - registry 含 FAIL_ON 时按 FAIL_CODE 失败；
 * - 否则把 `<pkg>` 装成一个带 bin 的包，并把环境里的 PATH 首项 / npm_node_execpath / 参数记录到 <prefix>/npm-call.json
 */
function fakeNpm(name: string, opts: { failOn?: string; failCode?: string; pkg: string; bin: string; version?: string }): string {
  const file = join(server.home, `${name}.js`)
  writeFileSync(
    file,
    `
const fs = require('fs'); const path = require('path')
const args = process.argv.slice(2)
const prefix = args[args.indexOf('--prefix') + 1]
const registry = args[args.indexOf('--registry') + 1]
console.log('npm http fetch GET 200 ' + registry + '/${opts.pkg}')
if (${JSON.stringify(opts.failOn ?? '')} && registry.includes(${JSON.stringify(opts.failOn ?? '')})) {
  console.error('npm error code ${opts.failCode ?? 'ETIMEDOUT'}')
  process.exit(1)
}
const dir = path.join(prefix, 'node_modules', ...'${opts.pkg}'.split('/'))
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '${opts.pkg}', version: '${opts.version ?? '1.2.3'}', bin: { ${opts.bin}: 'cli' } }))
fs.writeFileSync(path.join(dir, 'cli'), '#!/usr/bin/env node\\nconsole.log(1)\\n')
const calls = path.join(prefix, 'npm-calls.json')
const prev = fs.existsSync(calls) ? JSON.parse(fs.readFileSync(calls, 'utf8')) : []
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')
prev.push({ registry, pathHead: process.env[pathKey].split(path.delimiter)[0], npmNodeExecpath: process.env.npm_node_execpath || null, lulux: Object.keys(process.env).filter((k) => k.startsWith('LULUX_')) })
fs.writeFileSync(calls, JSON.stringify(prev))
console.log('added 1 package')
`,
  )
  chmodSync(file, 0o755)
  return file
}

async function waitKernel(id: string): Promise<any> {
  let kernel: any
  for (let i = 0; i < 100; i += 1) {
    kernel = (await server.request('GET', '/api/kernels')).json.find((k: { id: string }) => k.id === id)
    if (kernel.status !== 'installing' && kernel.status !== 'uninstalling') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return kernel
}

const logOf = async (id: string): Promise<string[]> => (await server.request('GET', `/api/kernels/${id}/log`)).json.lines

describe('安装源', () => {
  it('默认 npmmirror；网络类失败自动回退 npmjs 并成功', async () => {
    process.env.LULUX_KERNEL_NPM = fakeNpm('npm-fallback', { failOn: 'npmmirror', pkg: '@google/gemini-cli', bin: 'gemini' })
    expect((await server.request('POST', '/api/kernels/gemini-cli/install')).status).toBe(202)
    const kernel = await waitKernel('gemini-cli')
    expect(kernel).toMatchObject({ status: 'idle', installed: true, version: '1.2.3', error: null })
    const log = await logOf('gemini-cli')
    expect(log.some((l) => l.includes('--registry https://registry.npmmirror.com'))).toBe(true)
    expect(log.some((l) => l.includes('改用 https://registry.npmjs.org 重试'))).toBe(true)
    expect(log.some((l) => l.includes('安装完成') && l.includes('registry.npmjs.org'))).toBe(true)
    const calls = JSON.parse(readFileSync(join(server.home, 'kernels', 'gemini-cli', 'npm-calls.json'), 'utf8'))
    expect(calls.map((c: { registry: string }) => c.registry)).toEqual(['https://registry.npmjs.org'])
  })

  it('非网络错误（如 EACCES）不换源重试', async () => {
    process.env.LULUX_KERNEL_NPM = fakeNpm('npm-eacces', { failOn: 'registry', failCode: 'EACCES', pkg: '@qwen-code/qwen-code', bin: 'qwen' })
    await server.request('POST', '/api/kernels/qwen-code/install')
    const kernel = await waitKernel('qwen-code')
    expect(kernel.status).toBe('error')
    expect(kernel.error).toMatch(/npm 安装失败/)
    expect((await logOf('qwen-code')).some((l) => l.includes('重试'))).toBe(false)
  })

  it('设置 kernelRegistry 覆盖默认源；非法地址 400', async () => {
    expect((await server.request('PATCH', '/api/settings', { body: { kernelRegistry: 'ftp://x' } })).status).toBe(400)
    expect((await server.request('PATCH', '/api/settings', { body: { kernelRegistry: 'not a url' } })).status).toBe(400)
    const ok = await server.request('PATCH', '/api/settings', { body: { kernelRegistry: 'https://mirror.example.test/npm/' } })
    expect(ok.status).toBe(200)
    expect(ok.json.settings.kernelRegistry).toBe('https://mirror.example.test/npm')
    const schema = (await server.request('GET', '/api/settings/schema')).json as Array<{ key: string }>
    expect(schema.some((item) => item.key === 'kernelRegistry')).toBe(true)

    process.env.LULUX_KERNEL_NPM = fakeNpm('npm-custom', { pkg: '@qwen-code/qwen-code', bin: 'qwen', version: '2.0.0' })
    await server.request('POST', '/api/kernels/qwen-code/install')
    const kernel = await waitKernel('qwen-code')
    expect(kernel).toMatchObject({ status: 'idle', installed: true, version: '2.0.0' })
    expect((await logOf('qwen-code')).some((l) => l.includes('--registry https://mirror.example.test/npm'))).toBe(true)
  })
})

describe('随包 npm 与 node 垫片', () => {
  it('LULUX_NPM_CLI 指向 npm-cli.js 时经 process.execPath 运行；PATH 首项是 node 垫片；LULUX_* 不外泄', async () => {
    process.env.LULUX_NPM_CLI = fakeNpm('bundled-npm-cli', { pkg: '@openai/codex', bin: 'codex' })
    await server.request('POST', '/api/kernels/codex/install')
    const kernel = await waitKernel('codex')
    expect(kernel).toMatchObject({ status: 'idle', installed: true })
    expect((await logOf('codex')).some((l) => l.includes('内置 npm'))).toBe(true)
    const [call] = JSON.parse(readFileSync(join(server.home, 'kernels', 'codex', 'npm-calls.json'), 'utf8'))
    const shim = join(server.home, 'kernels', '.node-shim')
    expect(call.pathHead).toBe(shim)
    expect(call.npmNodeExecpath).toBe(process.execPath)
    expect(call.lulux).toEqual([])
    const shimFile = join(shim, process.platform === 'win32' ? 'node.cmd' : 'node')
    expect(readFileSync(shimFile, 'utf8')).toContain(process.execPath)
    if (process.platform !== 'win32') {
      const out = spawnSync(shimFile, ['-p', '40+2'], { encoding: 'utf8' })
      expect(out.stdout.trim()).toBe('42')
    }
  })

  it('LULUX_NPM_CLI 指向不存在的文件时回到仓库里的 npm / 本机 npm', async () => {
    process.env.LULUX_NPM_CLI = join(server.home, 'missing-npm-cli.js')
    const { resolveNpm } = await import('../src/services/kernels/node-runtime.js')
    expect(resolveNpm().source).not.toBe('override')
  })

  it('开发态 resolveNpm 找到仓库 node_modules 里的 npm 12，能实际执行', async () => {
    const { resolveNpm } = await import('../src/services/kernels/node-runtime.js')
    const npm = resolveNpm()
    expect(npm.source).toBe('bundled')
    const out = spawnSync(npm.command, [...npm.prefixArgs, '-v'], { env: { ...process.env, ...npm.env }, encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(Number(out.stdout.trim().split('.')[0])).toBeGreaterThanOrEqual(12)
  })
})

describe('node-runtime 单元', () => {
  it('isNodeScript：扩展名与 node shebang', async () => {
    const { isNodeScript } = await import('../src/services/kernels/node-runtime.js')
    const dir = join(server.home, 'scripts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a'), '#!/usr/bin/env node\nconsole.log(1)')
    writeFileSync(join(dir, 'b'), '#!/bin/sh\necho 1')
    writeFileSync(join(dir, 'c'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]))
    expect(isNodeScript(join(dir, 'x.mjs'))).toBe(true)
    expect(isNodeScript(join(dir, 'a'))).toBe(true)
    expect(isNodeScript(join(dir, 'b'))).toBe(false)
    expect(isNodeScript(join(dir, 'c'))).toBe(false)
    expect(isNodeScript(join(dir, 'missing'))).toBe(false)
  })

  it('checkPlatformPackages：识别缺失的平台二进制包', async () => {
    const { checkPlatformPackages } = await import('../src/services/kernels/node-runtime.js')
    const nm = join(server.home, 'nm')
    const optional = { '@x/cli-linux-x64': '1.0.0', '@x/cli-win32-x64': '1.0.0', '@x/cli-darwin-arm64': '1.0.0' }
    expect(checkPlatformPackages(nm, undefined)).toEqual({ hasPlatformPackages: false, expected: null, installed: true })
    expect(checkPlatformPackages(nm, optional, 'win32', 'x64')).toMatchObject({ installed: false, expected: '@x/cli-win32-x64' })
    mkdirSync(join(nm, '@x', 'cli-win32-x64'), { recursive: true })
    writeFileSync(join(nm, '@x', 'cli-win32-x64', 'package.json'), JSON.stringify({ name: '@x/cli-win32-x64', os: ['win32'], cpu: ['x64'] }))
    expect(checkPlatformPackages(nm, optional, 'win32', 'x64')).toMatchObject({ installed: true, expected: '@x/cli-win32-x64' })
    expect(checkPlatformPackages(nm, optional, 'darwin', 'arm64')).toMatchObject({ installed: false, expected: '@x/cli-darwin-arm64' })
    expect(existsSync(nm)).toBe(true)
  })
})
