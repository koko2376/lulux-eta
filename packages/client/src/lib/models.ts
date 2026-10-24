import type { Agent, Session } from '../api'
import { t } from '../i18n'

/** 推理强度五档（契约 §6.13）：滑块从“更快”到“更聪明” */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export interface ModelOption {
  providerId: string | null
  /** null = 默认 */
  model: string | null
  label: string
  /** 选中该模型时可用的档位；空 = 不支持 */
  efforts: EffortLevel[]
  /** 滑块形态：graded 分档 / toggle 开关 / fixed 始终思考 / none 未识别；省略时按 efforts 判断 */
  effortMode?: EffortMode
}

export type EffortMode = 'graded' | 'toggle' | 'fixed' | 'none'

/** 选中模型的滑块形态（旧服务端没有 effortMode 时按档位数推断） */
export function effortModeOf(option: ModelOption | null): EffortMode {
  if (!option) return 'none'
  if (option.effortMode) return option.effortMode
  const on = option.efforts.filter((level) => level !== 'off')
  if (on.length > 1) return 'graded'
  return on.length === 1 ? 'toggle' : 'none'
}

export interface ModelGroup {
  id: string
  label: string
  options: ModelOption[]
}

/** GET /api/models 的返回 */
export interface ModelCatalog {
  kernel: string
  kernelName: string
  mode: 'builtin' | 'scoped' | 'global'
  groups: ModelGroup[]
  default: ModelOption
  defaultEffort: EffortLevel | null
  effort: boolean
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function effortLabel(level: EffortLevel): string {
  return t(`modelPicker.effort_${level}`)
}

/** 会话的模型列表按哪个内核来：群聊 → LULUX 内置成员；单聊 → 它的内核（与服务端 sessionModelKernel 一致） */
export function sessionModelKernel(
  session: Pick<Session, 'kind' | 'agentIds'> | null,
  agents: Agent[],
  fallbackAgentId?: string,
): string {
  if (session?.kind === 'group') return 'builtin'
  const id = session?.agentIds[0] ?? fallbackAgentId
  const agent = agents.find((item) => item.id === id)
  return agent?.kind === 'kernel' && agent.kernelId ? agent.kernelId : 'builtin'
}

/** 当前选中的模型项：会话指定的那个；没指定 / 已不在列表里时为默认项 */
export function selectedOption(
  catalog: ModelCatalog | null,
  choice: { providerId: string | null; model: string | null },
): ModelOption | null {
  if (!catalog) return null
  if (choice.model) {
    for (const group of catalog.groups) {
      const hit = group.options.find(
        (option) =>
          option.model === choice.model &&
          (catalog.mode === 'global' || !choice.providerId || option.providerId === choice.providerId),
      )
      if (hit) return hit
    }
  }
  return catalog.default
}

/** 不支持的档位：取不超过它的最高可用档（与服务端 clampEffort 一致） */
export function clampEffort(level: EffortLevel, supported: readonly EffortLevel[]): EffortLevel | null {
  if (!supported.length) return null
  if (supported.includes(level)) return level
  const at = EFFORT_LEVELS.indexOf(level)
  for (let i = at; i >= 1; i -= 1) if (supported.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i]
  if (level !== 'off') {
    const on = EFFORT_LEVELS.find((item) => item !== 'off' && supported.includes(item))
    if (on) return on
  }
  return supported.includes('off') ? 'off' : supported[0]
}

/**
 * 实际生效的档位（显示在胶囊上 / 滑块上）：会话设置 → 默认档（内置内核为全局设置），再按模型收紧。
 * 返回 null 表示“CLI 默认”（global 内核未设置）或模型不支持。
 */
export function effectiveEffort(
  catalog: ModelCatalog | null,
  option: ModelOption | null,
  stored: EffortLevel | null | undefined,
): EffortLevel | null {
  if (!catalog || !option) return null
  const wanted = stored ?? catalog.defaultEffort
  if (!wanted) return null
  return clampEffort(wanted, option.efforts)
}

/** 胶囊上的模型名：太长的 Provider 模型 id 去掉路径前缀（openai/gpt-4o → gpt-4o） */
export function shortModel(label: string): string {
  const tail = label.includes('/') ? label.slice(label.lastIndexOf('/') + 1) : label
  return tail || label
}

/** 模型列表 → 工作流节点下拉需要的 Provider 形状（只取 builtin / scoped 的 Provider 分组） */
export function catalogProviders(
  catalog: ModelCatalog | null,
): Array<{ id: string; name: string; model: string; models: string[] }> | null {
  if (!catalog || catalog.mode === 'global') return null
  return catalog.groups.map((group) => {
    const models = group.options.map((option) => option.model ?? '').filter(Boolean)
    return { id: group.id, name: group.label, model: models[0] ?? '', models }
  })
}
