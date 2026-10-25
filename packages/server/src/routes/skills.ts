import type Router from '@koa/router'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { basename } from 'node:path'
import { z } from 'zod'
import { AppError, notFound } from '../errors.js'
import { isServerMode } from '../security/access.js'
import { agentService } from '../services/agent-service.js'
import { sessionService } from '../services/session-service.js'
import { agentSkills } from '../services/skills/agent-skills.js'
import { SkillPackageError } from '../services/skills/package.js'
import { skillService } from '../services/skills/skill-service.js'
import { packageFromFolder, packageFromUrl, packageFromZip } from '../services/skills/sources.js'
import { mimeOf } from '../services/skills/tools.js'
import { ToolError } from '../services/tools/tool-error.js'
import { listWorkspace, resolveInWorkspace, sessionWorkspace, WORKSPACE_QUOTA } from '../services/tools/workspace.js'
import { parse } from '../validation.js'

/** Skill 管理接口（契约 §8.3）。写操作需要 settings:write（policy.ts）。 */
function asAppError(error: unknown): never {
  if (error instanceof SkillPackageError) {
    const status = error.code === 'SKILL_TOO_LARGE' ? 413 : error.code === 'SKILL_FILE_NOT_FOUND' ? 404 : 400
    throw new AppError(status, error.code, error.message)
  }
  throw error
}

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    asAppError(error)
  }
}

const listQuery = z.object({
  query: z.string().max(200).optional(),
  category: z.string().max(40).optional(),
  source: z.enum(['builtin', 'user', 'agent', 'imported']).optional(),
  enabled: z.enum(['0', '1', 'true', 'false']).optional(),
})
const patchInput = z.object({ enabled: z.boolean() }).strict()
const zipInput = z.object({
  filename: z.string().max(200).optional(),
  dataBase64: z.string().min(1).max(21_000_000),
  subpath: z.string().max(240).optional(),
  overwrite: z.boolean().optional(),
})
const urlInput = z.object({ url: z.string().trim().min(1).max(2000), subpath: z.string().max(240).optional(), overwrite: z.boolean().optional() })
const folderInput = z.object({ path: z.string().trim().min(1).max(1000), overwrite: z.boolean().optional() })
const uploadInput = z.object({
  path: z.string().trim().min(1).max(300),
  dataBase64: z.string().min(1).max(14_000_000),
  overwrite: z.boolean().optional(),
})
const UPLOAD_LIMIT = 10 * 1024 * 1024

function dirBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = `${dir}/${entry.name}`
    if (entry.isDirectory()) total += dirBytes(abs)
    else if (entry.isFile()) total += statSync(abs).size
  }
  return total
}

const agentSkillsInput = z.object({ mode: z.enum(['all', 'selected', 'none']), skills: z.array(z.string().max(64)).max(500).default([]) })

const CATEGORY_LABELS: Record<string, string> = {
  trade: '外贸业务',
  office: '文档与办公',
  writing: '写作与沟通',
  research: '调研与分析',
  productivity: '效率与待办',
  meta: '技能开发',
  other: '其他',
}

function installResult(ctx: { status: number; body: unknown }, result: ReturnType<typeof skillService.install>): void {
  ctx.status = result.replaced ? 200 : 201
  ctx.body = { skill: result.skill, replaced: result.replaced }
}

export function skillRoutes(router: Router): void {
  router.get('/api/skills', (ctx) => {
    const query = parse(listQuery, ctx.query)
    const skills = skillService.list({
      query: query.query,
      category: query.category,
      source: query.source,
      enabled: query.enabled === undefined ? undefined : query.enabled === '1' || query.enabled === 'true',
    })
    const all = skillService.list()
    const counts = new Map<string, number>()
    for (const skill of all) counts.set(skill.category ?? 'other', (counts.get(skill.category ?? 'other') ?? 0) + 1)
    ctx.body = {
      skills,
      categories: [...counts].map(([id, count]) => ({ id, label: CATEGORY_LABELS[id] ?? id, count })).sort((a, b) => b.count - a.count),
    }
  })

  router.get('/api/skills/:name', (ctx) => {
    ctx.body = skillService.detail(ctx.params.name)
  })

  router.get('/api/skills/:name/file', async (ctx) => {
    const path = typeof ctx.query.path === 'string' ? ctx.query.path : 'SKILL.md'
    ctx.body = await guard(() => skillService.readFile(ctx.params.name, path))
  })

  router.get('/api/skills/:name/usage', (ctx) => {
    ctx.body = skillService.usage(ctx.params.name)
  })

  router.get('/api/skills/:name/export', (ctx) => {
    const zip = skillService.exportZip(ctx.params.name)
    ctx.set('Content-Type', 'application/zip')
    ctx.set('Content-Disposition', `attachment; filename="${ctx.params.name}.zip"`)
    ctx.body = zip
  })

  router.patch('/api/skills/:name', (ctx) => {
    const body = parse(patchInput, ctx.request.body)
    ctx.body = { skill: skillService.setEnabled(ctx.params.name, body.enabled) }
  })

  router.delete('/api/skills/:name', (ctx) => {
    skillService.remove(ctx.params.name)
    ctx.status = 204
  })

  router.post('/api/skills/:name/reset', (ctx) => {
    ctx.body = { skill: skillService.resetBuiltin(ctx.params.name) }
  })

  router.post('/api/skills/install/zip', async (ctx) => {
    const body = parse(zipInput, ctx.request.body)
    const buffer = Buffer.from(body.dataBase64, 'base64')
    await guard(() => {
      const pkg = packageFromZip(buffer, { subpath: body.subpath })
      installResult(ctx, skillService.install(pkg, { source: 'imported', origin: `zip:${body.filename ?? 'upload.zip'}`, installedBy: 'user', overwrite: body.overwrite }))
    })
  })

  router.post('/api/skills/install/url', async (ctx) => {
    const body = parse(urlInput, ctx.request.body)
    await guard(async () => {
      const { pkg, origin } = await packageFromUrl(body.url, { subpath: body.subpath })
      installResult(ctx, skillService.install(pkg, { source: 'imported', origin, installedBy: 'user', overwrite: body.overwrite }))
    })
  })

  router.post('/api/skills/install/folder', async (ctx) => {
    if (isServerMode()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '团队服务器模式不支持从本机文件夹导入')
    const body = parse(folderInput, ctx.request.body)
    await guard(() => {
      const { pkg, origin } = packageFromFolder(body.path)
      installResult(ctx, skillService.install(pkg, { source: 'user', origin, installedBy: 'user', overwrite: body.overwrite }))
    })
  })

  router.get('/api/agents/:id/skills', (ctx) => {
    const agent = agentService.find(ctx.params.id)
    if (!agent) throw notFound('Agent')
    ctx.body = { ...agentSkills.get(agent.id), available: agentSkills.allowed(agent.id).map((skill) => skill.name) }
  })

  router.put('/api/agents/:id/skills', (ctx) => {
    const agent = agentService.find(ctx.params.id)
    if (!agent) throw notFound('Agent')
    const body = parse(agentSkillsInput, ctx.request.body)
    const config = agentSkills.set(agent.id, body.mode, body.skills)
    ctx.body = { ...config, available: agentSkills.allowed(agent.id).map((skill) => skill.name) }
  })

  /** 列出会话工作区文件（客户端产物/文件面板用） */
  router.get('/api/chat/sessions/:id/files/list', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    sessionWorkspace(session.id)
    ctx.body = listWorkspace(session.id, '.', true, 1000)
  })

  /** 上传文件到会话工作区（供 skill 脚本读取，如要分析的 Excel/PDF） */
  router.post('/api/chat/sessions/:id/files', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    if (!sessionService.writable(session.id)) throw new AppError(403, 'FORBIDDEN', '只能向自己的会话上传文件')
    const body = parse(uploadInput, ctx.request.body)
    const data = Buffer.from(body.dataBase64, 'base64')
    if (data.length > UPLOAD_LIMIT) throw new AppError(413, 'FILE_TOO_LARGE', '单个文件不能超过 10 MB')
    let abs: string
    let rel: string
    try {
      const resolved = resolveInWorkspace(session.id, body.path)
      abs = resolved.path
      rel = resolved.rel
    } catch (error) {
      if (error instanceof ToolError) throw new AppError(400, 'VALIDATION_ERROR', error.message)
      throw error
    }
    if (existsSync(abs) && !body.overwrite) throw new AppError(409, 'FILE_EXISTS', '同名文件已存在；如需覆盖请设置 overwrite')
    if (dirBytes(sessionWorkspace(session.id)) + data.length > WORKSPACE_QUOTA) throw new AppError(413, 'WORKSPACE_FULL', '会话工作区已超过 50 MB 上限')
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    ctx.status = 201
    ctx.body = { path: rel, size: data.length }
  })

  /** 下载会话工作区里的文件（脚本生成的 docx/xlsx/pdf 等产物） */
  router.get('/api/chat/sessions/:id/files', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    const path = typeof ctx.query.path === 'string' ? ctx.query.path : ''
    if (!path) throw new AppError(400, 'VALIDATION_ERROR', '需要 path')
    let abs: string
    try {
      abs = resolveInWorkspace(session.id, path).path
    } catch (error) {
      if (error instanceof ToolError) throw new AppError(400, 'VALIDATION_ERROR', error.message)
      throw error
    }
    let stat
    try {
      stat = statSync(abs)
    } catch {
      throw notFound('文件')
    }
    if (!stat.isFile()) throw notFound('文件')
    const name = basename(abs)
    ctx.set('Content-Type', mimeOf(name))
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.body = readFileSync(abs)
  })
}
