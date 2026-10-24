import type { Message, ParticipantRole, Session, SessionParticipant } from '../api'

/**
 * 多人群聊（契约 §6.10）的纯函数：谁在群里、谁能管理、消息显示谁发的。
 * 群主 = 会话负责人；群管理员可以改群设置、邀请 / 移出普通成员；普通成员可以发言、退出。
 */

/** 群里的真人（群主在第一个）；单聊 / 旧服务端为空 */
export function humanMembers(session: Pick<Session, 'participants'> | null | undefined): SessionParticipant[] {
  return session?.participants ?? []
}

/** 多人群聊：群主以外还有同事 */
export function isMultiHuman(session: Pick<Session, 'participants'> | null | undefined): boolean {
  return humanMembers(session).length > 1
}

/** 当前用户的角色；旧服务端 / desktop 没有该字段时按群主 */
export function myRole(session: Pick<Session, 'myRole'> | null | undefined): ParticipantRole {
  return session?.myRole ?? 'owner'
}

/** 改群设置（群名、Agent 成员、主管）与邀请 / 移出成员：群主或群管理员 */
export function canManageGroup(session: Pick<Session, 'myRole'> | null | undefined): boolean {
  const role = myRole(session)
  return role === 'owner' || role === 'admin'
}

/** 解散群聊 / 删除会话、设群管理员：只有群主 */
export function isGroupOwner(session: Pick<Session, 'myRole'> | null | undefined): boolean {
  return myRole(session) === 'owner'
}

/** 能否把某位成员移出：不能移出群主；群管理员不能移出其他管理员；自己走“退出群聊” */
export function canRemoveMember(
  session: Pick<Session, 'myRole'> | null | undefined,
  member: SessionParticipant,
  meId: string | null | undefined,
): boolean {
  if (member.role === 'owner' || member.userId === meId) return false
  const role = myRole(session)
  if (role === 'owner') return true
  return role === 'admin' && member.role === 'member'
}

/** 头像上的字：中文取最后一个字（姓名常见写法），其余取首字母大写 */
export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (/[\u4e00-\u9fff]/.test(trimmed)) return [...trimmed].slice(-1)[0] ?? '?'
  const words = trimmed.split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : trimmed.slice(0, 1)
  return letters.toUpperCase()
}

const HUES = [210, 158, 28, 280, 340, 190, 95, 250]

/** 由账号 id 稳定地算出头像底色（同一个人在各处颜色一致） */
export function avatarHue(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return HUES[hash % HUES.length]
}

/**
 * 用户消息显示的发言人：多人群聊里显示名字（自己显示“我”由调用方决定）；
 * 单人会话返回 null（保持原样，不显示发言人）。
 */
export function messageSender(
  message: Pick<Message, 'role' | 'senderUserId' | 'senderName'>,
  session: Pick<Session, 'participants'> | null | undefined,
): { userId: string; name: string } | null {
  if (message.role !== 'user' || !isMultiHuman(session) || !message.senderUserId) return null
  const member = humanMembers(session).find((p) => p.userId === message.senderUserId)
  return { userId: message.senderUserId, name: member?.name ?? message.senderName ?? '' }
}

/** 远端推来的新消息并入当前列表：已有（同 id）忽略；按时间插入 */
export function mergeMessage(list: Message[], incoming: Message): Message[] {
  if (list.some((m) => m.id === incoming.id)) return list
  const next = [...list, incoming]
  next.sort((a, b) => a.createdAt - b.createdAt)
  return next
}
