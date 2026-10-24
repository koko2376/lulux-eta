import { config } from '../../config.js'
import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../../errors.js'
import { settingsService } from '../settings-service.js'

export interface McpCommandSpec {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

/** 命令指纹：command/args/env 任一变化都需要重新确认 */
export function commandHash(spec: Pick<McpCommandSpec, 'command' | 'args' | 'env'>): string {
  const envKeys = Object.keys(spec.env).sort()
  const normalized = JSON.stringify({
    command: spec.command,
    args: spec.args,
    env: envKeys.map((key) => [key, spec.env[key]]),
  })
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * 与桌面主进程之间的确认通道。服务进程由主进程以 `stdio: [..., 'ipc']` 启动，
 * 通过 process.send 发出 `{ type: 'lulux:mcp-confirm', id, spec }`，主进程弹出原生对话框后回
 * `{ type: 'lulux:mcp-confirm-result', id, approved }`。渲染进程无法接触这条通道。
 */
export interface ConfirmChannel {
  available(): boolean
  request(spec: McpCommandSpec): Promise<boolean>
}

const CONFIRM_TIMEOUT_MS = 5 * 60_000

interface IpcMessage {
  type?: string
  id?: string
  approved?: boolean
}

export function createIpcConfirmChannel(proc: NodeJS.Process = process): ConfirmChannel {
  const pending = new Map<string, (approved: boolean) => void>()
  let listening = false

  const listen = (): void => {
    if (listening) return
    listening = true
    proc.on('message', (raw: unknown) => {
      const message = raw as IpcMessage
      if (message?.type !== 'lulux:mcp-confirm-result' || !message.id) return
      const resolve = pending.get(message.id)
      if (!resolve) return
      pending.delete(message.id)
      resolve(message.approved === true)
    })
    proc.on('disconnect', () => {
      for (const [id, resolve] of pending) {
        pending.delete(id)
        resolve(false)
      }
    })
  }

  return {
    available() {
      return nativeConfirmEnabled() && typeof proc.send === 'function' && proc.connected === true
    },
    request(spec) {
      listen()
      const id = randomUUID()
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(false)
        }, CONFIRM_TIMEOUT_MS)
        timer.unref()
        pending.set(id, (approved) => {
          clearTimeout(timer)
          resolve(approved)
        })
        try {
          proc.send!({ type: 'lulux:mcp-confirm', id, spec: { ...spec, env: Object.keys(spec.env) } })
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          resolve(false)
        }
      })
    },
  }
}

/** 主进程在启动服务时设置 LULUX_NATIVE_CONFIRM=1，表示存在原生确认通道 */
const NATIVE_CONFIRM = process.env.LULUX_NATIVE_CONFIRM === '1'
function nativeConfirmEnabled(): boolean {
  return NATIVE_CONFIRM
}

let channel: ConfirmChannel = createIpcConfirmChannel()

export function setConfirmChannelForTests(next: ConfirmChannel): void {
  channel = next
}

export function hasNativeConfirm(): boolean {
  return channel.available()
}

/**
 * 新建/修改 MCP 命令前的确认：
 *  - 有桌面主进程：弹原生确认框，拒绝 → 403 MCP_COMMAND_REJECTED；
 *  - 无主进程（浏览器开发态）：仅当 allowMcpWithoutNativeConfirm=1 才放行，否则 403。
 */
export async function confirmMcpCommand(spec: McpCommandSpec): Promise<void> {
  // server 模式没有原生确认框：策略中间件已要求 owner 且 owner 已显式开启 MCP（契约 5.8）
  if (config.mode === 'server') return
  if (channel.available()) {
    const approved = await channel.request(spec)
    if (!approved) {
      throw new AppError(403, 'MCP_COMMAND_REJECTED', '用户在确认对话框中拒绝了这个 MCP 命令')
    }
    return
  }
  if (settingsService.get('allowMcpWithoutNativeConfirm') === '1') return
  throw new AppError(
    403,
    'MCP_COMMAND_REJECTED',
    '没有桌面端原生确认通道。如在浏览器开发态使用，请先在设置中开启 allowMcpWithoutNativeConfirm',
  )
}
