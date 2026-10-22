import { settingsService } from '../settings-service.js'

/**
 * 模型能力矩阵。按模型名匹配（不区分大小写，第一条命中的规则生效），再依次叠加：
 * Provider 发现模型时从上游元数据识别到的能力 → 设置 `modelCapabilities`（按模型名，支持 * 通配）
 * → Provider 里按模型手动设置的“思考强度” → 本进程从上游报错里学到的降级。
 * 数值是保守默认：宁可早一点压缩上下文，也不要撞上游上限。
 */
export type ReasoningStyle = 'none' | 'deepseek' | 'qwen' | 'openai' | 'anthropic'

export interface ModelCapabilities {
  /** 上下文窗口（输入+输出 token） */
  contextWindow: number
  /** 单次最大输出 token */
  maxOutput: number
  /** 是否支持 function calling / tool use */
  tools: boolean
  /** 是否支持图片输入 */
  vision: boolean
  /**
   * 推理风格，决定思考强度怎么发给上游：
   *  - openai：reasoning_effort（low / medium / high / xhigh）
   *  - anthropic：thinking.budget_tokens（按档位换算预算）
   *  - qwen：enable_thinking + thinking_budget
   *  - deepseek：只回传 reasoning_content；thinkingToggle 为 true 时用 thinking.type 开 / 关
   *  - none：不支持
   */
  reasoning: ReasoningStyle
  /** deepseek 风格：是否接受 thinking: {type: enabled|disabled} 开关（DeepSeek V3.1+、GLM-4.5+、豆包 Seed） */
  thinkingToggle: boolean
  /** OpenAI 兼容：是否支持 stream_options.include_usage */
  streamUsage: boolean
  /** 是否接受 temperature 等采样参数（o 系列/gpt-5 不接受） */
  temperature: boolean
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 32_000,
  maxOutput: 4096,
  tools: true,
  vision: false,
  reasoning: 'none',
  thinkingToggle: false,
  streamUsage: true,
  temperature: true,
}

/**
 * 面向用户的“思考强度”类型（Provider 设置里按模型手动选择 / 发现模型时自动识别）：
 *  - openai / anthropic / qwen：可分档调节
 *  - toggle：只能开 / 关（thinking.type）
 *  - fixed：始终思考，无法调节
 *  - none：不支持
 */
export const REASONING_CHOICES = ['openai', 'anthropic', 'qwen', 'toggle', 'fixed', 'none'] as const
export type ReasoningChoice = (typeof REASONING_CHOICES)[number]

export function isReasoningChoice(value: unknown): value is ReasoningChoice {
  return typeof value === 'string' && (REASONING_CHOICES as readonly string[]).includes(value)
}

export function choicePatch(choice: ReasoningChoice): Pick<ModelCapabilities, 'reasoning' | 'thinkingToggle'> {
  switch (choice) {
    case 'toggle':
      return { reasoning: 'deepseek', thinkingToggle: true }
    case 'fixed':
      return { reasoning: 'deepseek', thinkingToggle: false }
    default:
      return { reasoning: choice, thinkingToggle: false }
  }
}

export function choiceOf(caps: Pick<ModelCapabilities, 'reasoning' | 'thinkingToggle'>): ReasoningChoice {
  if (caps.reasoning === 'deepseek') return caps.thinkingToggle ? 'toggle' : 'fixed'
  return caps.reasoning
}

/** Provider 上按模型保存的能力：reasoning = 手动设置，detected = 发现模型时从上游元数据识别 */
export interface ModelCapEntry {
  reasoning?: ReasoningChoice
  detected?: ReasoningChoice
}
export type ModelCapsMap = Record<string, ModelCapEntry>

/** capabilitiesFor 的第二个参数：Provider 类型字符串，或带按模型能力的 Provider */
export type CapabilityContext = string | { kind: string; modelCaps?: ModelCapsMap } | undefined

function capEntry(map: ModelCapsMap | undefined, model: string): ModelCapEntry | undefined {
  if (!map) return undefined
  if (map[model]) return map[model]
  const lower = model.toLowerCase().trim()
  const key = Object.keys(map).find((item) => item.toLowerCase().trim() === lower)
  return key ? map[key] : undefined
}

type Rule = [RegExp, Partial<ModelCapabilities>]

const OPENAI_REASONING: Partial<ModelCapabilities> = { reasoning: 'openai', temperature: false }
const TOGGLE: Partial<ModelCapabilities> = { reasoning: 'deepseek', thinkingToggle: true }
const FIXED: Partial<ModelCapabilities> = { reasoning: 'deepseek' }

/**
 * 模型名前可以带厂商前缀或中转站别名（openai/gpt-5、azure-gpt-5、my-gpt5），
 * 所以多数规则用“开头或非字母数字”作左边界，而不是锚定 ^。
 */
const RULES: Rule[] = [
  // Anthropic（含 claude-4.5-sonnet、claude-3.7-sonnet 这类别名写法）
  [/claude-(opus|sonnet|haiku)-[4-9]|claude-[4-9](?:[.-]\d)?-(opus|sonnet|haiku)|claude-3[.-]7/, { contextWindow: 200_000, maxOutput: 32_000, vision: true, reasoning: 'anthropic' }],
  [/claude-3[.-]5-haiku|claude-3-haiku/, { contextWindow: 200_000, maxOutput: 8192, vision: true }],
  [/claude/, { contextWindow: 200_000, maxOutput: 8192, vision: true }],
  // OpenAI：gpt-5-chat / gpt-5.x-chat 是非推理版本
  [/(?:^|[^a-z0-9])gpt-?[5-9](?:\.\d+)?-chat/, { contextWindow: 128_000, maxOutput: 16_384, vision: true }],
  [/(?:^|[^a-z0-9])gpt-?5/, { contextWindow: 400_000, maxOutput: 128_000, vision: true, ...OPENAI_REASONING }],
  [/(?:^|[^a-z0-9])gpt-?[6-9]/, { contextWindow: 400_000, maxOutput: 128_000, vision: true, ...OPENAI_REASONING }],
  [/(?:^|[^a-z0-9])gpt-oss/, { contextWindow: 128_000, maxOutput: 32_768, reasoning: 'openai' }],
  [/(?:^|[^a-z0-9])o[1-9](?:-mini|-pro|-preview|-deep-research)?(?:$|[^a-z0-9])/, { contextWindow: 200_000, maxOutput: 100_000, vision: true, ...OPENAI_REASONING }],
  [/codex-(mini|max)/, { contextWindow: 200_000, maxOutput: 100_000, ...OPENAI_REASONING }],
  [/(?:^|[^a-z0-9])gpt-4\.1/, { contextWindow: 1_000_000, maxOutput: 32_768, vision: true }],
  [/(?:^|[^a-z0-9])gpt-4o/, { contextWindow: 128_000, maxOutput: 16_384, vision: true }],
  [/(?:^|[^a-z0-9])gpt-4-turbo/, { contextWindow: 128_000, maxOutput: 4096, vision: true }],
  [/(?:^|[^a-z0-9])gpt-3\.5/, { contextWindow: 16_000, maxOutput: 4096 }],
  // DeepSeek：R1 / reasoner 始终思考；V3.1 起的混合思考模型（含 deepseek-chat、V4）用 thinking.type 开关
  [/deepseek-r1/, { contextWindow: 64_000, maxOutput: 32_000, tools: false, ...FIXED }],
  [/deepseek-reasoner/, { contextWindow: 128_000, maxOutput: 32_000, ...FIXED }],
  [/deepseek-(v3[.-][1-9]|v[4-9]|chat|flash)/, { contextWindow: 128_000, maxOutput: 8192, ...TOGGLE }],
  [/deepseek/, { contextWindow: 128_000, maxOutput: 8192 }],
  // 通义千问：只思考的版本始终思考；instruct / coder 不思考；其余 Qwen3+ 与 qwen-plus/flash/turbo/max 为混合思考
  [/qwq|qvq|qwen[\d.]*-.*thinking/, { contextWindow: 128_000, maxOutput: 16_384, ...FIXED }],
  [/qwen-long/, { contextWindow: 1_000_000, maxOutput: 8192 }],
  [/qwen.*vl/, { contextWindow: 128_000, maxOutput: 8192, vision: true }],
  [/qwen[\d.]*-.*(instruct|coder)|qwen.*-mt-/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/qwen3|qwen-(plus|flash|turbo|max)/, { contextWindow: 128_000, maxOutput: 16_384, reasoning: 'qwen' }],
  [/qwen/, { contextWindow: 128_000, maxOutput: 8192 }],
  // Moonshot Kimi：thinking 版本始终思考
  [/kimi-k2.*thinking|kimi-thinking/, { contextWindow: 256_000, maxOutput: 32_000, ...FIXED }],
  [/kimi-k2|moonshot-v1-128k|kimi-latest/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/moonshot-v1-32k/, { contextWindow: 32_000, maxOutput: 4096 }],
  [/moonshot-v1-8k/, { contextWindow: 8000, maxOutput: 2048 }],
  // xAI Grok：grok-3-mini 接受 reasoning_effort；grok-4 系列始终推理且拒绝该参数（4.5 起才接受）
  [/grok-3-mini/, { contextWindow: 131_072, maxOutput: 16_384, reasoning: 'openai' }],
  [/grok-4.*non-reasoning/, { contextWindow: 256_000, maxOutput: 16_384 }],
  [/grok-4[.-]?(?:[5-9]|\d{2})(?:$|[^0-9])|grok-[5-9]/, { contextWindow: 256_000, maxOutput: 32_000, ...OPENAI_REASONING }],
  [/grok-4|grok-code/, { contextWindow: 256_000, maxOutput: 32_000, ...FIXED }],
  [/grok/, { contextWindow: 131_072, maxOutput: 8192 }],
  // 智谱 GLM-4.5 起：thinking.type 开关
  [/glm-4\.?[5-9]|glm-[5-9]|glm-z1/, { contextWindow: 128_000, maxOutput: 16_384, ...TOGGLE }],
  [/glm-4-plus|glm-4-long/, { contextWindow: 128_000, maxOutput: 8192 }],
  [/glm-4/, { contextWindow: 128_000, maxOutput: 4096 }],
  // Gemini 2.5 / 3+：OpenAI 兼容接口按 reasoning_effort 换算思考预算 / 思考等级
  [/gemini-(2\.5|[3-9])/, { contextWindow: 1_000_000, maxOutput: 32_768, vision: true, reasoning: 'openai' }],
  [/gemini-2/, { contextWindow: 1_000_000, maxOutput: 8192, vision: true }],
  [/gemini/, { contextWindow: 32_000, maxOutput: 8192, vision: true }],
  // MiniMax M1 / M2：始终思考（<think> 或 reasoning_content）
  [/minimax[-_]?m[1-9]/, { contextWindow: 200_000, maxOutput: 32_000, ...FIXED }],
  // 字节豆包：*-thinking 始终思考；Seed 1.6 起用 thinking.type 开关
  [/doubao.*thinking/, { contextWindow: 128_000, maxOutput: 16_384, ...FIXED }],
  [/doubao-seed|seed-(1\.[6-9]|[2-9])/, { contextWindow: 256_000, maxOutput: 16_384, ...TOGGLE }],
  [/doubao/, { contextWindow: 32_000, maxOutput: 4096 }],
  [/llama-?3\.[1-3]|llama-?4/, { contextWindow: 128_000, maxOutput: 4096 }],
  [/gemma|phi-?[23]|tinyllama|llama-?2/, { contextWindow: 8000, maxOutput: 2048, tools: false }],
]

/**
 * 上游元数据只说明“支不支持”，不说明参数格式：规则已识别出具体风格时保留规则（它知道该怎么发），
 * 元数据只在规则不认识（none）或元数据明确说不支持时生效。
 */
function applyDetected(caps: ModelCapabilities, detected: ReasoningChoice): ModelCapabilities {
  if (detected !== 'none' && caps.reasoning !== 'none') return caps
  return { ...caps, ...choicePatch(detected) }
}

/** 仅按内置规则判断（不含任何覆盖），设置页显示“自动检测”结果时用 */
export function ruleCapabilities(model: string): ModelCapabilities {
  const name = model.toLowerCase().trim()
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const rule = RULES.find(([pattern]) => pattern.test(name) || pattern.test(bare))
  return { ...DEFAULT_CAPABILITIES, ...(rule ? rule[1] : {}) }
}

/** 本进程内学到的降级：上游明确拒绝 tools / stream_options 的模型 */
const learned = new Map<string, Partial<ModelCapabilities>>()

export function learnCapability(model: string, patch: Partial<ModelCapabilities>): void {
  const key = model.toLowerCase().trim()
  learned.set(key, { ...(learned.get(key) ?? {}), ...patch })
}

/** 本进程对该模型学到的降级（调用方显式传了能力时，用它补上运行中学到的结果） */
export function learnedPatchFor(model: string): Partial<ModelCapabilities> | undefined {
  return learned.get(model.toLowerCase().trim())
}

/** 用户改了某模型的思考强度设置：丢掉之前学到的推理降级，按新设置重试 */
export function forgetLearnedReasoning(model: string): void {
  const key = model.toLowerCase().trim()
  const patch = learned.get(key)
  if (!patch) return
  const { reasoning: _r, thinkingToggle: _t, ...rest } = patch
  if (Object.keys(rest).length) learned.set(key, rest)
  else learned.delete(key)
}

export function resetLearnedCapabilitiesForTests(): void {
  learned.clear()
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.toLowerCase().replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

const NUMERIC: Array<keyof ModelCapabilities> = ['contextWindow', 'maxOutput']
const BOOLEAN: Array<keyof ModelCapabilities> = ['tools', 'vision', 'thinkingToggle', 'streamUsage', 'temperature']
const REASONING: ReasoningStyle[] = ['none', 'deepseek', 'qwen', 'openai', 'anthropic']

/** 校验并规范化单条覆盖；非法字段抛错（设置校验器使用） */
export function sanitizeCapabilityPatch(raw: unknown): Partial<ModelCapabilities> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('每个模型的能力覆盖必须是对象')
  const out: Partial<ModelCapabilities> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((NUMERIC as string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 256 || value > 10_000_000) {
        throw new Error(`${key} 必须是 256–10000000 之间的整数`)
      }
      ;(out as Record<string, unknown>)[key] = value
    } else if ((BOOLEAN as string[]).includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是 true/false`)
      ;(out as Record<string, unknown>)[key] = value
    } else if (key === 'reasoning') {
      if (typeof value !== 'string' || !REASONING.includes(value as ReasoningStyle)) {
        throw new Error(`reasoning 必须是 ${REASONING.join(' / ')} 之一`)
      }
      out.reasoning = value as ReasoningStyle
    } else {
      throw new Error(`未知能力字段：${key}`)
    }
  }
  return out
}

export function parseCapabilityOverrides(raw: string | undefined | null): Array<[RegExp, Partial<ModelCapabilities>]> {
  if (!raw || !raw.trim()) return []
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是 {"模型名": {...}} 形式的 JSON 对象')
  return Object.entries(parsed as Record<string, unknown>).map(([pattern, patch]) => [
    globToRegExp(pattern),
    sanitizeCapabilityPatch(patch),
  ])
}

function userOverrides(): Array<[RegExp, Partial<ModelCapabilities>]> {
  try {
    return parseCapabilityOverrides(settingsService.get('modelCapabilities'))
  } catch {
    return []
  }
}

export function capabilitiesFor(model: string, context?: CapabilityContext): ModelCapabilities {
  const name = model.toLowerCase().trim()
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const providerKind = typeof context === 'string' ? context : context?.kind
  const entry = typeof context === 'object' ? capEntry(context.modelCaps, model) : undefined
  let caps = ruleCapabilities(model)
  // Anthropic 原生接口不存在 stream_options
  if (providerKind === 'anthropic') caps.streamUsage = false
  if (entry?.detected) caps = applyDetected(caps, entry.detected)
  for (const [pattern, patch] of userOverrides()) {
    if (pattern.test(name) || pattern.test(bare)) caps = { ...caps, ...patch }
  }
  if (entry?.reasoning) caps = { ...caps, ...choicePatch(entry.reasoning) }
  const learnedPatch = learned.get(name)
  if (learnedPatch) caps = { ...caps, ...learnedPatch }
  caps.maxOutput = Math.min(caps.maxOutput, Math.floor(caps.contextWindow / 2))
  return caps
}

/** 只看内置规则 + 上游元数据 + 设置覆盖（不含手动选择与运行时降级）：设置页“自动检测”显示的结果 */
export function autoReasoningChoice(model: string, context?: CapabilityContext): ReasoningChoice {
  const name = model.toLowerCase().trim()
  const bare = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const entry = typeof context === 'object' ? capEntry(context.modelCaps, model) : undefined
  let caps = ruleCapabilities(model)
  if (entry?.detected) caps = applyDetected(caps, entry.detected)
  for (const [pattern, patch] of userOverrides()) {
    if (pattern.test(name) || pattern.test(bare)) caps = { ...caps, ...patch }
  }
  return choiceOf(caps)
}
