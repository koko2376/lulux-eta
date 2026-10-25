import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../../types.js'
import { modelAlias } from '../gateway/upstream.js'
import { providerService } from '../provider-service.js'
import { settingsService } from '../settings-service.js'
import { findKernel, type KernelDefinition } from './catalog.js'
import { kernelMcpToolTimeoutMs } from '../tool-approval.js'

/**
 * 内核运行模式（契约“内核网关”）：
 * - scoped（默认）：每个内核/会话一个隔离的配置目录，CLI 只认识本机网关与一次性令牌，
 *   网关再把请求转给用户在 LULUX 里配置的 Provider/模型。不需要 CLI 自己登录。
 * - global：沿用 CLI 自己的登录与配置（旧行为）。
 */
export type KernelMode = 'scoped' | 'global'

export const SCOPED_UNAVAILABLE_REASON = '请先在模型与密钥中配置模型'

export function kernelMode(id: string): KernelMode {
  const def = findKernel(id)
  if (!def) return 'global'
  return settingsService.get(def.modeSettingKey) === 'global' ? 'global' : 'scoped'
}

/** scoped 模式使用的 Provider：会话指定 → 默认 Provider → 第一个；必须有模型且 Key 可用 */
export function resolveScopedProvider(sessionProviderId?: string | null): Provider | null {
  const defaultProviderId = settingsService.get('defaultProviderId')
  const provider =
    (sessionProviderId ? providerService.get(sessionProviderId) : undefined) ??
    (defaultProviderId ? providerService.get(defaultProviderId) : undefined) ??
    providerService.list()[0] ??
    null
  if (!provider || !provider.model || provider.apiKeyError) return null
  return provider
}

/** scoped 模式下剥掉的继承环境变量：避免用户全局的 Key/配置混入，也避免真实 Key 泄露给 CLI */
const STRIP_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'CODEX_',
  'GEMINI_',
  'GOOGLE_',
  'QWEN_',
  'DASHSCOPE_',
  'AZURE_OPENAI',
  'OPENROUTER_',
  'VERTEX',
  'LULUX_',
  'HERMES_',
  'NOUS_',
  'PI_',
  'XAI_',
  'GROK_',
]

export function scopedBaseEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase()
    if (STRIP_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    env[key] = value
  }
  // CLI 访问本机网关不能走用户的 HTTP(S)_PROXY
  const loopback = '127.0.0.1,localhost,::1'
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const current = env[key]?.trim()
    env[key] = current ? `${current},${loopback}` : loopback
  }
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

export interface ScopedContext {
  token: string
  port: number
  provider: Provider
  model: string
  /** 隔离配置目录 <dataDir>/kernels/<id>/home/<sessionId> */
  home: string
  /** 内置 LULUX MCP 的一次性令牌（只在本次运行有效）；缺省则不注入 MCP */
  mcpToken?: string
}

export const LULUX_MCP_CONFIG_FILE = 'lulux-mcp.json'

/** 内置 LULUX MCP 的连接信息（各 CLI 的配置格式不同，见 scopedLaunch） */
export function luluxMcpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/gateway/mcp`
}

export interface ScopedLaunch {
  env: Record<string, string>
  args: string[]
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** 隔离目录归 LULUX 管理：每次运行都把我们关心的键写回（保留 CLI 自己写入的其他键） */
function writeSettings(file: string, value: Record<string, unknown>): void {
  let current: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
    } catch {
      current = {}
    }
  }
  const merged: Record<string, unknown> = { ...current }
  for (const [key, inner] of Object.entries(value)) {
    const prev = merged[key]
    merged[key] =
      inner && typeof inner === 'object' && !Array.isArray(inner) && prev && typeof prev === 'object' && !Array.isArray(prev)
        ? { ...(prev as Record<string, unknown>), ...(inner as Record<string, unknown>) }
        : inner
  }
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
}

/** LULUX MCP 工具超时（秒），与审批等待对齐 */
function mcpTimeoutSeconds(): number {
  return Math.ceil(kernelMcpToolTimeoutMs() / 1000)
}

/** Gemini CLI / Qwen Code settings.json 的 mcpServers 条目；无令牌时为 undefined（序列化时删除旧条目） */
function settingsMcp(ctx: ScopedContext): Record<string, unknown> | undefined {
  if (!ctx.mcpToken) return undefined
  return { httpUrl: luluxMcpEndpoint(ctx.port), headers: { Authorization: `Bearer ${ctx.mcpToken}` }, trust: true, timeout: kernelMcpToolTimeoutMs() }
}

/** Claude Code：--mcp-config 指向隔离目录里的配置文件（0600，令牌在运行结束后即失效）；允许 mcp__lulux 全部工具（写操作由 LULUX 自己审批） */
function claudeMcpArgs(ctx: ScopedContext): string[] {
  const file = join(ctx.home, LULUX_MCP_CONFIG_FILE)
  if (!ctx.mcpToken) {
    rmSync(file, { force: true })
    return []
  }
  const config = { mcpServers: { lulux: { type: 'http', url: luluxMcpEndpoint(ctx.port), headers: { Authorization: `Bearer ${ctx.mcpToken}` } } } }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return ['--mcp-config', file, '--allowedTools', 'mcp__lulux']
}

/** 各 CLI 的隔离配置：只写入网关地址、一次性令牌（仅环境变量）与模型名，绝不写入真实 Key */
export function scopedLaunch(def: KernelDefinition, ctx: ScopedContext): ScopedLaunch {
  mkdirSync(ctx.home, { recursive: true })
  const base = `http://127.0.0.1:${ctx.port}/gateway`
  const alias = modelAlias(ctx.provider, ctx.model)

  switch (def.id) {
    case 'claude-code':
      return {
        env: {
          CLAUDE_CONFIG_DIR: ctx.home,
          ANTHROPIC_BASE_URL: `${base}/anthropic`,
          ANTHROPIC_AUTH_TOKEN: ctx.token,
          ANTHROPIC_MODEL: alias,
          ANTHROPIC_SMALL_FAST_MODEL: alias,
          ANTHROPIC_DEFAULT_OPUS_MODEL: alias,
          ANTHROPIC_DEFAULT_SONNET_MODEL: alias,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: alias,
          CLAUDE_CODE_SUBAGENT_MODEL: alias,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
          // 网关在本机，上游错误已经是最终结果；少重试，失败尽快反馈给用户
          CLAUDE_CODE_MAX_RETRIES: '2',
          // MCP 工具超时（毫秒）不小于审批等待，避免等用户批准时 CLI 先超时
          ...(ctx.mcpToken ? { MCP_TOOL_TIMEOUT: String(kernelMcpToolTimeoutMs()) } : {}),
        },
        args: [...def.args, '--model', alias, ...claudeMcpArgs(ctx)],
      }
    case 'codex': {
      // codex exec 的 -c 覆盖 config.toml；自定义 provider 走 Responses 协议，Key 从 env_key 指定的变量读取
      const [first, ...rest] = def.args
      return {
        env: { CODEX_HOME: ctx.home, LULUX_GATEWAY_KEY: ctx.token, ...(ctx.mcpToken ? { LULUX_MCP_TOKEN: ctx.mcpToken } : {}) },
        args: [
          first!,
          '-c',
          'model_provider="lulux"',
          '-c',
          'model_providers.lulux.name="LULUX"',
          '-c',
          `model_providers.lulux.base_url=${tomlString(`${base}/openai/v1`)}`,
          '-c',
          'model_providers.lulux.wire_api="responses"',
          '-c',
          'model_providers.lulux.env_key="LULUX_GATEWAY_KEY"',
          '-c',
          'model_providers.lulux.request_max_retries=1',
          '-c',
          'model_providers.lulux.stream_max_retries=1',
          '-c',
          `model=${tomlString(ctx.model)}`,
          ...(ctx.mcpToken
            ? [
                '-c',
                `mcp_servers.lulux.url=${tomlString(luluxMcpEndpoint(ctx.port))}`,
                '-c',
                'mcp_servers.lulux.bearer_token_env_var="LULUX_MCP_TOKEN"',
                // 工具超时不小于审批等待（CLI 默认只有 60 秒，等用户批准时会先超时）
                '-c',
                `mcp_servers.lulux.tool_timeout_sec=${mcpTimeoutSeconds()}`,
              ]
            : []),
          ...rest,
        ],
      }
    }
    case 'gemini-cli': {
      // Gemini CLI 的 gemini-api-key 认证会读取 GOOGLE_GEMINI_BASE_URL 作为自定义 base URL；
      // GEMINI_API_KEY（一次性令牌）作为 x-goog-api-key 头发给网关。
      // （0.64 的 “gateway” 认证类型在 headless 校验里不被接受，所以显式选 gemini-api-key）
      const dir = join(ctx.home, '.gemini')
      mkdirSync(dir, { recursive: true })
      writeSettings(join(dir, 'settings.json'), {
        security: { auth: { selectedType: 'gemini-api-key' } },
        privacy: { usageStatisticsEnabled: false },
        general: { disableAutoUpdate: true, disableUpdateNag: true },
        mcpServers: { lulux: settingsMcp(ctx) },
      })
      return {
        env: {
          GEMINI_CLI_HOME: ctx.home,
          GOOGLE_GEMINI_BASE_URL: `${base}/gemini`,
          GEMINI_API_KEY: ctx.token,
        },
        args: [...def.args],
      }
    }
    case 'qwen-code':
      // Qwen Code 原生支持 OpenAI 兼容：OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL
      writeSettings(join(ctx.home, 'settings.json'), {
        security: { auth: { selectedType: 'openai' } },
        privacy: { usageStatisticsEnabled: false },
        general: { disableAutoUpdate: true },
        mcpServers: { lulux: settingsMcp(ctx) },
      })
      return {
        env: {
          QWEN_HOME: ctx.home,
          OPENAI_BASE_URL: `${base}/openai/v1`,
          OPENAI_API_KEY: ctx.token,
          OPENAI_MODEL: ctx.model,
        },
        args: [...def.args, '--auth-type', 'openai', '--model', ctx.model],
      }
    case 'hermes': {
      // Hermes Agent 0.22：HERMES_HOME 指向隔离目录，在其中的 config.yaml 声明一个 OpenAI 兼容的 lulux provider
      // （key_env 读一次性令牌，Key 不落盘），--provider lulux 选中它；--ignore-rules 不注入用户的 AGENTS.md / 记忆。
      // （新版上游的 --base-url/--api-key 启动参数 0.22.2 还没有）。JSON 是合法的 YAML，直接写 JSON 文本。
      // 工具：只开 skills 与 LULUX MCP（toolset 用服务器名 lulux，即 mcp-lulux 的别名；直接写 mcp-lulux 时 0.22.2 不会发现服务器）——不开 terminal / 文件写入，与其他内核的只读模式一致；
      // 关掉 tool_search，让 MCP 工具直接声明给模型（写操作仍由 LULUX 审批）
      const config: Record<string, unknown> = {
        model: { provider: 'lulux', default: ctx.model },
        providers: { lulux: { base_url: `${base}/openai/v1`, key_env: 'LULUX_GATEWAY_KEY' } },
        tools: { tool_search: { enabled: 'off' } },
      }
      if (ctx.mcpToken) {
        config.mcp_servers = {
          lulux: { url: luluxMcpEndpoint(ctx.port), headers: { Authorization: 'Bearer ${LULUX_MCP_TOKEN}' }, timeout: mcpTimeoutSeconds() },
        }
      }
      writeFileSync(join(ctx.home, 'config.yaml'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      return {
        env: {
          HERMES_HOME: ctx.home,
          LULUX_GATEWAY_KEY: ctx.token,
          ...(ctx.mcpToken ? { LULUX_MCP_TOKEN: ctx.mcpToken } : {}),
        },
        args: [...def.args, '--provider', 'lulux', '--model', ctx.model, '--ignore-rules', '--toolsets', ctx.mcpToken ? 'skills,lulux' : 'skills'],
      }
    }
    case 'pi': {
      // Pi：$PI_CODING_AGENT_DIR/models.json 声明一个 OpenAI 兼容的 lulux provider，Key 用环境变量插值（不落盘）；
      // MCP 写在同目录 mcp.json（Authorization 同样插值）。
      writeSettings(join(ctx.home, 'models.json'), {
        providers: {
          lulux: {
            baseUrl: `${base}/openai/v1`,
            api: 'openai-completions',
            apiKey: '$LULUX_GATEWAY_KEY',
            models: [{ id: ctx.model }],
          },
        },
      })
      const mcpFile = join(ctx.home, 'mcp.json')
      if (ctx.mcpToken) {
        writeFileSync(
          mcpFile,
          `${JSON.stringify({ mcpServers: { lulux: { url: luluxMcpEndpoint(ctx.port), headers: { Authorization: 'Bearer ${LULUX_MCP_TOKEN}' }, exposure: 'direct', timeout: mcpTimeoutSeconds() } } }, null, 2)}\n`,
          { mode: 0o600 },
        )
      } else {
        rmSync(mcpFile, { force: true })
      }
      return {
        env: {
          PI_CODING_AGENT_DIR: ctx.home,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          LULUX_GATEWAY_KEY: ctx.token,
          ...(ctx.mcpToken ? { LULUX_MCP_TOKEN: ctx.mcpToken } : {}),
        },
        // --tools 是声明给模型的白名单：只读内置工具 + LULUX MCP（direct 暴露，写操作仍由 LULUX 审批）
        args: [...def.args.map((arg) => (arg === 'read,grep,find,ls' && ctx.mcpToken ? 'read,grep,find,ls,mcp__lulux__*' : arg)), '--provider', 'lulux', '--model', ctx.model],
      }
    }
    case 'grok': {
      // Grok Build：GROK_HOME 指向隔离目录，config.toml 里声明一个自定义模型 [model.lulux]
      // （OpenAI 兼容 chat_completions，base_url 是本机网关，Key 用 env_key 从环境变量读一次性令牌，不落盘）；
      // 会话标题 / 摘要 / 搜索 / 图片描述这些旁路请求也走 lulux 模型（否则会去 api.x.ai 要 xAI 登录）。
      // 关掉 Claude / Cursor 配置兼容扫描（不读用户 ~/.claude 里的 MCP、hooks、CLAUDE.md），关掉自动更新、记忆、子 Agent、
      // MCP 按需发现（tool_search），LULUX MCP 写在 [mcp_servers.lulux]（bearer_token_env_var，令牌只在环境变量里）。
      const lines = [
        '# LULUX ETA 管理的隔离配置（每次运行重写）',
        '[cli]',
        'auto_update = false',
        '',
        '[models]',
        'default = "lulux"',
        'session_summary = "lulux"',
        'web_search = "lulux"',
        'image_description = "lulux"',
        '',
        '[model.lulux]',
        `model = ${tomlString(ctx.model)}`,
        `base_url = ${tomlString(`${base}/openai/v1`)}`,
        'name = "LULUX"',
        'env_key = "LULUX_GATEWAY_KEY"',
        'api_backend = "chat_completions"',
        'supports_backend_search = false',
        'max_retries = 1',
        '',
        '[compat.claude]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
        '',
        '[compat.cursor]',
        'skills = false',
        'rules = false',
        'agents = false',
        'mcps = false',
        'hooks = false',
      ]
      if (ctx.mcpToken) {
        lines.push('', '[mcp_servers.lulux]', `url = ${tomlString(luluxMcpEndpoint(ctx.port))}`, 'bearer_token_env_var = "LULUX_MCP_TOKEN"', `tool_timeout_sec = ${mcpTimeoutSeconds()}`)
      }
      writeFileSync(join(ctx.home, 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600 })
      const off = (keys: string[]): Record<string, string> => Object.fromEntries(keys.map((key) => [key, '0']))
      return {
        env: {
          GROK_HOME: ctx.home,
          LULUX_GATEWAY_KEY: ctx.token,
          GROK_DISABLE_AUTOUPDATER: '1',
          GROK_TOOL_SEARCH: '0',
          GROK_WRITE_FILE: '0',
          GROK_MEMORY: '0',
          GROK_SUBAGENTS: '0',
          GROK_WEB_FETCH: '0',
          ...off([
            'GROK_CLAUDE_SKILLS_ENABLED',
            'GROK_CLAUDE_RULES_ENABLED',
            'GROK_CLAUDE_AGENTS_ENABLED',
            'GROK_CLAUDE_MCPS_ENABLED',
            'GROK_CLAUDE_HOOKS_ENABLED',
            'GROK_CURSOR_SKILLS_ENABLED',
            'GROK_CURSOR_RULES_ENABLED',
            'GROK_CURSOR_AGENTS_ENABLED',
            'GROK_CURSOR_MCPS_ENABLED',
            'GROK_CURSOR_HOOKS_ENABLED',
          ]),
          ...(ctx.mcpToken ? { LULUX_MCP_TOKEN: ctx.mcpToken } : {}),
        },
        args: [...def.args, '-m', 'lulux'],
      }
    }
    default:
      return { env: {}, args: [...def.args] }
  }
}
