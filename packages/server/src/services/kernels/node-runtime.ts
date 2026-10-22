import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

/**
 * 内核的 Node 运行时（契约“内核安装与运行”）：
 * - 不依赖本机 Node / npm：用 `process.execPath`（桌面端即 Electron 主程序）+ `ELECTRON_RUN_AS_NODE=1`
 *   执行随安装包附带的 npm（`<resources>/npm/bin/npm-cli.js`，路径经 LULUX_NPM_CLI 下发）；
 * - 为 npm 生命周期脚本（如 `postinstall: node install.cjs`）和 CLI 自己再启动的 `node` 子进程，
 *   在 `<kernelsRoot>/.node-shim/` 生成 `node`（POSIX）/ `node.cmd`（Windows）垫片并放到 PATH 最前面；
 * - 内核 CLI 的 JS 入口（.js/.cjs/.mjs，或 `#!/usr/bin/env node` 脚本）同样经 process.execPath 运行。
 */

export interface NpmInvocation {
  command: string
  /** 放在 npm 参数之前的参数（打包 npm 时为 npm-cli.js 路径） */
  prefixArgs: string[]
  /** 需要合并进子进程的环境变量 */
  env: NodeJS.ProcessEnv
  source: 'override' | 'bundled' | 'system'
  description: string
}

/** 当前进程是否是 Electron（以 ELECTRON_RUN_AS_NODE 方式运行的服务端也算） */
export function isElectronRuntime(): boolean {
  return Boolean(process.versions.electron)
}

/** 让子进程把 process.execPath 当作 Node 运行所需的环境 */
export function nodeRuntimeEnv(): NodeJS.ProcessEnv {
  return isElectronRuntime() ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** 打包的 npm-cli.js：LULUX_NPM_CLI（桌面端主进程下发） > 开发态仓库 node_modules 里的 npm */
export function bundledNpmCli(): string | null {
  const explicit = process.env.LULUX_NPM_CLI?.trim()
  if (explicit) return existsSync(explicit) ? explicit : null
  try {
    // 打包后的单文件 CJS 没有 import.meta.url，用 __filename；开发态（ESM）用 import.meta.url
    const base = typeof __filename === 'string' ? __filename : import.meta.url
    const require = createRequire(base)
    const pkg = require.resolve('npm/package.json')
    const cli = join(dirname(pkg), 'bin', 'npm-cli.js')
    return existsSync(cli) ? cli : null
  } catch {
    return null
  }
}

/**
 * 选择 npm：
 * 1. LULUX_KERNEL_NPM（测试 / 高级用户指定的可执行文件）；
 * 2. 打包的 npm-cli.js，经 process.execPath 运行（即使本机装了 npm 也优先用它，保证版本一致）；
 * 3. 本机 PATH 上的 npm。
 */
export function resolveNpm(): NpmInvocation {
  const override = process.env.LULUX_KERNEL_NPM?.trim()
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [override], env: nodeRuntimeEnv(), source: 'override', description: `${process.execPath} ${override}` }
    }
    return { command: override, prefixArgs: [], env: {}, source: 'override', description: override }
  }
  const cli = bundledNpmCli()
  if (cli) {
    return { command: process.execPath, prefixArgs: [cli], env: nodeRuntimeEnv(), source: 'bundled', description: `内置 npm（${cli}）` }
  }
  return { command: 'npm', prefixArgs: [], env: {}, source: 'system', description: '本机 npm' }
}

/** Windows node.cmd 垫片从这个环境变量读取 process.execPath（见 ensureNodeShim） */
export const EXEC_ENV = 'NODE_SHIM_EXECPATH'

/**
 * Windows node.cmd 垫片内容。cmd.exe 按系统 ANSI/OEM 代码页（中文 Windows 为 GBK）读取 .cmd 文件，而这里写的是 UTF-8：
 * 安装在“C:\Users\张三\…”这类含中文路径下时，写死的路径会变成乱码。所以优先从环境变量读取路径（环境变量是 UTF-16，
 * 不受代码页影响，由 withNodeShim 设置）；写死的路径只在纯 ASCII 时作为兜底。
 */
export function windowsNodeShim(exec: string): string {
  const fallback = /^[\x20-\x7e]+$/.test(exec) ? `if not defined ${EXEC_ENV} set "${EXEC_ENV}=${exec}"\r\n` : ''
  return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${fallback}"%${EXEC_ENV}%" %*\r\nexit /b %ERRORLEVEL%\r\n`
}

/** 生成 node 垫片目录：里面的 node / node.cmd 都转发到 process.execPath */
export function ensureNodeShim(root: string): string {
  const dir = join(root, '.node-shim')
  mkdirSync(dir, { recursive: true })
  const exec = process.execPath
  if (process.platform === 'win32') {
    // ELECTRON_RUN_AS_NODE 由父进程环境继承；%* 原样转发参数。
    write(join(dir, 'node.cmd'), windowsNodeShim(exec))
  } else {
    const quoted = `'${exec.replace(/'/g, `'\\''`)}'`
    write(join(dir, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`, 0o755)
  }
  return dir
}

function write(file: string, content: string, mode?: number): void {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return
  } catch {
    // 重新写
  }
  writeFileSync(file, content, mode === undefined ? undefined : { mode })
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** 在 env 的 PATH 最前面加上 node 垫片目录 */
export function withNodeShim(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, ...nodeRuntimeEnv() }
  const key = pathKey(next)
  const shim = ensureNodeShim(root)
  const current = next[key] ?? ''
  next[key] = current ? `${shim}${delimiter}${current}` : shim
  // npm 用它运行 lifecycle 脚本里的 node-gyp 等
  next.npm_node_execpath = process.execPath
  next[EXEC_ENV] = process.execPath
  return next
}

/** 入口是否应该用 Node 运行：JS 扩展名，或首行是 node 的 shebang */
export function isNodeScript(file: string): boolean {
  if (/\.(c|m)?js$/i.test(file)) return true
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(128)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, read).toString('utf8')
    return /^#!.*\bnode\b/.test(head)
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface PlatformPackageCheck {
  /** 声明了平台二进制 optionalDependencies */
  hasPlatformPackages: boolean
  /** 当前平台应有的包名（未声明或无匹配时为 null） */
  expected: string | null
  installed: boolean
}

interface OptionalPackageJson {
  name?: string
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

function matches(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true
  const negated = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1))
  if (negated.includes(value)) return false
  const positive = list.filter((item) => !item.startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

const PLATFORM_HINT = /(win32|darwin|linux|freebsd|android)[-_](x64|arm64|ia32|arm)/i

/**
 * 检查 codex / claude-code 这类“主包 + 平台二进制 optionalDependencies”的包是否装上了当前平台的那一个。
 * 判断依据：optionalDependency 名称或其 package.json 的 os/cpu。musl 变体只在 Linux musl 上需要。
 */
export function checkPlatformPackages(
  nodeModules: string,
  optionalDependencies: Record<string, string> | undefined,
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformPackageCheck {
  const names = Object.keys(optionalDependencies ?? {}).filter((name) => PLATFORM_HINT.test(name))
  if (names.length === 0) return { hasPlatformPackages: false, expected: null, installed: true }
  const isMusl = platform === 'linux' && isMuslLibc()
  for (const name of names) {
    const dir = join(nodeModules, ...name.split('/'))
    const pkgFile = join(dir, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as OptionalPackageJson
        if (matches(pkg.os, platform) && matches(pkg.cpu, arch)) return { hasPlatformPackages: true, expected: name, installed: true }
      } catch {
        // 继续
      }
    }
  }
  const expected =
    names.find((name) => {
      const m = PLATFORM_HINT.exec(name)
      if (!m || m[1]!.toLowerCase() !== platform || m[2]!.toLowerCase() !== arch) return false
      return /musl/i.test(name) === isMusl
    }) ??
    names.find((name) => {
      const m = PLATFORM_HINT.exec(name)
      return Boolean(m && m[1]!.toLowerCase() === platform && m[2]!.toLowerCase() === arch)
    }) ??
    null
  return { hasPlatformPackages: true, expected, installed: false }
}

function isMuslLibc(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    return !report?.header?.glibcVersionRuntime
  } catch {
    return false
  }
}
