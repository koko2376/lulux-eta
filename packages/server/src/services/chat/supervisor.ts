import { BUILTIN_AGENT_ID } from '../../agents.js'
import type { ResolvedAgent } from '../agent-service.js'
import type { ToolSpec } from '../tools/registry.js'
import { parseMentions } from './mentions.js'

/**
 * 群聊主管（supervisor）：没有显式 @/指定时，主管先规划由谁回答（dispatch），成员按分工回答，
 * 最后主管汇总。会话的 supervisorId：'builtin'（默认，LULUX）/ 某个成员的 Agent id / 'none'（无主管，旧行为）。
 */
export const SUPERVISOR_NONE = 'none'
export const DEFAULT_SUPERVISOR_ID = BUILTIN_AGENT_ID
export const DISPATCH_TOOL_NAME = 'dispatch_members'

export type SupervisorRole = 'plan' | 'summary'

/** 各内核擅长的方向（写进主管的规划提示，帮助它分工） */
const STRENGTHS: Record<string, string> = {
  builtin: 'LULUX 业务数据与工具（客户、报价、邮件、订单、任务）、联网搜索、外贸业务知识与商务写作',
  hermes: '通用智能体，长任务拆解与多步执行、技能与工具调用',
  'claude-code': '代码与长文档、复杂推理与严谨审校、读写工作区文件',
  codex: '代码生成与修改、数据处理脚本、表格与自动化',
  pi: '轻量编码智能体，快速脚本与小改动',
  grok: '实时信息与市场动态、观点鲜明的分析',
  'gemini-cli': '超长上下文阅读、资料汇总、多语言',
  'qwen-code': '中文写作与本地化、代码',
}

export function strengthsOf(agent: Pick<ResolvedAgent, 'kernelId'>): string {
  return STRENGTHS[agent.kernelId ?? ''] ?? '通用问答'
}

export function kernelLabel(agent: ResolvedAgent): string {
  return agent.kind === 'builtin' ? 'LULUX 内核' : `${agent.kernelName ?? agent.name} 命令行内核`
}

/** 成员名单：一行一个（id、名字、内核、擅长） */
export function rosterLines(candidates: ResolvedAgent[]): string {
  return candidates
    .map(
      (agent) =>
        `- id: ${agent.id} ｜ 名字：${agent.name} ｜ 内核：${kernelLabel(agent)}` +
        (agent.role ? ` ｜ 群头衔：${agent.role}` : '') +
        (agent.instructions ? ` ｜ 职责：${agent.instructions.replace(/\s+/g, ' ').slice(0, 200)}` : ` ｜ 擅长：${strengthsOf(agent)}`),
    )
    .join('\n')
}

/** 规划阶段追加在主管系统提示 / 提示词里的说明 */
export function planInstructions(supervisor: ResolvedAgent, candidates: ResolvedAgent[], structured: boolean): string {
  const how = structured
    ? `需要成员回答时调用工具 ${DISPATCH_TOOL_NAME}，参数 {"members": [成员 id…], "instructions": "给成员的分工说明"}，` +
      '调用后只用一两句话说明分工，不要自己展开回答。'
    : '需要成员回答时，在回复末尾输出一个 JSON 代码块：\n```json\n{"members": ["成员 id"], "instructions": "给成员的分工说明"}\n```\n' +
      '代码块之前只用一两句话说明分工，不要自己展开回答。也可以用「@成员名」点名。'
  return [
    `你是本群聊的主管「${supervisor.name}」。用户的最新消息没有点名，由你决定谁来回答。`,
    '可以派发的成员：',
    rosterLines(candidates),
    '规则：',
    `- 只派发真正需要的成员（通常 1–2 位），按回答顺序排列；不能派发你自己。`,
    `- ${how}`,
    '- 问题简单、你自己就能答好时，直接完整回答，不要派发任何成员。',
    '- 成员回答后由你做最终汇总。',
  ].join('\n')
}

/** 汇总阶段的说明 */
export function summaryInstructions(supervisor: ResolvedAgent, spokenNames: string[]): string {
  return [
    `你是本群聊的主管「${supervisor.name}」。${spokenNames.join('、')} 已回答用户的最新消息。`,
    '请给出最终汇总：先给结论，合并各成员的要点，指出分歧并给出你的判断，最后列出下一步。',
    '不要逐条复述成员原话，不要再派发成员，保持简洁。',
  ].join('\n')
}

/** 成员拿到的主管分工 */
export function memberInstructions(supervisor: ResolvedAgent, instructions: string): string {
  return `主管「${supervisor.name}」的分工说明（来自本群主管，请按此回答你负责的部分）：\n${instructions}`
}

export interface DispatchPlan {
  members: string[]
  instructions: string
}

function toIds(values: unknown, candidates: ResolvedAgent[]): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const key = value.trim().replace(/^[@＠]/, '').toLowerCase()
    const hit =
      candidates.find((agent) => agent.id.toLowerCase() === key || agent.name.toLowerCase() === key) ??
      // 群头衔唯一时也认（「跟单员」）
      (() => {
        const byRole = candidates.filter((agent) => agent.role && agent.role.toLowerCase() === key)
        return byRole.length === 1 ? byRole[0] : undefined
      })()
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
}

/** 结构化派发参数 → 去重、只保留候选成员（不含主管自己） */
export function normalizeDispatch(args: Record<string, unknown>, candidates: ResolvedAgent[]): DispatchPlan {
  return {
    members: toIds(args.members, candidates),
    instructions: typeof args.instructions === 'string' ? args.instructions.trim().slice(0, 4000) : '',
  }
}

const FENCED_JSON = /```(?:json)?\s*\n?(\{[\s\S]*?\})\s*```/gi

/**
 * CLI 主管（以及没有调用工具的内置主管）：从回复里解析派发。
 * 优先最后一个含 members 的 JSON 代码块（解析后从正文里去掉）；没有时用 @成员名。
 */
export function parseDispatchText(text: string, candidates: ResolvedAgent[]): DispatchPlan & { cleaned: string } {
  let found: DispatchPlan | null = null
  let cleaned = text
  for (const match of text.matchAll(FENCED_JSON)) {
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && 'members' in parsed) {
        found = normalizeDispatch(parsed, candidates)
        cleaned = cleaned.replace(match[0], '')
      }
    } catch {
      /* 不是合法 JSON：当作普通代码块 */
    }
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  if (found) return { ...found, cleaned }
  const mentioned = parseMentions(text, candidates)
  return { members: mentioned, instructions: '', cleaned: text }
}

/** 内置主管规划用的工具：把参数交给 onDispatch，结果文字让模型收尾 */
export function dispatchToolSpec(candidates: ResolvedAgent[], onDispatch: (plan: DispatchPlan) => DispatchPlan): ToolSpec {
  return {
    name: DISPATCH_TOOL_NAME,
    description: '群聊主管专用：把用户的最新消息派发给指定成员回答（按顺序），并附上分工说明。不能派发自己。',
    inputSchema: {
      type: 'object',
      properties: {
        members: {
          type: 'array',
          items: { type: 'string', enum: candidates.map((agent) => agent.id) },
          description: '要回答的成员 id，按回答顺序',
        },
        instructions: { type: 'string', description: '给这些成员的分工说明（各自负责什么）' },
      },
      required: ['members'],
    },
    risk: 'read',
    group: 'core',
    run(args) {
      const plan = onDispatch(normalizeDispatch(args, candidates))
      if (plan.members.length === 0) return '没有派发任何成员（成员 id 无效或不可用）。请直接回答用户。'
      const names = plan.members.map((id) => candidates.find((agent) => agent.id === id)?.name ?? id)
      return `已派发给：${names.join('、')}。他们会依次回答，之后由你汇总。现在只用一两句话说明分工，不要展开回答。`
    },
  }
}
