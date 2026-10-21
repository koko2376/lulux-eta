/**
 * 邮箱接口（docs/API-CONTRACT.md §4）。
 * 所有函数只是对 request() 的薄封装，类型与契约一一对应。
 */
import { request } from './http'
import type { Customer } from './index'
import type { Visibility } from './team'

export type EmailPresetId =
  'gmail' | 'outlook' | 'office365' | 'qq' | 'exmail-qq' | '163' | '126' | 'aliyun-qiye' | 'zoho' | 'custom'

export interface MailServer {
  host: string
  port: number
  secure: boolean
}

export interface EmailPreset {
  id: EmailPresetId
  name: string
  imap: MailServer
  smtp: MailServer
  authTypes: ('password' | 'oauth2')[]
  oauthProvider: 'google' | 'microsoft' | null
  authHint: string
  helpUrl: string | null
  appendToSent: boolean
  domains: string[]
}

export type EmailAccountState = 'idle' | 'syncing' | 'error' | 'needs_reauth'

export interface EmailAccount {
  id: string
  name: string
  email: string
  displayName: string
  presetId: string | null
  authType: 'password' | 'oauth2'
  oauthProvider: 'google' | 'microsoft' | null
  imap: MailServer & { username: string }
  smtp: MailServer & { username: string }
  hasSecret: boolean
  secretError: string | null
  syncEnabled: boolean
  syncDays: number
  appendToSent: boolean
  signature: string
  folders: { inbox: string; sent: string | null }
  status: {
    state: EmailAccountState
    lastSyncAt: number | null
    lastError: string | null
    lastErrorCode: string | null
    idle: boolean
  }
  ownerId: string
  ownerName: string
  visibility: Visibility
  teamId: string | null
  /** 组织开启了“管理员可查看成员邮箱”（server 模式） */
  adminCanRead?: boolean
  /** 当前用户对内容的访问方式：自己的 / 共享给我的 / 管理员身份可读 / 只能管理不能看 */
  contentAccess?: 'own' | 'shared' | 'admin' | 'restricted'
  createdAt: number
  updatedAt: number
}

export interface EmailAccountInput {
  email: string
  name?: string
  displayName?: string
  presetId?: string | null
  imap: MailServer & { username?: string }
  smtp: MailServer & { username?: string }
  password?: string
  syncEnabled?: boolean
  syncDays?: number
  appendToSent?: boolean
  signature?: string
  visibility?: Visibility
  teamId?: string | null
  verify?: boolean
}

export interface EmailTestPart {
  ok: boolean
  code?: string
  error?: string
}
export interface EmailTestResult {
  ok: boolean
  imap: EmailTestPart & { folders?: { inbox: string; sent: string | null } }
  smtp: EmailTestPart
}

export interface SyncResult {
  accountId: string
  folders: { path: string; role: 'inbox' | 'sent'; fetched: number; highestUid: number; uidValidity: number }[]
  newMessages: number
  verdicts: { inquiry: number; spam: number; review: number }
  linkedToCustomers: number
  durationMs: number
}

export interface OAuthConfig {
  google: { clientId: string; hasClientSecret: boolean }
  microsoft: { clientId: string; tenant: string; hasClientSecret: boolean }
  redirectUris: { google: string; microsoft: string }
}

export interface EmailAddress {
  name: string
  address: string
}

export interface EmailAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  contentId: string | null
  inline: boolean
  downloaded: boolean
}

export type Verdict = 'inquiry' | 'spam' | 'review'

export interface EmailMessageSummary {
  id: string
  accountId: string
  folder: 'inbox' | 'sent'
  uid: number | null
  messageId: string
  threadKey: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  date: number
  snippet: string
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  verdict: Verdict | null
  verdictSource: 'rule' | 'model' | 'manual' | null
  verdictReason: string
  matchedRuleId: string | null
  customerId: string | null
  customerName: string | null
  createdAt: number
}

export interface EmailMessage extends EmailMessageSummary {
  replyTo: EmailAddress[]
  inReplyTo: string | null
  references: string[]
  text: string
  hasHtml: boolean
  truncated: boolean
  attachments: EmailAttachment[]
}

export interface DraftAttachment {
  id: string
  filename: string
  contentType: string
  size: number
}

export interface EmailDraft {
  id: string
  accountId: string
  replyToMessageId: string | null
  customerId: string | null
  quoteId: string | null
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  text: string
  attachQuotePdf: boolean
  attachments: DraftAttachment[]
  source: 'user' | 'ai' | 'agent'
  ai: { providerName: string; model: string } | null
  status: 'draft' | 'sending' | 'sent' | 'failed'
  error: string | null
  sentAt: number | null
  sentMessageId: string | null
  ownerId: string
  createdAt: number
  updatedAt: number
}

export interface DraftInput {
  accountId?: string
  replyToMessageId?: string | null
  customerId?: string | null
  quoteId?: string | null
  to?: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  subject?: string
  text?: string
  attachQuotePdf?: boolean
}

export interface MessageQuery {
  accountId?: string
  folder?: 'inbox' | 'sent' | 'all'
  verdict?: Verdict | 'none'
  customerId?: string
  threadKey?: string
  query?: string
  unread?: 1
  page?: number
  pageSize?: number
}

const enc = encodeURIComponent

/* ── 预设 / 账户 ── */
export const listEmailPresets = (): Promise<EmailPreset[]> => request('/api/email/presets')
export const listEmailAccounts = (opts: { silent?: boolean } = {}): Promise<EmailAccount[]> =>
  request('/api/email/accounts', { silent: opts.silent })
export const createEmailAccount = (input: EmailAccountInput): Promise<EmailAccount> =>
  request('/api/email/accounts', { method: 'POST', body: input, silent: true })
export const updateEmailAccount = (id: string, input: Partial<EmailAccountInput>): Promise<EmailAccount> =>
  request(`/api/email/accounts/${enc(id)}`, { method: 'PATCH', body: input, silent: true })
export const deleteEmailAccount = (id: string): Promise<void> =>
  request(`/api/email/accounts/${enc(id)}`, { method: 'DELETE' })
export const testEmailConfig = (input: EmailAccountInput): Promise<EmailTestResult> =>
  request('/api/email/accounts/test', { method: 'POST', body: input, silent: true })
export const testEmailAccount = (id: string): Promise<EmailTestResult> =>
  request(`/api/email/accounts/${enc(id)}/test`, { method: 'POST', silent: true })
export function syncEmailAccount(
  id: string,
  body: { wait?: boolean; full?: boolean } = {},
): Promise<SyncResult | { accepted: boolean }> {
  return request(`/api/email/accounts/${enc(id)}/sync`, { method: 'POST', body })
}

/* ── OAuth ── */
export const getOAuthConfig = (): Promise<OAuthConfig> => request('/api/email/oauth/config')
export const putOAuthConfig = (body: {
  google?: { clientId?: string; clientSecret?: string }
  microsoft?: { clientId?: string; tenant?: string; clientSecret?: string }
}): Promise<OAuthConfig> => request('/api/email/oauth/config', { method: 'PUT', body })
export const startOAuth = (body: {
  provider: 'google' | 'microsoft'
  accountId?: string
  loginHint?: string
}): Promise<{ state: string; authUrl: string; redirectUri: string; expiresAt: number }> =>
  request('/api/email/oauth/start', { method: 'POST', body, silent: true })
export const getOAuthStatus = (
  state: string,
): Promise<{ status: 'pending' | 'done' | 'error'; accountId: string | null; error: string | null }> =>
  request(`/api/email/oauth/status/${enc(state)}`, { silent: true })

/* ── 邮件 ── */
export const listEmailMessages = (query: MessageQuery): Promise<{ items: EmailMessageSummary[]; total: number }> =>
  request('/api/email/messages', { query: query as Record<string, string | number | undefined> })
export const getEmailMessage = (id: string): Promise<EmailMessage> => request(`/api/email/messages/${enc(id)}`)
export const getEmailMessageHtml = (id: string): Promise<string> =>
  request(`/api/email/messages/${enc(id)}/html`, { text: true, silent: true })
export const patchEmailMessage = (
  id: string,
  body: { seen?: boolean; flagged?: boolean; verdict?: Verdict; customerId?: string | null },
): Promise<EmailMessage> => request(`/api/email/messages/${enc(id)}`, { method: 'PATCH', body })
export const classifyEmailMessage = (id: string, useModel = true): Promise<EmailMessage> =>
  request(`/api/email/messages/${enc(id)}/classify`, { method: 'POST', body: { useModel } })
export const createCustomerFromEmail = (
  id: string,
  body: { company?: string; country?: string; website?: string; force?: boolean } = {},
  opts: { silent?: boolean } = {},
): Promise<{ customer: Customer; message: EmailMessage }> =>
  request(`/api/email/messages/${enc(id)}/create-customer`, { method: 'POST', body, silent: opts.silent })
export const linkEmailToCustomer = (id: string, customerId: string): Promise<EmailMessage> =>
  request(`/api/email/messages/${enc(id)}/link`, { method: 'POST', body: { customerId } })
export const downloadEmailAttachment = (id: string): Promise<Blob> =>
  request(`/api/email/attachments/${enc(id)}`, { blob: true })

/* ── 草稿 ── */
export const listEmailDrafts = (
  query: { accountId?: string; status?: string; customerId?: string } = {},
): Promise<EmailDraft[]> => request('/api/email/drafts', { query })
export const getEmailDraft = (id: string): Promise<EmailDraft> => request(`/api/email/drafts/${enc(id)}`)
export const createEmailDraft = (body: DraftInput & { accountId: string }): Promise<EmailDraft> =>
  request('/api/email/drafts', { method: 'POST', body })
export const updateEmailDraft = (id: string, body: DraftInput): Promise<EmailDraft> =>
  request(`/api/email/drafts/${enc(id)}`, { method: 'PATCH', body })
export const deleteEmailDraft = (id: string): Promise<void> =>
  request(`/api/email/drafts/${enc(id)}`, { method: 'DELETE' })
export const generateEmailDraft = (body: {
  messageId?: string
  accountId?: string
  customerId?: string
  quoteId?: string
  instructions?: string
  language?: string
}): Promise<EmailDraft> => request('/api/email/drafts/generate', { method: 'POST', body, silent: true })
export const uploadDraftAttachment = (
  id: string,
  body: { filename: string; contentType: string; dataBase64: string },
): Promise<DraftAttachment> => request(`/api/email/drafts/${enc(id)}/attachments`, { method: 'POST', body })
export const deleteDraftAttachment = (id: string, attachmentId: string): Promise<void> =>
  request(`/api/email/drafts/${enc(id)}/attachments/${enc(attachmentId)}`, { method: 'DELETE' })
/** 只能由用户在界面上显式点击“发送”并确认后调用（契约 §4.6） */
export const sendEmailDraft = (
  id: string,
  opts: { confirmSendAs?: boolean } = {},
): Promise<{ draft: EmailDraft; message: EmailMessage }> =>
  request(`/api/email/drafts/${enc(id)}/send`, {
    method: 'POST',
    silent: true,
    ...(opts.confirmSendAs ? { body: { confirmSendAs: true } } : {}),
  })

export const quotePdf = (id: string): Promise<Blob> => request(`/api/quotes/${enc(id)}/pdf`, { blob: true })
