/**
 * MCP 子进程环境变量白名单：只继承运行所需的系统变量 + 用户为该 Server 显式配置的 env。
 * 其余（包括 LULUX_API_TOKEN / LULUX_MASTER_KEY 以及用户其他服务的密钥）一律不传。
 */
export const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'TEMP',
  'TMP',
  'LANG',
] as const

/** Windows 上环境变量名大小写不敏感（如 Path），按不区分大小写查找 */
function lookup(source: NodeJS.ProcessEnv, key: string): string | undefined {
  if (source[key] !== undefined) return source[key]
  if (process.platform !== 'win32') return undefined
  const lower = key.toLowerCase()
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() === lower) return value
  }
  return undefined
}

export function buildMcpEnv(
  configured: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = lookup(source, key)
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}
