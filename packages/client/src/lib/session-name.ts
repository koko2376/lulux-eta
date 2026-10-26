import type { Session } from '../api'
import { t } from '../i18n'

/** 服务端默认标题（中文原文），按界面语言显示 */
const SERVER_DEFAULT_TITLE = '新会话'

/**
 * 群聊看会话类型（kind），不看成员数：群聊只能新建，单聊不会因为加成员变成群聊。
 * 旧服务端没有 kind 时按成员数推断。
 */
export function isGroupSession(session: Session | null | undefined): boolean {
  if (!session) return false
  if (session.kind) return session.kind === 'group'
  return session.agentIds.length > 1
}

/**
 * 会话在界面上的展示名：群聊设置了群名时用群名，否则用会话标题。
 * 群名独立于标题。
 */
export function sessionDisplayName(session: Session | null | undefined): string {
  if (!session) return ''
  if (isGroupSession(session) && session.groupName) return session.groupName
  return session.title === SERVER_DEFAULT_TITLE ? t('sessionName.newSession') : session.title
}
