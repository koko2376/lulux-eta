import { rmSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { config } from '../../config.js'
import { ImapFlow } from 'imapflow'
import nodemailer, { type Transporter } from 'nodemailer'
import { z } from 'zod'
import { currentActor } from '../../context.js'
import { db } from '../../db.js'
import { AppError, messageOf, notFound } from '../../errors.js'
import {
  assertCanModify,
  canSee,
  ownershipForNew,
  seesAll,
  VISIBILITIES,
  visibilityClause,
  type Visibility,
} from '../../security/access.js'
import { decryptSecret, encryptSecret, SecretUnavailableError } from '../../security/secrets.js'
import { newId } from '../../utils/id.js'
import { parse } from '../../validation.js'
import { teamService } from '../auth-service.js'
import { eventBus } from '../events.js'
import { settingsService } from '../settings-service.js'
import { accessTokenFor } from './oauth-tokens.js'
import { adminMailboxAccessEnabled, mailboxAccess, type MailboxAccess } from './mailbox-access.js'
import { presetById } from './presets.js'

export type AccountState = 'idle' | 'syncing' | 'error' | 'needs_reauth'

export interface EmailAccount {
  id: string
  name: string
  email: string
  displayName: string
  presetId: string | null
  authType: 'password' | 'oauth2'
  oauthProvider: 'google' | 'microsoft' | null
  imap: { host: string; port: number; secure: boolean; username: string }
  smtp: { host: string; port: number; secure: boolean; username: string }
  hasSecret: boolean
  secretError: string | null
  syncEnabled: boolean
  syncDays: number
  appendToSent: boolean
  signature: string
  folders: { inbox: string; sent: string | null }
  status: {
    state: AccountState
    lastSyncAt: number | null
    lastError: string | null
    lastErrorCode: string | null
    idle: boolean
  }
  ownerId: string
  ownerName: string
  visibility: Visibility
  teamId: string | null
  /** 组织开启了“管理员可查看成员邮箱”（server 模式），成员邮箱里据此显示提示 */
  adminCanRead: boolean
  /**
   * 当前用户对内容的访问方式（只在列表接口里按请求者计算）：
   * own 自己的 / shared 共享给我的 / admin 管理员身份可读 / restricted 管理员但组织未开启，只能管理不能看内容
   */
  contentAccess?: Exclude<MailboxAccess, 'none' | 'admin'> | 'admin' | 'restricted'
  createdAt: number
  updatedAt: number
}

export interface AccountRow {
  id: string
  org_id: string
  owner_id: string
  visibility: string
  team_id: string | null
  name: string
  email: string
  display_name: string
  preset_id: string | null
  auth_type: string
  oauth_provider: string | null
  imap_host: string
  imap_port: number
  imap_secure: number
  imap_user: string
  smtp_host: string
  smtp_port: number
  smtp_secure: number
  smtp_user: string
  secret: string
  oauth_access: string
  oauth_expires_at: number | null
  sync_enabled: number
  sync_days: number
  append_to_sent: number
  signature: string
  inbox_path: string
  sent_path: string | null
  state: string
  last_sync_at: number | null
  last_error: string | null
  last_error_code: string | null
  created_at: number
  updated_at: number
}

/** 当前保持 IDLE 的账户（由调度器维护） */
export const idleAccounts = new Set<string>()

function secretError(row: AccountRow): string | null {
  if (!row.secret) return null
  try {
    decryptSecret(row.secret)
    return null
  } catch {
    return '凭据无法用当前主密钥解密，请重新填写密码或重新授权'
  }
}

export function toPublicAccount(row: AccountRow): EmailAccount {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    displayName: row.display_name,
    presetId: row.preset_id,
    authType: row.auth_type as EmailAccount['authType'],
    oauthProvider: (row.oauth_provider as EmailAccount['oauthProvider']) ?? null,
    imap: { host: row.imap_host, port: row.imap_port, secure: row.imap_secure === 1, username: row.imap_user },
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure === 1, username: row.smtp_user },
    hasSecret: Boolean(row.secret),
    secretError: secretError(row),
    syncEnabled: row.sync_enabled === 1,
    syncDays: row.sync_days,
    appendToSent: row.append_to_sent === 1,
    signature: row.signature,
    folders: { inbox: row.inbox_path, sent: row.sent_path },
    status: {
      state: row.state as AccountState,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      lastErrorCode: row.last_error_code,
      idle: idleAccounts.has(row.id),
    },
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    visibility: (row.visibility || 'private') as Visibility,
    teamId: row.team_id,
    adminCanRead: config.mode === 'server' && adminMailboxAccessEnabled(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── 校验 ─────────────────────────────────────────────

const hostField = z
  .string()
  .trim()
  .min(1, '主机不能为空')
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[?[0-9a-fA-F:.]+\]?$/, '主机名格式不正确')
const endpoint = z.object({
  host: hostField,
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().max(320).optional(),
})
const emailAddress = z.string().trim().toLowerCase().email('邮箱地址格式不正确').max(320)

export const accountCreateInput = z.object({
  email: emailAddress,
  name: z.string().trim().max(100).optional(),
  displayName: z.string().trim().max(200).optional(),
  presetId: z.string().max(40).nullable().optional(),
  imap: endpoint,
  smtp: endpoint,
  password: z.string().min(1, '请填写密码 / 授权码').max(1000),
  syncEnabled: z.boolean().optional(),
  syncDays: z.number().int().min(1).max(365).optional(),
  appendToSent: z.boolean().optional(),
  signature: z.string().max(5000).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  teamId: z.string().max(80).nullable().optional(),
  verify: z.boolean().optional(),
})

export const accountPatchInput = z
  .object({
    name: z.string().trim().max(100),
    displayName: z.string().trim().max(200),
    presetId: z.string().max(40).nullable(),
    imap: endpoint,
    smtp: endpoint,
    password: z.string().max(1000),
    syncEnabled: z.boolean(),
    syncDays: z.number().int().min(1).max(365),
    appendToSent: z.boolean(),
    signature: z.string().max(5000),
    visibility: z.enum(VISIBILITIES),
    teamId: z.string().max(80).nullable(),
    verify: z.boolean(),
  })
  .partial()
  .strict()

// ── 连接 ─────────────────────────────────────────────

export interface ConnectionConfig {
  email: string
  imap: { host: string; port: number; secure: boolean; username: string }
  smtp: { host: string; port: number; secure: boolean; username: string }
  auth: { pass: string } | { accessToken: string }
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || (isIP(value) === 4 && value.startsWith('127.'))
}

const CONNECT_TIMEOUT_MS = 20_000

export function imapClient(config: ConnectionConfig): ImapFlow {
  const loopback = isLoopback(config.imap.host)
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    // 非本机地址且未用隐式 TLS 时强制 STARTTLS，绝不明文发送密码
    doSTARTTLS: config.imap.secure ? undefined : loopback ? undefined : true,
    auth:
      'pass' in config.auth
        ? { user: config.imap.username, pass: config.auth.pass }
        : { user: config.imap.username, accessToken: config.auth.accessToken },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 5 * 60_000,
    clientInfo: { name: 'LULUX ETA' },
    tls: { rejectUnauthorized: !loopback, minVersion: 'TLSv1.2' },
  })
}

export function smtpTransport(config: ConnectionConfig): Transporter {
  const loopback = isLoopback(config.smtp.host)
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure && !loopback,
    ignoreTLS: false,
    auth:
      'pass' in config.auth
        ? { user: config.smtp.username, pass: config.auth.pass }
        : { type: 'OAuth2', user: config.smtp.username, accessToken: config.auth.accessToken },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
    tls: { rejectUnauthorized: !loopback, minVersion: 'TLSv1.2' },
  })
}

/** 把 imapflow / nodemailer 的错误归类为契约 4.11 的错误码 */
export function classifyMailError(error: unknown, protocol: 'IMAP' | 'SMTP'): AppError {
  if (error instanceof AppError) return error
  const err = error as { code?: string; authenticationFailed?: boolean; responseText?: string; response?: string; message?: string }
  const detail = err.responseText || err.response || err.message || String(error)
  if (err.authenticationFailed || err.code === 'EAUTH' || /AUTHENTICATIONFAILED|authentication failed|Invalid login|535/i.test(detail)) {
    return new AppError(400, 'EMAIL_AUTH_FAILED', `${protocol} 登录失败：${detail}（请确认已开启 IMAP/SMTP，并使用授权码 / 应用专用密码）`)
  }
  return new AppError(502, 'EMAIL_CONNECT_FAILED', `${protocol} 连接失败：${detail}`)
}

const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'sent mail', '已发送', '已发送邮件', 'inbox.sent', '[gmail]/sent mail']

export async function detectFolders(client: ImapFlow): Promise<{ inbox: string; sent: string | null }> {
  const list = await client.list()
  const inbox = list.find((box) => box.specialUse === '\\Inbox')?.path ?? 'INBOX'
  const sent =
    list.find((box) => box.specialUse === '\\Sent')?.path ??
    list.find((box) => SENT_NAMES.includes(box.path.toLowerCase()) || SENT_NAMES.includes(box.name.toLowerCase()))?.path ??
    null
  return { inbox, sent }
}

export interface EmailTestResult {
  ok: boolean
  imap: { ok: boolean; code?: string; error?: string; folders?: { inbox: string; sent: string | null } }
  smtp: { ok: boolean; code?: string; error?: string }
}

export async function testConnection(config: ConnectionConfig): Promise<EmailTestResult> {
  const result: EmailTestResult = { ok: false, imap: { ok: false }, smtp: { ok: false } }
  const client = imapClient(config)
  client.on('error', () => undefined)
  try {
    await client.connect()
    result.imap = { ok: true, folders: await detectFolders(client) }
  } catch (error) {
    const mapped = classifyMailError(error, 'IMAP')
    result.imap = { ok: false, code: mapped.code, error: mapped.message }
  } finally {
    await client.logout().catch(() => client.close())
  }
  const transport = smtpTransport(config)
  try {
    await transport.verify()
    result.smtp = { ok: true }
  } catch (error) {
    const mapped = classifyMailError(error, 'SMTP')
    result.smtp = { ok: false, code: mapped.code, error: mapped.message }
  } finally {
    transport.close()
  }
  result.ok = result.imap.ok && result.smtp.ok
  return result
}

function configFromInput(data: z.infer<typeof accountCreateInput>): ConnectionConfig {
  return {
    email: data.email,
    imap: { host: data.imap.host, port: data.imap.port, secure: data.imap.secure, username: data.imap.username || data.email },
    smtp: { host: data.smtp.host, port: data.smtp.port, secure: data.smtp.secure, username: data.smtp.username || data.email },
    auth: { pass: data.password },
  }
}

/** 解密凭据（OAuth 账户自动刷新 access token） */
export async function connectionFor(row: AccountRow): Promise<ConnectionConfig> {
  const base = {
    email: row.email,
    imap: { host: row.imap_host, port: row.imap_port, secure: row.imap_secure === 1, username: row.imap_user },
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure === 1, username: row.smtp_user },
  }
  if (row.auth_type === 'oauth2') {
    return { ...base, auth: { accessToken: await accessTokenFor(row) } }
  }
  try {
    return { ...base, auth: { pass: decryptSecret(row.secret) } }
  } catch (error) {
    if (error instanceof SecretUnavailableError) {
      throw new AppError(409, 'EMAIL_SECRET_UNAVAILABLE', '邮箱密码无法用当前主密钥解密，请在邮箱设置里重新填写')
    }
    throw error
  }
}

export async function openImap(row: AccountRow): Promise<ImapFlow> {
  const config = await connectionFor(row)
  const client = imapClient(config)
  client.on('error', (error: unknown) => console.warn(`[lulux-eta] IMAP ${row.email}:`, messageOf(error)))
  try {
    await client.connect()
  } catch (error) {
    client.close()
    throw classifyMailError(error, 'IMAP')
  }
  return client
}

// ── 账户服务 ─────────────────────────────────────────

export function accountRow(id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as unknown as AccountRow | undefined
}

function assertTeam(teamId: string | null | undefined): void {
  const actor = currentActor()
  if (!teamId || actor.orgId === 'local') return
  if (!teamService.teamExists(teamId, actor.orgId)) throw new AppError(404, 'NOT_FOUND', '团队不存在')
  if (!seesAll(actor) && !actor.teamIds.includes(teamId)) throw new AppError(400, 'VALIDATION_ERROR', '只能共享给自己所在的团队')
}

export function publishAccount(row: AccountRow): void {
  eventBus.publish('email.account', { account: toPublicAccount(row) }, row)
}

export function setAccountStatus(id: string, state: AccountState, error: AppError | null = null, synced = false): void {
  db.prepare(
    `UPDATE email_accounts SET state = ?, last_error = ?, last_error_code = ?, last_sync_at = CASE WHEN ? = 1 THEN ? ELSE last_sync_at END
     WHERE id = ?`,
  ).run(state, error?.message ?? null, error?.code ?? null, synced ? 1 : 0, Date.now(), id)
  const row = accountRow(id)
  if (row) publishAccount(row)
}

export const accountService = {
  list(): EmailAccount[] {
    const scope = visibilityClause('a')
    return (
      db.prepare(`SELECT a.* FROM email_accounts a WHERE ${scope.sql} ORDER BY a.created_at`).all(...scope.params) as unknown as AccountRow[]
    ).map((row) => {
      const access = mailboxAccess(row)
      const contentAccess: EmailAccount['contentAccess'] =
        access === 'admin' ? (adminMailboxAccessEnabled() ? 'admin' : 'restricted') : access === 'none' ? 'restricted' : access
      return { ...toPublicAccount(row), contentAccess }
    })
  },

  /** 当前用户可见，否则 404 */
  requireRow(id: string): AccountRow {
    const row = accountRow(id)
    if (!row || !canSee(row)) throw notFound('邮箱账户')
    return row
  },

  requireWritableRow(id: string): AccountRow {
    const row = accountService.requireRow(id)
    assertCanModify(row, '邮箱账户')
    return row
  },

  /** 默认账户：当前用户自己的第一个，其次第一个可见的 */
  defaultRow(): AccountRow | undefined {
    const actor = currentActor()
    const scope = visibilityClause('a')
    const rows = db.prepare(`SELECT a.* FROM email_accounts a WHERE ${scope.sql} ORDER BY a.created_at`).all(...scope.params) as unknown as AccountRow[]
    return rows.find((row) => row.owner_id === actor.id) ?? rows[0]
  },

  async test(input: unknown): Promise<EmailTestResult> {
    const data = parse(accountCreateInput, input)
    return testConnection(configFromInput(data))
  },

  async testSaved(id: string): Promise<EmailTestResult> {
    const row = accountService.requireRow(id)
    try {
      return await testConnection(await connectionFor(row))
    } catch (error) {
      const mapped = classifyMailError(error, 'IMAP')
      return { ok: false, imap: { ok: false, code: mapped.code, error: mapped.message }, smtp: { ok: false, code: mapped.code, error: mapped.message } }
    }
  },

  async create(input: unknown): Promise<EmailAccount> {
    const data = parse(accountCreateInput, input)
    assertTeam(data.teamId)
    const actor = currentActor()
    const exists = db.prepare('SELECT 1 FROM email_accounts WHERE org_id = ? AND owner_id = ? AND email = ?').get(actor.orgId, actor.id, data.email)
    if (exists) throw new AppError(409, 'EMAIL_ACCOUNT_EXISTS', '你已经添加过这个邮箱')
    const config = configFromInput(data)
    let folders: { inbox: string; sent: string | null } = { inbox: 'INBOX', sent: null }
    if (data.verify !== false) {
      const result = await testConnection(config)
      if (!result.imap.ok) throw new AppError(result.imap.code === 'EMAIL_AUTH_FAILED' ? 400 : 502, result.imap.code!, result.imap.error!)
      if (!result.smtp.ok) throw new AppError(result.smtp.code === 'EMAIL_AUTH_FAILED' ? 400 : 502, result.smtp.code!, result.smtp.error!)
      folders = result.imap.folders ?? folders
    }
    const preset = presetById(data.presetId ?? null)
    const owner = ownershipForNew({ visibility: data.visibility, teamId: data.teamId })
    const id = newId('mbx')
    const now = Date.now()
    db.prepare(
      `INSERT INTO email_accounts (id, org_id, owner_id, visibility, team_id, name, email, display_name, preset_id, auth_type, oauth_provider,
         imap_host, imap_port, imap_secure, imap_user, smtp_host, smtp_port, smtp_secure, smtp_user, secret, sync_enabled, sync_days,
         append_to_sent, signature, inbox_path, sent_path, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(
      id,
      owner.orgId,
      owner.ownerId,
      owner.visibility,
      owner.teamId,
      data.name || data.email,
      data.email,
      data.displayName ?? '',
      data.presetId ?? null,
      config.imap.host,
      config.imap.port,
      config.imap.secure ? 1 : 0,
      config.imap.username,
      config.smtp.host,
      config.smtp.port,
      config.smtp.secure ? 1 : 0,
      config.smtp.username,
      encryptSecret(data.password),
      data.syncEnabled === false ? 0 : 1,
      data.syncDays ?? Number.parseInt(settingsService.get('emailSyncDays') ?? '30', 10),
      (data.appendToSent ?? preset?.appendToSent ?? true) ? 1 : 0,
      data.signature ?? '',
      folders.inbox,
      folders.sent,
      now,
      now,
    )
    return toPublicAccount(accountRow(id)!)
  },

  /** OAuth 回调里创建 / 更新账户 */
  upsertOAuth(input: {
    accountId: string | null
    provider: 'google' | 'microsoft'
    email: string
    displayName: string
    refreshToken: string
    accessToken: string
    expiresAt: number
    visibility?: Visibility
    teamId?: string | null
  }): AccountRow {
    const presetId = input.provider === 'google' ? 'gmail' : input.email.match(/@(outlook|hotmail|live|msn)\./i) ? 'outlook' : 'office365'
    const preset = presetById(presetId)!
    const now = Date.now()
    const actor = currentActor()
    const existing = input.accountId
      ? accountRow(input.accountId)
      : (db.prepare('SELECT * FROM email_accounts WHERE org_id = ? AND owner_id = ? AND email = ?').get(actor.orgId, actor.id, input.email) as unknown as AccountRow | undefined)
    if (existing) {
      db.prepare(
        `UPDATE email_accounts SET auth_type = 'oauth2', oauth_provider = ?, secret = CASE WHEN ? <> '' THEN ? ELSE secret END,
           oauth_access = ?, oauth_expires_at = ?, state = 'idle', last_error = NULL, last_error_code = NULL, updated_at = ? WHERE id = ?`,
      ).run(
        input.provider,
        input.refreshToken,
        input.refreshToken ? encryptSecret(input.refreshToken) : '',
        encryptSecret(input.accessToken),
        input.expiresAt,
        now,
        existing.id,
      )
      return accountRow(existing.id)!
    }
    const owner = ownershipForNew({ visibility: input.visibility, teamId: input.teamId })
    const id = newId('mbx')
    db.prepare(
      `INSERT INTO email_accounts (id, org_id, owner_id, visibility, team_id, name, email, display_name, preset_id, auth_type, oauth_provider,
         imap_host, imap_port, imap_secure, imap_user, smtp_host, smtp_port, smtp_secure, smtp_user, secret, oauth_access, oauth_expires_at,
         sync_enabled, sync_days, append_to_sent, signature, inbox_path, sent_path, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'oauth2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '', 'INBOX', NULL, 'idle', ?, ?)`,
    ).run(
      id,
      owner.orgId,
      owner.ownerId,
      owner.visibility,
      owner.teamId,
      input.email,
      input.email,
      input.displayName,
      presetId,
      input.provider,
      preset.imap.host,
      preset.imap.port,
      preset.imap.secure ? 1 : 0,
      input.email,
      preset.smtp.host,
      preset.smtp.port,
      preset.smtp.secure ? 1 : 0,
      input.email,
      encryptSecret(input.refreshToken),
      encryptSecret(input.accessToken),
      input.expiresAt,
      Number.parseInt(settingsService.get('emailSyncDays') ?? '30', 10),
      preset.appendToSent ? 1 : 0,
      now,
      now,
    )
    return accountRow(id)!
  },

  async update(id: string, input: unknown): Promise<EmailAccount> {
    const patch = parse(accountPatchInput, input)
    const row = accountService.requireWritableRow(id)
    if (patch.teamId !== undefined) assertTeam(patch.teamId)
    const imap = patch.imap
      ? { ...patch.imap, username: patch.imap.username || row.email }
      : { host: row.imap_host, port: row.imap_port, secure: row.imap_secure === 1, username: row.imap_user }
    const smtp = patch.smtp
      ? { ...patch.smtp, username: patch.smtp.username || row.email }
      : { host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure === 1, username: row.smtp_user }
    const passwordChanged = Boolean(patch.password)
    const connectionChanged = Boolean(patch.imap || patch.smtp || passwordChanged)
    if (row.auth_type === 'oauth2' && passwordChanged) {
      throw new AppError(400, 'VALIDATION_ERROR', 'OAuth 账户不能设置密码，请重新授权')
    }
    let folders = { inbox: row.inbox_path, sent: row.sent_path }
    if (connectionChanged && patch.verify !== false) {
      const config: ConnectionConfig =
        row.auth_type === 'oauth2'
          ? { ...(await connectionFor(row)), imap, smtp }
          : { email: row.email, imap, smtp, auth: { pass: passwordChanged ? patch.password! : (await connectionFor(row) as { auth: { pass: string } }).auth.pass } }
      const result = await testConnection(config)
      if (!result.imap.ok) throw new AppError(result.imap.code === 'EMAIL_AUTH_FAILED' ? 400 : 502, result.imap.code!, result.imap.error!)
      if (!result.smtp.ok) throw new AppError(result.smtp.code === 'EMAIL_AUTH_FAILED' ? 400 : 502, result.smtp.code!, result.smtp.error!)
      folders = result.imap.folders ?? folders
    }
    const visibility = patch.visibility ?? row.visibility
    const teamId = patch.teamId !== undefined ? patch.teamId : row.team_id
    if (visibility === 'team' && !teamId) throw new AppError(400, 'VALIDATION_ERROR', '共享给团队时必须指定团队（teamId）')
    const hostChanged = imap.host !== row.imap_host || imap.username !== row.imap_user
    db.prepare(
      `UPDATE email_accounts SET name = ?, display_name = ?, preset_id = ?, imap_host = ?, imap_port = ?, imap_secure = ?, imap_user = ?,
         smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, secret = ?, sync_enabled = ?, sync_days = ?, append_to_sent = ?,
         signature = ?, visibility = ?, team_id = ?, inbox_path = ?, sent_path = ?, updated_at = ?,
         state = CASE WHEN ? = 1 THEN 'idle' ELSE state END, last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END
       WHERE id = ?`,
    ).run(
      patch.name ?? row.name,
      patch.displayName ?? row.display_name,
      patch.presetId !== undefined ? patch.presetId : row.preset_id,
      imap.host,
      imap.port,
      imap.secure ? 1 : 0,
      imap.username,
      smtp.host,
      smtp.port,
      smtp.secure ? 1 : 0,
      smtp.username,
      passwordChanged ? encryptSecret(patch.password!) : row.secret,
      patch.syncEnabled === undefined ? row.sync_enabled : patch.syncEnabled ? 1 : 0,
      patch.syncDays ?? row.sync_days,
      patch.appendToSent === undefined ? row.append_to_sent : patch.appendToSent ? 1 : 0,
      patch.signature ?? row.signature,
      visibility,
      teamId,
      folders.inbox,
      folders.sent,
      Date.now(),
      connectionChanged ? 1 : 0,
      connectionChanged ? 1 : 0,
      id,
    )
    // 换了邮箱服务器：清掉同步游标，下次重新按 syncDays 扫描
    if (hostChanged) db.prepare('DELETE FROM email_sync_state WHERE account_id = ?').run(id)
    return toPublicAccount(accountRow(id)!)
  },

  remove(id: string): AccountRow {
    const row = accountService.requireWritableRow(id)
    const draftIds = (db.prepare('SELECT id FROM email_drafts WHERE account_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id)
    db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id)
    rmSync(join(config.home, 'attachments', id), { recursive: true, force: true })
    for (const draftId of draftIds) rmSync(join(config.home, 'attachments', 'drafts', draftId), { recursive: true, force: true })
    return row
  },
}
