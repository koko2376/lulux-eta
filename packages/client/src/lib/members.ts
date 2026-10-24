import type { Agent, MemberProfile, Session } from '../api'

/**
 * 群聊成员实例（与服务端 agents.ts 同一规则）：同一内核可以多次进群，第 2 个起 id 带序号（kernel-claude-code#2）。
 * 名字始终是内核原名；群头衔（role）作为彩色小标签贴在名字旁。
 */
const INSTANCE_RE = /^(.+)#([0-9]{1,2})$/

export function splitMemberId(id: string): { base: string; n: number } {
  const match = INSTANCE_RE.exec(id)
  if (match) {
    const n = Number(match[2])
    if (n >= 2 && n <= 99 && String(n) === match[2]) return { base: match[1]!, n }
  }
  return { base: id, n: 1 }
}

/** 成员实例 → 内核 Agent id */
export function memberKernelId(id: string | null | undefined): string {
  return id ? splitMemberId(id).base : ''
}

/** 按成员 id 找 Agent：实例返回内核 Agent 的副本，id 保留实例后缀 */
export function findMemberAgent(agents: Agent[], id: string | null | undefined): Agent | null {
  if (!id) return null
  const exact = agents.find((agent) => agent.id === id)
  if (exact) return exact
  const base = memberKernelId(id)
  const agent = agents.find((item) => item.id === base)
  return agent ? { ...agent, id } : null
}

export function memberProfile(session: Pick<Session, 'memberProfiles'> | null | undefined, id: string): MemberProfile | null {
  return session?.memberProfiles?.[id] ?? null
}

/**
 * 名字旁的小标签：有群头衔显示群头衔；同一内核多个成员都没头衔时显示序号（#2）。没有就不显示。
 */
export function memberTag(session: Pick<Session, 'agentIds' | 'memberProfiles'> | null | undefined, id: string): string {
  const role = memberProfile(session, id)?.role?.trim()
  if (role) return role
  if (!session) return ''
  const base = memberKernelId(id)
  const siblings = session.agentIds.filter((other) => memberKernelId(other) === base)
  if (siblings.length < 2) return ''
  return `#${splitMemberId(id).n}`
}

/** 标签配色：按文字稳定取色（每个头衔一个颜色） */
const TAG_HUES = [262, 211, 152, 28, 340, 190, 48, 290]
export function memberTagHue(tag: string): number {
  let hash = 0
  for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return TAG_HUES[hash % TAG_HUES.length]!
}

/** 新建 / 编辑群成员时的一行：内核 id + 群头衔（保存时由服务端分配实例序号） */
export interface MemberDraft {
  /** 已有成员的实例 id；新加的成员为内核 id */
  agentId: string
  role: string
  instructions: string
  /** 只在界面里区分行（同一内核可多行） */
  key: string
}

/** 纯文字场景（名单、复制对话、下拉选项）：「Claude Code（跟单员）」 */
export function withMemberTag(name: string, tag: string): string {
  return tag ? `${name}（${tag}）` : name
}

/**
 * 预测保存后的成员实例 id（与服务端 resolveMemberInputs 同一规则）：显式实例 id 先占位，
 * 其余按内核依次取第一个空号（内核 id、#2、#3…）。用于建群前选主管、显示序号。
 */
export function predictMemberIds(drafts: Array<Pick<MemberDraft, 'agentId'>>): string[] {
  const used = new Set<string>()
  const explicit = new Map<number, string>()
  drafts.forEach((draft, index) => {
    if (splitMemberId(draft.agentId).n > 1 && !used.has(draft.agentId)) {
      used.add(draft.agentId)
      explicit.set(index, draft.agentId)
    }
  })
  return drafts.map((draft, index) => {
    const fixed = explicit.get(index)
    if (fixed) return fixed
    const base = memberKernelId(draft.agentId)
    for (let n = 1; n <= 99; n++) {
      const id = n === 1 ? base : `${base}#${n}`
      if (!used.has(id)) {
        used.add(id)
        return id
      }
    }
    return base
  })
}

let draftSeq = 0
export function newMemberDraft(agentId: string, role = '', instructions = ''): MemberDraft {
  draftSeq += 1
  return { agentId, role, instructions, key: `m${draftSeq}` }
}

/** 群成员上限（与服务端 GROUP_MEMBER_MAX 一致） */
export const GROUP_MEMBER_MAX = 12
/** 群头衔最长字数（与服务端一致） */
export const MEMBER_ROLE_MAX = 16
