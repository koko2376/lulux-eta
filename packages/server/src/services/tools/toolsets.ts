import { z } from 'zod'
import type { ResolvedMcpTool } from '../mcp/runtime.js'
import { settingsService } from '../settings-service.js'
import type { ToolSpec } from './registry.js'

/**
 * 按需工具集（docs/API-CONTRACT.md §6.5.1）：每次请求只带“常驻核心工具 + 本轮意图命中的工具集 + 会话里用过的工具”，
 * 其余工具由元工具 `tool_search` 在同一轮里动态加载（下一次上游请求就会带上）。
 * 设置 `toolLoading`：`auto`（默认）| `all`（旧行为：每次带全部工具）。
 * 执行不受影响：模型调用任何已注册且对当前用户可用的工具都照常执行（RBAC / 审批 / 审计不变），只是定义不预先发送。
 */
export const TOOL_SEARCH = 'tool_search'

/** 常驻：最常用、定义短的工具 */
export const CORE_TOOL_NAMES = [TOOL_SEARCH, 'search_customers', 'get_customer', 'get_time', 'calculator', 'skill_view', 'memory_add', 'memory_replace', 'memory_remove']

export interface Toolset {
  id: string
  label: string
  tools: string[]
  intent: RegExp
}

export const TOOLSETS: Toolset[] = [
  {
    id: 'crm',
    label: '客户维护：建/改客户、阶段与标签、跟进记录、负责人、回收站',
    tools: ['create_customer', 'update_customer', 'add_activity', 'list_activities', 'list_team_members', 'delete_customer', 'list_trash', 'restore_from_trash'],
    intent: /客户|公司|联系人|负责人|跟进记录|阶段|标签|备注|移交|转给|回收站|误删|customer|client|contact|\blead\b|account owner|recycle bin|\btrash\b/i,
  },
  {
    id: 'quotes',
    label: '报价与 PI：按成本算价（汇率/运费/毛利）、查/建/改报价、生成 PI PDF、运价表',
    tools: ['list_quotes', 'get_quote', 'create_quote_draft', 'update_quote', 'generate_quote_pdf', 'delete_quote', 'quote_calculate', 'quote_generate_pi', 'fx_rates', 'list_freight_rates', 'save_freight_rate'],
    intent: /报价|询价|形式发票|\bPI\b|单价|价格|折扣|贸易术语|汇率|锁汇|运费|海运|运价|柜型|毛利|利润|成本|退税|exchange rate|freight|margin|quot|proforma|price|discount|incoterm|\b(FOB|CIF|EXW|CFR|DDP|DAP)\b/i,
  },
  {
    id: 'email',
    label: '邮件：搜邮件、读正文、询盘打分排序、起草回信（不发送）、从邮件建客户',
    tools: ['search_emails', 'get_email', 'create_email_draft', 'create_customer_from_email', 'score_inquiry', 'list_inquiries'],
    intent: /邮件|邮箱|回信|回复|询盘|打分|评分|索样|钓鱼|骗子|靠谱|值得回|先回|草稿|开发信|来信|e-?mail|mail|inbox|inquiry|enquiry|reply|draft|\bRFQ\b/i,
  },
  {
    id: 'outreach',
    label: '开发信序列：多步跟进、回信停发、待确认、退订',
    tools: ['sequence_list', 'sequence_get', 'sequence_create', 'sequence_update', 'sequence_enroll', 'sequence_queue', 'sequence_approve', 'sequence_skip', 'sequence_stop', 'email_unsubscribe'],
    intent: /开发信|序列|跟进信|群发|批量发|自动跟进|多封|退订|不要再发|待确认|cold ?email|outreach|sequence|drip|follow[- ]?up (?:email|sequence)|unsubscribe/i,
  },
  {
    id: 'docs',
    label: '出货单证：商业发票、装箱单、原产地证草稿、HS 编码建议',
    tools: ['docs_get', 'docs_update', 'docs_generate', 'hs_suggest'],
    intent: /单证|发票|装箱单|箱单|原产地|产地证|报关|唛头|毛重|净重|\bHS\b|hs\s*code|hs编码|commercial invoice|packing list|certificate of origin|\bC\/O\b|customs declaration/i,
  },
  {
    id: 'tasks',
    label: '跟进任务与提醒',
    tools: ['create_task', 'list_tasks', 'update_task', 'delete_task'],
    intent: /任务|提醒|待办|到期|跟进|日程|task|to-?do|remind|follow[- ]?up|deadline|due/i,
  },
  {
    id: 'deals',
    label: '商机与销售漏斗：建/改商机、赢单/输单、漏斗统计',
    tools: ['list_deals', 'create_deal', 'update_deal', 'pipeline_stats', 'delete_deal'],
    intent: /商机|漏斗|赢单|输单|丢单|成交|业绩|转化|预测|deal|pipeline|opportunit|forecast|win ?rate|funnel/i,
  },
  {
    id: 'orders',
    label: '订单、出运与收款：报价转订单、订单状态/柜型/提单/ETD/ETA、登记收款、逾期应收',
    tools: ['convert_quote_to_order', 'list_orders', 'update_order', 'record_payment', 'list_overdue_receivables', 'delete_order', 'delete_payment'],
    intent: /订单|下单|生产|出运|出货|发货|船期|船名|提单|柜型|柜号|货柜|收款|到账|水单|应收|尾款|定金|催款|账龄|回款|\border|payment|receivable|invoice|shipment|shipping|\bB\/?L\b|bill of lading|container|\bET[AD]\b|overdue/i,
  },
  {
    id: 'prospecting',
    label: '开发客户：英国海关进口商名录、各国市场规模、制裁名单筛查、线索库（保存/查看/转客户）',
    tools: [
      'find_uk_importers',
      'market_overview',
      'screen_sanctions',
      'save_prospects',
      'list_prospects',
      'get_prospect',
      'update_prospect',
      'convert_prospect_to_customer',
    ],
    intent:
      /开发客户|找客户|找买家|潜在客户|潜客|线索|进口商|采购商|买家|海关数据|提单|市场规模|哪个国家|制裁|黑名单|背调|\bHS\b|hs\s*code|hs编码|importer|buyer|prospect|lead gen|sanction|OFAC|customs data/i,
  },
  {
    id: 'web',
    label: '联网：网页抓取、搜索',
    tools: ['fetch_url', 'web_search'],
    intent: /网页|网站|网址|链接|搜索|上网|联网|查一下|最新|新闻|汇率|运费|官网|https?:\/\/|www\.|search|google|website|\burl\b|news|latest/i,
  },
  {
    id: 'browser',
    label: '内置浏览器：打开网页、点击、输入',
    tools: ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_scroll', 'browser_screenshot', 'browser_read', 'browser_wait', 'browser_back', 'browser_tabs'],
    intent: /浏览器|登录|登陆|注册|表单|点击|填写|下拉框|标签页|截图|打开.{0,6}(网页|网站|页面)|在.{0,4}(网页|网站|页面).{0,6}(操作|填|点)|browser|click|log ?in|sign ?in|sign ?up|checkout/i,
  },
  {
    id: 'computer',
    label: '电脑操作（实验性）：截屏看屏幕、点击、输入、按键，操作本机桌面应用',
    tools: [
      'computer_screenshot', 'computer_click', 'computer_move', 'computer_drag',
      'computer_scroll', 'computer_type', 'computer_key', 'computer_cursor',
    ],
    intent:
      /电脑操作|操作电脑|桌面|鼠标|键盘|电脑(上|里)|本机(应用|软件)|Excel|千牛|微信|企业微信|ERP|进销存|单证|截图.*(点击|操作)|computer use|desktop app|robotjs/i,
  },
  {
    id: 'group',
    label: '群聊：建多 Agent 群、改群、发起讨论、解散',
    tools: ['list_group_options', 'create_group', 'update_group', 'post_to_group', 'delete_group'],
    intent: /群聊|建群|拉群|拉个群|组个群|开个群|群里|群成员|群头衔|解散|讨论一下|一起讨论|多个\s*(Agent|智能体|模型)|几个\s*(Agent|智能体|模型)|group chat|create.{0,6}group|team of agents/i,
  },
  {
    id: 'files',
    label: '工作区文件与产物：列/读/写文件、生成产物、运行技能脚本（Word/Excel/PPT/PDF）',
    tools: ['workspace_list', 'workspace_read', 'workspace_write', 'create_artifact', 'skill_list', 'run_skill_script'],
    intent: /文件|文档|工作区|表格|报表|报告|附件|Excel|Word|PPT|PDF|xlsx|docx|pptx|csv|markdown|代码|脚本|产物|导出|生成.{0,6}(表|文档|报告|文件)|file|document|workspace|artifact|report|spreadsheet|slide/i,
  },
  {
    id: 'skills',
    label: '技能：查看/安装/编写/更新技能',
    tools: ['skill_list', 'run_skill_script', 'skill_install', 'skill_create', 'skill_update'],
    intent: /技能|skill/i,
  },
  {
    id: 'mcp',
    label: 'MCP Server 配置：查看/添加/修改/删除',
    tools: ['mcp_list', 'mcp_add', 'mcp_update', 'mcp_remove'],
    intent: /\bMCP\b|插件|connector|工具服务器/i,
  },
]

export function toolLoadingMode(): 'auto' | 'all' {
  return settingsService.get('toolLoading') === 'all' ? 'all' : 'auto'
}

/** 外部 MCP 工具按服务器分组：toolset id `mcp:<serverName>` */
function mcpGroups(tools: ResolvedMcpTool[]): Map<string, ResolvedMcpTool[]> {
  const groups = new Map<string, ResolvedMcpTool[]>()
  for (const tool of tools) {
    if (tool.serverId === 'builtin') continue
    const key = `mcp:${tool.serverName}`
    const list = groups.get(key) ?? []
    list.push(tool)
    groups.set(key, list)
  }
  return groups
}

function mentions(text: string, word: string): boolean {
  return word.length >= 3 && text.toLowerCase().includes(word.toLowerCase())
}

/**
 * 首次请求带哪些工具：核心 + 意图命中的工具集 + 历史用过的 + 提到名字的 MCP 服务器 / 工具。
 * `extraNames`：例如命中预加载技能时需要的 run_skill_script。
 */
export function selectInitialTools(all: ResolvedMcpTool[], intentText: string, historyNames: Iterable<string>, extraNames: string[] = []): Set<string> {
  const available = new Set(all.map((tool) => tool.name))
  const active = new Set<string>()
  const add = (name: string): void => {
    if (available.has(name)) active.add(name)
  }
  CORE_TOOL_NAMES.forEach(add)
  for (const set of TOOLSETS) if (set.intent.test(intentText)) set.tools.forEach(add)
  for (const name of historyNames) add(name)
  extraNames.forEach(add)
  const mcpIntent = TOOLSETS.find((set) => set.id === 'mcp')!.intent.test(intentText)
  for (const [key, tools] of mcpGroups(all)) {
    const serverName = key.slice(4)
    if (mcpIntent || mentions(intentText, serverName) || tools.some((tool) => mentions(intentText, tool.originalName))) tools.forEach((tool) => add(tool.name))
  }
  return active
}

/** 动态目录：tool_search 的说明里列出可加载的工具集（含外部 MCP 服务器） */
function catalog(all: ResolvedMcpTool[]): Array<{ id: string; label: string; tools: string[] }> {
  const available = new Set(all.map((tool) => tool.name))
  const sets = TOOLSETS.map((set) => ({ id: set.id, label: set.label, tools: set.tools.filter((name) => available.has(name)) })).filter((set) => set.tools.length > 0)
  for (const [key, tools] of mcpGroups(all)) {
    sets.push({ id: key, label: `外部 MCP 服务器「${key.slice(4)}」的工具`, tools: tools.map((tool) => tool.name) })
  }
  return sets
}

/**
 * 为一次对话构造 tool_search 元工具。`all` 为本次可用的全部工具；`load` 把工具加入当前发言者的活动集。
 */
export function buildToolSearch(all: ResolvedMcpTool[], describe: (name: string) => string): ToolSpec {
  const sets = catalog(all)
  const ids = sets.map((set) => set.id)
  return {
    name: TOOL_SEARCH,
    description:
      '加载更多工具（加载后下一步即可调用）。按工具集加载：' +
      sets.map((set) => `${set.id}（${set.label}）`).join('；') +
      '。也可以用 query 按关键词搜索工具名与说明。需要的工具不在当前列表里时先调用它，不要编造结果。',
    inputSchema: {
      type: 'object',
      properties: {
        toolsets: { type: 'array', items: { type: 'string', enum: ids } },
        query: { type: 'string', description: '关键词，如 “收款”、“pdf”' },
      },
    },
    risk: 'read',
    group: 'core',
    run(args, ctx) {
      const input = z
        .object({ toolsets: z.array(z.string()).max(20).optional(), query: z.string().max(200).optional() })
        .parse(args)
      const wanted = new Set<string>()
      const unknown: string[] = []
      for (const id of input.toolsets ?? []) {
        const set = sets.find((s) => s.id === id)
        if (set) set.tools.forEach((name) => wanted.add(name))
        else unknown.push(id)
      }
      if (input.query?.trim()) {
        const q = input.query.trim()
        for (const set of TOOLSETS) if (set.intent.test(q)) set.tools.forEach((name) => wanted.add(name))
        const words = q.toLowerCase().split(/[\s,，、]+/).filter((w) => w.length >= 2)
        for (const tool of all) {
          const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase()
          if (words.some((word) => hay.includes(word))) wanted.add(tool.name)
        }
      }
      const names = [...wanted].filter((name) => name !== TOOL_SEARCH && all.some((tool) => tool.name === name)).slice(0, 25)
      const loaded = ctx.loadTools ? ctx.loadTools(names) : []
      return {
        loaded: names.map((name) => ({ name, description: describe(name).slice(0, 160) })),
        newlyLoaded: loaded.length,
        unknownToolsets: unknown.length > 0 ? unknown : undefined,
        hint: names.length === 0 ? `没有匹配的工具。可用工具集：${ids.join(', ')}` : '这些工具已可调用。',
      }
    },
  }
}
