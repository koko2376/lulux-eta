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

/**
 * 本机命令型 MCP 的启动参数安全检查（保存前与每次启动前都做）。
 *
 * 用户在确认框里看到的是命令、参数和环境变量名（看不到变量值），所以要保证「看到的就是会执行的」：
 * - 命令与参数里不能有控制字符（NUL、ESC 控制序列等）；Windows 上经 cmd.exe 转发的命令，参数里也不能有换行（会截断 / 拼接命令）；
 * - 不允许设置会改变「运行哪个程序、加载哪些代码」的环境变量（PATH、NODE_OPTIONS、LD_PRELOAD 等）：
 *   这些变量能让确认框里看似无害的命令去加载任意代码；
 * - Windows 上非 .exe / .com 的命令（.cmd / .bat 包装脚本等）要经 cmd.exe 转发，参数里的双引号会被
 *   包装脚本重新解析，从而拼出额外的命令，这类命令的参数不允许出现双引号。
 */
/** 除制表符和换行外的控制字符（NUL、退格、ESC 控制序列等能在确认框里藏内容或截断参数） */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LINE_BREAKS = /[\r\n]/

const CODE_LOADING_ENV = new Set([
  'path',
  'pathext',
  'comspec',
  'node_options',
  'bash_env',
  'env',
  'shellopts',
  'perl5opt',
  'perl5lib',
  'perllib',
  'rubyopt',
  'rubylib',
  'pythonstartup',
  'pythonpath',
  'pythonhome',
  'java_tool_options',
  '_java_options',
  'jdk_java_options',
  'electron_run_as_node',
])

export function unsafeMcpCommandReason(
  spec: { command: string; args: string[]; env: Record<string, string> },
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Windows 上非 .exe / .com 的命令经 cmd.exe 转发：换行会截断命令，双引号会被包装脚本重新解析
  const viaCmd = platform === 'win32' && !/\.(exe|com)$/i.test(spec.command.trim())
  if (CONTROL_CHARS.test(spec.command) || LINE_BREAKS.test(spec.command)) return '命令里不能包含换行或其他控制字符'
  for (const arg of spec.args) {
    if (CONTROL_CHARS.test(arg) || (viaCmd && LINE_BREAKS.test(arg))) return '参数里不能包含换行或其他控制字符'
  }
  for (const key of Object.keys(spec.env)) {
    const lower = key.toLowerCase()
    if (CODE_LOADING_ENV.has(lower) || lower.startsWith('ld_') || lower.startsWith('dyld_')) {
      return `不允许设置环境变量 ${key}：它会改变实际运行的程序或加载的代码`
    }
  }
  if (viaCmd && spec.args.some((arg) => arg.includes('"'))) {
    return '在 Windows 上，经命令包装脚本启动的程序（如 npx、.cmd、.bat）参数里不能包含双引号'
  }
  return null
}
