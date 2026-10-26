import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 第三方内核清单。包名与 bin 已在 registry.npmmirror.com 上核实（2026-10-20）：
 *  - @anthropic-ai/claude-code 2.1.304，bin claude → bin/claude.exe（原生二进制，经平台 optionalDependency 安装）
 *  - @openai/codex 0.163.0，bin codex → bin/codex.js
 *  - @google/gemini-cli 0.64.0，bin gemini → bundle/gemini.js
 *  - @qwen-code/qwen-code 0.25.3，bin qwen → cli-entry.js
 * 非交互参数均按各 CLI 的 --help 核实。
 * 2026-10-21 增补（registry.npmjs.org 核实）：
 *  - hermes-agent 0.22.2，bin hermes → bin/hermes.js。Nous Research 官方不发 npm 包，这是社区维护的
 *    npm 桥（MIT，wyrtensi/hermes-agent-npm）：postinstall 用 uv 拉取隔离 Python 与上游固定 commit
 *    （需要 git 与访问 GitHub）。非交互：`hermes chat --oneshot --query-file - --format stream-json`
 *    （按上游 CLI 文档 hermes-agent.nousresearch.com/docs/reference/cli-commands 实现）。
 *  - @earendil-works/pi-coding-agent 1.3.0，bin pi → dist/bundle/cli.js。非交互：`pi --mode json`，
 *    提示词经 stdin；自定义 OpenAI 兼容端点写在 $PI_CODING_AGENT_DIR/models.json（包内 docs/ 核实）。
 *  - @xai-official/grok 1.0.62（xAI 官方 Grok Build CLI，Apache-2.0），bin grok → bin/grok（postinstall 从平台包
 *    @xai-official/grok-<os>-<arch> 解压出原生二进制；被阻止时 bin/grok 仍是 node 启动器，首次运行时自己解压）。
 *    非交互：`grok --prompt-file <file> --output-format streaming-json --no-alt-screen --always-approve`
 *    （docs.x.ai/build/cli/headless-scripting 与 `grok --help` 核实；-p 只能把提示词放在命令行上，所以用 --prompt-file）。
 *    自定义模型 [model.<id>] base_url / env_key / api_backend 见 docs.x.ai/build/settings/reference。
 *    注意：registry.npmmirror.com 上这个包停在 0.1.x（2026-10-21 核实），所以版本要求 >=1.0.0，镜像没有时回退 npmjs。
 */

export type StreamFormat = 'claude-stream-json' | 'codex-jsonl' | 'gemini-stream-json' | 'hermes-stream-json' | 'pi-json' | 'grok-streaming-json'

export interface KernelDefinition {
  id: string
  name: string
  vendor: string
  npmPackage: string
  bin: string
  description: string
  /** 内核选择器里的一行说明（同内核管理页的文案） */
  tagline: string
  /** 内核头像（客户端 public/agents/*.png）；没有 png 的内核为 null，客户端用 src/assets/*.svg 标志 */
  avatar: string | null
  sizeHint: string
  loginHint: string
  /** 非交互模式参数；提示词经 stdin 传入（promptFile 为 true 的内核除外） */
  args: string[]
  /** 提示词写进临时文件，参数里的 {promptFile} 替换为它的路径（CLI 不支持从 stdin 读提示词时） */
  promptFile?: boolean
  /** npm 安装的版本范围，缺省 latest（镜像上的版本过旧时用来强制回退到其他源） */
  versionRange?: string
  format: StreamFormat
  /** 是否检测到可用凭据（环境变量或本机登录文件）。返回 null 表示无法判断（仅 global 模式使用） */
  detectLogin: (env: NodeJS.ProcessEnv) => boolean | null
  /** 内核模式设置键（scoped | global），见 settings-schema.ts */
  modeSettingKey: string
}

function hasEnv(env: NodeJS.ProcessEnv, ...keys: string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()))
}

function homeFile(...parts: string[]): boolean {
  return existsSync(join(homedir(), ...parts))
}

export const KERNELS: KernelDefinition[] = [
  {
    id: 'hermes',
    modeSettingKey: 'kernelModeHermes',
    name: 'Hermes Agent',
    vendor: 'Nous Research',
    npmPackage: 'hermes-agent',
    bin: 'hermes',
    description: 'Nous Research 的自进化智能体（社区 npm 桥），以 oneshot stream-json 模式运行',
    tagline: 'Nous Research · MIT 许可 · 通过 npm 安装',
    avatar: '/agents/hermes.png',
    sizeHint: '约 450 MB',
    loginHint: '在终端运行 `hermes setup` 或 `hermes model` 选择 Provider 并配置 Key 后重启 LULUX ETA',
    args: ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--source', 'tool'],
    format: 'hermes-stream-json',
    detectLogin(env) {
      if (hasEnv(env, 'OPENROUTER_API_KEY', 'NOUS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY')) return true
      const hermesHome = env.HERMES_HOME?.trim()
      if (hermesHome && existsSync(join(hermesHome, 'config.yaml'))) return null
      if (homeFile('.hermes', 'auth.json')) return true
      return homeFile('.hermes', 'config.yaml') || homeFile('.hermes', '.env') ? null : false
    },
  },
  {
    id: 'claude-code',
    modeSettingKey: 'kernelModeClaudeCode',
    name: 'Claude Code',
    vendor: 'Anthropic',
    npmPackage: '@anthropic-ai/claude-code',
    bin: 'claude',
    description: 'Anthropic 官方命令行智能体，以非交互流式模式运行',
    tagline: 'Anthropic · npm 包 @anthropic-ai/claude-code',
    avatar: '/agents/claude.png',
    sizeHint: '约 280 MB',
    loginHint: '在终端运行 `claude` 并执行 /login 完成登录，或设置环境变量 ANTHROPIC_API_KEY 后重启 LULUX ETA',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
    format: 'claude-stream-json',
    detectLogin(env) {
      if (hasEnv(env, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')) return true
      if (homeFile('.claude', '.credentials.json')) return true
      // macOS 把凭据存在钥匙串，无法从文件判断
      if (process.platform === 'darwin') return null
      return false
    },
  },
  {
    id: 'codex',
    modeSettingKey: 'kernelModeCodex',
    name: 'Codex',
    vendor: 'OpenAI',
    npmPackage: '@openai/codex',
    bin: 'codex',
    description: 'OpenAI 官方命令行智能体，以 exec --json 模式运行（只读沙箱）',
    tagline: 'OpenAI · npm',
    avatar: '/agents/codex.png',
    sizeHint: '约 370 MB',
    loginHint: '在终端运行 `codex login` 完成登录，或设置环境变量 OPENAI_API_KEY 后重启 LULUX ETA',
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'],
    format: 'codex-jsonl',
    detectLogin(env) {
      if (hasEnv(env, 'OPENAI_API_KEY', 'CODEX_API_KEY')) return true
      const codexHome = env.CODEX_HOME?.trim()
      if (codexHome && existsSync(join(codexHome, 'auth.json'))) return true
      return homeFile('.codex', 'auth.json')
    },
  },
  {
    id: 'pi',
    modeSettingKey: 'kernelModePi',
    name: 'Pi',
    vendor: 'Earendil Works',
    npmPackage: '@earendil-works/pi-coding-agent',
    bin: 'pi',
    description: '极简的命令行编码智能体，以 --mode json 模式运行（只读工具）',
    tagline: 'Earendil Works · npm',
    avatar: '/agents/pi.png',
    sizeHint: '约 40 MB',
    loginHint: '在终端运行 `pi` 并执行 /login，或设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量后重启 LULUX ETA',
    args: ['--mode', 'json', '--no-session', '--tools', 'read,grep,find,ls'],
    format: 'pi-json',
    detectLogin(env) {
      if (hasEnv(env, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY')) return true
      const piDir = env.PI_CODING_AGENT_DIR?.trim()
      if (piDir && existsSync(join(piDir, 'auth.json'))) return true
      return homeFile('.pi', 'agent', 'auth.json')
    },
  },
  {
    id: 'grok',
    modeSettingKey: 'kernelModeGrok',
    name: 'Grok',
    vendor: 'SpaceXAI',
    npmPackage: '@xai-official/grok',
    bin: 'grok',
    description: 'xAI 官方 Grok Build 命令行智能体，以 headless streaming-json 模式运行（只读工具）',
    tagline: 'SpaceXAI · npm',
    avatar: '/agents/grok.png',
    sizeHint: '约 210 MB',
    loginHint: '在终端运行 `grok login`，或设置环境变量 XAI_API_KEY 后重启 LULUX ETA',
    args: [
      '--prompt-file',
      '{promptFile}',
      '--output-format',
      'streaming-json',
      '--no-alt-screen',
      '--always-approve',
      '--no-auto-update',
      '--tools',
      'read_file,list_dir,grep',
      '--no-subagents',
      '--no-plan',
      '--disable-web-search',
    ],
    promptFile: true,
    versionRange: '>=1.0.0',
    format: 'grok-streaming-json',
    detectLogin(env) {
      if (hasEnv(env, 'XAI_API_KEY')) return true
      const grokHome = env.GROK_HOME?.trim()
      if (grokHome && existsSync(join(grokHome, 'auth.json'))) return true
      return homeFile('.grok', 'auth.json') ? true : homeFile('.grok', 'config.toml') ? null : false
    },
  },
  {
    id: 'gemini-cli',
    modeSettingKey: 'kernelModeGeminiCli',
    name: 'Gemini CLI',
    vendor: 'Google',
    npmPackage: '@google/gemini-cli',
    bin: 'gemini',
    description: 'Google 官方命令行智能体，以 headless stream-json 模式运行（plan 只读）',
    tagline: 'Google · npm',
    avatar: null,
    sizeHint: '约 100 MB',
    loginHint: '在终端运行 `gemini` 完成 Google 登录，或设置环境变量 GEMINI_API_KEY 后重启 LULUX ETA',
    args: ['-p', ' ', '--output-format', 'stream-json', '--approval-mode', 'plan', '--skip-trust'],
    format: 'gemini-stream-json',
    detectLogin(env) {
      if (hasEnv(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA')) return true
      if (homeFile('.gemini', 'oauth_creds.json')) return true
      return homeFile('.gemini', 'settings.json') ? null : false
    },
  },
  {
    id: 'qwen-code',
    modeSettingKey: 'kernelModeQwenCode',
    name: 'Qwen Code',
    vendor: 'Alibaba Qwen',
    npmPackage: '@qwen-code/qwen-code',
    bin: 'qwen',
    description: '通义千问团队的命令行智能体，以 stream-json 模式运行（plan 只读）',
    tagline: '阿里云 · npm',
    avatar: null,
    sizeHint: '约 170 MB',
    loginHint: '在终端运行 `qwen` 完成登录（Qwen OAuth 或配置 OpenAI 兼容 Key）后重启 LULUX ETA',
    args: ['--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', 'plan'],
    format: 'claude-stream-json',
    detectLogin(env) {
      if (homeFile('.qwen', 'oauth_creds.json')) return true
      if (homeFile('.qwen', 'settings.json')) return null
      if (hasEnv(env, 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY')) return null
      return false
    },
  },
]

export function findKernel(id: string): KernelDefinition | undefined {
  return KERNELS.find((kernel) => kernel.id === id)
}
