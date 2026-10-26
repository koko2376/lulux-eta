import { DEFAULT_AGENT_ID } from './agents.js'

/**
 * 设置项白名单。值在库里与接口中都以字符串存储/返回（兼容旧版）：
 * boolean 为 '0' | '1'，integer 为十进制字符串。PATCH 时也接受 true/false 与数字。
 */
export type SettingType = 'string' | 'boolean' | 'integer' | 'enum'

export interface SettingDefinition {
  key: string
  type: SettingType
  default: string
  enum?: string[]
  min?: number
  max?: number
  description: string
}

export const SETTINGS_SCHEMA: SettingDefinition[] = [
  { key: 'theme', type: 'enum', default: 'dark', enum: ['dark', 'light', 'system'], description: '界面主题' },
  { key: 'language', type: 'enum', default: 'zh-CN', enum: ['zh-CN', 'en-US'], description: '界面语言' },
  { key: 'defaultProviderId', type: 'string', default: '', description: '默认 Provider，留空时用列表第一个' },
  { key: 'defaultAgentId', type: 'string', default: DEFAULT_AGENT_ID, description: '新会话默认 Agent' },
  { key: 'contextLimit', type: 'integer', default: '40', min: 2, max: 200, description: '每轮携带的历史消息条数' },
  { key: 'proxyUrl', type: 'string', default: '', description: '出站 HTTP(S) 代理，留空直连' },
  { key: 'webhookUrl', type: 'string', default: '', description: '对话完成通知地址（http/https）' },
  { key: 'webhookEnabled', type: 'boolean', default: '0', description: '是否发送对话完成通知' },
  // 会话权限级别（契约 §6.11）：新会话的默认级别；每个会话可在输入框旁单独切换
  { key: 'defaultPermissionLevel', type: 'enum', default: 'ask', enum: ['read', 'ask', 'full'], description: '新会话的默认权限：read 仅可查看（不提供写/执行工具）/ ask 需审批 / full 完全权限（直接执行）' },
  // 旧键（已由 defaultPermissionLevel 取代）：读写时与之同步（ask ↔ ask，auto ↔ full；read 记为 ask）
  { key: 'toolApproval', type: 'enum', default: 'ask', enum: ['ask', 'auto'], description: '（已弃用，见 defaultPermissionLevel）工具执行前是否需要确认' },
  {
    key: 'allowMcpWithoutNativeConfirm',
    type: 'boolean',
    default: '0',
    description: '浏览器开发态（无桌面主进程）是否允许不经原生确认添加/修改 MCP 命令',
  },
  { key: 'emailSyncDays', type: 'integer', default: '30', min: 1, max: 365, description: '新邮箱首次同步最近多少天的邮件' },
  {
    key: 'emailSyncIntervalMinutes',
    type: 'integer',
    default: '5',
    min: 0,
    max: 1440,
    description: '后台自动同步邮箱的间隔（分钟），0 关闭',
  },
  { key: 'emailUseIdle', type: 'boolean', default: '0', description: '收件箱保持 IMAP IDLE，新邮件立即同步' },
  { key: 'emailModelClassify', type: 'boolean', default: '0', description: '规则判定为“待复核”的邮件再用模型二次判定' },
  { key: 'emailAutoLinkCustomers', type: 'boolean', default: '1', description: '按发件人邮箱/域名自动关联客户' },
  { key: 'builtinTools', type: 'boolean', default: '1', description: '对话中启用内置业务工具（查客户、建报价草稿、起草邮件）' },
  // 内置内核（docs/BUILTIN-KERNEL.md，契约第 6 节）
  // Skill 系统（docs/SKILLS.md，契约第 8 节）
  { key: 'skillsEnabled', type: 'boolean', default: '1', description: '对话中启用 Skill（系统提示注入已启用 skill 的索引，提供 skill_list / skill_view / run_skill_script 等工具）' },
  { key: 'skillAutoPreload', type: 'boolean', default: '1', description: '用户消息命中 skill 关键词时自动预加载该 skill 的说明（最多 2 个）' },
  { key: 'kernelTools', type: 'boolean', default: '1', description: '对话中启用通用内置工具（网页抓取、联网搜索、工作区文件、产物、时间、计算器）' },
  // 内置浏览器（docs/browser-use.md）：Agent 操作用户桌面端可见的浏览器面板
  { key: 'browserAgent', type: 'boolean', default: '1', description: '允许 Agent 操作内置浏览器（桌面端本地模式；需要桌面端提供进程通道）' },
  { key: 'browserDeniedDomains', type: 'string', default: '', description: 'Agent 禁止打开的域名（逗号或换行分隔，含子域名；如 bank.example.com, mail.example.com）' },
  { key: 'browserMaxSteps', type: 'integer', default: '50', min: 1, max: 500, description: '一次运行内 Agent 最多执行多少步浏览器操作' },
  // 电脑操作（docs/computer-use.md）：Agent 用截图 + 鼠标键盘操作用户本机的桌面应用（实验性，默认关闭）
  { key: 'computerUse', type: 'boolean', default: '0', description: '允许 Agent 操作本机桌面（截屏、鼠标键盘；实验性）。还需要在该会话里手动开启' },
  { key: 'computerMaxSteps', type: 'integer', default: '30', min: 1, max: 300, description: '一次运行内 Agent 最多执行多少步电脑操作' },
  { key: 'autoBackupHours', type: 'integer', default: '24', min: 0, max: 168, description: '自动备份间隔（小时，整库快照到 <dataDir>/backups/，0 关闭）' },
  { key: 'autoBackupKeep', type: 'integer', default: '7', min: 1, max: 60, description: '自动备份保留份数（只轮转自动备份）' },
  { key: 'sanctionsAutoUpdate', type: 'boolean', default: '1', description: '自动更新制裁名单（OFAC / 欧盟 / 联合国，超过 24 小时未更新时重新下载）' },
  // 报价引擎：汇率来源与手动锁汇、报价默认参数
  { key: 'fxSource', type: 'enum', default: 'auto', enum: ['auto', 'frankfurter', 'erapi'], description: '汇率来源：auto 先 Frankfurter（欧洲央行）失败再用 open.er-api.com' },
  { key: 'fxLocks', type: 'string', default: '{}', description: '手动锁定的汇率（JSON，如 {"USD/CNY":7.1,"EUR/CNY":7.8}；锁定的币种对优先于实时汇率）' },
  { key: 'defaultMarginPct', type: 'integer', default: '15', min: 0, max: 95, description: '报价默认毛利率（%，按售价计算；单价 = 成本 ÷ (1 − 毛利率)）' },
  { key: 'defaultInsuranceRatePct', type: 'string', default: '0.11', description: '报价默认保险费率（%，按 CIF × 110% 计算保费）' },
  { key: 'trashRetentionDays', type: 'integer', default: '30', min: 0, max: 3650, description: '回收站保留天数：超过后自动彻底删除（0 不自动清理）' },
  { key: 'kernelCrmMcp', type: 'boolean', default: '1', description: 'scoped 模式的第三方 CLI 内核（Claude Code / Codex / Gemini CLI / Qwen Code）通过内置本地 LULUX MCP 访问 CRM 工具（写操作仍需在界面批准）' },
  // 旧键：已由 agent.maxTurns 取代（老库里普遍存着 '8'，不再读取），保留只为兼容旧客户端的 PATCH
  { key: 'maxToolRounds', type: 'integer', default: '8', min: 1, max: 50, description: '（已弃用，见 agent.maxTurns）一次回复里最多连续调用几轮工具' },
  { key: 'agent.maxTurns', type: 'integer', default: '90', min: 0, max: 500, description: '内置内核一次回复里最多的工具调用轮数（0 = 不限制）。到上限后再发一轮不带工具的请求让模型总结进度' },
  { key: 'agent.budgetPressure', type: 'boolean', default: '1', description: '工具轮数用到 70% / 90% 时给模型注入预算提醒（[BUDGET: …]），促使其收敛' },
  { key: 'parallelToolCalls', type: 'boolean', default: '1', description: '同一轮的只读工具并行执行（同一轮里有写工具时全部按顺序执行，避免读到旧数据）' },
  { key: 'toolLoading', type: 'enum', default: 'auto', enum: ['auto', 'all'], description: '工具定义加载方式：auto 只发送核心工具 + 按意图命中的工具集，其余由 tool_search 按需加载（省输入 token）；all 每次发送全部工具' },
  { key: 'llmMaxRetries', type: 'integer', default: '3', min: 0, max: 8, description: '模型请求遇到 429/5xx/网络错误时的最多重试次数（指数退避）' },
  { key: 'llmTimeoutSeconds', type: 'integer', default: '120', min: 10, max: 600, description: '模型首包与流式空闲超时（秒）' },
  { key: 'maxContinuations', type: 'integer', default: '2', min: 0, max: 5, description: '回复因长度截断时自动续写的最多次数' },
  { key: 'contextCompaction', type: 'boolean', default: '1', description: '上下文超出模型窗口时自动把较早的对话压缩为摘要' },
  { key: 'reasoningEffort', type: 'enum', default: 'off', enum: ['off', 'low', 'medium', 'high', 'xhigh'], description: '推理强度默认值（Anthropic 扩展思考预算 / OpenAI reasoning_effort）；会话可单独覆盖（契约 §6.13）' },
  { key: 'autoTitle', type: 'boolean', default: '1', description: '首轮回复后用模型自动生成会话标题' },
  { key: 'timezone', type: 'string', default: '', description: '对话中使用的时区（IANA，如 Asia/Shanghai），留空用系统时区' },
  { key: 'modelCapabilities', type: 'string', default: '', description: '模型能力覆盖（JSON：{"模型名或通配": {contextWindow, maxOutput, tools, vision, reasoning, streamUsage, temperature}}）' },
  { key: 'modelPricing', type: 'string', default: '', description: '模型单价（JSON，每百万 token：{"模型名或 Provider名/模型名": {input, output, cacheRead?, cacheWrite?, currency}}）' },
  // 内核运行模式（契约“内核网关”）：scoped = 隔离配置 + 经本机网关使用 LULUX 的 Provider；global = 用 CLI 自己的登录/配置
  { key: 'kernelModeClaudeCode', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Claude Code 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  { key: 'kernelModeCodex', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Codex 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  { key: 'kernelModeGeminiCli', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Gemini CLI 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  // CLI 内核超时：卡住（等交互登录、网关无响应、MCP 卡死）时自动结束本次运行，0 = 不限制
  { key: 'kernelIdleTimeoutSeconds', type: 'integer', default: '600', min: 0, max: 86400, description: 'CLI 内核无输出超时（秒）：这么久没有任何输出就结束本次运行（0 = 不限制）' },
  { key: 'kernelMaxRunMinutes', type: 'integer', default: '60', min: 0, max: 1440, description: 'CLI 内核单次运行总时长上限（分钟，0 = 不限制）' },
  { key: 'kernelRegistry', type: 'string', default: '', description: '第三方内核的 npm 安装源，留空用默认（registry.npmmirror.com，失败自动回退 registry.npmjs.org）' },
  { key: 'kernelModeQwenCode', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Qwen Code 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  { key: 'kernelModeHermes', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Hermes Agent 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  { key: 'kernelModePi', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Pi 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  { key: 'kernelModeGrok', type: 'enum', default: 'scoped', enum: ['scoped', 'global'], description: 'Grok 内核模式：scoped 用 LULUX 的模型 Provider（无需登录），global 用 CLI 自己的登录' },
  // 按用户限流（仅 server 模式生效；桌面单用户不限制）：0 = 不限制
  { key: 'chatMaxConcurrentRunsPerUser', type: 'integer', default: '3', min: 0, max: 50, description: '每个成员同时进行中的对话运行数上限（仅团队服务器模式；0 = 不限制）' },
  { key: 'chatRunsPerMinutePerUser', type: 'integer', default: '20', min: 0, max: 600, description: '每个成员每分钟最多发起的对话运行数（仅团队服务器模式；0 = 不限制）' },
  { key: 'scheduleMissedRunHours', type: 'integer', default: '24', min: 0, max: 168, description: '定时任务补跑窗口（小时）：应用关闭期间错过的触发，在窗口内启动后补跑一次，超出则跳到下一次；0 = 不补跑' },
]

export const SETTING_KEYS = new Set(SETTINGS_SCHEMA.map((item) => item.key))
