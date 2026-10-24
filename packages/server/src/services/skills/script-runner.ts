import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, extname, join, relative, sep } from 'node:path'
import { spawn as crossSpawn } from 'cross-spawn'
import { killTree } from '../../utils/kill-tree.js'
import { kernelRegistries } from '../kernels/registry.js'
import { nodeRuntimeEnv, resolveNpm, withNodeShim } from '../kernels/node-runtime.js'
import { sessionWorkspace } from '../tools/workspace.js'
import { ToolError } from '../tools/tool-error.js'
import { resolveSkillFile, skillDir, skillRuntimeDir } from './paths.js'
import type { Skill } from './skill-service.js'

/**
 * run_skill_script 的执行器：
 * - 只运行已安装 skill 的 scripts/ 下文件（路径校验同 skill_view，拒绝穿越与符号链接）；
 * - .js/.cjs/.mjs 用 process.execPath（桌面端 = Electron 自带 Node，ELECTRON_RUN_AS_NODE=1）；.py 用系统 python3（没有则报错）；
 * - cwd = 会话工作区沙箱 <dataDir>/workspace/<sessionId>；环境变量白名单（不继承任何密钥/代理/LULUX_* 变量）；
 * - 超时（默认 60 秒，最多 300 秒）后杀掉整个进程组；stdout/stderr 各最多保留 64 KB；
 * - skill 声明的 npm 依赖首次运行时装到 <dataDir>/skill-runtime（随包 npm，与内核安装同源与回退），
 *   NODE_PATH 指向它和服务端自带的 node_modules（含 pdfkit）。
 */
export const SCRIPT_DEFAULT_TIMEOUT_S = 60
export const SCRIPT_MAX_TIMEOUT_S = 300
export const SCRIPT_OUTPUT_LIMIT = 64 * 1024
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000
const SNAPSHOT_LIMIT = 3000

const ENV_ALLOW = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
])

export interface ScriptRequest {
  skill: Skill
  script: string
  args: string[]
  stdin?: string
  timeoutSeconds?: number
  sessionId: string
  signal: AbortSignal
}

export interface ScriptFile {
  path: string
  size: number
  created: boolean
}

export interface ScriptResult {
  script: string
  interpreter: 'node' | 'python'
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  files: ScriptFile[]
  installed: string[]
}

let pythonCache: { command: string; args: string[] } | null | undefined

/** 系统 python3：python3 → python（需是 3.x）→ Windows 的 py -3 */
export function findPython(): { command: string; args: string[] } | null {
  if (pythonCache !== undefined) return pythonCache
  const explicit = process.env.LULUX_PYTHON?.trim()
  const candidates: Array<{ command: string; args: string[] }> = explicit
    ? [{ command: explicit, args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }, { command: 'python3', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
  pythonCache = null
  for (const candidate of candidates) {
    try {
      const out = spawnSync(candidate.command, [...candidate.args, '--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      const text = `${out.stdout ?? ''}${out.stderr ?? ''}`
      if (out.status === 0 && /Python 3\./.test(text)) {
        pythonCache = candidate
        break
      }
    } catch {
      // 下一个
    }
  }
  return pythonCache
}

export function resetPythonCacheForTests(): void {
  pythonCache = undefined
}

/** 服务端自带的 node_modules（含 pdfkit）：脚本可直接 require */
/** 服务端可能自带、技能脚本常用的包（pdfkit 是服务端依赖；其余按需装到 skill-runtime，若服务端恰好带了也复用） */
export const SERVER_SCRIPT_PACKAGES = ['pdfkit', 'docx', 'exceljs', 'pptxgenjs', 'pdf-parse']

/** 从模块入口路径向上找到包所在的 node_modules 目录（支持 @scope/name） */
export function nodeModulesOf(entry: string, name: string): string | null {
  const segments = name.split('/').length
  let dir = dirname(entry)
  for (let i = 0; i < 40; i += 1) {
    let root = dir
    for (let k = 0; k < segments; k += 1) root = dirname(root)
    if (basename(root) === 'node_modules' && relative(root, dir).split(sep).join('/') === name) return root
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 服务端自带依赖所在的 node_modules（可能多个，去重）。
 * 不能用 `require.resolve('<pkg>/package.json')`：pdfkit 等包的 exports 不导出 package.json（ERR_PACKAGE_PATH_NOT_EXPORTED）。
 * 先解析包本身的入口再向上找 node_modules；入口也解析不了时，按 require.resolve.paths 的候选目录找 `<dir>/<pkg>/package.json`。
 * 开发态（tsx/ESM）用 import.meta.url，打包后的单文件 CJS（resources/server/index.cjs + resources/server/node_modules）用 __filename。
 */
export function serverNodeModulesDirs(base?: string): string[] {
  const from = base ?? (typeof __filename === 'string' ? __filename : import.meta.url)
  let req: NodeRequire
  try {
    req = createRequire(from)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of SERVER_SCRIPT_PACKAGES) {
    let found: string | null = null
    try {
      found = nodeModulesOf(req.resolve(name), name)
    } catch {
      found = null
    }
    if (!found) {
      for (const candidate of req.resolve.paths(name) ?? []) {
        if (existsSync(join(candidate, ...name.split('/'), 'package.json'))) {
          found = candidate
          break
        }
      }
    }
    if (found && !dirs.includes(found)) dirs.push(found)
  }
  return dirs
}

function packageName(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.startsWith('@')) {
    const at = trimmed.indexOf('@', 1)
    return at > 0 ? trimmed.slice(0, at) : trimmed
  }
  const at = trimmed.indexOf('@')
  return at > 0 ? trimmed.slice(0, at) : trimmed
}

const NPM_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-zA-Z0-9.^~<>=*| -]+)?$/

export function missingNpmPackages(specs: string[]): string[] {
  const nodeModules = join(skillRuntimeDir(), 'node_modules')
  const server = serverNodeModulesDirs()
  return specs.filter((spec) => {
    const name = packageName(spec)
    if (existsSync(join(nodeModules, ...name.split('/'), 'package.json'))) return false
    if (server.some((dir) => existsSync(join(dir, ...name.split('/'), 'package.json')))) return false
    return true
  })
}

async function installNpm(specs: string[], signal: AbortSignal): Promise<void> {
  for (const spec of specs) {
    if (!NPM_SPEC_RE.test(spec)) throw new ToolError(`skill 声明的 npm 依赖不合法：${spec}`)
  }
  const dir = skillRuntimeDir()
  mkdirSync(dir, { recursive: true })
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) writeFileSync(pkgFile, `${JSON.stringify({ name: 'lulux-skill-runtime', private: true, version: '0.0.0' }, null, 2)}\n`)
  const npm = resolveNpm()
  let lastError = ''
  for (const registry of kernelRegistries()) {
    const args = [...npm.prefixArgs, 'install', ...specs, '--prefix', dir, '--registry', registry, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel', 'error']
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      let output = ''
      const child = crossSpawn(npm.command, args, {
        cwd: dir,
        env: withNodeShim({ ...process.env, ...npm.env }, dir),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const onAbort = (): void => {
        killTree(child)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => killTree(child), NPM_INSTALL_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => (output = `${output}${chunk.toString()}`.slice(-4000)))
      child.stderr?.on('data', (chunk: Buffer) => (output = `${output}${chunk.toString()}`.slice(-4000)))
      child.on('error', (error) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ code: null, output: error.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve({ code, output })
      })
    })
    if (signal.aborted) throw new ToolError('已取消')
    if (result.code === 0 && missingNpmPackages(specs).length === 0) return
    lastError = result.output.trim().slice(-800)
  }
  throw new ToolError(`安装脚本依赖失败（${specs.join(' ')}）：${lastError || '未知错误'}。请检查网络或在设置里更换 npm 源（kernelRegistry）。`)
}

function snapshot(root: string): Map<string, { size: number; mtimeMs: number }> {
  const map = new Map<string, { size: number; mtimeMs: number }>()
  const walk = (dir: string): void => {
    if (map.size >= SNAPSHOT_LIMIT) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (map.size >= SNAPSHOT_LIMIT) return
      if (entry.name === '.tmp' || entry.name === '.cache' || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) {
        try {
          const stat = statSync(abs)
          map.set(relative(root, abs).split(sep).join('/'), { size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // 忽略
        }
      }
    }
  }
  walk(root)
  return map
}

function scriptEnv(skill: Skill, cwd: string, interpreter: 'node' | 'python'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_ALLOW.has(key.toUpperCase()) && value !== undefined) env[key] = value
  }
  const tmp = join(cwd, '.tmp')
  mkdirSync(tmp, { recursive: true })
  Object.assign(env, {
    HOME: tmp,
    USERPROFILE: tmp,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    NO_COLOR: '1',
    LULUX_SKILL_NAME: skill.name,
    LULUX_SKILL_DIR: skillDir(skill.name),
    LULUX_WORKSPACE: cwd,
  })
  if (interpreter === 'node') {
    Object.assign(env, nodeRuntimeEnv())
    const paths = [join(skillRuntimeDir(), 'node_modules'), ...serverNodeModulesDirs()]
    env.NODE_PATH = paths.join(delimiter)
    env.NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
  } else {
    Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' })
  }
  return env
}

class Capture {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  push(chunk: Buffer): void {
    if (this.size >= SCRIPT_OUTPUT_LIMIT) {
      this.truncated = true
      return
    }
    const room = SCRIPT_OUTPUT_LIMIT - this.size
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (chunk.length > room) this.truncated = true
    this.chunks.push(part)
    this.size += part.length
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** 解析脚本路径：接受 “scripts/x.js” 或 “x.js”；必须位于 scripts/ 下 */
export function resolveScript(skill: Skill, script: string): { abs: string; rel: string; interpreter: 'node' | 'python' } {
  const input = script.replace(/\\/g, '/').replace(/^\.\//, '')
  const rel = input.startsWith('scripts/') ? input : `scripts/${input}`
  const resolved = resolveSkillFile(skill.name, rel)
  if (!resolved.rel.startsWith('scripts/')) throw new ToolError('只能运行 skill 的 scripts/ 目录下的脚本')
  const ext = extname(resolved.rel).toLowerCase()
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return { ...resolved, interpreter: 'node' }
  if (ext === '.py') return { ...resolved, interpreter: 'python' }
  throw new ToolError(`不支持的脚本类型 ${ext || '（无扩展名）'}：只支持 Node（.js/.cjs/.mjs）与 Python（.py）`)
}

export async function runSkillScript(request: ScriptRequest): Promise<ScriptResult> {
  const { skill, sessionId, signal } = request
  const target = resolveScript(skill, request.script)
  // 规范化真实路径：子进程看到的 cwd 是解析过符号链接的（macOS 的 /var → /private/var），LULUX_WORKSPACE 必须与之一致
  const cwd = realpathSync(sessionWorkspace(sessionId))
  const timeoutS = Math.min(SCRIPT_MAX_TIMEOUT_S, Math.max(1, Math.floor(request.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT_S)))

  let installed: string[] = []
  let command: string
  let args: string[]
  if (target.interpreter === 'node') {
    const missing = missingNpmPackages(skill.requires.npm)
    if (missing.length > 0) {
      await installNpm(missing, signal)
      installed = missing
    }
    command = process.execPath
    args = [target.abs, ...request.args]
  } else {
    const python = findPython()
    if (!python) throw new ToolError('没有找到 Python 3：这个脚本需要本机安装 python3（Windows 可从 python.org 或 Microsoft Store 安装，并勾选“添加到 PATH”）。')
    command = python.command
    args = [...python.args, target.abs, ...request.args]
  }
  if (request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new ToolError('脚本参数不合法')

  const before = snapshot(cwd)
  const started = Date.now()
  const env = scriptEnv(skill, cwd, target.interpreter)
  const stdout = new Capture()
  const stderr = new Capture()
  let timedOut = false
  let aborted = false

  const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    let child
    try {
      child = nodeSpawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(new ToolError(`无法启动脚本：${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const kill = (): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutS * 1000)
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new ToolError(`无法启动脚本：${error.message}`))
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, signal: sig })
    })
    child.stdin.on('error', () => undefined)
    if (request.stdin) child.stdin.write(request.stdin)
    child.stdin.end()
  })

  const after = snapshot(cwd)
  const files: ScriptFile[] = []
  for (const [path, info] of after) {
    const old = before.get(path)
    if (!old || old.size !== info.size || old.mtimeMs !== info.mtimeMs) files.push({ path, size: info.size, created: !old })
  }
  return {
    script: target.rel,
    interpreter: target.interpreter,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut,
    aborted,
    durationMs: Date.now() - started,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    files: files.slice(0, 50),
    installed,
  }
}

/** 读取产物（下载路由用） */
export function readWorkspaceBinary(abs: string): Buffer {
  return readFileSync(abs)
}
