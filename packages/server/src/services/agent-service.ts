import { BUILTIN_AGENT, BUILTIN_AGENT_ID, canonicalAgentId, DEFAULT_AGENT_ID } from '../agents.js'
import type { Agent } from '../types.js'
import { KERNELS, type KernelDefinition } from './kernels/catalog.js'
import { kernelService } from './kernels/kernel-service.js'
import { kernelMode, resolveScopedProvider, SCOPED_UNAVAILABLE_REASON } from './kernels/scoped.js'
import { serverSecurity } from './auth-service.js'

/**
 * 会话可选的 Agent = 内核：LULUX（kind builtin，跑 LULUX 自己的 agent 循环）+ 命令行内核（kind kernel）。
 * 旧 persona id 经 canonicalAgentId 映射到内置内核。
 */
export type ResolvedAgent =
  | (Agent & { kind: 'builtin'; persona: string })
  | (Agent & { kind: 'kernel'; kernelId: string; kernel: KernelDefinition })

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

export function isKnownAgentId(id: string): boolean {
  const canonical = canonicalAgentId(id)
  return canonical === BUILTIN_AGENT_ID || kernelAgentIds.has(canonical)
}

export const agentService = {
  /** 内置内核在前（默认），然后是各命令行内核（顺序同内核管理页） */
  list(): Agent[] {
    return [builtinAgent(), ...KERNELS.map(kernelAgent)].map(strip)
  },

  find(id: string | null | undefined): ResolvedAgent | undefined {
    if (!id) return undefined
    const canonical = canonicalAgentId(id)
    if (canonical === BUILTIN_AGENT_ID) return builtinAgent()
    if (canonical.startsWith(KERNEL_AGENT_PREFIX)) {
      const def = KERNELS.find((item) => `${KERNEL_AGENT_PREFIX}${item.id}` === canonical)
      if (def) return kernelAgent(def)
    }
    return undefined
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
