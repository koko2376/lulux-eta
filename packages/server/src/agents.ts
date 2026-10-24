/**
 * 会话的“内核”：LULUX 内核（直接调用 LULUX 里配置的模型）+ 第三方命令行内核
 * （Hermes Agent / Claude Code / Codex / Pi / Gemini CLI / Qwen Code，见 services/kernels/catalog.ts）。
 *
 * 早期版本里会话选择的是 5 个 persona（id 为 lux-*，更早叫 hermes/pi/grok/codex/claude），
 * 它们只是“提示词 + 头像”，都跑在内置模型上。现在选择器只列内核：这些旧 id 全部作为别名
 * 映射到内置内核，老会话与导入的数据不会失效。
 */

/** 内置内核的 Agent id（会话成员 / 消息发送者 / 默认 Agent 设置都用它） */
export const BUILTIN_AGENT_ID = 'builtin'

export const DEFAULT_AGENT_ID = BUILTIN_AGENT_ID

export interface BuiltinAgentDefinition {
  id: string
  name: string
  description: string
  avatar: string
  accent: string
  /** 只存在于服务端的系统提示开头，不会下发到客户端 */
  persona: string
}

/** 名称与说明同内核管理页；头像是 LULUX 产品图标 */
export const BUILTIN_AGENT: BuiltinAgentDefinition = {
  id: BUILTIN_AGENT_ID,
  name: 'LULUX',
  description: '内置 · 随软件更新，无需单独安装',
  avatar: '/icon.png',
  accent: '#c9c4b8',
  persona:
    '你是 LULUX ETA 的内置智能体，长期服务外贸企业：熟悉客户开发信、报价结构、FOB/CIF 条款、' +
    '交期与付款方式谈判，也擅长任务拆解、市场与竞品分析、表格数据处理和商务写作审校。' +
    '回答时先给结论，再给可直接使用的话术、清单或表格，并提醒可能踩坑的细节；区分事实与推测，不夸大承诺。',
}

/**
 * 迁移 2 使用的最早一批 id → persona id（冻结，不要再改：迁移按版本号只跑一次）。
 */
export const LEGACY_AGENT_IDS: Record<string, string> = {
  hermes: 'lux-trade',
  pi: 'lux-planner',
  grok: 'lux-analyst',
  codex: 'lux-data',
  claude: 'lux-writer',
}

/** 已下线的 persona id（以及更早的 id）→ 内置内核 */
export const RETIRED_PERSONA_IDS: readonly string[] = [
  'lux-trade',
  'lux-planner',
  'lux-analyst',
  'lux-data',
  'lux-writer',
  ...Object.keys(LEGACY_AGENT_IDS),
]

const retired = new Set(RETIRED_PERSONA_IDS)

/**
 * 群聊成员实例：同一个内核可以多次进群，第 2 个起 id 带序号后缀（kernel-claude-code#2）。
 * 第 1 个就是内核原 id，旧群聊数据无需迁移。序号 2–99。
 */
export const MEMBER_INSTANCE_MAX = 99
const INSTANCE_RE = /^(.+)#([0-9]{1,2})$/

/** 拆出成员实例的内核 id 与序号（没有后缀时序号为 1）；后缀不合法时原样当作内核 id */
export function splitMemberId(id: string): { base: string; n: number } {
  const match = INSTANCE_RE.exec(id)
  if (match) {
    const n = Number(match[2])
    if (n >= 2 && n <= MEMBER_INSTANCE_MAX && String(n) === match[2]) return { base: match[1], n }
  }
  return { base: id, n: 1 }
}

export function memberInstanceId(base: string, n: number): string {
  return n <= 1 ? base : `${base}#${n}`
}

/** 旧 id → 现行 id；其余原样返回（成员实例保留序号后缀） */
export function canonicalAgentId(id: string): string {
  const { base, n } = splitMemberId(id)
  const canonical = retired.has(base) ? BUILTIN_AGENT_ID : base
  return memberInstanceId(canonical, n)
}
