import { spawn as crossSpawn } from 'cross-spawn'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { config } from '../../config.js'
import { AppError, conflict, notFound } from '../../errors.js'
import { fetchWithProxy } from '../http-client.js'
import { findKernel, KERNELS, type KernelDefinition } from './catalog.js'
import { checkPlatformPackages, resolveNpm, withNodeShim, isNodeScript } from './node-runtime.js'
import { kernelDir, kernelsRoot } from './paths.js'
import { kernelRegistries } from './registry.js'
import { kernelMode, resolveScopedProvider, type KernelMode } from './scoped.js'

export type KernelStatus = 'idle' | 'installing' | 'uninstalling' | 'error'

export interface Kernel {
  id: string
  name: string
  vendor: string
  npmPackage: string
  description: string
  /** 内核选择器里的一行说明（原版内核管理页文案） */
  tagline: string
  /** 原版内核头像（/agents/*.png）；null 表示客户端用内置的 svg 标志 */
  avatar: string | null
  sizeHint: string
  installed: boolean
  version: string | null
  latestVersion: string | null
  status: KernelStatus
  progress: number | null
  error: string | null
  /** global 模式下为 true（需要 CLI 自己登录）；scoped 模式为 false */
  requiresLogin: boolean
  loginHint: string
  /** 当前模式（契约“内核网关”）；内置内核为 null */
  mode: KernelMode | null
  /** 切换模式用的设置键（PATCH /api/settings）；内置内核为 null */
  modeSettingKey: string | null
  /** scoped 模式下默认会使用的 Provider/模型（会话可另选 Provider）；global 或未配置时为 null */
  scopedProvider: { id: string; name: string; model: string } | null
}

interface KernelState {
  status: KernelStatus
  progress: number | null
  error: string | null
  log: string[]
  latest: { version: string | null; checkedAt: number } | null
  latestPending: boolean
}

const LOG_LIMIT = 500
const LATEST_TTL_MS = 10 * 60_000

export const BUILTIN_KERNEL: Kernel = {
  id: 'builtin',
  name: 'LULUX',
  vendor: 'LULUX ETA',
  npmPackage: '',
  description: 'LULUX 自带运行时，直接调用设置中的模型 Provider',
  tagline: '内置 · 随软件更新，无需单独安装',
  avatar: '/icon.png',
  sizeHint: '已内置',
  installed: true,
  version: config.version,
  latestVersion: config.version,
  status: 'idle',
  progress: null,
  error: null,
  requiresLogin: false,
  loginHint: '',
  mode: null,
  modeSettingKey: null,
  scopedProvider: null,
}

export { kernelDir, kernelsRoot } from './paths.js'

function packageDir(def: KernelDefinition): string {
  return join(kernelDir(def.id), 'node_modules', ...def.npmPackage.split('/'))
}

interface PackageJson {
  version?: string
  bin?: string | Record<string, string>
}

function readPackage(def: KernelDefinition): PackageJson | null {
  const file = join(packageDir(def), 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson
  } catch {
    return null
  }
}

/**
 * 解析已安装内核的可执行入口：JS 入口（扩展名或 node shebang）用 process.execPath 运行
 * （桌面端即 Electron + ELECTRON_RUN_AS_NODE，用户机器无需 Node），其余（原生二进制）直接执行。
 */
export function resolveKernelBinary(def: KernelDefinition): { file: string; viaNode: boolean } | null {
  const pkg = readPackage(def)
  if (!pkg) return null
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[def.bin]
  if (!rel) return null
  const file = join(packageDir(def), rel)
  if (!existsSync(file)) return null
  if (def.id === 'grok') {
    const native = grokNativeBinary(def)
    if (native) return { file: native, viaNode: false }
  }
  return { file, viaNode: isNodeScript(file) }
}

/**
 * Grok Build 的 npm 包只带一个 node 启动器 + 平台包里 brotli 压缩的原生二进制。postinstall 在 Unix 上把它解压成
 * bin/grok-native；没解压时（Windows 永远不解压、npm 阻止了脚本）启动器会在 $GROK_HOME/bin 里解压——而 scoped
 * 模式每个会话一个 GROK_HOME，会每个会话解压一份 160 MB。所以 LULUX 自己解压一次到包目录，直接运行原生二进制。
 */
function grokNativeBinary(def: KernelDefinition): string | null {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const target = join(packageDir(def), 'bin', `grok-native${exe}`)
  if (existsSync(target)) return target
  const platformDir = join(kernelDir(def.id), 'node_modules', '@xai-official', `grok-${process.platform}-${process.arch}`, 'bin')
  const brotli = join(platformDir, `grok${exe}.br`)
  const plain = join(platformDir, `grok${exe}`)
  const tmp = `${target}.tmp.${process.pid}`
  try {
    if (existsSync(brotli)) writeFileSync(tmp, brotliDecompressSync(readFileSync(brotli)))
    else if (existsSync(plain)) copyFileSync(plain, tmp)
    else return null
    if (process.platform !== 'win32') chmodSync(tmp, 0o755)
    renameSync(tmp, target)
    return target
  } catch {
    rmSync(tmp, { force: true })
    return null
  }
}

/** 只支持 ">=X.Y.Z" 这种最低版本要求（KernelDefinition.versionRange） */
export function satisfiesMinVersion(version: string, range: string | undefined): boolean {
  const min = range?.match(/^>=\s*(\d+)\.(\d+)\.(\d+)/)
  if (!min) return true
  const got = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!got) return false
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(got[i])
    const b = Number(min[i])
    if (a !== b) return a > b
  }
  return true
}

/** 网络/源相关的 npm 失败（只看 npm 的错误行）：换源重试有意义 */
const REGISTRY_FAILURE =
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|E404|E5\d\d|E429|ETARGET|EINTEGRITY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED)\b|socket hang up|network request|request to https?:\/\/\S+ failed/i

function isRegistryFailure(output: string): boolean {
  const errors = output.split(/\r?\n/).filter((line) => /npm (error|ERR!)/.test(line))
  return errors.some((line) => REGISTRY_FAILURE.test(line))
}

class KernelService {
  private states = new Map<string, KernelState>()

  private state(id: string): KernelState {
    let state = this.states.get(id)
    if (!state) {
      state = { status: 'idle', progress: null, error: null, log: [], latest: null, latestPending: false }
      this.states.set(id, state)
    }
    return state
  }

  private append(id: string, text: string): void {
    const state = this.state(id)
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd()
      if (!line) continue
      state.log.push(line)
    }
    if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT)
  }

  installedVersion(id: string): string | null {
    const def = findKernel(id)
    if (!def) return null
    return readPackage(def)?.version ?? null
  }

  isInstalled(id: string): boolean {
    const def = findKernel(id)
    return Boolean(def && resolveKernelBinary(def))
  }

  /** 内核是否需要登录：null 表示无法判断（交给运行时报错） */
  loginState(id: string): boolean | null {
    const def = findKernel(id)
    if (!def) return null
    return def.detectLogin(process.env)
  }

  private refreshLatest(def: KernelDefinition): void {
    const state = this.state(def.id)
    if (state.latestPending) return
    if (state.latest && Date.now() - state.latest.checkedAt < LATEST_TTL_MS) return
    if (process.env.LULUX_KERNEL_OFFLINE === '1') return
    state.latestPending = true
    const query = async (): Promise<string | null> => {
      for (const registry of kernelRegistries()) {
        try {
          const url = `${registry}/${def.npmPackage.replace('/', '%2F')}/latest`
          const response = await fetchWithProxy(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
          if (!response.ok) continue
          const body = (await response.json()) as { version?: string }
          // 镜像上的版本低于内核要求时（Grok 在 npmmirror 停在 0.1.x）不算数，看下一个源
          if (typeof body.version === 'string' && satisfiesMinVersion(body.version, def.versionRange)) return body.version
        } catch {
          // 换下一个源
        }
      }
      return state.latest?.version ?? null
    }
    void query()
      .then((version) => {
        state.latest = { version, checkedAt: Date.now() }
      })
      .finally(() => {
        state.latestPending = false
      })
  }

  describe(def: KernelDefinition): Kernel {
    const state = this.state(def.id)
    this.refreshLatest(def)
    const installed = Boolean(resolveKernelBinary(def))
    const mode = kernelMode(def.id)
    const provider = mode === 'scoped' ? resolveScopedProvider() : null
    return {
      id: def.id,
      name: def.name,
      vendor: def.vendor,
      npmPackage: def.npmPackage,
      description: def.description,
      tagline: def.tagline,
      avatar: def.avatar,
      sizeHint: def.sizeHint,
      installed,
      version: installed ? (readPackage(def)?.version ?? null) : null,
      latestVersion: state.latest?.version ?? null,
      status: state.status,
      progress: state.progress,
      error: state.error,
      requiresLogin: mode === 'global',
      loginHint: def.loginHint,
      mode,
      modeSettingKey: def.modeSettingKey,
      scopedProvider: provider ? { id: provider.id, name: provider.name, model: provider.model } : null,
    }
  }

  list(): Kernel[] {
    return [BUILTIN_KERNEL, ...KERNELS.map((def) => this.describe(def))]
  }

  get(id: string): Kernel {
    if (id === 'builtin') return BUILTIN_KERNEL
    const def = findKernel(id)
    if (!def) throw notFound('内核')
    return this.describe(def)
  }

  log(id: string): string[] {
    if (id !== 'builtin' && !findKernel(id)) throw notFound('内核')
    return [...this.state(id).log]
  }

  private requireMutable(id: string): KernelDefinition {
    if (id === 'builtin') throw new AppError(400, 'KERNEL_BUILTIN', '内置内核无需安装或卸载')
    const def = findKernel(id)
    if (!def) throw notFound('内核')
    const state = this.state(id)
    if (state.status === 'installing' || state.status === 'uninstalling') {
      throw conflict('该内核正在处理中，请稍后', 'KERNEL_BUSY')
    }
    return def
  }

  install(id: string): Kernel {
    const def = this.requireMutable(id)
    this.runNpmInstall(def)
    return this.describe(def)
  }

  update(id: string): Kernel {
    const def = this.requireMutable(id)
    if (!resolveKernelBinary(def)) throw new AppError(409, 'KERNEL_NOT_INSTALLED', '内核尚未安装')
    this.runNpmInstall(def)
    return this.describe(def)
  }

  uninstall(id: string): Kernel {
    const def = this.requireMutable(id)
    const state = this.state(id)
    state.status = 'uninstalling'
    state.progress = 0
    state.error = null
    this.append(id, `[lulux] 卸载 ${def.npmPackage}`)
    // 异步执行，接口立即返回 202
    setTimeout(() => {
      try {
        rmSync(join(kernelDir(id), 'node_modules'), { recursive: true, force: true })
        rmSync(join(kernelDir(id), 'package.json'), { force: true })
        rmSync(join(kernelDir(id), 'package-lock.json'), { force: true })
        state.status = 'idle'
        state.progress = null
        this.append(id, '[lulux] 已卸载')
      } catch (error) {
        state.status = 'error'
        state.progress = null
        state.error = `卸载失败：${error instanceof Error ? error.message : String(error)}`
        this.append(id, state.error)
      }
    }, 0)
    return this.describe(def)
  }

  /**
   * npm 12 起默认阻止依赖的安装脚本（allowScripts），而 Claude Code 等靠 postinstall 把原生二进制放到位，
   * 被阻止时只剩占位文件、运行报 “native binary not installed”。这里在内核目录的 package.json 里
   * 只为该内核包本身放行（npm 10/11 会忽略这个字段）。
   */
  private allowKernelScripts(def: KernelDefinition, dir: string): void {
    const file = join(dir, 'package.json')
    let pkg: Record<string, unknown> = {}
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed as Record<string, unknown>
      } catch {
        pkg = {}
      }
    }
    const allow = pkg.allowScripts && typeof pkg.allowScripts === 'object' ? (pkg.allowScripts as Record<string, unknown>) : {}
    if (allow[def.npmPackage] === true) return
    pkg.allowScripts = { ...allow, [def.npmPackage]: true }
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  private runNpmInstall(def: KernelDefinition): void {
    const state = this.state(def.id)
    const dir = kernelDir(def.id)
    mkdirSync(dir, { recursive: true })
    try {
      this.allowKernelScripts(def, dir)
    } catch (error) {
      this.append(def.id, `[lulux] 无法写入 allowScripts：${error instanceof Error ? error.message : String(error)}`)
    }
    state.status = 'installing'
    state.progress = 5
    state.error = null
    state.latest = null

    const registries = kernelRegistries()
    const npm = resolveNpm()
    this.append(def.id, `[lulux] 使用 ${npm.description}`)
    void this.installFrom(def, npm, registries, 0)
  }

  /** 依次尝试安装源：首选源（默认 npmmirror）因网络/源问题失败时回退到下一个（默认 npmjs） */
  private async installFrom(
    def: KernelDefinition,
    npm: ReturnType<typeof resolveNpm>,
    registries: string[],
    index: number,
  ): Promise<void> {
    const state = this.state(def.id)
    const registry = registries[index]!
    const result = await this.spawnNpm(def, npm, registry)
    if (state.status !== 'installing') return
    if (result.code === 0 && resolveKernelBinary(def)) {
      const platform = this.platformCheck(def)
      if (platform) {
        this.fail(def, platform)
        return
      }
      state.status = 'idle'
      state.progress = null
      state.error = null
      this.append(def.id, `[lulux] 安装完成：${def.npmPackage}@${readPackage(def)?.version ?? '?'}（源 ${registry}）`)
      return
    }
    const canRetry =
      result.spawnError === null &&
      result.code !== 0 &&
      index + 1 < registries.length &&
      isRegistryFailure(result.output)
    if (canRetry) {
      this.append(def.id, `[lulux] 从 ${registry} 安装失败，改用 ${registries[index + 1]} 重试`)
      state.progress = 5
      await this.installFrom(def, npm, registries, index + 1)
      return
    }
    if (result.spawnError) {
      this.fail(
        def,
        result.spawnError.code === 'ENOENT'
          ? npm.source === 'system'
            ? '未找到 npm。安装第三方内核需要 Node.js 22+（含 npm），请先安装 Node.js 后重试'
            : `未找到 npm（${npm.description}）`
          : `无法启动 npm：${result.spawnError.message}`,
      )
      return
    }
    const tail = state.log.slice(-3).join(' | ')
    this.fail(
      def,
      result.code === 0
        ? '安装完成但未找到可执行文件（可能当前平台不受支持）'
        : `npm 安装失败（退出码 ${result.code ?? 'unknown'}）${tail ? `：${tail}` : ''}`,
    )
  }

  /** codex / claude-code 这类“主包 + 平台二进制”的包：确认当前平台的二进制包确实装上了 */
  private platformCheck(def: KernelDefinition): string | null {
    const file = join(packageDir(def), 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { optionalDependencies?: Record<string, string> }
      const check = checkPlatformPackages(join(kernelDir(def.id), 'node_modules'), pkg.optionalDependencies)
      if (check.installed) return null
      return check.expected
        ? `安装完成，但缺少当前平台（${process.platform}-${process.arch}）的二进制包 ${check.expected}，请重试安装或切换安装源`
        : `${def.name} 不支持当前平台（${process.platform}-${process.arch}）`
    } catch {
      return null
    }
  }

  private fail(def: KernelDefinition, message: string): void {
    const state = this.state(def.id)
    state.status = 'error'
    state.progress = null
    state.error = message
    this.append(def.id, `[lulux] ${message}`)
  }

  private spawnNpm(
    def: KernelDefinition,
    npm: ReturnType<typeof resolveNpm>,
    registry: string,
  ): Promise<{ code: number | null; output: string; spawnError: NodeJS.ErrnoException | null }> {
    const state = this.state(def.id)
    const dir = kernelDir(def.id)
    const args = [
      'install',
      '--prefix',
      dir,
      '--registry',
      registry,
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--loglevel',
      'http',
      `${def.npmPackage}@${def.versionRange ?? 'latest'}`,
    ]
    this.append(def.id, `[lulux] npm ${args.join(' ')}`)

    // npm 本身需要完整环境（PATH、缓存目录、代理）；去掉 LULUX 的内部变量。
    // node 垫片放到 PATH 最前面：npm 生命周期脚本里的 `node xxx` 也走 process.execPath（用户机器无需装 Node）
    let env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('LULUX_')) delete env[key]
    env = withNodeShim({ ...env, ...npm.env }, kernelsRoot())
    const proxy = process.env.LULUX_KERNEL_PROXY
    if (proxy) {
      env.npm_config_proxy = proxy
      env.npm_config_https_proxy = proxy
    }

    return new Promise((resolve) => {
      let output = ''
      let settled = false
      const finish = (code: number | null, spawnError: NodeJS.ErrnoException | null): void => {
        if (settled) return
        settled = true
        resolve({ code, output, spawnError })
      }
      let child: ReturnType<typeof crossSpawn>
      try {
        child = crossSpawn(npm.command, [...npm.prefixArgs, ...args], {
          cwd: dir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        finish(null, error as NodeJS.ErrnoException)
        return
      }
      let requests = 0
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString()
        output = `${output}${text}`.slice(-20_000)
        this.append(def.id, text)
        // npm http 日志每个请求一行，用来粗略推进进度（最多到 90%）
        requests += (text.match(/http fetch/g) ?? []).length
        state.progress = Math.min(90, 5 + requests * 5)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (error: NodeJS.ErrnoException) => finish(null, error))
      child.on('close', (code) => finish(code, null))
    })
  }
}

export const kernelService = new KernelService()
