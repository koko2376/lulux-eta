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
    label: '报价与 PI：查/建/改报价、生成 PI PDF',
    tools: ['list_quotes', 'get_quote', 'create_quote_draft', 'update_quote', 'generate_quote_pdf', 'delete_quote'],
    intent: /报价|询价|形式发票|\bPI\b|单价|价格|折扣|贸易术语|quot|proforma|price|discount|incoterm|\b(FOB|CIF|EXW|CFR|DDP|DAP)\b/i,
  },
  {
    id: 'email',
    label: '邮件：搜邮件、读正文、起草回信（不发送）、从邮件建客户',
    tools: ['search_emails', 'get_email', 'create_email_draft', 'create_customer_from_email'],
    intent: /邮件|邮箱|回信|回复|询盘|草稿|开发信|来信|e-?mail|mail|inbox|inquiry|enquiry|reply|draft|\bRFQ\b/i,
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
    id: 'web',
    label: '联网：网页抓取、搜索',
    tools: ['fetch_url', 'web_search'],
    intent: /网页|网站|网址|链接|搜索|上网|联网|查一下|最新|新闻|汇率|运费|官网|https?:\/\/|www\.|search|google|website|\burl\b|news|latest/i,
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
