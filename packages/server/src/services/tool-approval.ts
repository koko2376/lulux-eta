/**
 * 工具调用审批：编排层发出 tool_request 后在这里等待用户在界面上批准或拒绝。
 * 超时、用户停止都按拒绝处理，避免对话一直挂起。
 * 运行由服务端持有（契约 §6.9）：客户端断开不算拒绝。没有客户端接上时审批照样等待（默认 30 分钟，
 * LULUX_APPROVAL_TIMEOUT_MS 可调）；重新接上的客户端从运行回放或 GET /api/chat/pending 取回卡片并决定。
 * 内置内核增强：
 * - 记录待审批请求的元数据，断线重连后可用 GET /api/chat/pending 取回；
 * - remember='session'：本会话内同名工具后续调用不再询问（进程内记忆，重启后失效）。
 */
export interface ApprovalMeta {
  sessionId: string
  agentId: string
  name: string
  server: string
  arguments: string
  risk: 'read' | 'write'
  builtin: boolean
  /** “本会话始终允许”的键：默认模型侧工具名；run_skill_script 为 `run_skill_script:<skill>` */
  toolKey: string
  /** 审批卡片类型（契约 §8.5）：tool | skill_script | skill_install | skill_write | mcp_add | mcp_update | mcp_remove */
  approvalKind?: string
  /** 卡片详情（结构见契约 §8.5） */
  detail?: unknown
  /** false 时不提供“本会话始终允许” */
  canRemember?: boolean
}

export interface PendingApprovalInfo extends ApprovalMeta {
  requestId: string
  createdAt: number
  expiresAt: number
}

interface PendingApproval {
  finish: (approved: boolean) => void
  info: PendingApprovalInfo | null
}

const pending = new Map<string, PendingApproval>()
/** sessionId → 已“本会话始终允许”的工具 */
const sessionAllow = new Map<string, Set<string>>()
/**
 * 非交互会话（工作流节点 / 定时任务）：没有人在界面上审批。登记后该会话的每个写工具都走审批，
 * 且审批立刻按登记的决定返回（allowWrite=true → 批准，否则拒绝），不受全局 toolApproval / “本会话始终允许”影响。
 */
const nonInteractive = new Map<string, boolean>()

export function setNonInteractiveApproval(sessionId: string, allowWrite: boolean): void {
  nonInteractive.set(sessionId, allowWrite)
}

export function clearNonInteractiveApproval(sessionId: string): void {
  nonInteractive.delete(sessionId)
}

/** 会话是否为非交互运行（写工具一律经过 waitForApproval，由登记的决定自动答复） */
export function isNonInteractive(sessionId: string): boolean {
  return nonInteractive.has(sessionId)
}

/** 默认审批等待：30 分钟（无人接上的后台运行也够用户回来处理） */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000

/** 审批等待时长：环境变量 LULUX_APPROVAL_TIMEOUT_MS（毫秒，≥1000）覆盖默认 30 分钟 */
export function approvalTimeoutMs(): number {
  const raw = Number(process.env.LULUX_APPROVAL_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : DEFAULT_APPROVAL_TIMEOUT_MS
}

export function waitForApproval(
  requestId: string,
  signal: AbortSignal,
  timeoutMs = approvalTimeoutMs(),
  meta?: ApprovalMeta,
): Promise<boolean> {
  const decided = meta ? nonInteractive.get(meta.sessionId) : undefined
  if (decided !== undefined) return Promise.resolve(decided && !signal.aborted)
  return new Promise<boolean>((resolve) => {
    let settled = false

    const finish = (approved: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      pending.delete(requestId)
      resolve(approved)
    }

    const onAbort = (): void => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()

    if (signal.aborted) {
      finish(false)
      return
    }

    signal.addEventListener('abort', onAbort, { once: true })
    const now = Date.now()
    pending.set(requestId, { finish, info: meta ? { ...meta, requestId, createdAt: now, expiresAt: now + timeoutMs } : null })
  })
}

/** 界面回传决定；找不到说明已超时或已结束 */
export function resolveApproval(requestId: string, approved: boolean, remember?: 'session'): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  if (approved && remember === 'session' && entry.info && entry.info.canRemember !== false) allowForSession(entry.info.sessionId, entry.info.toolKey)
  entry.finish(approved)
  return true
}

export function allowForSession(sessionId: string, toolKey: string): void {
  const set = sessionAllow.get(sessionId) ?? new Set<string>()
  set.add(toolKey)
  sessionAllow.set(sessionId, set)
}

export function isAllowedForSession(sessionId: string, toolKey: string): boolean {
  return sessionAllow.get(sessionId)?.has(toolKey) ?? false
}

export function sessionAllowList(sessionId: string): string[] {
  return [...(sessionAllow.get(sessionId) ?? [])]
}

export function clearSessionAllow(sessionId: string): void {
  sessionAllow.delete(sessionId)
}

/** 某会话当前等待中的审批（断线重连用） */
export function pendingForSession(sessionId: string): PendingApprovalInfo[] {
  return [...pending.values()]
    .map((entry) => entry.info)
    .filter((info): info is PendingApprovalInfo => Boolean(info && info.sessionId === sessionId))
}

/** 请求所属会话（路由校验权限用） */
export function pendingSessionOf(requestId: string): string | null {
  return pending.get(requestId)?.info?.sessionId ?? null
}

/** 测试用：当前等待中的审批请求 id */
export function getPendingIdsForTests(): string[] {
  return [...pending.keys()]
}
