import { splitMemberId } from '../../agents.js'
import { agentService, type ResolvedAgent } from '../agent-service.js'
import { validateModelChoice } from '../models/catalog.js'
import type { MemberProfile } from '../../types.js'

/**
 * 群聊成员的显示名（给模型看、@ 解析、事件里的 name）：
 * 名字始终是内核原名，群头衔跟在后面——「Claude Code（跟单员）」。
 * 同一内核没有头衔（或头衔重复）时用序号区分——「Claude Code #2」。
 */
export function memberLabels(members: ResolvedAgent[], profiles: Record<string, MemberProfile>): Map<string, string> {
  const base = new Map<string, string>()
  for (const member of members) {
    const role = profiles[member.id]?.role?.trim()
    base.set(member.id, role ? `${member.name}（${role}）` : member.name)
  }
  const counts = new Map<string, number>()
  for (const label of base.values()) counts.set(label, (counts.get(label) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const member of members) {
    const label = base.get(member.id)!
    labels.set(member.id, (counts.get(label) ?? 0) > 1 ? `${label} #${splitMemberId(member.id).n}` : label)
  }
  return labels
}

/** 给群聊成员附上资料：name 换成显示名（kernelName 保留原名）、群头衔、职责、模型 */
export function decorateMembers(members: ResolvedAgent[], profiles: Record<string, MemberProfile>): ResolvedAgent[] {
  const labels = memberLabels(members, profiles)
  return members.map((member) => {
    const profile = profiles[member.id]
    return {
      ...member,
      kernelName: member.name,
      name: labels.get(member.id) ?? member.name,
      role: profile?.role?.trim() || undefined,
      instructions: profile?.instructions?.trim() || undefined,
      memberModel: profile?.model ?? null,
    }
  })
}

/** 成员自己的系统提示补充：群里的身份与职责 */
export function memberIdentityPrompt(member: ResolvedAgent): string {
  if (!member.role && !member.instructions) return ''
  const lines = [`你在本群的身份：「${member.name}」${member.role ? `，群头衔「${member.role}」` : ''}。`]
  if (member.instructions) lines.push(`你的职责：${member.instructions}`)
  lines.push('按这个身份发言，只做你职责范围内的事；别人点名你时再补充。')
  return lines.join('\n')
}

/**
 * 成员资料里的模型必须是该成员内核可用的模型（内置 / scoped：会话 Provider 的模型；global CLI：内核的模型表）。
 * 不合法时抛 400 UNKNOWN_MODEL（不做部分修改）。
 */
export function validateMemberModels(
  members: Array<{ agentId: string; model?: string | null }>,
  providerId: string | null,
): void {
  for (const member of members) {
    const model = member.model?.trim()
    if (!model) continue
    const agent = agentService.find(member.agentId)
    if (!agent) continue
    validateModelChoice(agent.kind === 'kernel' ? agent.kernelId : 'builtin', { providerId, model }, { providerId })
  }
}
