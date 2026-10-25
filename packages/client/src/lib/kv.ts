import { t } from '../i18n'
/** "KEY=VALUE" 每行一条 <-> Record */
export function parseEnvText(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {}
  const errors: string[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const eq = line.indexOf('=')
    if (eq <= 0) {
      errors.push(t('kv.k1va8fwd', [index + 1]))
      return
    }
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(t('kv.k12f30u9', [index + 1, key]))
      return
    }
    env[key] = line.slice(eq + 1)
  })
  return { env, errors }
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

export function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

const RESERVED_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'host', 'content-length']

/** 远程 MCP 请求头："Name: value" 或 "Name=value" 每行一条（值里可以有冒号） */
export function parseHeadersText(text: string): { headers: Record<string, string>; errors: string[] } {
  const headers: Record<string, string> = {}
  const errors: string[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const m = /^([^:=\s]+)\s*[:=]\s*(.*)$/.exec(line)
    if (!m) {
      errors.push(t('kv.k1t464dq', [index + 1]))
      return
    }
    const key = m[1]
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) {
      errors.push(t('kv.k151k4od', [index + 1, key]))
      return
    }
    if (RESERVED_HEADERS.includes(key.toLowerCase())) {
      errors.push(t('kv.kphg8mm', [index + 1, key]))
      return
    }
    headers[key] = m[2]
  })
  if (Object.keys(headers).length > 20) errors.push(t('kv.k1flxln'))
  return { headers, errors }
}
