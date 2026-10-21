import { AppError, messageOf } from '../../errors.js'
import { db } from '../../db.js'
import { decryptSecret, encryptSecret } from '../../security/secrets.js'

export type OAuthProvider = 'google' | 'microsoft'

export interface OAuthEndpoints {
  auth: string
  token: string
  userinfo: string | null
}

/** 测试可用 LULUX_OAUTH_TEST_ENDPOINTS（JSON）覆盖服务商地址 */
export function endpointsFor(provider: OAuthProvider, tenant = 'common'): OAuthEndpoints {
  const override = process.env.LULUX_OAUTH_TEST_ENDPOINTS
  if (override) {
    const parsed = JSON.parse(override) as Partial<Record<OAuthProvider, OAuthEndpoints>>
    if (parsed[provider]) return parsed[provider]!
  }
  if (provider === 'google') {
    return {
      auth: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    }
  }
  const t = encodeURIComponent(tenant || 'common')
  return {
    auth: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    userinfo: null,
  }
}

export const OAUTH_SCOPES: Record<OAuthProvider, string> = {
  google: 'https://mail.google.com/ openid email profile',
  microsoft:
    'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send openid email profile',
}

// ── 配置（app_meta） ─────────────────────────────────────

function meta(key: string): string {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? ''
}

function setMeta(key: string, value: string): void {
  if (!value) {
    db.prepare('DELETE FROM app_meta WHERE key = ?').run(key)
    return
  }
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  tenant: string
}

export function oauthClient(provider: OAuthProvider): OAuthClientConfig {
  let clientSecret = ''
  try {
    clientSecret = decryptSecret(meta(`oauth.${provider}.clientSecret`))
  } catch {
    clientSecret = ''
  }
  return {
    clientId: meta(`oauth.${provider}.clientId`),
    clientSecret,
    tenant: meta(`oauth.${provider}.tenant`) || 'common',
  }
}

export function saveOAuthClient(provider: OAuthProvider, patch: { clientId?: string; clientSecret?: string; tenant?: string }): void {
  if (patch.clientId !== undefined) setMeta(`oauth.${provider}.clientId`, patch.clientId.trim())
  if (patch.tenant !== undefined) setMeta(`oauth.${provider}.tenant`, patch.tenant.trim())
  if (patch.clientSecret !== undefined) setMeta(`oauth.${provider}.clientSecret`, patch.clientSecret ? encryptSecret(patch.clientSecret) : '')
}

export function hasClientSecret(provider: OAuthProvider): boolean {
  return Boolean(meta(`oauth.${provider}.clientSecret`))
}

// ── token 交换 / 刷新 ────────────────────────────────────

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

export async function postToken(provider: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const client = oauthClient(provider)
  const body = new URLSearchParams({ client_id: client.clientId, ...params })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  if (provider === 'microsoft' && !body.has('scope')) body.set('scope', OAUTH_SCOPES.microsoft)
  let response: Response
  try {
    response = await fetch(endpointsFor(provider, client.tenant).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw new AppError(502, 'OAUTH_EXCHANGE_FAILED', `连接授权服务器失败：${messageOf(error)}`)
  }
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // 非 JSON
  }
  if (!response.ok || typeof json.access_token !== 'string') {
    const reason = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : `HTTP ${response.status}`
    throw new AppError(502, 'OAUTH_EXCHANGE_FAILED', `授权服务器拒绝：${reason}`)
  }
  return json as unknown as TokenResponse
}

export class ReauthRequiredError extends AppError {
  constructor(message = 'OAuth 授权已失效，请重新授权该邮箱') {
    super(409, 'EMAIL_REAUTH_REQUIRED', message)
  }
}

interface TokenRow {
  id: string
  oauth_provider: string | null
  secret: string
  oauth_access: string
  oauth_expires_at: number | null
}

/** 返回可用的 access token；过期前 2 分钟自动刷新（契约 4.3） */
export async function accessTokenFor(row: TokenRow): Promise<string> {
  const provider = row.oauth_provider as OAuthProvider
  let access = ''
  try {
    access = decryptSecret(row.oauth_access)
  } catch {
    access = ''
  }
  if (access && row.oauth_expires_at && row.oauth_expires_at - Date.now() > 120_000) return access
  let refresh = ''
  try {
    refresh = decryptSecret(row.secret)
  } catch {
    throw new AppError(409, 'EMAIL_SECRET_UNAVAILABLE', '邮箱凭据无法用当前主密钥解密，请重新授权')
  }
  if (!refresh) throw new ReauthRequiredError()
  let token: TokenResponse
  try {
    token = await postToken(provider, { grant_type: 'refresh_token', refresh_token: refresh })
  } catch (error) {
    db.prepare("UPDATE email_accounts SET state = 'needs_reauth', last_error = ?, last_error_code = 'EMAIL_REAUTH_REQUIRED', updated_at = ? WHERE id = ?").run(
      messageOf(error),
      Date.now(),
      row.id,
    )
    throw new ReauthRequiredError(`OAuth 刷新失败，请重新授权：${messageOf(error)}`)
  }
  const expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000
  db.prepare('UPDATE email_accounts SET oauth_access = ?, oauth_expires_at = ?, secret = CASE WHEN ? <> \'\' THEN ? ELSE secret END WHERE id = ?').run(
    encryptSecret(token.access_token),
    expiresAt,
    token.refresh_token ?? '',
    token.refresh_token ? encryptSecret(token.refresh_token) : '',
    row.id,
  )
  return token.access_token
}
