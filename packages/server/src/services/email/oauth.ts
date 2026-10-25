import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config, runtimeInfo } from '../../config.js'
import { currentActor, runAs, type Actor } from '../../context.js'
import { AppError, messageOf } from '../../errors.js'
import { VISIBILITIES, type Visibility } from '../../security/access.js'
import { parse } from '../../validation.js'
import { auditService } from '../audit-service.js'
import { accountService, publishAccount } from './account-service.js'
import {
  endpointsFor,
  hasClientSecret,
  OAUTH_SCOPES,
  oauthClient,
  postToken,
  saveOAuthClient,
  type OAuthProvider,
} from './oauth-tokens.js'

interface PendingAuth {
  provider: OAuthProvider
  verifier: string
  redirectUri: string
  actor: Actor
  accountId: string | null
  visibility?: Visibility
  teamId?: string | null
  expiresAt: number
  status: 'pending' | 'done' | 'error'
  resultAccountId: string | null
  error: string | null
}

const STATE_TTL_MS = 10 * 60_000
const pending = new Map<string, PendingAuth>()

function sweep(): void {
  const now = Date.now()
  for (const [state, entry] of pending) {
    // 完成的结果再保留 10 分钟供轮询
    if (entry.expiresAt + (entry.status === 'pending' ? 0 : STATE_TTL_MS) < now) pending.delete(state)
  }
}

export function redirectUriFor(provider: OAuthProvider): string {
  if (config.mode === 'server') return `${config.publicOrigins[0]}/oauth/callback`
  const port = runtimeInfo.getPort()
  // Microsoft 对 http://localhost 回环地址忽略端口；Google 桌面应用允许任意端口的 127.0.0.1
  return provider === 'microsoft' ? `http://localhost:${port}/oauth/callback` : `http://127.0.0.1:${port}/oauth/callback`
}

const startInput = z
  .object({
    provider: z.enum(['google', 'microsoft']),
    accountId: z.string().max(80).optional(),
    loginHint: z.string().trim().max(320).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    teamId: z.string().max(80).nullable().optional(),
  })
  .strict()

const configInput = z
  .object({
    google: z.object({ clientId: z.string().max(500).optional(), clientSecret: z.string().max(500).optional() }).strict().optional(),
    microsoft: z
      .object({ clientId: z.string().max(500).optional(), clientSecret: z.string().max(500).optional(), tenant: z.string().max(100).optional() })
      .strict()
      .optional(),
  })
  .strict()

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export const oauthService = {
  config() {
    const google = oauthClient('google')
    const microsoft = oauthClient('microsoft')
    return {
      google: { clientId: google.clientId, hasClientSecret: hasClientSecret('google') },
      microsoft: { clientId: microsoft.clientId, tenant: microsoft.tenant, hasClientSecret: hasClientSecret('microsoft') },
      redirectUris: {
        google: redirectUriFor('google'),
        microsoft: config.mode === 'server' ? redirectUriFor('microsoft') : 'http://localhost/oauth/callback',
      },
    }
  },

  saveConfig(input: unknown) {
    const data = parse(configInput, input)
    if (data.google) saveOAuthClient('google', data.google)
    if (data.microsoft) saveOAuthClient('microsoft', data.microsoft)
    auditService.record({ action: 'settings.update', entityType: 'oauth', entityId: null, summary: '修改邮箱 OAuth 配置' })
    return oauthService.config()
  },

  start(input: unknown): { state: string; authUrl: string; redirectUri: string; expiresAt: number } {
    sweep()
    const data = parse(startInput, input)
    const client = oauthClient(data.provider)
    if (!client.clientId) {
      throw new AppError(400, 'OAUTH_NOT_CONFIGURED', `请先在设置里填写 ${data.provider === 'google' ? 'Google' : 'Microsoft'} OAuth Client ID`)
    }
    if (data.accountId) accountService.requireWritableRow(data.accountId)
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const redirectUri = redirectUriFor(data.provider)
    const expiresAt = Date.now() + STATE_TTL_MS
    pending.set(state, {
      provider: data.provider,
      verifier,
      redirectUri,
      actor: currentActor(),
      accountId: data.accountId ?? null,
      visibility: data.visibility,
      teamId: data.teamId,
      expiresAt,
      status: 'pending',
      resultAccountId: null,
      error: null,
    })
    const url = new URL(endpointsFor(data.provider, client.tenant).auth)
    url.searchParams.set('client_id', client.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', OAUTH_SCOPES[data.provider])
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (data.provider === 'google') {
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    } else {
      url.searchParams.set('response_mode', 'query')
      url.searchParams.set('prompt', 'select_account')
    }
    if (data.loginHint) url.searchParams.set('login_hint', data.loginHint)
    return { state, authUrl: url.toString(), redirectUri, expiresAt }
  },

  status(state: string): { status: 'pending' | 'done' | 'error'; accountId: string | null; error: string | null } {
    sweep()
    const entry = pending.get(state)
    if (!entry || entry.actor.id !== currentActor().id) throw new AppError(404, 'OAUTH_STATE_EXPIRED', '授权会话不存在或已过期，请重新发起')
    return { status: entry.status, accountId: entry.resultAccountId, error: entry.error }
  },

  /** 浏览器回调（非 /api，不需要 token；state 即凭证） */
  async callback(query: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    sweep()
    const state = typeof query.state === 'string' ? query.state : ''
    const entry = state ? pending.get(state) : undefined
    if (!entry || entry.status !== 'pending' || entry.expiresAt < Date.now()) {
      return { ok: false, message: '授权会话不存在或已过期，请回到 LULUX 重新发起授权。' }
    }
    if (typeof query.error === 'string') {
      entry.status = 'error'
      entry.error = `授权被拒绝：${String(query.error_description ?? query.error)}`
      return { ok: false, message: entry.error }
    }
    const code = typeof query.code === 'string' ? query.code : ''
    if (!code) {
      entry.status = 'error'
      entry.error = '回调缺少授权码'
      return { ok: false, message: entry.error }
    }
    try {
      const token = await postToken(entry.provider, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: entry.redirectUri,
        code_verifier: entry.verifier,
      })
      if (!token.refresh_token) throw new AppError(502, 'OAUTH_EXCHANGE_FAILED', '服务商没有返回 refresh token（请确认 scope 含 offline_access / access_type=offline）')
      let email = ''
      let displayName = ''
      const claims = token.id_token ? decodeJwtPayload(token.id_token) : {}
      email = String(claims.email ?? claims.preferred_username ?? '')
      displayName = String(claims.name ?? '')
      const userinfoUrl = endpointsFor(entry.provider, oauthClient(entry.provider).tenant).userinfo
      if (!email && userinfoUrl) {
        const response = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000) })
        const info = (await response.json()) as { email?: string; name?: string }
        email = info.email ?? ''
        displayName = displayName || info.name || ''
      }
      email = email.trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new AppError(502, 'OAUTH_EXCHANGE_FAILED', '无法从授权结果读取邮箱地址')
      const row = await runAs(entry.actor, async () => {
        const saved = accountService.upsertOAuth({
          accountId: entry.accountId,
          provider: entry.provider,
          email,
          displayName,
          refreshToken: token.refresh_token!,
          accessToken: token.access_token,
          expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
          visibility: entry.visibility,
          teamId: entry.teamId,
        })
        auditService.record({
          action: entry.accountId ? 'email_account.update' : 'email_account.create',
          entityType: 'email_account',
          entityId: saved.id,
          summary: `OAuth 授权邮箱 ${email}`,
        })
        return saved
      })
      publishAccount(row)
      entry.status = 'done'
      entry.resultAccountId = row.id
      return { ok: true, message: `已授权 ${email}，可以关闭此页面回到 LULUX。` }
    } catch (error) {
      entry.status = 'error'
      entry.error = messageOf(error)
      return { ok: false, message: `授权失败：${entry.error}` }
    }
  },
}
