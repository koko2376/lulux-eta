import type Router from '@koa/router'
import { z } from 'zod'
import { APP_VERSION, config } from '../config.js'
import { AppError } from '../errors.js'
import { auditService } from '../services/audit-service.js'
import { authService, serverSecurity, teamService } from '../services/auth-service.js'
import { currentActor } from '../context.js'
import {
  isServerMode,
  OVERRIDABLE_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  requirePermission,
  ROLE_PERMISSIONS,
} from '../security/access.js'
import { parse } from '../validation.js'
import { eventBus } from '../services/events.js'
import { localAuthService } from '../services/local-auth-service.js'

function localOnly(): void {
  if (isServerMode()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '该接口仅在本机模式可用')
}

function serverOnly(): void {
  if (!isServerMode()) throw new AppError(404, 'NOT_AVAILABLE_IN_MODE', '该接口仅在团队服务器模式可用')
}

export function authRoutes(router: Router): void {
  router.get('/api/auth/mode', (ctx) => {
    ctx.body = {
      mode: config.mode,
      setupRequired: authService.setupRequired(),
      version: APP_VERSION,
      publicOrigin: isServerMode() ? (config.publicOrigins[0] ?? null) : null,
    }
  })

  router.post('/api/auth/setup', async (ctx) => {
    serverOnly()
    ctx.status = 201
    ctx.body = await authService.setup(ctx.request.body)
  })

  router.post('/api/auth/login', async (ctx) => {
    serverOnly()
    ctx.body = await authService.login(ctx.request.body)
  })

  router.get('/api/auth/me', (ctx) => {
    ctx.body = isServerMode()
      ? { mode: config.mode, ...authService.me() }
      : { mode: config.mode, ...authService.me(), local: { hasAccount: localAuthService.hasAccounts(), ...localAuthService.current() } }
  })

  /* ── 本机账户（desktop 模式，契约 §3.1） ── */
  router.get('/api/auth/local/status', (ctx) => {
    localOnly()
    ctx.body = localAuthService.status()
  })
  router.post('/api/auth/local/accounts', async (ctx) => {
    localOnly()
    ctx.status = 201
    ctx.body = await localAuthService.create(ctx.request.body)
  })
  router.post('/api/auth/local/login', async (ctx) => {
    localOnly()
    ctx.body = await localAuthService.login(ctx.request.body)
  })
  router.post('/api/auth/local/logout', (ctx) => {
    localOnly()
    const actor = currentActor()
    localAuthService.logout()
    eventBus.revokeSession(actor.sessionId)
    ctx.status = 204
  })
  router.post('/api/auth/local/password', async (ctx) => {
    localOnly()
    await localAuthService.changePassword(ctx.request.body)
    ctx.status = 204
  })
  /* 找回本机密码：恢复码 / 数据目录里的重置文件；凭当前密码重新生成恢复码 */
  router.get('/api/auth/local/recovery', (ctx) => {
    localOnly()
    ctx.body = localAuthService.recoveryInfo()
  })
  router.post('/api/auth/local/recover', async (ctx) => {
    localOnly()
    ctx.body = await localAuthService.recover(ctx.request.body)
  })
  router.post('/api/auth/local/reset-with-file', async (ctx) => {
    localOnly()
    ctx.body = await localAuthService.resetWithFile(ctx.request.body)
  })
  router.post('/api/auth/local/recovery-code', async (ctx) => {
    localOnly()
    ctx.body = await localAuthService.regenerateRecoveryCode(ctx.request.body)
  })

  router.post('/api/auth/refresh', (ctx) => {
    serverOnly()
    ctx.body = authService.refresh()
  })

  router.post('/api/auth/logout', (ctx) => {
    serverOnly()
    const actor = currentActor()
    authService.logout()
    eventBus.revokeSession(actor.sessionId)
    ctx.status = 204
  })

  router.post('/api/auth/password', async (ctx) => {
    serverOnly()
    await authService.changePassword(ctx.request.body)
    ctx.status = 204
  })

  router.get('/api/auth/invites/:code', (ctx) => {
    serverOnly()
    ctx.body = authService.inviteInfo(ctx.params.code)
  })

  router.post('/api/auth/invites/accept', async (ctx) => {
    serverOnly()
    ctx.status = 201
    ctx.body = await authService.acceptInvite(ctx.request.body)
  })
}

export function teamRoutes(router: Router): void {
  router.get('/api/team/org', (ctx) => {
    serverOnly()
    ctx.body = teamService.org()
  })
  router.patch('/api/team/org', (ctx) => {
    serverOnly()
    requirePermission('settings:write')
    ctx.body = teamService.renameOrg(parse(z.object({ name: z.string() }).strict(), ctx.request.body).name)
  })

  router.get('/api/team/members', (ctx) => {
    serverOnly()
    ctx.body = teamService.members()
  })
  router.post('/api/team/members', async (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.status = 201
    ctx.body = await teamService.createMember(ctx.request.body)
  })
  router.patch('/api/team/members/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    const user = teamService.updateMember(ctx.params.id, ctx.request.body)
    if (user.disabled) eventBus.revokeUser(user.id)
    ctx.body = user
  })
  router.get('/api/team/members/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.body = teamService.member(ctx.params.id)
  })
  router.put('/api/team/members/:id/permissions', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    const body = parse(
      z.object({ overrides: z.record(z.string().max(40), z.enum(['grant', 'deny']).nullable()) }).strict(),
      ctx.request.body,
    )
    ctx.body = teamService.setPermissionOverrides(ctx.params.id, body.overrides)
  })
  router.get('/api/team/permission-catalog', (ctx) => {
    serverOnly()
    ctx.body = {
      groups: PERMISSION_GROUPS,
      roleDefaults: ROLE_PERMISSIONS,
      labels: Object.fromEntries(OVERRIDABLE_PERMISSIONS.map((permission) => [permission, PERMISSION_LABELS[permission]])),
    }
  })
  router.post('/api/team/members/:id/reset-password', async (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    await teamService.resetMemberPassword(ctx.params.id, ctx.request.body)
    eventBus.revokeUser(ctx.params.id)
    ctx.status = 204
  })
  router.delete('/api/team/members/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    teamService.disableMember(ctx.params.id)
    eventBus.revokeUser(ctx.params.id)
    ctx.status = 204
  })
  router.post('/api/team/transfer-ownership', (ctx) => {
    serverOnly()
    ctx.body = teamService.transferOwnership(parse(z.object({ userId: z.string().max(80) }).strict(), ctx.request.body).userId)
  })

  router.get('/api/team/teams', (ctx) => {
    serverOnly()
    ctx.body = teamService.listTeams()
  })
  router.post('/api/team/teams', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.status = 201
    ctx.body = teamService.createTeam(ctx.request.body)
  })
  router.patch('/api/team/teams/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.body = teamService.updateTeam(ctx.params.id, ctx.request.body)
  })
  router.delete('/api/team/teams/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    teamService.removeTeam(ctx.params.id)
    ctx.status = 204
  })

  router.get('/api/team/invites', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.body = teamService.listInvites()
  })
  router.post('/api/team/invites', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    ctx.status = 201
    ctx.body = teamService.createInvite(ctx.request.body)
  })
  router.delete('/api/team/invites/:id', (ctx) => {
    serverOnly()
    requirePermission('members:manage')
    teamService.revokeInvite(ctx.params.id)
    ctx.status = 204
  })

  router.get('/api/team/security', (ctx) => {
    serverOnly()
    ctx.body = serverSecurity.state()
  })
  router.patch('/api/team/security', (ctx) => {
    serverOnly()
    ctx.body = serverSecurity.update(ctx.request.body)
  })

  router.get('/api/audit', (ctx) => {
    requirePermission('audit:read')
    ctx.body = auditService.list(currentActor().orgId, ctx.query)
  })
}
