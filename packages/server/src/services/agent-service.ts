import { BUILTIN_AGENT, BUILTIN_AGENT_ID, canonicalAgentId, DEFAULT_AGENT_ID, splitMemberId } from '../agents.js'
import type { Agent } from '../types.js'
import { KERNELS, type KernelDefinition } from './kernels/catalog.js'
import { kernelService } from './kernels/kernel-service.js'
import { kernelMode, resolveScopedProvider, SCOPED_UNAVAILABLE_REASON } from './kernels/scoped.js'
import { serverSecurity } from './auth-service.js'

/**
 * 会话可选的 Agent = 内核：LULUX（kind builtin，跑 LULUX 自己的 agent 循环）+ 命令行内核（kind kernel）。
 * 旧 persona id 经 canonicalAgentId 映射到内置内核。
 */
/** 群聊成员实例的资料（只在群聊发言时附上；name 会换成带群头衔的显示名，原名在 kernelName） */
export interface MemberExtras {
  kernelName?: string
  role?: string
  instructions?: string
  memberModel?: string | null
}

export type ResolvedAgent =
  | (Agent & MemberExtras & { kind: 'builtin'; persona: string })
  | (Agent & MemberExtras & { kind: 'kernel'; kernelId: string; kernel: KernelDefinition })

const KERNEL_AGENT_PREFIX = 'kernel-'
/** 没有 png 头像的命令行内核（Gemini CLI / Qwen Code）的 avatar 字段：产品图标；客户端按 kernelId 显示 svg 标志 */
export const KERNEL_AGENT_AVATAR = '/icon.png'

function builtinAgent(): ResolvedAgent {
  return {
    id: BUILTIN_AGENT.id,
    name: BUILTIN_AGENT.name,
    description: BUILTIN_AGENT.description,
    avatar: BUILTIN_AGENT.avatar,
    accent: BUILTIN_AGENT.accent,
    kind: 'builtin',
    kernelId: 'builtin',
    available: true,
    unavailableReason: null,
    persona: BUILTIN_AGENT.persona,
  }
}

function kernelAgent(def: KernelDefinition): ResolvedAgent {
  let available = true
  let unavailableReason: string | null = null
  if (!serverSecurity.kernelsAllowed()) {
    available = false
    unavailableReason = '服务器已禁用内核'
  } else if (!kernelService.isInstalled(def.id)) {
    available = false
    unavailableReason = '未安装'
  } else if (kernelMode(def.id) === 'scoped') {
    // scoped：只要求“已安装 + LULUX 有可用 Provider”，不要求 CLI 登录
    if (!resolveScopedProvider()) {
      available = false
      unavailableReason = SCOPED_UNAVAILABLE_REASON
    }
  } else if (kernelService.loginState(def.id) === false) {
    available = false
    unavailableReason = '需要登录'
  }
  return {
    id: `${KERNEL_AGENT_PREFIX}${def.id}`,
    name: def.name,
    // 内核管理页的一行说明，如“Anthropic · npm 包 @anthropic-ai/claude-code”
    description: def.tagline,
    avatar: def.avatar ?? KERNEL_AGENT_AVATAR,
    accent: '#7a7f8c',
    kind: 'kernel',
    kernelId: def.id,
    available,
    unavailableReason,
    kernel: def,
  }
}

function strip(agent: ResolvedAgent): Agent {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
    accent: agent.accent,
    kind: agent.kind,
    kernelId: agent.kernelId,
    available: agent.available,
    unavailableReason: agent.unavailableReason,
  }
}

const kernelAgentIds = new Set(KERNELS.map((def) => `${KERNEL_AGENT_PREFIX}${def.id}`))

/** 内核 id 或其成员实例 id（kernel-claude-code#2）都算已知 */
export function isKnownAgentId(id: string): boolean {
  const { base: canonical } = splitMemberId(canonicalAgentId(id))
  return canonical === BUILTIN_AGENT_ID || kernelAgentIds.has(canonical)
}

/** 只认内核本身（不带 #n 实例后缀）：默认 Agent、工作流节点、定时任务用 */
export function isKnownKernelAgentId(id: string): boolean {
  return splitMemberId(canonicalAgentId(id)).n === 1 && isKnownAgentId(id)
}

/** 成员实例 → 内核 id（kernel-claude-code#2 → kernel-claude-code） */
export function memberKernelId(id: string): string {
  return splitMemberId(canonicalAgentId(id)).base
}

export const agentService = {
  /** 内置内核在前（默认），然后是各命令行内核（顺序同内核管理页） */
  list(): Agent[] {
    return [builtinAgent(), ...KERNELS.map(kernelAgent)].map(strip)
  },

  /** 也认成员实例 id（kernel-claude-code#2）：返回该内核，id 保留实例后缀 */
  find(id: string | null | undefined): ResolvedAgent | undefined {
    if (!id) return undefined
    const full = canonicalAgentId(id)
    const { base: canonical } = splitMemberId(full)
    let agent: ResolvedAgent | undefined
    if (canonical === BUILTIN_AGENT_ID) agent = builtinAgent()
    else if (canonical.startsWith(KERNEL_AGENT_PREFIX)) {
      const def = KERNELS.find((item) => `${KERNEL_AGENT_PREFIX}${item.id}` === canonical)
      if (def) agent = kernelAgent(def)
    }
    if (!agent) return undefined
    return full === agent.id ? agent : { ...agent, id: full }
  },

  /** 过滤未知 id、把旧 id 映射到现行 id、去重（多个旧 persona 会合并成一个内置内核） */
  normalizeIds(input: unknown): string[] {
    if (!Array.isArray(input)) return []
    const result: string[] = []
    for (const value of input) {
      if (typeof value !== 'string') continue
      const canonical = canonicalAgentId(value)
      if (!isKnownAgentId(canonical) || result.includes(canonical)) continue
      result.push(canonical)
    }
    return result
  },

  defaultId(): string {
    return DEFAULT_AGENT_ID
  },
}
