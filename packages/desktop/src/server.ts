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
  stop(): Promise<void>
}

/** 服务进程请求原生确认时的命令描述（env 只有键名） */
export interface McpConfirmRequest {
  name: string
  command: string
  args: string[]
  env: string[]
}

interface StartOptions {
  /** 每次启动生成的 API token，经 LULUX_API_TOKEN 交给服务 */
  token: string
  /** 服务进程意外退出时回调，用于提示用户 */
  onUnexpectedExit?: (message: string) => void
  /** 服务端请求确认 MCP 命令；返回是否允许 */
  confirmMcp?: (request: McpConfirmRequest) => Promise<boolean>
  /** 优先使用的端口（自动重启时沿用原端口，界面不必换地址）；被占用时退回系统分配 */
  preferredPort?: number
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

/**
 * 字段加密主密钥：随机 32 字节，用 Electron safeStorage（Windows DPAPI / macOS Keychain /
 * Linux libsecret）加密后存在数据目录的 master.key.safe。safeStorage 不可用（或 Linux 只有
 * basic_text 明文后端）时返回 null，交给服务端使用 <dataDir>/master.key（0600）。
 */
export function loadMasterKey(dataHome: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return null
  } catch {
    return null
  }
  mkdirSync(dataHome, { recursive: true })
  const file = join(dataHome, 'master.key.safe')
  if (existsSync(file)) {
    try {
      const key = safeStorage.decryptString(readFileSync(file))
      if (/^[0-9a-f]{64}$/.test(key)) return key
    } catch {
      // 换了系统账户 / 钥匙串被清空：保留旧文件，不覆盖（避免永久丢失可恢复的密钥）
      return null
    }
    return null
  }
  const key = randomBytes(32).toString('hex')
  writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 })
  return key
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
}

/** 以子进程方式托管本地 API 服务，返回可访问的地址与停止方法 */
export async function startLocalServer(options: StartOptions): Promise<LocalServer> {
  const port = options.preferredPort
    ? await freePort(options.preferredPort).catch(() => freePort())
    : await freePort()
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
  const masterKey = loadMasterKey(dataHome)
  if (masterKey) env.LULUX_MASTER_KEY = masterKey

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
    if (message?.type !== 'lulux:mcp-confirm' || !message.id || !message.spec) return
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
