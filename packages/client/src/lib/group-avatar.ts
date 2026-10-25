import type { Agent, Session } from '../api'
import { kernelAvatar, kernelVariantAvatar } from './kernel-logos'
import { splitMemberId } from './members'

/** 内置 LULUX 内核的 Agent id（也是群聊默认主管） */
export const BUILTIN_AGENT_ID = 'builtin'
/** 群聊“无主管”的取值 */
export const SUPERVISOR_NONE = 'none'

/** 群头像里最多显示的格子数；成员更多时前 3 个 + “+N” */
export const GROUP_AVATAR_MAX_CELLS = 4

export type GroupAvatarMember =
  { type: 'agent'; id: string; supervisor: boolean } | { type: 'human'; userId: string; name: string }

export type GroupAvatarCell = GroupAvatarMember | { type: 'more'; count: number }

/** 格子在方块里的位置与边长（百分比，相对整个群头像） */
export interface GroupAvatarSlot {
  left: number
  top: number
  size: number
}

/**
 * Agent 头像图片：内核角色图 / 标志（tile=true 时放在方块里）；未知内核用服务端给的 avatar，
 * 都没有用产品图标。
 */
export function agentAvatarSource(
  agent: (Pick<Agent, 'kind' | 'kernelId' | 'avatar'> & { id?: string }) | null | undefined,
  look = 1,
): {
  src: string
  tile: boolean
} {
  if (!agent) return { src: '/icon.png', tile: false }
  const kernel = agent.kind === 'kernel' ? agent.kernelId : BUILTIN_AGENT_ID
  // 同一内核在群里的第 2、3… 个实例：换一个形象（保留额头的内核标志），一眼分得清
  // 单聊会话：按会话换形象（look），侧栏里同一内核的会话不再一模一样
  const instance = agent.id ? splitMemberId(agent.id).n : 1
  const n = instance > 1 ? instance : look
  if (n > 1) {
    const variant = kernelVariantAvatar(kernel, n)
    if (variant) return { src: variant, tile: false }
  }
  const local = kernelAvatar(kernel)
  if (local) return local
  return { src: agent.avatar || '/icon.png', tile: false }
}

/** 群聊主管 id：缺省按内置 LULUX；'none' 表示没有主管 */
export function groupSupervisorId(session: Pick<Session, 'supervisorId'>): string | null {
  const id = session.supervisorId ?? BUILTIN_AGENT_ID
  return id === SUPERVISOR_NONE || !id ? null : id
}

/**
 * 群头像成员顺序：主管（有的话）→ 其余 Agent → 同事（多人群聊里除自己以外的真人）。
 * 同一个 Agent 只出现一次。
 */
export function groupAvatarMembers(
  session: Pick<Session, 'agentIds' | 'supervisorId' | 'participants'>,
  meId?: string | null,
): GroupAvatarMember[] {
  const out: GroupAvatarMember[] = []
  const seen = new Set<string>()
  const supervisor = groupSupervisorId(session)
  if (supervisor) {
    out.push({ type: 'agent', id: supervisor, supervisor: true })
    seen.add(supervisor)
  }
  for (const id of session.agentIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ type: 'agent', id, supervisor: false })
  }
  const humans = session.participants ?? []
  if (humans.length > 1) {
    for (const p of humans) {
      if (meId && p.userId === meId) continue
      out.push({ type: 'human', userId: p.userId, name: p.name })
    }
  }
  return out
}

/** 要画的格子：不超过 4 个；超过时前 3 个成员 + “+N”（N = 没画出来的人数） */
export function groupAvatarCells(members: GroupAvatarMember[]): GroupAvatarCell[] {
  if (members.length <= GROUP_AVATAR_MAX_CELLS) return members
  const shown = members.slice(0, GROUP_AVATAR_MAX_CELLS - 1)
  return [...shown, { type: 'more', count: members.length - shown.length }]
}

const PAD = 7
const GAP = 3
const CELL = (100 - PAD * 2 - GAP) / 2
const MID = (100 - CELL) / 2
const FAR = PAD + CELL + GAP

/**
 * 格子位置：1 个居中放大；2 个左右并排；3 个上 1 下 2；4 个 2×2。
 */
export function groupAvatarLayout(count: number): GroupAvatarSlot[] {
  const n = Math.max(0, Math.min(count, GROUP_AVATAR_MAX_CELLS))
  if (n === 0) return []
  if (n === 1) {
    const size = 100 - PAD * 2 - 14
    const at = (100 - size) / 2
    return [{ left: at, top: at, size }]
  }
  if (n === 2) {
    return [
      { left: PAD, top: MID, size: CELL },
      { left: FAR, top: MID, size: CELL },
    ]
  }
  if (n === 3) {
    return [
      { left: MID, top: PAD, size: CELL },
      { left: PAD, top: FAR, size: CELL },
      { left: FAR, top: FAR, size: CELL },
    ]
  }
  return [
    { left: PAD, top: PAD, size: CELL },
    { left: FAR, top: PAD, size: CELL },
    { left: PAD, top: FAR, size: CELL },
    { left: FAR, top: FAR, size: CELL },
  ]
}

/** 形象数：原头像 + 5 个实例形象 */
export const AVATAR_LOOKS = 6

/** 单聊会话的形象编号 1..6：用服务端给的 avatarLook；没有（旧服务端）按会话 id 算一个固定值 */
export function sessionLook(session: Pick<Session, 'id' | 'avatarLook'> | null | undefined): number {
  if (!session) return 1
  const look = session.avatarLook
  if (typeof look === 'number' && Number.isInteger(look) && look >= 1 && look <= AVATAR_LOOKS) return look
  let h = 2166136261
  for (let i = 0; i < session.id.length; i++) {
    h ^= session.id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % AVATAR_LOOKS) + 1
}
