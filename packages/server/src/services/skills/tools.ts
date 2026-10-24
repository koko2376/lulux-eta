import { basename, extname } from 'node:path'
import { z } from 'zod'
import { currentActor } from '../../context.js'
import { AppError } from '../../errors.js'
import { isServerMode } from '../../security/access.js'
import { serverSecurity } from '../auth-service.js'
import { auditService } from '../audit-service.js'
import { confirmMcpCommand } from '../mcp/confirm.js'
import { mcpRuntime } from '../mcp/runtime.js'
import { mcpService, publicMcpServer } from '../mcp-service.js'
import type { ToolSpec } from '../tools/registry.js'
import { ToolError } from '../tools/tool-error.js'
import { agentSkills, skillsFeatureEnabled } from './agent-skills.js'
import { headersInput, mcpUrlInput } from './mcp-input.js'
import { SkillPackageError } from './package.js'
import { missingNpmPackages, resolveScript, runSkillScript, SCRIPT_OUTPUT_LIMIT } from './script-runner.js'
import { skillService } from './skill-service.js'
import { packageFromFolder, packageFromUrl } from './sources.js'

/**
 * Skill 与 Agent 自配置工具（契约 §8.4）。
 * - read：skill_list、skill_view、mcp_list（直接执行）；
 * - 需要审批（approval='always'；“完全权限”下直接执行，mcp_* 增删改标 orgLevel 仍逐次确认，契约 §6.11）：run_skill_script、skill_install、skill_create、
 *   skill_update、mcp_add、mcp_update、mcp_remove；
 * - mcp_add / mcp_update 涉及本机命令时，审批通过后仍必须经过 Electron 原生确认框（confirmMcpCommand，不可绕过）；
 * - server 模式：自配置工具只给 owner/admin；run_skill_script 与 MCP 工具在 owner 开启 MCP 前不可用（与 MCP 同策略）。
 */

const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.zip': 'application/zip',
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function isAdmin(): boolean {
  const role = currentActor().role
  return role === 'owner' || role === 'admin'
}

/** server 模式只有 owner/admin 能让 Agent 改配置 */
function configAllowed(): boolean {
  return !isServerMode() || isAdmin()
}

function mcpAllowed(): boolean {
  return !isServerMode() || (serverSecurity.mcpAllowed() && isAdmin())
}

function scriptsAllowed(): boolean {
  return !isServerMode() || serverSecurity.mcpAllowed()
}

function audit(action: string, entityType: string, entityId: string | null, summary: string): void {
  try {
    auditService.record({ action, entityType, entityId, summary: `Agent：${summary}` })
  } catch {
    // 审计失败不影响操作
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof SkillPackageError) throw new ToolError(error.message)
    throw error
  }
}

const skillName = z.string().trim().min(1).max(64)
const fileInput = z.array(z.object({ path: z.string().min(1).max(240), content: z.string().max(200_000) })).max(30)

const listInput = z.object({ query: z.string().max(200).optional(), category: z.string().max(40).optional() })
const viewInput = z.object({ name: skillName, path: z.string().max(240).optional() })
const runInput = z.object({
  skill: skillName,
  script: z.string().min(1).max(240),
  args: z.array(z.string().max(20_000)).max(50).default([]),
  stdin: z.string().max(500_000).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
})
const installInput = z.object({
  url: z.string().max(2000).optional(),
  subpath: z.string().max(240).optional(),
  path: z.string().max(1000).optional(),
  overwrite: z.boolean().optional(),
})
const createInput = z.object({
  name: skillName,
  description: z.string().trim().min(10).max(1024),
  body: z.string().min(1).max(100_000),
  keywords: z.array(z.string().max(40)).max(20).optional(),
  category: z.string().max(40).optional(),
  files: fileInput.optional(),
})
const updateInput = z.object({
  name: skillName,
  description: z.string().trim().min(10).max(1024).optional(),
  body: z.string().min(1).max(100_000).optional(),
  keywords: z.array(z.string().max(40)).max(20).optional(),
  files: fileInput.optional(),
  deleteFiles: z.array(z.string().max(240)).max(30).optional(),
})
const envInput = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名不合法').max(128), z.string().max(8000))
const mcpAddInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    command: z.string().trim().min(1).max(1000).optional(),
    args: z.array(z.string().max(4000)).max(100).default([]),
    env: envInput.default({}),
    url: mcpUrlInput.optional(),
    headers: headersInput.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.command) !== Boolean(v.url), '需要 command（本机命令型 MCP）或 url（远程 HTTP MCP），二选一')
const mcpUpdateInput = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(100).optional(),
  command: z.string().trim().min(1).max(1000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  env: envInput.optional(),
  url: mcpUrlInput.optional(),
  headers: headersInput.optional(),
  enabled: z.boolean().optional(),
})
const mcpRemoveInput = z.object({ id: z.string().min(1).max(80) })

function safeParse<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T | null {
  const result = schema.safeParse(args)
  return result.success ? result.data : null
}

/** 只显示键名、不显示值的参数（请求头、环境变量可能含密钥） */
const SECRET_ARG_FIELDS = new Set(['headers', 'env'])

function summarizeArg(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => {
      if (item && typeof item === 'object' && 'path' in item) return String((item as { path: unknown }).path).slice(0, 240)
      return typeof item === 'string' ? item.slice(0, 200) : typeof item === 'object' ? '[object]' : item
    })
  }
  return '[object]'
}

/**
 * 参数校验失败时的审批详情：工具运行时会报参数错误，但审批卡片不能是空的（detail 不为 null），
 * 让用户看清模型想做什么、哪里不合法。密钥类字段只给键名。
 */
function invalidDetail(schema: z.ZodType<unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const result = schema.safeParse(args)
  const errors = result.success ? [] : result.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '参数'}：${issue.message}`)
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args).slice(0, 30)) {
    if (SECRET_ARG_FIELDS.has(key)) fields[`${key}Keys`] = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 50) : []
    else fields[key] = summarizeArg(value)
  }
  return { invalid: true, errors, arguments: fields }
}

export const skillTools: ToolSpec[] = [
  {
    name: 'skill_list',
    group: 'skills',
    risk: 'read',
    description: '列出当前可用的技能（Skill），可按关键词或分类筛选。返回 name、description、分类、是否含脚本。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（匹配名称、描述、关键词）' },
        category: { type: 'string', description: 'trade（外贸）| office（办公）| research | writing | productivity 等' },
      },
    },
    available: () => skillsFeatureEnabled(),
    run(args, ctx) {
      const input = listInput.parse(args)
      const query = input.query?.toLowerCase().trim()
      const skills = agentSkills
        .allowed(ctx.agentId)
        .filter((s) => !input.category || s.category === input.category)
        .filter((s) => !query || `${s.name} ${s.description} ${s.keywords.join(' ')}`.toLowerCase().includes(query))
      return {
        total: skills.length,
        skills: skills.slice(0, 60).map((s) => ({ name: s.name, description: s.description, category: s.category, hasScripts: s.hasScripts, keywords: s.keywords.slice(0, 8) })),
      }
    },
  },
  {
    name: 'skill_view',
    group: 'skills',
    risk: 'read',
    description:
      '读取技能的 SKILL.md（不填 path）或其附属文件（path 为 skill 内相对路径，如 references/x.md、templates/y.md）。' +
      '开始一项与某技能相关的任务前先读它的 SKILL.md。scripts/ 下的脚本不要读来照抄，直接用 run_skill_script 运行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        path: { type: 'string', description: 'skill 目录内的相对路径，默认 SKILL.md' },
      },
      required: ['name'],
    },
    available: () => skillsFeatureEnabled(),
    run(args, ctx) {
      const input = viewInput.parse(args)
      if (!agentSkills.isAllowed(ctx.agentId, input.name)) {
        throw new ToolError(`技能「${input.name}」不存在、未启用或当前 Agent 不可用。可先调用 skill_list 查看。`)
      }
      return wrap(() => {
        const file = skillService.readFile(input.name, input.path || 'SKILL.md', 200_000)
        if ((input.path || 'SKILL.md') === 'SKILL.md') skillService.recordUse(input.name, 'view', ctx.sessionId, ctx.agentId)
        const skill = skillService.require(input.name)
        const result: Record<string, unknown> = { skill: input.name, path: file.path, size: file.size }
        if (file.binary) result.note = '二进制文件，无法以文本显示。'
        else result.content = file.content + (file.truncated ? '\n…（文件过长，已截断）' : '')
        if (file.path === 'SKILL.md') {
          result.files = skillService.files(input.name).map((f) => f.path)
          if (skill.hasScripts) result.scriptsNote = '运行 scripts/ 下的脚本请用 run_skill_script（需要用户批准），产物写在会话工作区里。'
        }
        return result
      })
    },
  },
  {
    name: 'run_skill_script',
    group: 'skills',
    risk: 'write',
    approval: 'always',
    approvalKind: 'skill_script',
    description:
      '运行已安装技能 scripts/ 目录下的脚本（Node .js/.cjs/.mjs 或 Python .py）。工作目录是本会话的工作区沙箱，' +
      '脚本读写的相对路径都在工作区里（可配合 workspace_read / workspace_write）。每次运行都需要用户批准。返回退出码、输出与新生成的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名' },
        script: { type: 'string', description: '脚本路径，如 scripts/quote_calc.js 或 quote_calc.js' },
        args: { type: 'array', items: { type: 'string' }, description: '命令行参数' },
        stdin: { type: 'string', description: '传给脚本标准输入的内容（如 JSON）' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, description: '超时秒数，默认 60' },
      },
      required: ['skill', 'script'],
    },
    available: () => skillsFeatureEnabled() && scriptsAllowed(),
    rememberKey(args) {
      const skill = typeof args.skill === 'string' ? args.skill : ''
      return `run_skill_script:${skill}`
    },
    approvalDetail(args) {
      const input = safeParse(runInput, args)
      if (!input) return invalidDetail(runInput, args)
      const skill = skillService.get(input.skill)
      let interpreter: string | null = null
      try {
        if (skill) interpreter = resolveScript(skill, input.script).interpreter
      } catch {
        interpreter = null
      }
      return {
        skill: input.skill,
        skillSource: skill?.source ?? null,
        script: input.script,
        args: input.args,
        interpreter,
        npmToInstall: skill && interpreter === 'node' ? missingNpmPackages(skill.requires.npm) : [],
        timeoutSeconds: input.timeoutSeconds ?? 60,
        cwd: '会话工作区',
      }
    },
    async run(args, ctx) {
      if (!scriptsAllowed()) throw new ToolError('团队服务器未开启脚本执行（与 MCP 同一开关，需 owner 在“服务器安全”中开启）')
      const input = runInput.parse(args)
      if (!agentSkills.isAllowed(ctx.agentId, input.skill)) throw new ToolError(`技能「${input.skill}」不存在、未启用或当前 Agent 不可用`)
      const skill = skillService.require(input.skill)
      if (!skill.hasScripts) throw new ToolError(`技能「${input.skill}」没有 scripts/ 目录`)
      const result = await (async () => {
        try {
          return await runSkillScript({ skill, script: input.script, args: input.args, stdin: input.stdin, timeoutSeconds: input.timeoutSeconds, sessionId: ctx.sessionId, signal: ctx.signal })
        } catch (error) {
          if (error instanceof SkillPackageError) throw new ToolError(error.message)
          throw error
        }
      })()
      skillService.recordUse(skill.name, 'script', ctx.sessionId, ctx.agentId)
      for (const file of result.files) {
        ctx.emitFile?.({ path: file.path, size: file.size, title: basename(file.path), mime: mimeOf(file.path) })
      }
      if (result.timedOut) throw new ToolError(`脚本运行超时（${input.timeoutSeconds ?? 60} 秒）已被终止。输出：\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`)
      return {
        ok: result.exitCode === 0,
        script: result.script,
        interpreter: result.interpreter,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        installedDependencies: result.installed,
        // 提示放在 stdout 之前：工具结果整体还会被截断（ROUND_RESULT_LIMIT），放末尾会丢
        outputTruncated: result.stdoutTruncated || result.stderrTruncated ? `输出过长，已截断（每路上限 ${SCRIPT_OUTPUT_LIMIT / 1024} KB）；大结果请写到文件` : undefined,
        stdout: result.stdout + (result.stdoutTruncated ? '\n…（输出过长，已截断）' : ''),
        stderr: result.stderr + (result.stderrTruncated ? '\n…（已截断）' : ''),
        files: result.files,
        note: result.files.length > 0 ? '生成/修改的文件在会话工作区里，已显示在产物面板，可下载。' : undefined,
      }
    },
  },
  {
    name: 'skill_install',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'skill_install',
    description:
      '安装技能：url 可以是 GitHub 仓库或目录地址（https://github.com/<owner>/<repo>/tree/<分支>/<目录>）、raw 地址、或 zip 下载地址；' +
      '仓库里有多个技能时用 subpath 指定目录。桌面版也可用 path 指定本机文件夹。需要用户批准；含 scripts/ 的技能会被标记为“含可执行脚本”。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        subpath: { type: 'string', description: '仓库或 zip 内的技能目录' },
        path: { type: 'string', description: '本机文件夹绝对路径（仅桌面版）' },
        overwrite: { type: 'boolean', description: '已存在同名（非内置）技能时覆盖（旧版本会备份）' },
      },
    },
    available: () => skillsFeatureEnabled() && configAllowed(),
    approvalDetail(args) {
      const input = safeParse(installInput, args)
      return input ? { url: input.url ?? null, subpath: input.subpath ?? null, path: input.path ?? null, overwrite: Boolean(input.overwrite) } : invalidDetail(installInput, args)
    },
    async run(args) {
      if (!configAllowed()) throw new ToolError('只有 owner/admin 可以让 Agent 安装技能')
      const input = installInput.parse(args)
      if (!input.url && !input.path) throw new ToolError('需要 url 或 path')
      if (input.path && isServerMode()) throw new ToolError('团队服务器模式不支持从本机文件夹导入')
      let installed
      try {
        const { pkg, origin } = input.url ? await packageFromUrl(input.url, { subpath: input.subpath }) : packageFromFolder(input.path!)
        installed = skillService.install(pkg, { source: 'imported', origin, installedBy: 'agent', overwrite: input.overwrite })
        audit('skill.install', 'skill', installed.skill.name, origin)
      } catch (error) {
        if (error instanceof SkillPackageError) throw new ToolError(`安装失败：${error.message}`)
        throw error
      }
      return {
        installed: true,
        replaced: installed.replaced,
        skill: { name: installed.skill.name, description: installed.skill.description, hasScripts: installed.skill.hasScripts, source: installed.skill.source },
        note: installed.skill.hasScripts ? '该技能含可执行脚本，运行前仍会逐次征求用户同意。' : undefined,
      }
    },
  },
  {
    name: 'skill_create',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'skill_write',
    description:
      '创建一个新技能（来源标记为 agent）：name 用小写字母/数字/连字符；description 写清“做什么 + 什么时候用”；body 是 SKILL.md 正文（步骤、模板、检查清单）；' +
      'files 可附带 references/、templates/、scripts/ 下的文本文件。写之前先 skill_view skill-creator 学习写法。需要用户批准。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string', description: 'SKILL.md 正文（不含 frontmatter）' },
        keywords: { type: 'array', items: { type: 'string' }, description: '触发预加载的关键词' },
        category: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      },
      required: ['name', 'description', 'body'],
    },
    available: () => skillsFeatureEnabled() && configAllowed(),
    approvalDetail(args) {
      const input = safeParse(createInput, args)
      if (!input) return invalidDetail(createInput, args)
      const files = (input.files ?? []).map((f) => f.path)
      return { name: input.name, description: input.description, files: ['SKILL.md', ...files], hasScripts: files.some((p) => p.replace(/\\/g, '/').startsWith('scripts/')) }
    },
    run(args) {
      if (!configAllowed()) throw new ToolError('只有 owner/admin 可以让 Agent 创建技能')
      const input = createInput.parse(args)
      const skill = wrap(() => skillService.createByAgent(input))
      audit('skill.create', 'skill', skill.name, 'skill_create')
      return { created: true, skill: { name: skill.name, description: skill.description, source: skill.source, hasScripts: skill.hasScripts } }
    },
  },
  {
    name: 'skill_update',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'skill_write',
    description: '修改已安装的非内置技能（描述、正文、关键词、附属文件；deleteFiles 删除文件）。修改前自动备份旧版本。内置技能只读。需要用户批准。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        deleteFiles: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    available: () => skillsFeatureEnabled() && configAllowed(),
    approvalDetail(args) {
      const input = safeParse(updateInput, args)
      if (!input) return invalidDetail(updateInput, args)
      const files = (input.files ?? []).map((f) => f.path)
      return {
        name: input.name,
        changes: [input.description !== undefined ? 'description' : '', input.body !== undefined ? 'body' : '', input.keywords ? 'keywords' : ''].filter(Boolean),
        files,
        deleteFiles: input.deleteFiles ?? [],
        hasScripts: files.some((p) => p.replace(/\\/g, '/').startsWith('scripts/')),
      }
    },
    run(args) {
      if (!configAllowed()) throw new ToolError('只有 owner/admin 可以让 Agent 修改技能')
      const input = updateInput.parse(args)
      const result = wrap(() => skillService.updateByAgent(input))
      audit('skill.update', 'skill', result.skill.name, 'skill_update')
      return { updated: true, backedUp: Boolean(result.backup), skill: { name: result.skill.name, description: result.skill.description, hasScripts: result.skill.hasScripts } }
    },
  },
  {
    name: 'mcp_list',
    group: 'config',
    risk: 'read',
    description: '列出已配置的 MCP Server（名称、传输方式、命令或地址、启用状态、连接状态与工具名）。不返回环境变量与请求头的值。',
    inputSchema: { type: 'object', properties: {} },
    available: () => mcpAllowed(),
    run() {
      const states = mcpRuntime.states()
      return {
        servers: mcpService.list().map((server) => {
          const pub = publicMcpServer(server)
          const state = states.get(server.id)
          return {
            id: pub.id,
            name: pub.name,
            transport: pub.transport,
            command: pub.command,
            args: pub.args,
            envKeys: Object.keys(pub.env),
            url: pub.url,
            headerKeys: pub.headerKeys,
            enabled: pub.enabled,
            approved: pub.approved,
            createdBy: pub.createdBy,
            status: state?.status ?? 'stopped',
            error: state?.error || undefined,
            tools: state?.tools ?? [],
          }
        }),
      }
    },
  },
  {
    name: 'mcp_add',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'mcp_add',
    noRemember: true,
    orgLevel: true,
    description:
      '添加 MCP Server。本机命令型：command + args（+ env），用户批准后桌面端还会弹出系统确认框显示完整命令；' +
      '远程 HTTP 型：url（+ headers），用户批准后即添加。添加后自动连接，工具在下一轮对话中可用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string', description: '可执行文件，如 npx、uvx、node' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        url: { type: 'string', description: '远程 MCP 的 Streamable HTTP 地址' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: '远程 MCP 请求头，如 Authorization' },
        enabled: { type: 'boolean' },
      },
      required: ['name'],
    },
    available: () => mcpAllowed(),
    approvalDetail(args) {
      const input = safeParse(mcpAddInput, args)
      if (!input) return invalidDetail(mcpAddInput, args)
      return input.url
        ? { transport: 'http', name: input.name, url: input.url, headerKeys: Object.keys(input.headers ?? {}), nativeConfirm: false }
        : { transport: 'stdio', name: input.name, command: input.command, args: input.args, envKeys: Object.keys(input.env), nativeConfirm: true }
    },
    async run(args) {
      if (!mcpAllowed()) throw new ToolError('当前不允许添加 MCP（团队服务器需 owner 开启 MCP，且只有 owner/admin 可操作）')
      const input = mcpAddInput.parse(args)
      if (input.command) {
        // 不可绕过：与设置页同一条原生确认通道（契约 §2）
        await confirmMcpCommand({ name: input.name, command: input.command, args: input.args, env: input.env })
      }
      const server = mcpService.create({ ...input, createdBy: 'agent' })
      audit('mcp.create', 'mcp', server.id, `mcp_add ${server.transport} ${server.name}`)
      // 新增的 server 直接 refresh 连接（不要先 sync()：那会启动一次连接，随后又被 refresh 关闭）
      const state = await mcpRuntime.refresh(server.id).catch(() => undefined)
      return { added: true, server: { id: server.id, name: server.name, transport: server.transport }, status: state?.status ?? 'connecting', error: state?.error || undefined, tools: state?.tools ?? [] }
    },
  },
  {
    name: 'mcp_update',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'mcp_update',
    noRemember: true,
    orgLevel: true,
    description: '修改 MCP Server（名称、启用、命令/参数/环境变量，或远程地址/请求头）。改本机命令时桌面端会再弹系统确认框。需要用户批准。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    available: () => mcpAllowed(),
    approvalDetail(args) {
      const input = safeParse(mcpUpdateInput, args)
      if (!input) return invalidDetail(mcpUpdateInput, args)
      const current = mcpService.get(input.id)
      const commandChanged = current?.transport === 'stdio' && (input.command !== undefined || input.args !== undefined || input.env !== undefined)
      return {
        id: input.id,
        name: current?.name ?? null,
        transport: current?.transport ?? null,
        command: input.command ?? current?.command ?? null,
        args: input.args ?? current?.args ?? null,
        envKeys: input.env ? Object.keys(input.env) : undefined,
        url: input.url,
        headerKeys: input.headers ? Object.keys(input.headers) : undefined,
        enabled: input.enabled,
        nativeConfirm: commandChanged,
      }
    },
    async run(args) {
      if (!mcpAllowed()) throw new ToolError('当前不允许修改 MCP')
      const input = mcpUpdateInput.parse(args)
      const current = mcpService.get(input.id)
      if (!current) throw new ToolError(`找不到 MCP Server：${input.id}`)
      if (current.transport === 'http' && (input.command !== undefined || input.args !== undefined || input.env !== undefined)) {
        throw new ToolError('远程 HTTP MCP 不能改成本机命令；请删除后重新添加')
      }
      if (current.transport === 'stdio' && (input.url !== undefined || input.headers !== undefined)) {
        throw new ToolError('本机命令 MCP 不能改成远程 HTTP；请删除后重新添加')
      }
      const { id, ...patch } = input
      const preview = mcpService.preview(id, patch)!
      const commandChanged = current.transport === 'stdio' && (input.command !== undefined || input.args !== undefined || input.env !== undefined)
      const httpChanged = current.transport === 'http' && (input.url !== undefined || input.headers !== undefined)
      if (commandChanged) await confirmMcpCommand({ name: preview.name, command: preview.command, args: preview.args, env: preview.env })
      const server = mcpService.update(id, patch, commandChanged || httpChanged)
      if (!server) throw new AppError(404, 'NOT_FOUND', 'MCP Server 不存在')
      audit('mcp.update', 'mcp', server.id, `mcp_update ${server.name}`)
      mcpRuntime.sync()
      return { updated: true, server: { id: server.id, name: server.name, enabled: server.enabled, approved: server.approved } }
    },
  },
  {
    name: 'mcp_remove',
    group: 'config',
    risk: 'write',
    approval: 'always',
    approvalKind: 'mcp_remove',
    noRemember: true,
    orgLevel: true,
    description: '删除一个 MCP Server。需要用户批准。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    available: () => mcpAllowed(),
    approvalDetail(args) {
      const input = safeParse(mcpRemoveInput, args)
      const current = input ? mcpService.get(input.id) : undefined
      return input ? { id: input.id, name: current?.name ?? null, transport: current?.transport ?? null } : invalidDetail(mcpRemoveInput, args)
    },
    run(args) {
      if (!mcpAllowed()) throw new ToolError('当前不允许删除 MCP')
      const input = mcpRemoveInput.parse(args)
      if (!mcpService.remove(input.id)) throw new ToolError(`找不到 MCP Server：${input.id}`)
      audit('mcp.delete', 'mcp', input.id, 'mcp_remove')
      mcpRuntime.sync()
      return { removed: true, id: input.id }
    },
  },
]
