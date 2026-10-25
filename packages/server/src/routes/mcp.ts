import type Router from '@koa/router'
import { z } from 'zod'
import { notFound } from '../errors.js'
import { confirmMcpCommand } from '../services/mcp/confirm.js'
import { mcpRuntime } from '../services/mcp/runtime.js'
import { assertSafeMcpSpec, mcpService, publicMcpServer } from '../services/mcp-service.js'
import { AppError } from '../errors.js'
import { mcpUrlInput, headersInput } from '../services/skills/mcp-input.js'
import { parse } from '../validation.js'

const envInput = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量名不合法').max(128), z.string().max(8000))
  .refine((env) => Object.keys(env).length <= 100, '环境变量过多')

const createInput = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(100),
    command: z.string().trim().min(1, '命令不能为空').max(1000).optional(),
    args: z.array(z.string().max(4000)).max(100).default([]),
    env: envInput.default({}),
    enabled: z.boolean().optional(),
    /** 远程 HTTP MCP（契约 §8.6）：与 command 二选一 */
    url: mcpUrlInput.optional(),
    headers: headersInput.optional(),
  })
  .refine((v) => Boolean(v.command) !== Boolean(v.url), '需要 command（本机命令）或 url（远程 HTTP），二选一')

const patchInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().max(4000)).max(100),
    env: envInput,
    enabled: z.boolean(),
    url: mcpUrlInput,
    headers: headersInput,
  })
  .partial()
  .strict()

function withState() {
  const states = mcpRuntime.states()
  return mcpService.list().map((server) => ({
    ...publicMcpServer(server),
    state: states.get(server.id) ?? { status: 'stopped', error: '', tools: [] },
  }))
}

export function mcpRoutes(router: Router): void {
  router.get('/api/mcp/servers', (ctx) => {
    ctx.body = { servers: withState() }
  })

  router.post('/api/mcp/servers', async (ctx) => {
    const body = parse(createInput, ctx.request.body)
    // 本机命令：先原生确认再写库，拒绝时什么都不留下；远程 HTTP 不执行本机命令，不需要原生确认
    if (body.command) {
      assertSafeMcpSpec({ command: body.command, args: body.args, env: body.env })
      await confirmMcpCommand({ name: body.name, command: body.command, args: body.args, env: body.env })
    }
    const server = mcpService.create(body)
    mcpRuntime.sync()
    ctx.status = 201
    ctx.body = { server: publicMcpServer(server) }
  })

  router.patch('/api/mcp/servers/:id', async (ctx) => {
    const body = parse(patchInput, ctx.request.body)
    const preview = mcpService.preview(ctx.params.id, body)
    if (!preview) throw notFound('MCP Server')
    const current = mcpService.get(ctx.params.id)!
    if (current.transport === 'http' && (body.command !== undefined || body.args !== undefined || body.env !== undefined)) {
      throw new AppError(400, 'VALIDATION_ERROR', '远程 HTTP MCP 不能改成本机命令；请删除后重新添加')
    }
    if (current.transport === 'stdio' && (body.url !== undefined || body.headers !== undefined)) {
      throw new AppError(400, 'VALIDATION_ERROR', '本机命令 MCP 不能改成远程 HTTP；请删除后重新添加')
    }
    const httpChanged = current.transport === 'http' && (body.url !== undefined || body.headers !== undefined)
    const commandChanged = current.transport === 'stdio' && (body.command !== undefined || body.args !== undefined || body.env !== undefined)
    if (commandChanged) {
      assertSafeMcpSpec(preview)
      await confirmMcpCommand({ name: preview.name, command: preview.command, args: preview.args, env: preview.env })
    }
    const server = mcpService.update(ctx.params.id, body, commandChanged || httpChanged)
    mcpRuntime.sync()
    ctx.body = { server: server ? publicMcpServer(server) : server }
  })

  router.delete('/api/mcp/servers/:id', (ctx) => {
    if (!mcpService.remove(ctx.params.id)) throw notFound('MCP Server')
    mcpRuntime.sync()
    ctx.status = 204
  })

  /** 重启子进程并重新拉取工具列表；未确认过的命令先走确认 */
  router.post('/api/mcp/servers/:id/refresh', async (ctx) => {
    const server = mcpService.get(ctx.params.id)
    if (!server) throw notFound('MCP Server')
    if (!server.approved) {
      if (server.transport === 'stdio') await confirmMcpCommand(server)
      mcpService.approve(server.id)
    }
    const state = await mcpRuntime.refresh(server.id)
    ctx.body = { state }
  })
}
