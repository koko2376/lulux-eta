import type Koa from 'koa'
import { currentActor } from '../context.js'
import { AppError } from '../errors.js'
import { isServerMode, requirePermission, type Permission } from '../security/access.js'
import { auditService } from '../services/audit-service.js'
import { serverSecurity } from '../services/auth-service.js'
import { isApiPath } from './auth.js'
import { rememberActor } from '../services/logger.js'

type Check = Permission | Permission[] | ((ctx: Koa.Context) => void)

interface Rule {
  methods: string[]
  path: RegExp
  check?: Check
  /** 成功后记一条审计；`{id}` 取路径参数或响应体 id */
  audit?: { action: string; entityType: string }
}

const W = ['POST', 'PUT', 'PATCH', 'DELETE']

function ownerWhenServer(feature: 'kernels' | 'mcp'): (ctx: Koa.Context) => void {
  return () => {
    if (!isServerMode()) return
    const allowed = feature === 'kernels' ? serverSecurity.kernelsAllowed() : serverSecurity.mcpAllowed()
    if (!allowed) {
      throw new AppError(
        403,
        'FEATURE_DISABLED',
        feature === 'kernels' ? '团队服务器默认禁用内核，需 owner 在“服务器安全”中开启' : '团队服务器默认禁用 MCP，需 owner 在“服务器安全”中开启',
      )
    }
    if (currentActor().role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以操作内核 / MCP')
  }
}

/** 只有 owner（desktop 模式下本机用户就是 owner） */
const ownerOnly = (): void => {
  if (currentActor().role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有 owner 可以修改')
}

/** owner / admin，且有对应权限（按账号授予的权限不能越过角色） */
function ownerOrAdmin(permission: Permission): (ctx: Koa.Context) => void {
  return () => {
    requirePermission(permission)
    const role = currentActor().role
    if (role !== 'owner' && role !== 'admin') throw new AppError(403, 'FORBIDDEN', '只有 owner 或管理员可以操作')
  }
}

const notInServerMode = (): void => {
  if (isServerMode()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '团队服务器模式不使用本机锁')
}

/** 方法 + 路径 → 所需权限与审计动作（契约 5.5 / 5.9）。按顺序匹配第一条。 */
const RULES: Rule[] = [
  { methods: W, path: /^\/api\/auth\//, check: undefined },
  { methods: W, path: /^\/api\/team\//, check: undefined },
  { methods: ['POST'], path: /^\/api\/lock\//, check: notInServerMode },

  { methods: ['POST'], path: /^\/api\/providers$/, check: 'providers:write', audit: { action: 'provider.create', entityType: 'provider' } },
  { methods: ['PATCH'], path: /^\/api\/providers\/([^/]+)$/, check: 'providers:write', audit: { action: 'provider.update', entityType: 'provider' } },
  { methods: ['DELETE'], path: /^\/api\/providers\/([^/]+)$/, check: 'providers:write', audit: { action: 'provider.delete', entityType: 'provider' } },
  { methods: ['POST'], path: /^\/api\/providers\/[^/]+\/discover-models$/, check: 'providers:write' },
  { methods: ['PUT'], path: /^\/api\/providers\/([^/]+)\/model-caps$/, check: 'providers:write', audit: { action: 'provider.update', entityType: 'provider' } },

  { methods: ['PATCH'], path: /^\/api\/settings$/, check: 'settings:write', audit: { action: 'settings.update', entityType: 'settings' } },
  { methods: ['POST'], path: /^\/api\/(proxy|webhook)\/test$/, check: 'settings:write' },

  // Skill 管理（契约 §8.3）：组织级配置，owner/admin
  { methods: ['POST'], path: /^\/api\/skills\/install\/(zip|url|folder)$/, check: 'settings:write', audit: { action: 'skill.install', entityType: 'skill' } },
  { methods: ['PATCH'], path: /^\/api\/skills\/([^/]+)$/, check: 'settings:write', audit: { action: 'skill.update', entityType: 'skill' } },
  { methods: ['POST'], path: /^\/api\/skills\/([^/]+)\/reset$/, check: 'settings:write', audit: { action: 'skill.update', entityType: 'skill' } },
  { methods: ['DELETE'], path: /^\/api\/skills\/([^/]+)$/, check: 'settings:write', audit: { action: 'skill.delete', entityType: 'skill' } },
  { methods: W, path: /^\/api\/skills(\/|$)/, check: 'settings:write' },
  { methods: ['PUT'], path: /^\/api\/agents\/([^/]+)\/skills$/, check: 'settings:write', audit: { action: 'agent.skills', entityType: 'agent' } },

  { methods: ['GET'], path: /^\/api\/customers\/export$/, check: 'data:export', audit: { action: 'customer.export', entityType: 'customer' } },
  { methods: ['PUT'], path: /^\/api\/data\/backups\/location$/, check: ownerOnly },
  { methods: ['GET'], path: /^\/api\/data\/backups\/([^/]+)\/download$/, check: 'data:export', audit: { action: 'backup.download', entityType: 'backup' } },
  { methods: ['DELETE'], path: /^\/api\/data\/backups\/([^/]+)$/, check: ownerOrAdmin('data:export'), audit: { action: 'backup.delete', entityType: 'backup' } },
  { methods: ['GET'], path: /^\/api\/data\/backups$/, check: 'data:export' },
  { methods: ['POST'], path: /^\/api\/data\/backups$/, check: 'data:export', audit: { action: 'backup.create', entityType: 'backup' } },
  { methods: ['POST'], path: /^\/api\/data\/backups\/([^/]+)\/restore$/, check: 'data:import', audit: { action: 'backup.restore_request', entityType: 'backup' } },
  { methods: ['GET'], path: /^\/api\/data\/restore$/, check: 'data:import' },
  { methods: ['DELETE'], path: /^\/api\/data\/restore$/, check: 'data:import', audit: { action: 'backup.restore_cancel', entityType: 'backup' } },
  { methods: ['GET'], path: /^\/api\/data\/export$/, check: 'data:export', audit: { action: 'data.export', entityType: 'data' } },
  { methods: ['POST'], path: /^\/api\/data\/import$/, check: 'data:import', audit: { action: 'data.import', entityType: 'data' } },
  { methods: ['DELETE'], path: /^\/api\/data\/sessions$/, check: 'data:import' },

  { methods: ['POST'], path: /^\/api\/mcp\/servers$/, check: ownerWhenServer('mcp'), audit: { action: 'mcp.create', entityType: 'mcp' } },
  { methods: ['PATCH'], path: /^\/api\/mcp\/servers\/([^/]+)$/, check: ownerWhenServer('mcp'), audit: { action: 'mcp.update', entityType: 'mcp' } },
  { methods: ['DELETE'], path: /^\/api\/mcp\/servers\/([^/]+)$/, check: ownerWhenServer('mcp'), audit: { action: 'mcp.delete', entityType: 'mcp' } },
  { methods: ['POST'], path: /^\/api\/mcp\/servers\/[^/]+\/refresh$/, check: ownerWhenServer('mcp') },

  { methods: ['POST'], path: /^\/api\/kernels\/([^/]+)\/(install)$/, check: ownerWhenServer('kernels'), audit: { action: 'kernel.install', entityType: 'kernel' } },
  { methods: ['POST'], path: /^\/api\/kernels\/([^/]+)\/(update)$/, check: ownerWhenServer('kernels'), audit: { action: 'kernel.update', entityType: 'kernel' } },
  { methods: ['POST'], path: /^\/api\/kernels\/([^/]+)\/(uninstall)$/, check: ownerWhenServer('kernels'), audit: { action: 'kernel.uninstall', entityType: 'kernel' } },

  { methods: W, path: /^\/api\/products(\/|$)/, check: 'catalog:write' },
  { methods: ['POST'], path: /^\/api\/inquiry-rules\/test$/, check: 'data:read' },
  { methods: W, path: /^\/api\/(inquiry-rules|quote-templates)(\/|$)/, check: 'settings:write' },
  { methods: ['PUT'], path: /^\/api\/email\/oauth\/config$/, check: 'settings:write' },

  { methods: ['POST'], path: /^\/api\/customers\/import$/, check: ['data:write', 'customer:import'], audit: { action: 'customer.import', entityType: 'customer' } },
  { methods: ['POST'], path: /^\/api\/customers\/transfer$/, check: 'members:manage' },
  { methods: ['POST'], path: /^\/api\/customers$/, check: 'data:write', audit: { action: 'customer.create', entityType: 'customer' } },
  { methods: ['PATCH'], path: /^\/api\/customers\/([^/]+)$/, check: 'data:write', audit: { action: 'customer.update', entityType: 'customer' } },
  // 删除 = 移入回收站；审计（含删除前快照）由服务层记录，界面 / Agent / MCP 一致
  { methods: ['DELETE'], path: /^\/api\/customers\/([^/]+)$/, check: ['data:write', 'customer:delete'] },
  { methods: ['POST'], path: /^\/api\/tasks$/, check: 'data:write', audit: { action: 'task.create', entityType: 'task' } },
  { methods: ['PATCH'], path: /^\/api\/tasks\/([^/]+)$/, check: 'data:write', audit: { action: 'task.update', entityType: 'task' } },
  { methods: ['DELETE'], path: /^\/api\/tasks\/([^/]+)$/, check: ['data:write', 'task:delete'] },
  { methods: ['POST'], path: /^\/api\/deals$/, check: 'data:write', audit: { action: 'deal.create', entityType: 'deal' } },
  { methods: ['PATCH'], path: /^\/api\/deals\/([^/]+)$/, check: 'data:write', audit: { action: 'deal.update', entityType: 'deal' } },
  { methods: ['DELETE'], path: /^\/api\/deals\/([^/]+)$/, check: ['data:write', 'deal:delete'] },
  { methods: ['POST'], path: /^\/api\/quotes\/[^/]+\/order$/, check: 'data:write', audit: { action: 'order.create', entityType: 'order' } },
  { methods: ['PATCH'], path: /^\/api\/orders\/([^/]+)$/, check: 'data:write', audit: { action: 'order.update', entityType: 'order' } },
  { methods: ['DELETE'], path: /^\/api\/orders\/([^/]+)$/, check: ['data:write', 'order:delete'] },
  { methods: ['POST'], path: /^\/api\/orders\/([^/]+)\/payments$/, check: 'data:write', audit: { action: 'payment.create', entityType: 'order' } },
  { methods: ['DELETE'], path: /^\/api\/orders\/([^/]+)\/payments\/[^/]+$/, check: ['data:write', 'order:delete'], audit: { action: 'payment.delete', entityType: 'order' } },
  { methods: ['POST'], path: /^\/api\/quotes$/, check: 'data:write', audit: { action: 'quote.create', entityType: 'quote' } },
  { methods: ['PATCH'], path: /^\/api\/quotes\/([^/]+)$/, check: 'data:write', audit: { action: 'quote.update', entityType: 'quote' } },
  { methods: ['DELETE'], path: /^\/api\/quotes\/([^/]+)$/, check: ['data:write', 'quote:delete'] },
  { methods: ['POST'], path: /^\/api\/email\/accounts$/, check: 'data:write', audit: { action: 'email_account.create', entityType: 'email_account' } },
  { methods: ['PATCH'], path: /^\/api\/email\/accounts\/([^/]+)$/, check: 'data:write', audit: { action: 'email_account.update', entityType: 'email_account' } },
  { methods: ['DELETE'], path: /^\/api\/email\/accounts\/([^/]+)$/, check: 'data:write', audit: { action: 'email_account.delete', entityType: 'email_account' } },
  { methods: ['POST'], path: /^\/api\/email\/drafts\/[^/]+\/send$/, check: 'email:send' },

  // 工作流与定时任务（契约「工作流与定时任务」）：增删改需 workflow:manage；手动运行 / 取消只需 data:write
  // （运行中的每次工具调用仍按负责人的生效权限检查）。行级权限在服务层
  { methods: ['POST'], path: /^\/api\/workflows\/import$/, check: ['data:write', 'workflow:manage'], audit: { action: 'workflow.import', entityType: 'workflow' } },
  { methods: ['POST'], path: /^\/api\/workflows$/, check: ['data:write', 'workflow:manage'], audit: { action: 'workflow.create', entityType: 'workflow' } },
  { methods: ['PATCH'], path: /^\/api\/workflows\/([^/]+)$/, check: ['data:write', 'workflow:manage'], audit: { action: 'workflow.update', entityType: 'workflow' } },
  { methods: ['DELETE'], path: /^\/api\/workflows\/([^/]+)$/, check: ['data:write', 'workflow:manage'], audit: { action: 'workflow.delete', entityType: 'workflow' } },
  { methods: ['POST'], path: /^\/api\/workflows\/[^/]+\/duplicate$/, check: ['data:write', 'workflow:manage'], audit: { action: 'workflow.create', entityType: 'workflow' } },
  { methods: ['POST'], path: /^\/api\/workflows\/([^/]+)\/run$/, check: 'data:write', audit: { action: 'workflow.run', entityType: 'workflow' } },
  { methods: ['POST'], path: /^\/api\/workflow-runs\/[^/]+\/cancel$/, check: 'data:write' },
  { methods: ['POST'], path: /^\/api\/schedules\/preview$/, check: 'data:read' },
  { methods: ['POST'], path: /^\/api\/schedules$/, check: ['data:write', 'workflow:manage'], audit: { action: 'schedule.create', entityType: 'schedule' } },
  { methods: ['PATCH'], path: /^\/api\/schedules\/([^/]+)$/, check: ['data:write', 'workflow:manage'], audit: { action: 'schedule.update', entityType: 'schedule' } },
  { methods: ['DELETE'], path: /^\/api\/schedules\/([^/]+)$/, check: ['data:write', 'workflow:manage'], audit: { action: 'schedule.delete', entityType: 'schedule' } },
  { methods: ['POST'], path: /^\/api\/schedules\/[^/]+\/run-now$/, check: 'data:write' },

  // 多人群聊成员变更（契约 §6.10）：留审计；行级权限（群主 / 群管理员）在路由层
  { methods: ['POST'], path: /^\/api\/sessions\/([^/]+)\/participants$/, check: 'data:write', audit: { action: 'session.member_add', entityType: 'session' } },
  { methods: ['PATCH'], path: /^\/api\/sessions\/([^/]+)\/participants\/[^/]+$/, check: 'data:write', audit: { action: 'session.member_role', entityType: 'session' } },
  { methods: ['DELETE'], path: /^\/api\/sessions\/([^/]+)\/participants\/[^/]+$/, check: 'data:read', audit: { action: 'session.member_remove', entityType: 'session' } },

  // 长期记忆（契约 §6.11）：账号自己的个人数据，只读角色也能管理自己的记忆；只作用于本人（服务层按当前账号）
  { methods: W, path: /^\/api\/memory(\/|$)/, check: 'data:read' },

  // 回收站：恢复需要 data:write；彻底删除另需对应的 *:delete（团队服务器还要求 owner/admin），在服务层校验
  { methods: ['POST'], path: /^\/api\/trash\/[^/]+\/[^/]+\/restore$/, check: 'data:write' },
  { methods: ['DELETE'], path: /^\/api\/trash\/[^/]+\/[^/]+$/, check: 'data:write' },

  // 其余写操作（会话、对话、Activity、邮件、草稿…）至少需要 data:write
  { methods: W, path: /^\/api\//, check: 'data:write' },
]

function entityIdOf(ctx: Koa.Context, match: RegExpExecArray): string | null {
  if (match[1] && !['install', 'update', 'uninstall', 'zip', 'url', 'folder'].includes(match[1])) return decodeURIComponent(match[1])
  const body = ctx.body as { id?: unknown; skill?: { name?: unknown } } | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.id === 'string') return body.id
  // Skill 安装接口返回 { skill: { name } }
  return body.skill && typeof body.skill.name === 'string' ? body.skill.name : null
}

export function policyMiddleware(): Koa.Middleware {
  return async (ctx, next) => {
    rememberActor(ctx)
    if (!isApiPath(ctx.path) || ctx.method === 'OPTIONS') {
      await next()
      return
    }
    let matched: { rule: Rule; match: RegExpExecArray } | null = null
    for (const rule of RULES) {
      if (!rule.methods.includes(ctx.method)) continue
      const match = rule.path.exec(ctx.path)
      if (match) {
        matched = { rule, match }
        break
      }
    }
    if (!matched) {
      await next()
      return
    }
    const { rule, match } = matched
    if (typeof rule.check === 'string') requirePermission(rule.check)
    else if (Array.isArray(rule.check)) for (const permission of rule.check) requirePermission(permission)
    else if (typeof rule.check === 'function') rule.check(ctx)
    await next()
    if (rule.audit && ctx.status < 400) {
      const entityId = entityIdOf(ctx, match)
      auditService.record({
        action: rule.audit.action,
        entityType: rule.audit.entityType,
        entityId,
        summary: `${ctx.method} ${ctx.path}`,
      })
    }
  }
}
