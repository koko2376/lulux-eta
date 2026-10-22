/**
 * 鉴权、团队、审计与实时事件（docs/API-CONTRACT.md §4.8、§5）。
 */
import { apiUrl, authHeaders, request } from './http'
import type { Customer } from './index'

export type Visibility = 'private' | 'team' | 'org'
export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export type Permission =
  | 'data:read'
  | 'data:write'
  | 'data:export'
  | 'data:import'
  | 'customer:delete'
  | 'customer:import'
  | 'deal:delete'
  | 'quote:delete'
  | 'order:delete'
  | 'task:delete'
  | 'workflow:manage'
  | 'catalog:write'
  | 'settings:write'
  | 'providers:write'
  | 'members:manage'
  | 'audit:read'
  | 'email:send'
  | 'security:manage'

export const ALL_PERMISSIONS: Permission[] = [
  'data:read',
  'data:write',
  'data:export',
  'data:import',
  'customer:delete',
  'customer:import',
  'deal:delete',
  'quote:delete',
  'order:delete',
  'task:delete',
  'workflow:manage',
  'catalog:write',
  'settings:write',
  'providers:write',
  'members:manage',
  'audit:read',
  'email:send',
  'security:manage',
]

export interface User {
  id: string
  email: string
  name: string
  role: Role
  disabled: boolean
  /** 管理员设置 / 重置过密码：下次登录必须先修改（旧服务端没有这个字段） */
  mustChangePassword?: boolean
  createdAt: number
  lastLoginAt: number | null
}
export type PermissionEffect = 'grant' | 'deny'
export type PermissionOverrides = Partial<Record<Permission, PermissionEffect>>
/** 成员列表里的成员：团队服务器返回覆盖项与生效权限（旧服务端没有这两个字段） */
export interface Member extends User {
  permissionOverrides?: PermissionOverrides
  permissions?: Permission[]
}
export interface Org {
  id: string
  name: string
  createdAt: number
}
export interface Team {
  id: string
  name: string
  memberIds: string[]
  createdAt: number
}
export interface Me {
  mode: 'desktop' | 'server'
  user: User
  org: Org
  teams: Team[]
  permissions: Permission[]
  session: { expiresAt: number } | null
}
export interface AuthMode {
  mode: 'desktop' | 'server'
  setupRequired: boolean
  version: string
  publicOrigin: string | null
}
export interface LoginResult {
  token: string
  expiresAt: number
  user: User
  org: Org
}
export interface Invite {
  id: string
  role: Exclude<Role, 'owner'>
  email: string | null
  teamId: string | null
  maxUses: number
  uses: number
  expiresAt: number
  createdBy: string
  createdAt: number
  revoked: boolean
}
export interface SecuritySettings {
  allowKernels: boolean
  allowMcp: boolean
  /** 管理员可查看成员邮箱（默认关闭） */
  adminMailboxAccess?: boolean
  warning: string
}
export interface AuditEntry {
  id: string
  at: number
  userId: string | null
  userName: string
  action: string
  entityType: string | null
  entityId: string | null
  summary: string
  ip: string
  meta: Record<string, unknown>
}
export interface AuditQuery {
  userId?: string
  action?: string
  entityType?: string
  entityId?: string
  from?: number
  to?: number
  page?: number
  pageSize?: number
}

export interface LocalAuthStatus {
  hasAccount: boolean
  signedIn: boolean
  username: string | null
}
export interface LocalAccount {
  id: string
  username: string
  createdAt: number
  lastLoginAt: number | null
}
export interface LocalLoginResult {
  token: string
  expiresAt: number
  persistent: boolean
  account: LocalAccount
  /** 新发的一次性恢复码：只在这一次响应里出现，界面必须让用户保存 */
  recoveryCode?: string
}
export interface LocalRecoveryInfo {
  dataDir: string
  resetFileName: string
  resetFilePresent: boolean
}

const enc = encodeURIComponent

/* ── 会话 ── */
export const getAuthMode = (): Promise<AuthMode> => request('/api/auth/mode', { silent: true, noAuthRedirect: true })
export const getMe = (): Promise<Me> => request('/api/auth/me', { silent: true, noAuthRedirect: true })
export const login = (email: string, password: string): Promise<LoginResult> =>
  request('/api/auth/login', { method: 'POST', body: { email, password }, silent: true, noAuthRedirect: true })
export const setupOwner = (body: {
  setupToken: string
  email: string
  password: string
  name: string
  orgName: string
}): Promise<LoginResult> => request('/api/auth/setup', { method: 'POST', body, silent: true, noAuthRedirect: true })
export const logout = (): Promise<void> =>
  request('/api/auth/logout', { method: 'POST', silent: true, noAuthRedirect: true })
export const refreshSession = (): Promise<{ expiresAt: number }> =>
  request('/api/auth/refresh', { method: 'POST', silent: true })
export const changePassword = (currentPassword: string, newPassword: string): Promise<void> =>
  request('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword }, silent: true })

/* ── 本机账户（desktop 模式，契约 §3.1） ── */
export const getLocalAuthStatus = (): Promise<LocalAuthStatus> =>
  request('/api/auth/local/status', { silent: true, noAuthRedirect: true })
export const localLogin = (username: string, password: string, remember: boolean): Promise<LocalLoginResult> =>
  request('/api/auth/local/login', {
    method: 'POST',
    body: { username, password, remember },
    silent: true,
    noAuthRedirect: true,
  })
export const createLocalAccount = (username: string, password: string, remember: boolean): Promise<LocalLoginResult> =>
  request('/api/auth/local/accounts', {
    method: 'POST',
    body: { username, password, remember },
    silent: true,
    noAuthRedirect: true,
  })
export const localLogout = (): Promise<void> =>
  request('/api/auth/local/logout', { method: 'POST', silent: true, noAuthRedirect: true })
export const changeLocalPassword = (currentPassword: string, newPassword: string): Promise<void> =>
  request('/api/auth/local/password', { method: 'POST', body: { currentPassword, newPassword }, silent: true })
/* 找回本机密码 */
export const getLocalRecoveryInfo = (): Promise<LocalRecoveryInfo> =>
  request('/api/auth/local/recovery', { silent: true, noAuthRedirect: true })
export const recoverLocalPassword = (body: {
  username: string
  recoveryCode: string
  newPassword: string
  remember: boolean
}): Promise<LocalLoginResult> =>
  request('/api/auth/local/recover', { method: 'POST', body, silent: true, noAuthRedirect: true })
export const resetLocalPasswordWithFile = (body: {
  username: string
  newPassword: string
  remember: boolean
}): Promise<LocalLoginResult> =>
  request('/api/auth/local/reset-with-file', { method: 'POST', body, silent: true, noAuthRedirect: true })
export const regenerateLocalRecoveryCode = (currentPassword: string): Promise<{ recoveryCode: string }> =>
  request('/api/auth/local/recovery-code', { method: 'POST', body: { currentPassword }, silent: true })

export const getInvitePublic = (
  code: string,
): Promise<{ orgName: string; role: Role; email: string | null; expiresAt: number }> =>
  request(`/api/auth/invites/${enc(code)}`, { silent: true, noAuthRedirect: true })
export const acceptInvite = (body: {
  code: string
  email: string
  password: string
  name: string
}): Promise<LoginResult> =>
  request('/api/auth/invites/accept', { method: 'POST', body, silent: true, noAuthRedirect: true })

/* ── 组织 / 成员 / 团队 / 邀请 ── */
export const getOrg = (): Promise<Org> => request('/api/team/org')
export const updateOrg = (name: string): Promise<Org> => request('/api/team/org', { method: 'PATCH', body: { name } })
export const listMembers = (opts: { silent?: boolean } = {}): Promise<Member[]> =>
  request('/api/team/members', { silent: opts.silent })
export const updateMember = (
  id: string,
  body: { role?: Role; disabled?: boolean; name?: string; permissionOverrides?: PermissionOverrides },
): Promise<Member> => request(`/api/team/members/${enc(id)}`, { method: 'PATCH', body })
/** 全量替换某成员的覆盖项（不在表里的权限跟随角色默认值） */
export const setMemberPermissions = (id: string, overrides: PermissionOverrides): Promise<Member> =>
  request(`/api/team/members/${enc(id)}/permissions`, { method: 'PUT', body: { overrides } })
export const resetMemberPassword = (id: string, newPassword: string): Promise<void> =>
  request(`/api/team/members/${enc(id)}/reset-password`, { method: 'POST', body: { newPassword }, silent: true })
/** 管理员直接创建成员并设初始密码；对方首次登录必须先改密 */
export const createMember = (body: {
  email: string
  name: string
  role: Exclude<Role, 'owner'>
  password: string
  teamId?: string
}): Promise<Member> => request('/api/team/members', { method: 'POST', body, silent: true })
export const removeMember = (id: string): Promise<void> => request(`/api/team/members/${enc(id)}`, { method: 'DELETE' })
export const transferOwnership = (userId: string): Promise<{ from: User; to: User }> =>
  request('/api/team/transfer-ownership', { method: 'POST', body: { userId } })
export const listTeams = (opts: { silent?: boolean } = {}): Promise<Team[]> =>
  request('/api/team/teams', { silent: opts.silent })
export const createTeam = (body: { name: string; memberIds?: string[] }): Promise<Team> =>
  request('/api/team/teams', { method: 'POST', body })
export const updateTeam = (id: string, body: { name?: string; memberIds?: string[] }): Promise<Team> =>
  request(`/api/team/teams/${enc(id)}`, { method: 'PATCH', body })
export const deleteTeam = (id: string): Promise<void> => request(`/api/team/teams/${enc(id)}`, { method: 'DELETE' })
export const listInvites = (): Promise<Invite[]> => request('/api/team/invites')
export const createInvite = (body: {
  role: Invite['role']
  email?: string
  teamId?: string
  expiresInHours?: number
  maxUses?: number
}): Promise<{ invite: Invite; code: string; url: string }> => request('/api/team/invites', { method: 'POST', body })
export const revokeInvite = (id: string): Promise<void> => request(`/api/team/invites/${enc(id)}`, { method: 'DELETE' })
export const getSecurity = (opts: { silent?: boolean } = {}): Promise<SecuritySettings> =>
  request('/api/team/security', { silent: opts.silent })
export const updateSecurity = (body: {
  allowKernels?: boolean
  allowMcp?: boolean
  adminMailboxAccess?: boolean
  confirm?: 'I_UNDERSTAND'
}): Promise<SecuritySettings> => request('/api/team/security', { method: 'PATCH', body })

/* ── 客户负责人 ── */
export const assignCustomer = (
  id: string,
  body: { ownerId: string; visibility?: Visibility; teamId?: string | null },
): Promise<Customer> => request(`/api/customers/${enc(id)}/assign`, { method: 'POST', body })
/** 离职交接：交接人名下各类记录的数量 */
export interface HandoverCounts {
  customers: number
  quotes: number
  deals: number
  orders: number
  tasks: number
  emailAccounts: number
  workflows: number
  schedules: number
}
export type HandoverEmailMode = 'transfer' | 'disable' | 'keep'
export interface HandoverOptions {
  emailAccounts?: HandoverEmailMode
  workflows?: boolean
  schedules?: boolean
}
export interface HandoverResult {
  moved: number
  quotes?: number
  deals?: number
  orders?: number
  tasks?: number
  /** 旧服务端只返回 moved */
  emailAccounts?: { mode: HandoverEmailMode; count: number }
  workflows?: number
  schedules?: number
}
export const getHandoverPreview = (fromUserId: string): Promise<HandoverCounts> =>
  request('/api/customers/transfer/preview', { query: { fromUserId }, silent: true })
export const transferCustomers = (
  fromUserId: string,
  toUserId: string,
  options: HandoverOptions = {},
): Promise<HandoverResult> =>
  request('/api/customers/transfer', { method: 'POST', body: { fromUserId, toUserId, ...options } })

/* ── 审计 ── */
export const listAudit = (query: AuditQuery): Promise<{ items: AuditEntry[]; total: number }> =>
  request('/api/audit', { query: query as Record<string, string | number | undefined> })

/* ── 实时事件（§4.8）：fetch 读流，断线自动重连 ── */
export type ServerEvent = { event: string; data: unknown }

export function subscribeEvents(onEvent: (event: ServerEvent) => void): () => void {
  return subscribeSse('/api/events', onEvent, (status) => {
    if (status === 401) onEvent({ event: 'session.revoked', data: {} })
  })
}

/**
 * 会话实时事件（契约 §6.10.4）：GET /api/sessions/:id/events → message / session / removed。
 * 失去访问权（404 / removed）时停止，不再重连。
 */
export function subscribeSessionEvents(sessionId: string, onEvent: (event: ServerEvent) => void): () => void {
  let stop: () => void = () => undefined
  stop = subscribeSse(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    (event) => {
      onEvent(event)
      if (event.event === 'removed') stop()
    },
    (status) => {
      if (status === 404) onEvent({ event: 'removed', data: { sessionId } })
    },
  )
  return () => stop()
}

/** fetch 读 SSE 流，断线指数退避重连；401 / 404 时调用 onFatal 并停止 */
export function subscribeSse(
  path: string,
  onEvent: (event: ServerEvent) => void,
  onFatal: (status: number) => void = () => undefined,
): () => void {
  let stopped = false
  let controller: AbortController | null = null
  let delay = 1000

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const response = await fetch(apiUrl(path), {
          headers: { Accept: 'text/event-stream', ...authHeaders() },
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 404) {
          onFatal(response.status)
          return
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        delay = 1000
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!stopped) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const parsed = parseEventBlock(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            if (parsed) onEvent(parsed)
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch {
        if (stopped) return
      }
      if (stopped) return
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}

export function parseEventBlock(block: string): ServerEvent | null {
  let event = 'message'
  const lines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) lines.push(line.slice(5).trim())
  }
  if (!lines.length) return null
  try {
    return { event, data: JSON.parse(lines.join('\n')) }
  } catch {
    return null
  }
}
