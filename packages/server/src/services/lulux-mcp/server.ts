import { createHash, randomBytes } from 'node:crypto'
import { APP_VERSION } from '../../config.js'
import { runAs, type Actor } from '../../context.js'
import { messageOf } from '../../errors.js'
import { can } from '../../security/access.js'
import { newId } from '../../utils/id.js'
import { auditService } from '../audit-service.js'
import { mcpRuntime, type ResolvedMcpTool } from '../mcp/runtime.js'
import { settingsService } from '../settings-service.js'
import { deniedUnattended, EGRESS_REFUSAL, effectiveSessionLevel, READ_ONLY_REFUSAL, toolGate, UNATTENDED_REFUSAL, type PermissionLevel } from '../permissions.js'
import { memoryToolsBlocked } from '../memory/session-policy.js'
import { CLAUDE_PROMPT_TOOL } from '../kernels/permissions.js'
import { findKernel } from '../kernels/catalog.js'
import { approvalTimeoutMs, inToolApprover, isAllowedForSession, isNonInteractive, unattendedKernelLevel, waitForApproval } from '../tool-approval.js'
import { listTools, runTool, toolPermissionDenial, type ToolSpec } from '../tools/registry.js'
import type { ToolTraceEntry } from '../../types.js'

/**
 * 内置本地 LULUX MCP 服务（Streamable HTTP，JSON 响应），只给 scoped 模式下运行的第三方 CLI 内核用：
 * - 每次内核运行签发一个一次性令牌（只存 SHA-256），绑定会话、Agent 与发起对话的用户身份；运行结束即吊销；
 * - 暴露：业务工具（客户 / 报价 / 跟进 / 任务 / 邮件草稿，group='business'）、skill 工具（skill_list / skill_view /
 *   run_skill_script，group='skills'，按该内核 Agent 的 skill 配置过滤）、记忆工具（memory_*，group='memory'，
 *   只看发起者自己的记忆开关，不需要审批）、群聊工具（list_group_options / create_group / update_group / post_to_group /
 *   delete_group，group='group'，一句话建群并发起讨论），以及用户在 LULUX 里添加并启用的 MCP Server
 *   的工具（名字 `<server>__<tool>`）——这样 LULUX 里装的 skill 与 MCP 在任何内核的会话里都能用；
 *   不暴露工作区、自配置（skill_install / mcp_add …）等工具；
 * - 工具以发起对话的用户身份执行（RBAC 与行级可见性同 /api）；
 * - 审批与内置内核完全一致，按会话权限级别（契约 §6.11）：read 工具直接执行；write 工具（用户 MCP 工具一律按 write）
 *   在“仅可查看”下不出现在 tools/list 里、调用也直接拒绝；“需审批”下向对话下发 tool_request，等用户在界面批准
 *   （支持“本会话始终允许”，粒度同内置：skill 脚本按 skill、MCP 工具按内置内核里的工具名，两边共用）；
 *   “完全权限”下直接执行（组织级配置变更除外，桥上本来也不暴露）；
 *   超时 / 停止 / 拒绝都不执行；viewer 的写操作返回无权限；业务写操作与用户 MCP 调用写审计日志；
 * - Claude Code 在“需审批”下用 --permission-prompt-tool mcp__lulux__approval_prompt：它自带工具（Bash / Edit / Write …）
 *   的权限请求经这里变成 LULUX 审批卡片，批准返回 {behavior:'allow'}，拒绝 / 超时返回 {behavior:'deny'}；
 * - 每次调用写入该条助手消息的工具轨迹（toolTrace）并下发 tool_result。
 */
export const LULUX_MCP_SERVER_NAME = 'lulux'
export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const TRACE_RESULT_LIMIT = 4000
const MAX_TTL_MS = 6 * 3600_000

export interface McpBridge {
  sessionId: string
  agentId: string
  signal: AbortSignal
  send(event: string, payload: unknown): void
  trace(entry: ToolTraceEntry): void
}

interface McpTarget {
  actor: Actor
  kernelId: string
  bridge: McpBridge
  createdAt: number
  calls: number
  /** 令牌吊销（内核运行结束）时中止：这次运行名下还在等的审批一律作废 */
  ended: AbortController
}

const targets = new Map<string, McpTarget>()

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export const luluxMcpTokens = {
  issue(input: { actor: Actor; kernelId: string; bridge: McpBridge }): { token: string; revoke(): void } {
    const now = Date.now()
    for (const [key, target] of targets) if (now - target.createdAt > MAX_TTL_MS) targets.delete(key)
    const token = `lulux-mcp-${randomBytes(32).toString('hex')}`
    const key = digest(token)
    const ended = new AbortController()
    targets.set(key, { ...input, createdAt: now, calls: 0, ended })
    return {
      token,
      revoke: () => {
        targets.delete(key)
        ended.abort()
      },
    }
  },
  resolve(token: string | null | undefined): McpTarget | null {
    if (!token || token.length > 200) return null
    const target = targets.get(digest(token))
    if (!target) return null
    if (Date.now() - target.createdAt > MAX_TTL_MS) {
      targets.delete(digest(token))
      return null
    }
    return target
  },
  size(): number {
    return targets.size
  },
  clear(): void {
    for (const target of targets.values()) target.ended.abort()
    targets.clear()
  },
}

/**
 * 经桥暴露的内置工具分组：业务 + skill（不含 core 的工作区/抓取，也不含 config 自配置）。
 * 电脑操作（group 'computer'）刻意不暴露：MCP 调用方（第三方 CLI 内核）拿不到截图图片，
 * 也无法弹出“动作 + 标注截图”的审批卡，逐步审批与用户接管都无从谈起。
 */
const BRIDGE_GROUPS = new Set<ToolSpec['group']>(['business', 'skills', 'group'])

/** CRM / skill / 用户 MCP 是否经桥暴露（builtinTools + kernelCrmMcp）；记忆工具只看 builtinTools 与账号自己的记忆开关 */
function crmBridgeEnabled(): boolean {
  return settingsService.get('builtinTools') !== '0' && settingsService.get('kernelCrmMcp') !== '0'
}
/** CLI 对工具名的限制（Claude Code mcp__lulux__<name> ≤ 64，Codex/Gemini 要求 [a-zA-Z0-9_-]） */
const MAX_TOOL_NAME = 48

/** 暴露给 CLI 的内置工具（在发起者身份下计算，builtinTools='0' 时为空） */
export function mcpTools(actor: Actor): ToolSpec[] {
  return runAs(actor, () => {
    const crm = crmBridgeEnabled()
    return listTools().filter((tool) => tool.group === 'memory' || (crm && BRIDGE_GROUPS.has(tool.group)))
  })
}

export interface BridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: 'read' | 'write'
  spec?: ToolSpec
  mcp?: ResolvedMcpTool
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 桥上的全部工具：内置（业务 + skill）+ 用户启用的 MCP Server 工具（`<server>__<tool>`，与内置同名时跳过） */
export async function bridgeTools(actor: Actor): Promise<BridgeTool[]> {
  const tools: BridgeTool[] = mcpTools(actor).map((spec) => ({
    name: spec.name,
    description: spec.description ?? spec.name,
    inputSchema: spec.inputSchema && typeof spec.inputSchema === 'object' ? (spec.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} },
    risk: spec.risk,
    spec,
  }))
  const used = new Set(tools.map((tool) => tool.name))
  const external = runAs(actor, () => crmBridgeEnabled())
    ? await runAs(actor, () => mcpRuntime.toolDefinitions()).catch((error) => {
        console.warn('[lulux-eta] user MCP tools unavailable for kernel bridge:', messageOf(error))
        return [] as ResolvedMcpTool[]
      })
    : []
  for (const mcp of external) {
    const prefix = safeName(mcp.serverSlug || mcp.serverId.slice(-6))
    const base = `${prefix}__${safeName(mcp.originalName)}`.slice(0, MAX_TOOL_NAME)
    let name = base
    for (let n = 2; used.has(name); n += 1) name = `${base.slice(0, MAX_TOOL_NAME - 3)}_${n}`
    used.add(name)
    tools.push({
      name,
      description: `[${mcp.serverName}] ${mcp.description ?? ''}`.trim(),
      inputSchema: mcp.inputSchema && typeof mcp.inputSchema === 'object' ? (mcp.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} },
      risk: 'write',
      mcp,
    })
  }
  return tools
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}
function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** 本次运行会话的有效权限级别（以发起者身份计算；运行中切换级别对之后的调用生效） */
/** 会话级别；非交互运行与 CLI 启动参数同一口径（取与 allowWrite 更严的一个），approval_prompt 的提供与否才一致 */
function sessionLevel(target: McpTarget): PermissionLevel {
  const level = runAs(target.actor, () => effectiveSessionLevel(target.bridge.sessionId, target.actor))
  return unattendedKernelLevel(target.bridge.sessionId, level)
}

/**
 * 一次 MCP 调用的生命周期信号：会话运行被停止、内核运行结束（令牌吊销）、调用方断开 HTTP 请求（CLI 侧超时）
 * 任一发生就中止——等待中的审批卡片随之作废（按拒绝收回），批准不会再执行写操作。
 */
function callSignal(target: McpTarget, request?: AbortSignal): AbortSignal {
  return AbortSignal.any([target.bridge.signal, target.ended.signal, ...(request ? [request] : [])])
}

/** 审批 / 执行被中止时给调用方的说明 */
function abortedText(target: McpTarget): string {
  return target.bridge.signal.aborted ? '用户停止了对话，工具未执行。' : '调用已超时断开或本次运行已结束，审批已作废，工具未执行。'
}

/** Claude Code 的权限提示工具名（mcp__lulux__ 前缀之后的部分） */
export const APPROVAL_PROMPT_TOOL = CLAUDE_PROMPT_TOOL.replace(/^mcp__lulux__/, '')

/** 是否在 tools/list 里提供 approval_prompt：只给“需审批”下的 Claude Code */
function offersApprovalPrompt(target: McpTarget, level: PermissionLevel): boolean {
  return target.kernelId === 'claude-code' && level === 'ask'
}

/**
 * Claude Code 自带工具的权限请求 → LULUX 审批卡片（契约 §6.11）。输入 {tool_name, input, tool_use_id?}，
 * 输出文本是 Claude Code 要求的 JSON：{behavior:'allow', updatedInput} 或 {behavior:'deny', message}。
 */
async function approvalPrompt(target: McpTarget, args: Record<string, unknown>, request?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const signal = callSignal(target, request)
  const { bridge } = target
  const toolName = typeof args.tool_name === 'string' && args.tool_name ? args.tool_name.slice(0, 120) : 'unknown'
  const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {}
  const kernelName = findKernel(target.kernelId)?.name ?? target.kernelId
  const deny = (message: string): { text: string; isError: boolean } => ({ text: JSON.stringify({ behavior: 'deny', message }), isError: false })
  const level = sessionLevel(target)
  const nonInteractive = isNonInteractive(bridge.sessionId)
  if (level === 'read' && !nonInteractive) return deny(READ_ONLY_REFUSAL)
  const requestId = newId('tool')
  const createdAt = Date.now()
  const rawArguments = JSON.stringify(input)
  const toolKey = `${target.kernelId}:${toolName}`
  const remembered = isAllowedForSession(bridge.sessionId, toolKey)
  const needsApproval = nonInteractive || (level === 'ask' && !remembered)
  bridge.send('tool_request', {
    requestId,
    agentId: bridge.agentId,
    name: toolName,
    server: kernelName,
    arguments: rawArguments,
    auto: !needsApproval,
    builtin: false,
    risk: 'write',
    toolCallId: typeof args.tool_use_id === 'string' ? args.tool_use_id : requestId,
    approvalKind: 'tool',
    detail: null,
    canRemember: true,
    toolKey,
    via: 'permission_prompt',
  })
  const approved = needsApproval
    ? await waitForApproval(requestId, signal, approvalTimeoutMs(), {
        sessionId: bridge.sessionId,
        agentId: bridge.agentId,
        name: toolName,
        server: kernelName,
        arguments: rawArguments,
        risk: 'write',
        builtin: false,
        toolKey,
        approvalKind: 'tool',
        detail: null,
        canRemember: true,
      })
    : true
  const result = approved ? `已批准 ${kernelName} 执行 ${toolName}` : signal.aborted ? abortedText(target) : '用户拒绝了这次工具调用。'
  const durationMs = Date.now() - createdAt
  bridge.trace({ id: requestId, name: toolName, server: kernelName, arguments: rawArguments, ok: approved, approved, result, durationMs, createdAt, builtin: false, risk: 'write' })
  bridge.send('tool_result', {
    requestId,
    agentId: bridge.agentId,
    name: toolName,
    server: kernelName,
    ok: approved,
    approved,
    result,
    durationMs,
    builtin: false,
    risk: 'write',
    toolCallId: requestId,
  })
  return approved ? { text: JSON.stringify({ behavior: 'allow', updatedInput: input }), isError: false } : deny(result)
}

async function callTool(target: McpTarget, name: string, args: Record<string, unknown>, request?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const { bridge, actor } = target
  if (name === APPROVAL_PROMPT_TOOL && offersApprovalPrompt(target, sessionLevel(target))) return approvalPrompt(target, args, request)
  const signal = callSignal(target, request)
  const tool = (await bridgeTools(actor)).find((item) => item.name === name)
  if (!tool) return { text: `未知工具：${name}`, isError: true }
  const { spec, mcp } = tool
  const requestId = newId('tool')
  const createdAt = Date.now()
  const rawArguments = JSON.stringify(args ?? {})
  const server = mcp ? mcp.serverName : 'LULUX'
  const displayName = mcp ? mcp.originalName : name
  const builtin = Boolean(spec)
  // 与内置内核一致：skill 脚本按 skill 记忆；MCP 工具用内置内核里的名字（mcp_<server>_<tool>），两边“本会话始终允许”互通
  const toolKey = spec?.rememberKey ? spec.rememberKey(args) : mcp ? mcp.name : name
  const canRemember = !spec?.noRemember
  const nonInteractive = isNonInteractive(bridge.sessionId)
  // 角色本身没有写权限（viewer）时先给出 RBAC 原因：比“会话仅可查看”更根本，切换会话权限也解决不了。
  // 账号个人数据（记忆，personal）不受 data:write 限制，viewer 也能写自己的记忆
  // 账号生效权限（角色默认值 ± 管理员的覆盖项）：缺少时不弹审批、直接拒绝，例如“没有权限：删除客户”
  if (spec) {
    const denial = runAs(actor, () => toolPermissionDenial(spec))
    if (denial) return { text: denial, isError: true }
  } else if (tool.risk === 'write' && !can('data:write', actor)) return { text: '当前用户是只读角色，没有权限执行写操作。', isError: true }
  const level = sessionLevel(target)
  const gate = toolGate(level, { risk: tool.risk, approval: spec?.approval, orgLevel: spec?.orgLevel, personal: spec?.personal, egress: spec?.egress })
  // 非交互运行：不可恢复 / 高风险工具一律拒绝，不看 allowWrite；“仅可查看”下外发网络的工具也不执行
  if (spec && nonInteractive && deniedUnattended(spec)) return { text: UNATTENDED_REFUSAL, isError: true }
  if (spec?.egress && level === 'read') return { text: EGRESS_REFUSAL, isError: true }
  // 记忆工具：“仅可查看”、非交互运行、多人群聊里一律拒绝
  if (spec?.personal) {
    const blocked = memoryToolsBlocked(bridge.sessionId) ?? (gate === 'hidden' ? READ_ONLY_REFUSAL : null)
    if (blocked) return { text: blocked, isError: true }
  }
  if (gate === 'hidden' && !nonInteractive) return { text: READ_ONLY_REFUSAL, isError: true }
  const remembered = canRemember && isAllowedForSession(bridge.sessionId, toolKey)
  // 记忆工具（approval='never'）从不弹卡片（契约 §6.12）；能走到这里说明是交互式、单人、非“仅可查看”的会话
  const needsApproval = tool.risk === 'write' && spec?.approval !== 'never' && (nonInteractive || (gate === 'ask' && !remembered))
  const approvalKind = spec?.approvalKind ?? 'tool'
  let detail: unknown = null
  if (spec?.approvalDetail) {
    try {
      detail = spec.approvalDetail(args, { sessionId: bridge.sessionId }) ?? { invalid: true, errors: ['参数不合法'], arguments: {} }
    } catch (error) {
      detail = { invalid: true, errors: [messageOf(error)], arguments: {} }
    }
  }
  bridge.send('tool_request', {
    requestId,
    agentId: bridge.agentId,
    name: displayName,
    server,
    arguments: rawArguments,
    auto: !needsApproval,
    builtin,
    risk: tool.risk,
    toolCallId: requestId,
    approvalKind,
    detail,
    canRemember,
    toolKey,
    via: 'mcp',
  })
  let approved = true
  if (needsApproval) {
    approved = await waitForApproval(requestId, signal, approvalTimeoutMs(), {
      sessionId: bridge.sessionId,
      agentId: bridge.agentId,
      name: displayName,
      server,
      arguments: rawArguments,
      risk: tool.risk,
      builtin,
      toolKey,
      approvalKind,
      detail,
      canRemember,
    })
  }
  let text: string
  let success = false
  if (!approved || signal.aborted) {
    approved = false
    text = signal.aborted ? abortedText(target) : '用户拒绝了这次工具调用。'
  } else if (spec) {
    const outcome = await runAs(actor, () =>
      runTool(spec, args ?? {}, {
        sessionId: bridge.sessionId,
        agentId: bridge.agentId,
        signal,
        addArtifact: () => undefined,
        requestApproval: inToolApprover((event, payload) => bridge.send(event as never, payload as never), {
          sessionId: bridge.sessionId,
          agentId: bridge.agentId,
          signal,
          newRequestId: () => newId('tool'),
          via: 'mcp',
        }),
        emitFile: (file) =>
          bridge.send('artifact', {
            agentId: bridge.agentId,
            artifact: {
              id: newId('art'),
              title: file.title,
              language: file.path.slice(file.path.lastIndexOf('.') + 1).toLowerCase(),
              filename: file.title,
              path: file.path,
              size: file.size,
              binary: true,
              mime: file.mime,
              downloadUrl: `/api/chat/sessions/${encodeURIComponent(bridge.sessionId)}/files?path=${encodeURIComponent(file.path)}`,
            },
          }),
      }),
    )
    success = outcome.ok
    text = outcome.text
  } else if (mcp && !runAs(actor, () => can('data:write'))) {
    text = '当前用户是只读角色，没有权限调用 MCP 工具。'
  } else if (mcp) {
    try {
      const result = await runAs(actor, () => mcpRuntime.call(mcp.name, args ?? {}, signal))
      success = result.ok
      text = result.text
    } catch (error) {
      text = signal.aborted ? '已取消。' : `工具执行失败：${messageOf(error)}`
    }
    runAs(actor, () =>
      auditService.record({
        action: 'agent.tool',
        entityType: 'tool',
        entityId: mcp.name,
        summary: `Agent 经 MCP 调用 ${mcp.serverName} / ${mcp.originalName}`,
        meta: { sessionId: bridge.sessionId, agentId: bridge.agentId, server: mcp.serverName, via: 'mcp', ok: success, argKeys: Object.keys(args ?? {}) },
      }),
    )
  } else {
    text = `未知工具：${name}`
  }
  const durationMs = Date.now() - createdAt
  const result = text.slice(0, TRACE_RESULT_LIMIT)
  bridge.trace({ id: requestId, name: displayName, server, arguments: rawArguments, ok: success, approved, result, durationMs, createdAt, builtin, risk: tool.risk })
  bridge.send('tool_result', {
    requestId,
    agentId: bridge.agentId,
    name: displayName,
    server,
    ok: success,
    approved,
    result,
    durationMs,
    builtin,
    risk: tool.risk,
    toolCallId: requestId,
  })
  return { text, isError: !success }
}

/** 处理一条 JSON-RPC 消息；通知返回 null（HTTP 202） */
export async function handleMcpMessage(target: McpTarget, message: JsonRpcRequest, request?: AbortSignal): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
    return fail(message?.id, -32600, 'Invalid Request')
  }
  const isNotification = message.id === undefined || message.id === null
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION
      return ok(message.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lulux-crm', title: 'LULUX CRM', version: APP_VERSION },
        instructions:
          'LULUX 工具：长期记忆（memory_add / memory_replace / memory_remove，保存这个用户跨会话有效的画像与偏好，无需批准）；CRM（查询/新建/更新客户、跟进活动、报价与 PI PDF、报价引擎（quote_calculate 按成本算 EXW/FOB/CFR/CIF/DDP 价格、quote_generate_pi 一键出报价单和 PI、fx_rates 汇率、list_freight_rates / save_freight_rate 运价表）、任务提醒、漏斗统计、从邮件建客户、邮件草稿，不能发送；询盘打分 score_inquiry / list_inquiries 按分排出值得先回的询盘；开发信序列 sequence_*，到点只生成待确认草稿；出货单证 docs_* / hs_suggest）；开发客户（find_uk_importers 英国海关进口商名录、market_overview 各国进口规模、screen_sanctions 制裁名单初筛、save_prospects / list_prospects / get_prospect / update_prospect / convert_prospect_to_customer 线索库）；LULUX skill（skill_list / skill_view 读取说明，run_skill_script 运行 skill 自带脚本）；群聊（create_group 建多 Agent 群并配置成员群头衔，post_to_group 在群里发起讨论并带回结论，update_group / delete_group 管理群）；以及用户在 LULUX 里添加的 MCP Server 工具（名字形如 <server>__<tool>）。写操作需要用户在 LULUX 界面批准。',
      })
    }
    case 'ping':
      return isNotification ? null : ok(message.id, {})
    case 'tools/list': {
      // “仅可查看”：写工具不出现在列表里（非交互运行除外：仍由 allowWrite 自动答复）；
      // 记忆工具：“仅可查看”、非交互运行、多人群聊里都不出现
      const level = sessionLevel(target)
      const memoryBlocked = Boolean(memoryToolsBlocked(target.bridge.sessionId))
      const listed = (await bridgeTools(target.actor)).filter((tool) => {
        const gate = toolGate(level, { risk: tool.risk, approval: tool.spec?.approval, orgLevel: tool.spec?.orgLevel, personal: tool.spec?.personal, egress: tool.spec?.egress })
        if (tool.spec?.personal) return !memoryBlocked && gate !== 'hidden'
        const unattended = isNonInteractive(target.bridge.sessionId)
        if (unattended && tool.spec && deniedUnattended(tool.spec)) return false
        if (tool.spec?.egress) return gate !== 'hidden'
        return unattended || gate !== 'hidden'
      })
      const tools: Array<Record<string, unknown>> = listed.map((tool) => ({
        name: tool.name,
        description: `${tool.description}${tool.risk === 'write' && tool.spec ? '（写操作）' : ''}`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.risk === 'read', destructiveHint: false, openWorldHint: Boolean(tool.mcp) },
      }))
      if (offersApprovalPrompt(target, level)) {
        tools.push({
          name: APPROVAL_PROMPT_TOOL,
          description: 'LULUX 权限审批：由 Claude Code 在需要执行写文件 / 命令等操作前自动调用，请求用户在 LULUX 界面批准。不要直接调用。',
          inputSchema: {
            type: 'object',
            properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
            required: ['tool_name', 'input'],
          },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })
      }
      return ok(message.id, { tools })
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {}
      target.calls += 1
      const result = await callTool(target, name, args, request)
      return ok(message.id, { content: [{ type: 'text', text: result.text }], isError: result.isError })
    }
    case 'resources/list':
      return ok(message.id, { resources: [] })
    case 'prompts/list':
      return ok(message.id, { prompts: [] })
    default:
      if (message.method.startsWith('notifications/')) return null
      return isNotification ? null : fail(message.id, -32601, `Method not found: ${message.method}`)
  }
}
