import type Router from '@koa/router'
import { AppError } from '../errors.js'
import { currentActor } from '../context.js'
import { requirePermission } from '../security/access.js'
import { KERNELS } from '../services/kernels/catalog.js'
import { kernelAskSupport } from '../services/kernels/permissions.js'
import { kernelMode } from '../services/kernels/scoped.js'
import { builtinToolsEnabled } from '../services/chat/builtin-tools.js'
import { settingsService } from '../services/settings-service.js'
import { defaultPermissionLevel, PERMISSION_LEVELS, permissionCaps } from '../services/permissions.js'

/** 某内核本次运行会不会注入内置 LULUX MCP（与编排器的条件一致：scoped + builtinTools + kernelCrmMcp） */
function kernelHasMcp(kernelId: string): boolean {
  return kernelMode(kernelId) === 'scoped' && builtinToolsEnabled() && settingsService.get('kernelCrmMcp') !== '0'
}

/** 会话权限级别（契约 §6.11） */
export function permissionRoutes(router: Router): void {
  /**
   * 选择器需要的信息：三个级别、新会话默认、当前用户上限（desktop 恒为 full），
   * 以及每个 CLI 内核在“需审批”下的审批方式（card = 经 LULUX 审批卡片；readonly = 只能退回仅可查看）。
   */
  router.get('/api/permissions', (ctx) => {
    ctx.body = {
      levels: PERMISSION_LEVELS,
      defaultLevel: defaultPermissionLevel(),
      cap: permissionCaps.capFor(),
      capsEnabled: permissionCaps.enabled(),
      kernels: Object.fromEntries(KERNELS.map((kernel) => [kernel.id, { ask: kernelAskSupport(kernel.id, kernelHasMcp(kernel.id)) }])),
    }
  })

  /** 团队上限（server 模式，members:manage）：按角色与按成员 */
  router.get('/api/team/permission-caps', (ctx) => {
    if (!permissionCaps.enabled()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '该接口仅在团队服务器模式可用')
    requirePermission('members:manage')
    ctx.body = permissionCaps.get(currentActor().orgId)
  })
  router.patch('/api/team/permission-caps', (ctx) => {
    if (!permissionCaps.enabled()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '该接口仅在团队服务器模式可用')
    requirePermission('members:manage')
    ctx.body = permissionCaps.update(ctx.request.body)
  })
}
