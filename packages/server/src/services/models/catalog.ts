import { AppError } from '../../errors.js'
import type { Provider, ProviderKind } from '../../types.js'
import { findKernel } from '../kernels/catalog.js'
import { kernelMode } from '../kernels/scoped.js'
import { capabilitiesFor, type CapabilityContext } from '../llm/capabilities.js'
import { anthropicThinkingSupported } from '../llm/reasoning-params.js'
import type { ReasoningEffort } from '../llm/types.js'
import { providerService } from '../provider-service.js'
import { settingsService } from '../settings-service.js'
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from './effort.js'

/**
 * 会话模型与推理强度（契约 §6.13）。
 *
 * 模型列表按内核来：
 *  - builtin（LULUX 内置内核）与 scoped 模式的 CLI 内核：已配置 Provider 的模型（Provider 配了模型列表就全列，
 *    否则只列它的默认模型），按 Provider 分组；
 *  - global 模式的 CLI 内核（CLI 自己的登录）：各 CLI 已知的模型名（下表，按各自的 --help / 官方文档核实），
 *    “默认”（不传参数，CLI 自己决定）永远排第一。
 *
 * 推理强度五档：off / low / medium / high / xhigh（界面：关闭 / 低 / 中 / 高 / 极高）。
 *  - builtin：OpenAI 系推理模型 → reasoning_effort；Anthropic 扩展思考 → thinking 预算（llm/anthropic.ts）；
 *    极高只给支持的模型（OpenAI gpt-5.2+ / gpt-6+；Anthropic 单次输出上限 ≥ 64K 的模型）；其他模型只有“关闭”。
 *  - scoped CLI 内核：由本机网关按会话设置给上游加 reasoning_effort（只对 OpenAI 系推理模型；
 *    Anthropic 的思考块带签名，跨协议转发无法回传，所以不开）。
 *  - global CLI 内核：映射成 CLI 自己的参数（CLI_MODELS.efforts 为 null 的内核不显示滑块）。
 */
export { EFFORT_LEVELS, isEffortLevel, type EffortLevel }

const OPENAI_XHIGH = /gpt-5\.(?:[2-9]|\d{2,})|gpt-[6-9]|codex-max/i

const GRADED: EffortLevel[] = ['off', 'low', 'medium', 'high']

function kindOf(context: CapabilityContext): string | undefined {
  return typeof context === 'string' ? context : context?.kind
}

/**
 * 内置内核（直连 Provider）时某个模型支持的档位。context 传 Provider 时会带上它按模型保存的手动设置 / 识别结果。
 *  - openai：reasoning_effort 分档；anthropic：思考预算分档；qwen：thinking_budget 分档
 *  - deepseek + thinkingToggle：只有开 / 关（['off', 'high']，界面显示为开关）
 *  - Anthropic 协议的 Provider：任何可调节的风格都按 thinking 预算分档
 */
export function builtinEfforts(model: string, context: CapabilityContext): EffortLevel[] {
  const caps = capabilitiesFor(model, context)
  if (kindOf(context) === 'anthropic') {
    if (!anthropicThinkingSupported(caps)) return ['off']
    return caps.maxOutput >= 64_000 ? [...EFFORT_LEVELS] : GRADED
  }
  if (caps.reasoning === 'openai') {
    return OPENAI_XHIGH.test(model) ? [...EFFORT_LEVELS] : GRADED
  }
  if (caps.reasoning === 'anthropic') {
    return caps.maxOutput >= 64_000 ? [...EFFORT_LEVELS] : GRADED
  }
  if (caps.reasoning === 'qwen') return GRADED
  if (caps.reasoning === 'deepseek' && caps.thinkingToggle) return ['off', 'high']
  return ['off']
}

/**
 * scoped CLI 内核经网关时支持的档位：OpenAI 兼容 Provider 上的 openai / qwen / 开关风格。
 * Anthropic 的思考块带签名，跨协议转发回不去，所以不在网关里开。
 */
export function gatewayEfforts(model: string, context: CapabilityContext): EffortLevel[] {
  const caps = capabilitiesFor(model, context)
  if (caps.reasoning === 'openai') return OPENAI_XHIGH.test(model) ? [...EFFORT_LEVELS] : GRADED
  if (kindOf(context) === 'anthropic') return ['off']
  if (caps.reasoning === 'qwen') return GRADED
  if (caps.reasoning === 'deepseek' && caps.thinkingToggle) return ['off', 'high']
  return ['off']
}

/** 滑块的形态：graded = 分档滑块；toggle = 开关；fixed = 始终思考不可调；none = 未识别到支持 */
export type EffortMode = 'graded' | 'toggle' | 'fixed' | 'none'

export function effortModeFor(model: string, context: CapabilityContext, efforts: readonly EffortLevel[]): EffortMode {
  if (efforts.length > 2) return 'graded'
  if (efforts.length === 2) return 'toggle'
  const caps = capabilitiesFor(model, context)
  return caps.reasoning === 'deepseek' && !caps.thinkingToggle ? 'fixed' : 'none'
}

/**
 * 请求的档位不受支持时：取不超过它的最高可用档；都没有则取最低可用档。
 * 要求了思考（非“关闭”）而低档都不可用时（开关风格只有 off / high），取最低的非关闭档。
 */
export function clampEffort(requested: EffortLevel, supported: readonly EffortLevel[]): EffortLevel {
  if (supported.includes(requested)) return requested
  const at = EFFORT_LEVELS.indexOf(requested)
  for (let i = at; i >= 1; i -= 1) if (supported.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!
  if (requested !== 'off') {
    const on = EFFORT_LEVELS.find((level) => level !== 'off' && supported.includes(level))
    if (on) return on
  }
  return supported.includes('off') ? 'off' : (supported[0] ?? 'off')
}

/** 全局默认推理强度（设置 → 内置内核） */
export function defaultEffort(): EffortLevel {
  const value = settingsService.get('reasoningEffort')
  return isEffortLevel(value) ? value : 'off'
}

/** 内置内核实际使用的推理强度：会话设置 → 全局默认，再按模型能力收紧 */
export function effectiveBuiltinEffort(
  requested: EffortLevel | null | undefined,
  model: string,
  context: CapabilityContext,
): ReasoningEffort {
  return clampEffort(requested ?? defaultEffort(), builtinEfforts(model, context))
}

/** scoped CLI 内核经网关的推理强度：只有会话显式设置时才加（null = 不改 CLI 自己的请求） */
export function effectiveGatewayEffort(
  requested: EffortLevel | null | undefined,
  model: string,
  context: CapabilityContext,
): ReasoningEffort | null {
  if (!requested) return null
  const supported = gatewayEfforts(model, context)
  const effort = clampEffort(requested, supported)
  // 能关的模型（qwen / 开关风格）显式选“关闭”时要发关闭参数；只能分档的 OpenAI 系“关闭” = 不改
  if (effort === 'off') return supported.length > 1 && capabilitiesFor(model, context).reasoning !== 'openai' ? 'off' : null
  return effort
}

export interface CliModelSpec {
  /** 已知模型名（“默认”不在其中，由界面固定放第一） */
  models: string[]
  /** 支持的推理强度档；null = CLI 没有对应参数（隐藏滑块） */
  efforts: EffortLevel[] | null
  /** 核实来源（写进契约） */
  source: string
}

/**
 * global 模式 CLI 内核的模型 / 推理强度参数（2026-10-21 核实）：
 *  - Claude Code：`--model <alias|name>`（default / sonnet / opus / haiku / fable / opusplan / sonnet[1m] / opus[1m]），
 *    `--effort low|medium|high|xhigh`（code.claude.com/docs/en/model-config；思考不能关，所以没有“关闭”）
 *  - Codex：`exec -m <model>`，`-c model_reasoning_effort="low|medium|high|xhigh"`
 *    （developers.openai.com/codex/models、/codex/config-reference）
 *  - Gemini CLI：`-m, --model`（gemini-cli docs/cli/model.md），无推理强度参数
 *  - Qwen Code：`-m, --model`（qwen-code 文档 configuration/settings），无推理强度参数
 *  - Grok：`-m, --model <MODEL>`（docs.x.ai/build/cli/headless-scripting），无推理强度参数
 *  - Pi：`--model <pattern>`（模糊匹配），`--thinking off|minimal|low|medium|high|xhigh|max`（包内 docs/cli.md）
 *  - Hermes Agent：模型由 `hermes model` 选定的 Provider 决定，只提供“默认”
 */
export const CLI_MODELS: Record<string, CliModelSpec> = {
  'claude-code': {
    models: ['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'sonnet[1m]', 'opus[1m]'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    source: 'claude --model / --effort',
  },
  codex: {
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    source: 'codex exec -m / -c model_reasoning_effort',
  },
  'gemini-cli': {
    models: ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    efforts: null,
    source: 'gemini -m',
  },
  'qwen-code': {
    models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    efforts: null,
    source: 'qwen -m',
  },
  grok: {
    models: ['grok-build-0.1', 'grok-4.7', 'grok-4.6'],
    efforts: null,
    source: 'grok -m',
  },
  pi: {
    models: ['sonnet', 'opus', 'haiku'],
    efforts: ['off', 'low', 'medium', 'high', 'xhigh'],
    source: 'pi --model / --thinking',
  },
  hermes: { models: [], efforts: null, source: 'hermes（模型由 hermes model 决定）' },
}

/** 模型名只作为单独的 argv 元素传给 CLI；仍然拒绝以 - 开头或含空白 / 控制字符的值 */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,119}$/

export function assertSafeModel(model: string): void {
  if (!SAFE_MODEL.test(model)) throw new AppError(400, 'VALIDATION_ERROR', `模型名不合法：${model.slice(0, 40)}`)
}

/**
 * global 模式：把会话的模型 / 推理强度拼进 CLI 参数（model / effort 为 null 时不加，CLI 用自己的默认）。
 * 不认识的内核原样返回。
 */
export function applyCliModel(
  kernelId: string,
  input: string[],
  model: string | null | undefined,
  effort: EffortLevel | null | undefined,
): { args: string[]; env: Record<string, string> } {
  const spec = CLI_MODELS[kernelId]
  const args = [...input]
  const env: Record<string, string> = {}
  if (!spec) return { args, env }
  const level = effort && spec.efforts ? clampEffort(effort, spec.efforts) : null
  // 运行时再按白名单校验一次：内核从 scoped 切到 global 后，会话里存的 Provider 模型名不在白名单 → 忽略，用 CLI 默认
  const picked = model?.trim() || null
  if (picked) assertSafeModel(picked)
  const m = picked && spec.models.includes(picked) ? picked : null
  switch (kernelId) {
    case 'claude-code':
      if (m) args.push('--model', m)
      if (level) args.push('--effort', level)
      break
    case 'codex': {
      // -m / -c 属于 exec 子命令：放在 exec 之后，避免被末尾的 `-`（stdin 提示词）之后的位置吞掉
      const extra: string[] = []
      if (m) extra.push('-m', m)
      if (level) extra.push('-c', `model_reasoning_effort="${level}"`)
      const at = args.indexOf('exec')
      if (at >= 0) args.splice(at + 1, 0, ...extra)
      else args.unshift(...extra)
      break
    }
    case 'gemini-cli':
    case 'qwen-code':
    case 'grok':
      if (m) args.push('-m', m)
      break
    case 'pi':
      if (m) args.push('--model', m)
      if (level) args.push('--thinking', level)
      break
    default:
      break
  }
  return { args, env }
}

export interface ModelOption {
  /** CLI 模型为 null */
  providerId: string | null
  /** null = 默认 */
  model: string | null
  label: string
  /** 选中该模型时可用的推理强度档；空数组 = 不支持（滑块隐藏或全部置灰） */
  efforts: EffortLevel[]
  /** 滑块形态（Provider 模型才有；CLI 模型省略 = 按 efforts 判断） */
  effortMode?: EffortMode
}

export interface ModelGroup {
  id: string
  label: string
  options: ModelOption[]
}

export interface ModelCatalog {
  kernel: string
  kernelName: string
  mode: 'builtin' | 'scoped' | 'global'
  groups: ModelGroup[]
  /** 会话没选模型（model = null）时实际使用的模型 */
  default: ModelOption
  /** 会话没选推理强度时的档位：builtin 为全局设置，CLI 内核为 null（CLI 自己的默认） */
  defaultEffort: EffortLevel | null
  /** 是否显示推理强度滑块（global 模式且 CLI 没有对应参数时为 false） */
  effort: boolean
}

function providerModels(provider: Provider): string[] {
  const list = provider.models.length ? provider.models : provider.model ? [provider.model] : []
  return [...new Set(list.filter(Boolean))]
}

function defaultProvider(): Provider | null {
  const id = settingsService.get('defaultProviderId')
  return (id ? providerService.get(id) : undefined) ?? providerService.list()[0] ?? null
}

function providerCatalog(
  kernel: string,
  kernelName: string,
  mode: 'builtin' | 'scoped',
  sessionProviderId?: string | null,
): ModelCatalog {
  const effortsOf = mode === 'builtin' ? builtinEfforts : gatewayEfforts
  const groups: ModelGroup[] = providerService.list().map((provider) => ({
    id: provider.id,
    label: provider.name,
    options: providerModels(provider).map((model) => option(provider, model, model)),
  }))
  function option(provider: Provider, model: string | null, label: string): ModelOption {
    const target = model ?? provider.model
    const efforts = effortsOf(target, provider)
    return { providerId: provider.id, model, label, efforts, effortMode: effortModeFor(target, provider, efforts) }
  }
  const base = (sessionProviderId ? providerService.get(sessionProviderId) : undefined) ?? defaultProvider()
  const def: ModelOption = base?.model
    ? option(base, null, base.model)
    : { providerId: null, model: null, label: '', efforts: ['off'], effortMode: 'none' }
  return {
    kernel,
    kernelName,
    mode,
    groups,
    default: def,
    defaultEffort: mode === 'builtin' ? defaultEffort() : null,
    effort: true,
  }
}

/** GET /api/models?kernel=builtin|<kernelId> */
export function modelCatalog(kernel: string, sessionProviderId?: string | null): ModelCatalog {
  if (!kernel || kernel === 'builtin') return providerCatalog('builtin', 'LULUX', 'builtin', sessionProviderId)
  const def = findKernel(kernel)
  if (!def) throw new AppError(404, 'NOT_FOUND', '内核不存在')
  if (kernelMode(def.id) === 'scoped') return providerCatalog(def.id, def.name, 'scoped', sessionProviderId)
  const spec = CLI_MODELS[def.id] ?? { models: [], efforts: null, source: '' }
  const efforts = spec.efforts ?? []
  return {
    kernel: def.id,
    kernelName: def.name,
    mode: 'global',
    groups: [
      {
        id: def.id,
        label: def.name,
        options: spec.models.map((model) => ({ providerId: null, model, label: model, efforts })),
      },
    ],
    default: { providerId: null, model: null, label: '默认', efforts },
    defaultEffort: null,
    effort: Boolean(spec.efforts),
  }
}

/**
 * PATCH 会话时校验模型选择：builtin / scoped 必须是某个 Provider 的模型（providerId 省略时按会话 / 默认 Provider）；
 * global CLI 内核只接受已知模型名。返回规范化后的 providerId（global 时保持原值）。
 */
export function validateModelChoice(
  kernel: string,
  choice: { providerId: string | null | undefined; model: string | null },
  current: { providerId: string | null },
): { providerId: string | null; model: string | null } {
  const catalog = modelCatalog(kernel, choice.providerId ?? current.providerId)
  if (catalog.mode === 'global') {
    if (choice.model === null) return { providerId: current.providerId, model: null }
    if (!catalog.groups[0]!.options.some((option) => option.model === choice.model)) {
      throw new AppError(400, 'UNKNOWN_MODEL', `${catalog.kernelName} 不支持模型「${choice.model}」`)
    }
    return { providerId: current.providerId, model: choice.model }
  }
  const providerId = choice.providerId === undefined ? current.providerId : choice.providerId
  if (providerId && !providerService.get(providerId)) throw new AppError(400, 'UNKNOWN_PROVIDER', 'Provider 不存在')
  if (choice.model === null) return { providerId, model: null }
  const target = (providerId ? providerService.get(providerId) : undefined) ?? defaultProvider()
  if (!target || !providerModels(target).includes(choice.model)) {
    throw new AppError(400, 'UNKNOWN_MODEL', `Provider「${target?.name ?? '?'}」没有模型「${choice.model}」`)
  }
  return { providerId: providerId ?? null, model: choice.model }
}

/** 会话模型落在某个 Provider 上：只有它是该 Provider 的模型时才覆盖默认模型 */
export function withSessionModel(provider: Provider, model: string | null | undefined): Provider {
  if (!model || model === provider.model) return provider
  return providerModels(provider).includes(model) ? { ...provider, model } : provider
}
