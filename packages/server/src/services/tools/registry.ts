import { z } from 'zod'
import { AppError, messageOf } from '../../errors.js'
import { can, currentRole, missingPermission, permissionDeniedMessage, type Permission } from '../../security/access.js'
import type { ToolDefinition } from '../../types.js'
import { builtinTools as businessTools } from '../chat/builtin-tools.js'
import { settingsService } from '../settings-service.js'
import { coreTools } from './core-tools.js'
import { browserTools } from '../browser/tools.js'
import { computerTools } from '../computer/tools.js'
import { skillTools } from '../skills/tools.js'
import { ToolError } from './tool-error.js'
import { auditService } from '../audit-service.js'
import { memoryTools } from '../memory/tools.js'
import { groupTools } from '../chat/group-tools.js'

/**
 * 统一的内置工具注册表（非 MCP）。
 * - 业务工具：`services/chat/builtin-tools.ts`（客户/报价/邮件，契约 4.9）；
 * - 通用工具：`services/tools/core-tools.ts`（网页抓取、搜索、工作区、产物、时间、计算器）。
 * 设置 `builtinTools='0'` 关闭全部内置工具（总开关，兼容契约 4.9）；`kernelTools='0'` 只关闭通用工具。
 * 两类工具共享同一套 risk 分级、审批、权限检查、参数校验与结果截断（runTool）。
 * 新增内置工具：在对应文件的数组里加一项即可，不需要改编排层。
 */
export type ToolRisk = 'read' | 'write'

export interface ToolArtifact {
  id: string
  title: string
  language: string
  filename: string
  path: string
  size: number
}

/** 工作区里新生成的文件（docx/xlsx/pdf 等二进制产物），编排层下发 `artifact` 事件（binary=true，带下载地址） */
export interface ToolFile {
  path: string
  size: number
  title: string
  mime: string
}

/** 工具返回给模型的图片（data 为不带前缀的 base64） */
export interface ToolImage {
  mime: string
  data: string
  width?: number
  height?: number
  name?: string
}

export interface ToolContext {
  sessionId: string
  agentId: string
  signal: AbortSignal
  /** 产物：编排层负责下发 `artifact` 事件并把代码块追加进回复正文 */
  addArtifact(artifact: ToolArtifact, content: string): void
  /** 二进制产物：只下发事件，不往正文里追加 */
  emitFile?(file: ToolFile): void
  /** 按需工具集：把工具加入当前发言者的活动集（tool_search 使用），返回新加入的名字 */
  loadTools?(names: string[]): string[]
  /** 工具内部的额外确认卡片（内置浏览器高风险点击）；没有时视为无人可问，调用方应拒绝 */
  requestApproval?(request: import('../tool-approval.js').InToolApproval): Promise<boolean>
  /**
   * 工具把图片交给模型（电脑操作的截图）：编排层在本轮工具结果之后追加一条带图 user 轮。
   * 没有实现时（例如 MCP 调用方）工具在结果文字里注明无法接收图片。
   */
  attachImage?(image: ToolImage): void
}

export interface ToolSpec extends ToolDefinition {
  risk: ToolRisk
  group: 'business' | 'core' | 'skills' | 'config' | 'memory' | 'browser' | 'computer' | 'group'
  /** 运行时是否可用（例如未配置搜索服务时 web_search 不出现） */
  available?(): boolean
  /**
   * 'always'：标记高风险工具（脚本执行、Agent 自配置）。会话权限“需审批”下总是询问（不受旧 toolApproval 影响）；
   * “完全权限”下直接执行，除非同时标了 orgLevel（契约 §6.11）。
   * 'never'：从不审批（记忆工具：账号自己的资料，不是业务数据；任何权限级别、非交互运行里都直接执行，契约 §6.12）
   */
  approval?: 'always' | 'never'
  /** 组织级配置变更（MCP Server 增删改）：即使“完全权限”也逐次确认 */
  orgLevel?: boolean
  /** 账号个人数据（记忆）：只读角色 / “仅可查看”权限级别下也可用，不受 data:write 限制 */
  personal?: boolean
  /** 除 data:write 外还需要的账号权限（例如删除类工具的 customer:delete） */
  permissions?: Permission[]
  /** 审批卡片类型（契约 §8.5）；缺省为普通工具卡片 */
  approvalKind?: string
  /** 审批卡片的结构化详情（命令、脚本、将安装的依赖…） */
  approvalDetail?(args: Record<string, unknown>, ctx?: { sessionId: string }): unknown
  /** “本会话始终允许”的粒度；缺省为工具名 */
  rememberKey?(args: Record<string, unknown>): string
  /** 不提供“本会话始终允许”（MCP 增删改每次都要确认） */
  noRemember?: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> | unknown
}

export interface ToolOutcome {
  ok: boolean
  text: string
}

export { ToolError }

export const BUILTIN_SERVER = 'LULUX'
/** 单个工具结果最多交给模型的字符数 */
export const TOOL_RESULT_LIMIT = 60_000

/** builtinTools 是内置工具总开关（契约 4.9：'0' 时整体关闭）；kernelTools 只控制通用工具 */
function coreEnabled(): boolean {
  return settingsService.get('builtinTools') !== '0' && settingsService.get('kernelTools') !== '0'
}

export function listTools(): ToolSpec[] {
  const business: ToolSpec[] = businessTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    risk: tool.risk,
    group: 'business',
    permissions: tool.permissions,
    approval: tool.approval,
    noRemember: tool.noRemember,
    run: (args, ctx) => tool.run(args, ctx),
  }))
  const core = coreEnabled() ? coreTools.filter((tool) => !tool.available || tool.available()) : []
  // 内置浏览器（docs/browser-use.md）：以内置工具总开关为准，同时要求 desktop 的进程 IPC 通道可用；
  // 与 core 一样受 kernelTools 控制（没有桌面主进程时 available() 已为 false，开关只影响本地桌面模式）
  const browser = coreEnabled() ? browserTools.filter((tool) => !tool.available || tool.available()) : []
  // 电脑操作（docs/computer-use.md）：computerUse='1' 且 desktop 的进程 IPC 通道可用；与 browser 一样受 kernelTools 控制
  const computer = coreEnabled() ? computerTools.filter((tool) => !tool.available || tool.available()) : []
  // Skill 与自配置工具不受 kernelTools 影响，由 skillsEnabled 与各自的 available() 控制
  const skills = settingsService.get('builtinTools') !== '0' ? skillTools.filter((tool) => !tool.available || tool.available()) : []
  // 记忆工具：内置工具总开关 + 账号自己的“记忆”开关（不受 kernelTools / kernelCrmMcp 影响）
  const memory = settingsService.get('builtinTools') !== '0' ? memoryTools.filter((tool) => !tool.available || tool.available()) : []
  // 群聊工具（一句话建群并讨论）：受内置工具总开关控制，不受 kernelTools 影响（属于 LULUX 自身功能）
  const group = settingsService.get('builtinTools') !== '0' ? groupTools : []
  return [...business, ...core, ...browser, ...computer, ...skills, ...memory, ...group]
}

export function findTool(name: string): ToolSpec | undefined {
  return listTools().find((tool) => tool.name === name)
}

function clipResult(text: string): string {
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}\n…（结果过长，已截断）` : text
}

export const READ_ONLY_ROLE_REFUSAL = '当前用户是只读角色，没有权限执行写操作。'

/**
 * 当前账号（生效权限）能否调用该工具；不能时返回给模型 / 用户的拒绝原因。
 * 在审批之前调用：没有权限的操作不弹审批卡片。
 */
export function toolPermissionDenial(tool: Pick<ToolSpec, 'risk' | 'personal' | 'permissions'>): string | null {
  if (tool.risk === 'write' && !tool.personal && !can('data:write')) {
    return currentRole() === 'viewer' ? READ_ONLY_ROLE_REFUSAL : permissionDeniedMessage('data:write')
  }
  const missing = tool.permissions?.length ? missingPermission(tool.permissions) : null
  return missing ? permissionDeniedMessage(missing) : null
}

/** 执行内置工具；权限不足、参数错误、工具失败都以文本结果返回给模型（不抛） */
export async function runTool(tool: ToolSpec, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const denial = toolPermissionDenial(tool)
  if (denial) return { ok: false, text: denial }
  try {
    const result = await tool.run(args, ctx)
    if (tool.risk === 'write' && (tool.group === 'business' || tool.group === 'group')) {
      // Agent 对业务数据的写操作进审计日志（谁、哪个会话、哪个 Agent、哪个工具），参数只记键名
      auditService.record({
        action: 'agent.tool',
        entityType: 'tool',
        entityId: tool.name,
        summary: `Agent 执行 ${tool.name}`,
        meta: { sessionId: ctx.sessionId, agentId: ctx.agentId, argKeys: Object.keys(args) },
      })
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { ok: true, text: clipResult(text ?? '') }
  } catch (error) {
    if (ctx.signal.aborted) return { ok: false, text: '已取消。' }
    if (error instanceof z.ZodError) {
      return { ok: false, text: `参数不正确：${error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('；')}` }
    }
    if (error instanceof ToolError) return { ok: false, text: error.message }
    if (error instanceof AppError) return { ok: false, text: `${error.code}：${error.message}` }
    return { ok: false, text: `执行失败：${messageOf(error)}` }
  }
}
