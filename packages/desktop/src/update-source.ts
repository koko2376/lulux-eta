/**
 * 更新源地址与更新错误的纯函数（不依赖 electron，便于单元测试）。
 */

export type UpdateErrorKind = 'network' | 'not-found' | 'forbidden' | 'bad-feed' | 'other'

/** 把 electron-updater / 网络层的错误归类，界面据此给出明确提示 */
export function classifyUpdateError(error: unknown): UpdateErrorKind {
  const text = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}` : String(error)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|net::ERR_|socket hang up|network|timed? ?out|getaddrinfo|CERT_|certificate/i.test(text)) {
    return 'network'
  }
  if (/\b404\b|Not Found|Cannot find channel|latest[-\w]*\.yml/i.test(text)) return 'not-found'
  if (/\b(401|403)\b|Unauthorized|Forbidden|rate limit/i.test(text)) return 'forbidden'
  if (/YAML|yaml|parse|Unexpected token|sha512 checksum|checksum mismatch/i.test(text)) return 'bad-feed'
  return 'other'
}

/**
 * 更新源只允许 https：安装包的完整性只靠同一个源里的 latest.yml 校验，明文 http 会被同网段的中间人整包替换。
 * http 只放行本机回环地址（localhost / 127.0.0.1 / [::1]），用于本机测试。
 */
export function feedProtocolAllowed(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

/**
 * 规范化“更新源地址”（generic provider）：只接受 https（http 仅限本机回环地址），末尾补 /；
 * 空字符串 / null 表示不用自定义源。不合法时抛错（消息给界面直接显示）。
 */
export function normalizeFeedUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('更新源地址必须是字符串')
  const text = raw.trim()
  if (!text) return null
  if (text.length > 500) throw new Error('更新源地址过长')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('更新源地址不是有效的网址（例如 https://mirror.example.com/lulux/）')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('更新源地址只支持 https://')
  if (!feedProtocolAllowed(url)) throw new Error('更新源地址必须使用 https://（http 只允许 localhost / 127.0.0.1，用于本机测试）')
  if (url.username || url.password) throw new Error('更新源地址里不要包含用户名或密码')
  url.hash = ''
  const href = url.href
  return href.endsWith('/') ? href : `${href}/`
}
