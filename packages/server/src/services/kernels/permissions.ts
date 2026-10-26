import type { PermissionLevel } from '../permissions.js'

/**
 * 会话权限级别 → 各 CLI 内核的真实参数（契约 §6.11）。参数全部按已安装 CLI 的 --help 核实（2026-10-21）：
 *
 * | 内核        | read（仅可查看）                                   | ask（需审批）                                                       | full（完全权限）                                            |
 * |-------------|----------------------------------------------------|---------------------------------------------------------------------|-------------------------------------------------------------|
 * | Claude Code | --permission-mode dontAsk --tools Read,Grep,Glob   | --permission-mode default --permission-prompt-tool mcp__lulux__approval_prompt（经 LULUX 审批卡片）；没有 LULUX MCP 时退回 read | --permission-mode bypassPermissions --allow-dangerously-skip-permissions |
 * | Codex       | exec --sandbox read-only                           | 退回 read（codex exec 无交互审批）                                  | exec --sandbox workspace-write（工作区内可写，exec 默认审批策略 never） |
 * | Gemini CLI  | --approval-mode plan                               | 退回 read（headless 无法交互审批）                                  | --approval-mode yolo                                        |
 * | Qwen Code   | --approval-mode plan                               | 退回 read                                                           | --approval-mode yolo                                        |
 * | Grok        | --tools read_file,list_dir,grep --always-approve   | 退回 read                                                           | 去掉 --tools 白名单（默认工具集）+ --always-approve，GROK_WRITE_FILE=1 |
 * | Hermes      | --toolsets skills[,lulux]                          | 退回 read（oneshot 模式自动批准，无交互审批）                       | --toolsets skills,file,terminal[,lulux] --yolo              |
 * | Pi          | --tools read,grep,find,ls[,mcp__lulux__*]          | 退回 read（Pi 没有审批机制）                                        | --tools read,bash,edit,write,grep,find,ls[,mcp__lulux__*]   |
 *
 * “退回 read”只影响 CLI 自带的写文件 / 执行命令工具；LULUX MCP 的写工具在 ask 下照常弹 LULUX 审批卡片。
 * ask / full 时 CLI 的工作目录是会话工作区 <dataDir>/workspace/<sessionId>/（写操作落在这里）。
 */

/** ask 级别下 CLI 自带工具的审批方式：card = 经 LULUX 审批卡片；readonly = 无法交互审批，退回只读 */
export type KernelAskSupport = 'card' | 'readonly'

/** Claude Code 的权限提示工具（内置 LULUX MCP 上的 approval_prompt） */
export const CLAUDE_PROMPT_TOOL = 'mcp__lulux__approval_prompt'

/** 某内核在 ask 级别下能否经 LULUX 审批卡片审批自带工具（需要本次运行注入了 LULUX MCP） */
export function kernelAskSupport(kernelId: string, mcpAvailable: boolean): KernelAskSupport {
  return kernelId === 'claude-code' && mcpAvailable ? 'card' : 'readonly'
}

/** CLI 实际生效的级别：ask 而无法经卡片审批时退回 read */
export function kernelEffectiveLevel(kernelId: string, level: PermissionLevel, mcpAvailable: boolean): PermissionLevel {
  if (level === 'ask' && kernelAskSupport(kernelId, mcpAvailable) === 'readonly') return 'read'
  return level
}

export interface KernelPermissionContext {
  /** 本次运行是否注入了内置 LULUX MCP */
  mcp: boolean
}

export interface KernelPermissionLaunch {
  args: string[]
  env: Record<string, string>
  /** CLI 自带工具实际生效的级别 */
  level: PermissionLevel
}

/** 去掉一个带值的参数（`--flag value` 或 `--flag=value`），返回新数组 */
function dropFlag(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === flag) {
      i += 1
      continue
    }
    if (arg.startsWith(`${flag}=`)) continue
    out.push(arg)
  }
  return out
}

/** 设置带值参数：已有则替换值，没有则追加 */
function setFlag(args: string[], flag: string, value: string): string[] {
  const at = args.indexOf(flag)
  if (at >= 0 && at + 1 < args.length) {
    const next = [...args]
    next[at + 1] = value
    return next
  }
  return [...dropFlag(args, flag), flag, value]
}

/** 在 codex 的 `exec` 子命令之后插入参数（末尾的 `-` 是 stdin 提示词，必须留在最后） */
function codexSandbox(args: string[], mode: string): string[] {
  const at = args.indexOf('--sandbox')
  if (at >= 0) return setFlag(args, '--sandbox', mode)
  const exec = args.indexOf('exec')
  return exec >= 0 ? [...args.slice(0, exec + 1), '--sandbox', mode, ...args.slice(exec + 1)] : [...args, '--sandbox', mode]
}

const PI_READ = 'read,grep,find,ls'
const PI_FULL = 'read,bash,edit,write,grep,find,ls'
const GROK_READ = 'read_file,list_dir,grep'

/**
 * 把权限级别套到内核的启动参数上（scoped 与 global 两种模式都经过这里）。
 * args 是已经拼好的参数（catalog 的只读基线 + scoped 的模型 / MCP 参数），只改与权限有关的部分。
 */
export function applyKernelPermission(
  kernelId: string,
  requested: PermissionLevel,
  input: string[],
  ctx: KernelPermissionContext,
): KernelPermissionLaunch {
  const level = kernelEffectiveLevel(kernelId, requested, ctx.mcp)
  let args = [...input]
  const env: Record<string, string> = {}
  switch (kernelId) {
    case 'claude-code': {
      args = dropFlag(dropFlag(dropFlag(args, '--permission-mode'), '--tools'), '--permission-prompt-tool')
      args = args.filter((arg) => arg !== '--allow-dangerously-skip-permissions' && arg !== '--dangerously-skip-permissions')
      if (level === 'read') args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob')
      else if (level === 'ask') args.push('--permission-mode', 'default', '--permission-prompt-tool', CLAUDE_PROMPT_TOOL)
      else args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions')
      break
    }
    case 'codex':
      args = codexSandbox(args, level === 'full' ? 'workspace-write' : 'read-only')
      break
    case 'gemini-cli':
    case 'qwen-code':
      args = setFlag(args, '--approval-mode', level === 'full' ? 'yolo' : 'plan')
      break
    case 'grok': {
      if (level === 'full') {
        args = dropFlag(args, '--tools')
        env.GROK_WRITE_FILE = '1'
      } else {
        args = setFlag(args, '--tools', GROK_READ)
        env.GROK_WRITE_FILE = '0'
      }
      if (!args.includes('--always-approve')) args.push('--always-approve')
      break
    }
    case 'hermes': {
      const current = args.indexOf('--toolsets')
      const hasLulux = current >= 0 && (args[current + 1] ?? '').split(',').includes('lulux')
      const sets = level === 'full' ? ['skills', 'file', 'terminal'] : ['skills']
      if (hasLulux || ctx.mcp) sets.push('lulux')
      args = setFlag(args, '--toolsets', sets.join(','))
      args = args.filter((arg) => arg !== '--yolo')
      if (level === 'full') args.push('--yolo')
      break
    }
    case 'pi': {
      const at = args.indexOf('--tools')
      const withMcp = at >= 0 && (args[at + 1] ?? '').includes('mcp__lulux__')
      const tools = `${level === 'full' ? PI_FULL : PI_READ}${withMcp || ctx.mcp ? ',mcp__lulux__*' : ''}`
      args = setFlag(args, '--tools', tools)
      break
    }
    default:
      break
  }
  return { args, env, level }
}
