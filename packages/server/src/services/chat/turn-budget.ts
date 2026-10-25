import type { ToolCall } from '../../types.js'

/**
 * 内置内核的工具轮数预算与循环保护。
 * 纯函数，便于单测；persona-loop 负责把结果注入对话。
 */

/** 默认每次回复最多 90 轮工具调用（Hermes agent.max_turns 默认值） */
export const DEFAULT_MAX_TURNS = 90
export const MAX_TURNS_LIMIT = 500
/** 预算提醒阈值：70% 提醒收敛，90% 要求立刻作答 */
export const BUDGET_CAUTION = 0.7
export const BUDGET_WARNING = 0.9
/** 同一工具 + 相同参数连续出现这么多次视为死循环 */
export const REPEAT_LIMIT = 3

export type BudgetLevel = 'caution' | 'warning'

/**
 * 本轮结束后是否需要注入预算提醒。每个级别只提醒一次（alreadySent 记录已发过的级别）；
 * 已到上限时不提醒（由收尾提示接管）；maxTurns=0 表示不限制，永不提醒。
 */
export function budgetPressure(used: number, maxTurns: number, alreadySent: ReadonlySet<BudgetLevel>): BudgetLevel | null {
  if (maxTurns <= 0 || used >= maxTurns) return null
  const ratio = used / maxTurns
  if (ratio >= BUDGET_WARNING && !alreadySent.has('warning')) return 'warning'
  if (ratio >= BUDGET_CAUTION && !alreadySent.has('caution') && !alreadySent.has('warning')) return 'caution'
  return null
}

/** 预算提醒文本（格式与 Hermes 一致，后附中文说明） */
export function budgetPressureText(level: BudgetLevel, used: number, maxTurns: number): string {
  const left = Math.max(0, maxTurns - used)
  if (level === 'warning') {
    return `[BUDGET WARNING: ${used}/${maxTurns}. Only ${left} left. Respond NOW.]（系统提示：工具调用轮数即将用完，请立即停止探索，基于已有结果给出回答。）`
  }
  return `[BUDGET: ${used}/${maxTurns}. ${left} iterations left. Start consolidating.]（系统提示：工具调用轮数已用 ${Math.round((used / maxTurns) * 100)}%，请开始收敛，优先完成最关键的步骤。）`
}

/** 参数规范化：解析 JSON 后按键排序序列化，键顺序/空白不同的同一参数视为相同 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export function callSignature(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  let args: string
  try {
    args = JSON.stringify(canonical(JSON.parse(call.arguments || '{}')))
  } catch {
    args = (call.arguments ?? '').trim()
  }
  return `${call.name}\u0000${args}`
}

/**
 * 循环检测：按模型给出的顺序记录每个工具调用的签名，同一签名连续出现 REPEAT_LIMIT 次即判为重复。
 * 不同调用穿插会重置计数。
 */
export class RepeatGuard {
  private last = ''
  private count = 0

  constructor(private readonly limit = REPEAT_LIMIT) {}

  /** 记录一次调用；返回 true 表示这次调用已是连续第 limit 次（应拦截） */
  observe(call: Pick<ToolCall, 'name' | 'arguments'>, limit = this.limit): boolean {
    const signature = callSignature(call)
    if (signature === this.last) this.count += 1
    else {
      this.last = signature
      this.count = 1
    }
    return this.count >= limit
  }
}

/**
 * 观察 / 推进实时界面的工具：同样的参数连续调用结果会变（再截一次图看加载完没有、继续往下滚、再按一次方向键），
 * 不能按“结果不会改变”在第 3 次拦截，只在明显死循环时（STATEFUL_REPEAT_LIMIT 次）拦。
 */
export const STATEFUL_TOOLS = new Set([
  'computer_screenshot',
  'computer_scroll',
  'computer_key',
  'computer_cursor',
  'browser_snapshot',
  'browser_screenshot',
  'browser_scroll',
  'browser_wait',
  'browser_read',
])
export const STATEFUL_REPEAT_LIMIT = 8

export function repeatLimitFor(name: string): number {
  return STATEFUL_TOOLS.has(name) ? STATEFUL_REPEAT_LIMIT : REPEAT_LIMIT
}

export function repeatBlockedResult(name: string, times = REPEAT_LIMIT): string {
  if (STATEFUL_TOOLS.has(name)) {
    // 实时界面工具：不停用工具、不结束本轮，只要求先看清现状再换做法（连按 8 次同一个键往往是没看结果）
    return `（系统拦截：你已经连续 ${times} 次用完全相同的参数调用 ${name}，本次未执行。先截图 / 读页面确认当前状态，再换一种做法；确实做不下去就停下来告诉用户。）`
  }
  return `（系统拦截：你已经连续 ${times} 次用完全相同的参数调用 ${name}，结果不会改变，本次未执行。不要再重复这个调用；请基于已有结果直接回答，或换一种做法。）`
}

export const LOOP_GUARD_PROMPT =
  '（系统提示：检测到你在重复相同的工具调用，工具已停用。请总结目前的进展和已获得的结果，直接回答用户；还缺的信息请明确告诉用户。）'
