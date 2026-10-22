import { ApiError, type EmailAddress, type EmailPreset, type Verdict } from '../api'
import { labelled, localized, t } from '../i18n'

/** 邮箱页面用到的纯函数（便于单测） */

export const VERDICT_LABEL: Record<Verdict, string> = localized(() => ({
  inquiry: t('mail.k8ab8zk'),
  spam: t('mail.k2qemew'),
  review: t('mail.kjfifnh'),
}))

export const VERDICT_SOURCE_LABEL: Record<string, string> = localized(() => ({
  rule: t('mail.k1twygko'),
  model: t('mail.k16g5qd9'),
  manual: t('mail.kzjumnp'),
}))

/** 按邮箱后缀推荐服务商预设 */
export function presetForEmail(presets: EmailPreset[], email: string): EmailPreset | null {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return null
  return presets.find((p) => p.domains.some((d) => d.toLowerCase() === domain)) ?? null
}

/** 密码栏的叫法因服务商而异 */
export function secretLabel(preset: EmailPreset | null): string {
  if (!preset) return t('mail.k1jjzsan')
  if (['qq', '163', '126'].includes(preset.id)) return t('mail.k11unj5d')
  if (['gmail', 'outlook', 'office365', 'zoho'].includes(preset.id)) return t('mail.k1by8fju')
  if (preset.id === 'exmail-qq' || preset.id === 'aliyun-qiye') return t('mail.kfe8civ')
  return t('mail.k1mh9vyr')
}

const EMAIL_ERRORS: Record<string, string> = localized(() => ({
  EMAIL_CONFIG_INVALID: t('mail.k1xbm6cw'),
  EMAIL_CONNECT_FAILED: t('mail.knhy6ls'),
  EMAIL_REAUTH_REQUIRED: t('mail.kswr4g7'),
  EMAIL_SECRET_UNAVAILABLE: t('mail.k17v26fz'),
  EMAIL_ACCOUNT_EXISTS: t('mail.k10cyaxq'),
  EMAIL_SYNC_FAILED: t('mail.k1aviqah'),
  EMAIL_SEND_FAILED: t('mail.kitt2do'),
  NO_RECIPIENTS: t('mail.k1riw1qp'),
  DRAFT_ALREADY_SENT: t('mail.k12x5znz'),
  ATTACHMENT_TOO_LARGE: t('mail.k1f1u8yr'),
  ALREADY_LINKED: t('mail.kdklt3h'),
  OAUTH_NOT_CONFIGURED: t('mail.k50aujv'),
  OAUTH_STATE_EXPIRED: t('mail.k11l7hsn'),
  OAUTH_EXCHANGE_FAILED: t('mail.kzdtta5'),
  NO_PROVIDER: t('mail.k19mwn59'),
  NO_MODEL: t('mail.kppt917'),
  API_KEY_UNAVAILABLE: t('mail.k1b5hbcl'),
  FORBIDDEN: t('mail.k9c0iu6'),
}))

/** 把邮箱相关错误翻成带操作指引的中文；服务端 message 更具体时保留 */
export function emailErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const base = EMAIL_ERRORS[error.code]
    if (!base) return error.message
    // AUTH_FAILED / SEND_FAILED 的 message 里有服务商原因，比通用文案更有用
    if (error.message && error.message !== base && !/^(HTTP_\d+|[A-Z_]+)$/.test(error.message)) {
      return error.code === 'EMAIL_SEND_FAILED' || error.code === 'EMAIL_CONNECT_FAILED'
        ? labelled(base, error.message)
        : error.message
    }
    return base
  }
  return error instanceof Error ? error.message : String(error)
}

export function formatAddress(a: EmailAddress | null | undefined): string {
  if (!a) return ''
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address
}

export function formatAddressList(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(', ')
}

/**
 * 解析用户输入的收件人：支持逗号 / 分号 / 换行分隔，`Name <a@b.com>` 或裸地址。
 * 返回合法地址与无法识别的片段。
 */
export function parseAddressList(input: string): { list: EmailAddress[]; invalid: string[] } {
  const list: EmailAddress[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of input.split(/[,;，；\n]+/)) {
    const part = raw.trim()
    if (!part) continue
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/) ?? null
    const name = m ? m[1].trim() : ''
    const address = (m ? m[2] : part).trim()
    if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(address)) {
      invalid.push(part)
      continue
    }
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push({ name, address })
  }
  return { list, invalid }
}

/** 发送前二次确认的说明文字：必须完整列出所有收件人 */
export function sendConfirmMessage(
  draft: {
    to: EmailAddress[]
    cc: EmailAddress[]
    bcc: EmailAddress[]
    subject: string
    attachments: { filename: string }[]
    attachQuotePdf: boolean
  },
  from: string,
): string {
  const lines = [t('mail.ktyn1xt', [from]), t('mail.kcahjq1', [formatAddressList(draft.to) || t('mail.kr93x5m')])]
  if (draft.cc.length) lines.push(t('mail.k1ranxl7', [formatAddressList(draft.cc)]))
  if (draft.bcc.length) lines.push(t('mail.k1dvmgy0', [formatAddressList(draft.bcc)]))
  lines.push(t('mail.k1y3th5m', [draft.subject || t('mail.k1v84skf')]))
  const files = draft.attachments.map((a) => a.filename)
  if (draft.attachQuotePdf && !files.some((f) => /\.pdf$/i.test(f))) files.push(t('mail.kjpusqv'))
  if (files.length) lines.push(t('mail.k1l6gg2o', [files.join(t('fmt.listSep'))]))
  lines.push('', t('mail.k14ryxqg'))
  return lines.join('\n')
}

/** 列表时间：今天显示时刻，今年显示月日，否则年月日 */
export function mailTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const n = new Date(now)
  const p = (x: number) => String(x).padStart(2, '0')
  if (d.toDateString() === n.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear()) return t('mail.k1xdmaps', [d.getMonth() + 1, d.getDate()])
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(binary)
}
