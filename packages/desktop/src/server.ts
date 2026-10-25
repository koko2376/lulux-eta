import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { app, safeStorage } from 'electron'

export interface LocalServer {
  url: string
  origin: string
  port: number
  /** 字段加密主密钥的保管文件存在但这次解不开：服务以“密钥只读”方式运行（不能保存新的密钥） */
  masterKeyLocked: boolean
  /** 主进程主动通知服务进程（docs/computer-use.md 的 lulux:computer-event，无 id） */
  sendComputerEvent(event: { event: string; reason: string }): void
  stop(): Promise<void>
}

/** 服务进程请求原生确认时的命令描述（env 只有键名） */
export interface McpConfirmRequest {
  name: string
  command: string
  args: string[]
  env: string[]
}

/** 服务进程经 IPC 请求 Agent 操作内置浏览器（docs/browser-use.md） */
export interface BrowserCommandMessage {
  action?: string
  [key: string]: unknown
}

/** 主进程执行 browser 命令的最小接口（BrowserAgent 实现） */
export interface BrowserCommandRunner {
  execute(cmd: unknown): Promise<unknown>
}

/** 服务进程经 IPC 请求 Agent 操作本机桌面（docs/computer-use.md） */
export interface ComputerCommandMessage {
  action?: string
  [key: string]: unknown
}

/** 主进程执行 computer 命令的最小接口（ComputerAgent 实现） */
export interface ComputerCommandRunner {
  execute(cmd: unknown): Promise<unknown>
}

interface StartOptions {
  /** 每次启动生成的 API token，经 LULUX_API_TOKEN 交给服务 */
  token: string
  /** 服务进程意外退出时回调，用于提示用户 */
  onUnexpectedExit?: (message: string) => void
  /** 服务端请求确认 MCP 命令；返回是否允许 */
  confirmMcp?: (request: McpConfirmRequest) => Promise<boolean>
  /** 服务端请求 Agent 操作内置浏览器；没有（或窗口不存在）时返回 NO_WINDOW */
  browserAgent?: BrowserCommandRunner
  /** 服务端请求 Agent 操作本机桌面（docs/computer-use.md）；没有时返回 NATIVE_UNAVAILABLE */
  computerAgent?: ComputerCommandRunner
  /** 优先使用的端口（自动重启时沿用原端口，界面不必换地址）；被占用时依次试后面几个固定端口 */
  preferredPort?: number
}

/** 首选端口被占用时，依次再试的固定端口个数（P+1 … P+N），都不行才交给系统分配 */
export const PORT_FALLBACK_SPAN = 9

/**
 * 按固定顺序挑端口：preferred、preferred+1 … preferred+span，都被占用 / 被系统保留时才用系统分配的端口。
 * 固定顺序让页面 origin 尽量稳定（系统分配的临时端口每次都不同）。probe 可注入，便于测试。
 */
export async function pickPort(
  preferred: number | undefined,
  probe: (port: number) => Promise<number> = freePort,
  span = PORT_FALLBACK_SPAN,
): Promise<number> {
  if (preferred && Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535) {
    for (let port = preferred; port <= Math.min(65535, preferred + span); port += 1) {
      try {
        return await probe(port)
      } catch {
        // 被占用 / 被保留（EACCES）：试下一个
      }
    }
  }
  return probe(0)
}

export function generateApiToken(): string {
  return randomBytes(32).toString('hex')
}

/** 让系统分配一个空闲端口（或检查指定端口是否可用），避免固定端口被占用 */
function freePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('无法分配本地端口'))
      })
    })
  })
}

/**
 * 开发态直接用系统 node 运行 tsc 产物；打包后由 Electron 自己充当 Node
 * （ELECTRON_RUN_AS_NODE），运行 esbuild 打好的单文件服务端。
 */
function serverEntry(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'server', 'index.cjs')
    : join(__dirname, '..', '..', 'server', 'dist', 'index.js')
}

/** 打包时随附的 npm（electron-builder extraResources → <resources>/npm） */
function bundledNpmCli(): string | null {
  const cli = join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js')
  return existsSync(cli) ? cli : null
}

function clientDist(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'client')
    : join(__dirname, '..', '..', 'client', 'dist')
}

/** 与服务端 config.ts 的规则保持一致：显式 LULUX_ETA_HOME > 打包默认 > ~/.lulux-eta */
export function resolveDataHome(): string {
  const custom = process.env.LULUX_ETA_HOME
  if (custom) return custom
  if (app.isPackaged) {
    // 免安装版把数据放在 exe 同级目录，用户整包拷到哪个盘，数据就在哪个盘
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    return portableDir ? join(portableDir, 'LULUX ETA Data') : join(app.getPath('userData'), 'data')
  }
  return join(homedir(), '.lulux-eta')
}

/** 主进程可注入的安全存储（便于测试） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * 主密钥加载结果：
 * - key：解出（或首次生成）的主密钥；
 * - locked：master.key.safe 存在但这次解不开（钥匙串拒绝、密钥环尚未解锁、换了系统账户）。
 *   这时绝不生成新的明文 master.key 顶替，原文件保留，服务以“密钥只读”方式运行，下次启动再试；
 * - 两者都没有：系统本来就没有安全存储且从没用过它，交给服务端使用 <dataDir>/master.key（0600）。
 */
export interface MasterKeyResult {
  key: string | null
  locked: boolean
}

/**
 * 字段加密主密钥：随机 32 字节，用系统安全存储（Windows DPAPI / macOS 钥匙串 / Linux 密钥环）
 * 加密后存在数据目录的 master.key.safe。
 */
export function loadMasterKey(dataHome: string, storage: SafeStorageLike = safeStorage): MasterKeyResult {
  const file = join(dataHome, 'master.key.safe')
  const hasSafeFile = existsSync(file)
  let available = false
  try {
    available =
      storage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text')
  } catch {
    available = false
  }
  if (!available) return { key: null, locked: hasSafeFile }
  if (hasSafeFile) {
    try {
      const key = storage.decryptString(readFileSync(file))
      if (/^[0-9a-f]{64}$/.test(key)) return { key, locked: false }
    } catch {
      // 解不开：保留旧文件，不覆盖（避免永久丢失可恢复的密钥）
    }
    return { key: null, locked: true }
  }
  mkdirSync(dataHome, { recursive: true })
  const key = randomBytes(32).toString('hex')
  writeFileSync(file, storage.encryptString(key), { mode: 0o600 })
  return { key, locked: false }
}

function tail(text: string, lines = 3): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.split('\n').slice(-lines).join(' | ')
}

async function waitForHealth(
  url: string,
  token: string,
  child: ChildProcess,
  readError: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`本地服务启动失败（退出码 ${child.exitCode}）${readError()}`)
    }
    try {
      const response = await fetch(`${url}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(800),
      })
      if (response.ok) return
    } catch {
      // 端口还没开始监听，继续等
    }
    await sleep(200)
  }
  throw new Error(`本地服务在 20 秒内没有就绪。${readError()}`)
}

interface ConfirmMessage {
  type?: string
  id?: string
  spec?: McpConfirmRequest
  cmd?: BrowserCommandMessage | ComputerCommandMessage
}

/** 以子进程方式托管本地 API 服务，返回可访问的地址与停止方法 */
export async function startLocalServer(options: StartOptions): Promise<LocalServer> {
  const port = await pickPort(options.preferredPort)
  const origin = `http://127.0.0.1:${port}`
  const dataHome = resolveDataHome()

  // 服务端需要完整用户环境（内核 CLI 依赖用户自己的登录与 Key）；LULUX 内部变量单独设置
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LULUX_ETA_HOST: '127.0.0.1',
    LULUX_ETA_PORT: String(port),
    LULUX_ETA_CLIENT_DIST: clientDist(),
    // 父进程退出导致 stdin / IPC 关闭时，服务端自行收尾
    LULUX_ETA_PARENT_PIPE: '1',
    LULUX_API_TOKEN: options.token,
    // 有原生确认通道（IPC）
    LULUX_NATIVE_CONFIRM: '1',
    // 桌面内置服务永远是单用户模式；团队服务器模式只用于独立部署
    LULUX_MODE: 'desktop',
  }
  delete env.LULUX_PUBLIC_ORIGIN
  delete env.LULUX_MASTER_KEY
  delete env.LULUX_MASTER_KEY_LOCKED
  const masterKey = loadMasterKey(dataHome)
  if (masterKey.key) env.LULUX_MASTER_KEY = masterKey.key
  // 主密钥暂时解不开：告诉服务端不要生成明文 master.key 顶替，新密钥一律拒绝保存
  else if (masterKey.locked) env.LULUX_MASTER_KEY_LOCKED = '1'

  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = '1'
    env.NODE_ENV = 'production'
    if (!env.LULUX_ETA_HOME) env.LULUX_ETA_HOME = dataHome
    // 随包 npm：服务端用 process.execPath（即本程序）+ ELECTRON_RUN_AS_NODE 运行它来安装第三方内核，用户机器无需 Node/npm
    const npmCli = bundledNpmCli()
    if (npmCli) env.LULUX_NPM_CLI = npmCli
    // 内置 skill：单文件 CJS 服务端里没有 import.meta.url，显式告诉它 <resources>/skills
    const skills = join(process.resourcesPath, 'skills')
    if (!env.LULUX_BUILTIN_SKILLS_DIR && existsSync(skills)) env.LULUX_BUILTIN_SKILLS_DIR = skills
    // 实验特性（node:sqlite）的提示不是错误，避免混进 stderr 尾部的报错信息
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ')
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }

  let stderrTail = ''
  let spawnError: Error | null = null
  let stopping = false
  let ready = false

  // fork 带 IPC 通道：服务端经 process.send 请求原生确认，渲染进程无法触及
  const child = fork(serverEntry(), [], {
    env,
    execPath: app.isPackaged ? process.execPath : process.env.LULUX_ETA_NODE || 'node',
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })

  child.on('message', (raw: unknown) => {
    const message = raw as ConfirmMessage
    if (!message?.id) return
    if (message.type === 'lulux:browser-cmd' || message.type === 'lulux:computer-cmd') {
      const computer = message.type === 'lulux:computer-cmd'
      const id = message.id
      const agent = computer ? options.computerAgent : options.browserAgent
      const reply = (payload: Record<string, unknown>): void => {
        if (child.connected) {
          child.send({ type: computer ? 'lulux:computer-result' : 'lulux:browser-result', id, ...payload })
        }
      }
      if (!agent) {
        reply(
          computer
            ? { ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '电脑操作不可用（主进程未启用）' } }
            : { ok: false, error: { code: 'NO_WINDOW', message: '内置浏览器不可用（主窗口不存在）' } },
        )
        return
      }
      let pending: Promise<unknown>
      try {
        pending = agent.execute(message.cmd)
      } catch (error) {
        pending = Promise.reject(error)
      }
      pending.then(
        (result) => reply({ ok: true, result: result ?? null }),
        (error: unknown) => {
          const code =
            error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
              ? ((error as { code: string }).code)
              : 'FAILED'
          const detail =
            error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败'
          reply({ ok: false, error: { code, message: detail } })
        },
      )
      return
    }
    if (message.type !== 'lulux:mcp-confirm' || !message.spec) return
    const reply = (approved: boolean): void => {
      if (child.connected) child.send({ type: 'lulux:mcp-confirm-result', id: message.id, approved })
    }
    const confirm = options.confirmMcp
    if (!confirm) {
      reply(false)
      return
    }
    confirm(message.spec).then(reply, () => reply(false))
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000)
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    if (!app.isPackaged) process.stdout.write(chunk)
  })
  child.on('error', (error) => {
    spawnError = error
  })

  child.on('exit', (code) => {
    // 启动阶段的退出由 waitForHealth 抛错处理，不重复回调
    if (stopping || !ready) return
    const detail = tail(stderrTail)
    options.onUnexpectedExit?.(
      `本地服务已退出（退出码 ${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`,
    )
  })

  const readError = (): string => {
    if (spawnError) return `\n${spawnError.message}`
    const detail = tail(stderrTail)
    return detail ? `\n${detail}` : ''
  }

  try {
    if (spawnError) throw spawnError
    await waitForHealth(origin, options.token, child, readError)
    if (spawnError) throw spawnError
    ready = true
  } catch (error) {
    stopping = true
    child.kill()
    throw error
  }

  return {
    url: origin,
    origin,
    port,
    masterKeyLocked: masterKey.locked,
    /** 主进程主动通知（急停 / 用户接管）；服务端按无 id 的消息处理 */
    sendComputerEvent(event: { event: string; reason: string }): void {
      if (stopping || !child.connected) return
      try {
        child.send({ type: 'lulux:computer-event', ...event })
      } catch {
        // 服务进程刚退出：事件丢掉即可
      }
    },
    async stop(): Promise<void> {
      if (stopping || child.exitCode !== null) return
      stopping = true
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const done = (): void => {
          if (timer) clearTimeout(timer)
          resolve()
        }
        child.once('exit', done)
        // 关闭 stdin 让服务端优雅退出；MCP 子进程会一并收尾
        child.stdin?.end()
        timer = setTimeout(() => {
          child.kill()
          timer = setTimeout(done, 500)
          timer.unref()
        }, 2500)
      })
    },
  }
}
