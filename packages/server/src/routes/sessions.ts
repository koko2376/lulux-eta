import type Router from '@koa/router'
import { z } from 'zod'
import { AppError, notFound } from '../errors.js'
import { BUILTIN_AGENT_ID } from '../agents.js'
import { agentService } from '../services/agent-service.js'
import { activeRun, latestRun, runState } from '../services/chat/run-registry.js'
import { SUPERVISOR_NONE } from '../services/chat/supervisor.js'
import { validateMemberModels } from '../services/chat/group-members.js'
import { deleteSessionFully } from '../services/chat/session-delete.js'
import { currentActor } from '../context.js'
import { teamService } from '../services/auth-service.js'
import { sessionHub } from '../services/session-hub.js'
import { MAX_GROUP_HUMANS, resolveMemberInputs, sessionService } from '../services/session-service.js'
import { isServerMode } from '../security/access.js'
import { openSse, sendSse } from '../utils/sse.js'
import { parse } from '../validation.js'
import { EFFORT_LEVELS, type EffortLevel } from '../services/models/effort.js'
import { validateModelChoice } from '../services/models/catalog.js'
import { assertWithinCap } from '../services/permissions.js'
import { browserControl } from '../services/browser/control.js'
import { computerControl } from '../services/computer/control.js'
import { computerChannel } from '../services/computer/channel.js'
import { settingsService } from '../services/settings-service.js'
import { clearSessionAllow } from '../services/tool-approval.js'

const agentIds = z.array(z.string().max(80)).max(20)
/** 群成员（同一内核可多次出现；role = 名字旁的群头衔） */
const memberInput = z
  .object({
    agentId: z.string().min(1).max(84),
    role: z.string().max(40).nullable().optional(),
    instructions: z.string().max(4000).nullable().optional(),
    model: z.string().max(200).nullable().optional(),
  })
  .strict()
const membersInput = z.array(memberInput).min(1).max(12, '一个群最多 12 个 Agent 成员')
const permissionLevelInput = z.enum(['read', 'ask', 'full']).nullable()
const effortInput = z.enum(EFFORT_LEVELS).nullable()
const modelInput = z.string().trim().min(1).max(120).nullable()

const createInput = z.object({
  title: z.string().max(200).optional(),
  /** 'group' 新建群聊（空历史）；省略时按成员数推断 */
  kind: z.enum(['single', 'group']).optional(),
  groupName: z.string().max(200).nullable().optional(),
  providerId: z.string().max(80).optional(),
  agentId: z.string().max(80).optional(),
  agentIds: agentIds.optional(),
  /** 群聊成员（带群头衔 / 职责 / 模型）；给了就忽略 agentIds，并按群聊新建 */
  members: membersInput.optional(),
  /** 会话只属于本人（契约 §5.6a）：只接受 private，不再支持 team / org 共享 */
  visibility: z.literal('private', { message: '会话仅本人可见，不支持共享（team / org）' }).optional(),
  teamId: z.null().optional(),
  supervisorId: z.string().max(80).optional(),
  /** 群聊：一起邀请的同事账号 id（团队服务器模式，契约 §6.10） */
  userIds: z.array(z.string().min(1).max(80)).max(MAX_GROUP_HUMANS).optional(),
  /** 会话权限级别（契约 §6.11）；省略 = 跟随全局默认 */
  permissionLevel: permissionLevelInput.optional(),
  /** 会话模型 / 推理强度（契约 §6.13）；省略 = 默认 */
  model: modelInput.optional(),
  reasoningEffort: effortInput.optional(),
})

const participantsInput = z
  .object({
    userIds: z.array(z.string().min(1).max(80)).min(1).max(MAX_GROUP_HUMANS),
    role: z.enum(['admin', 'member']).optional(),
  })
  .strict()

const participantPatch = z.object({ role: z.enum(['admin', 'member']) }).strict()
const browserControlInput = z.object({ action: z.enum(['pause', 'resume', 'stop']) }).strict()
const computerControlInput = z.object({ action: z.enum(['pause', 'resume', 'stop']) }).strict()
const computerEnableInput = z.object({ enabled: z.boolean() }).strict()

const patchInput = z
  .object({
    title: z.string().max(200),
    groupName: z.string().max(200).nullable(),
    agentIds,
    /** 群聊：整体替换成员（含群头衔 / 职责 / 模型）；与 agentIds 二选一 */
    members: membersInput,
    /** 群聊主管：'builtin'（默认）/ 成员 Agent id / 'none'（无主管） */
    supervisorId: z.string().max(84).nullable(),
    /** 会话权限级别：read | ask | full；null 恢复为跟随全局默认（契约 §6.11） */
    permissionLevel: permissionLevelInput,
    /** 会话模型（契约 §6.13）：Provider 的模型或 global CLI 内核的模型；null 恢复默认 */
    providerId: z.string().max(80).nullable(),
    model: modelInput,
    /** 推理强度 off | low | medium | high | xhigh；null 恢复默认 */
    reasoningEffort: effortInput,
  })
  .partial()
  .strict()

/** 主管只能是 LULUX、'none' 或本会话的成员 */
function validSupervisor(value: string, members: string[]): string {
  if (value === SUPERVISOR_NONE || value === BUILTIN_AGENT_ID) return value
  const [canonical] = agentService.normalizeIds([value])
  if (!canonical || !members.includes(canonical)) {
    throw new AppError(400, 'VALIDATION_ERROR', '主管只能选择 LULUX、无主管或本群的成员')
  }
  return canonical
}

/** 会话的模型列表按哪个内核来：群聊 → LULUX 内置成员；单聊 → 它的内核（契约 §6.13） */
export function sessionModelKernel(session: { kind: string; agentIds: string[] }): string {
  if (session.kind === 'group') return 'builtin'
  const agent = agentService.find(session.agentIds[0])
  return agent?.kind === 'kernel' ? agent.kernelId : 'builtin'
}

function applyModelPatch(
  session: { id: string; kind: string; agentIds: string[]; providerId: string | null },
  body: { providerId?: string | null; model?: string | null; reasoningEffort?: EffortLevel | null },
): void {
  if (body.providerId === undefined && body.model === undefined && body.reasoningEffort === undefined) return
  const patch: { providerId?: string | null; model?: string | null; reasoningEffort?: EffortLevel | null } = {}
  if (body.model !== undefined || body.providerId !== undefined) {
    const chosen = validateModelChoice(
      sessionModelKernel(session),
      { providerId: body.providerId, model: body.model ?? null },
      { providerId: session.providerId },
    )
    patch.providerId = chosen.providerId
    patch.model = chosen.model
  }
  if (body.reasoningEffort !== undefined) patch.reasoningEffort = body.reasoningEffort
  sessionService.setModelChoice(session.id, patch)
}

export function assertSessionWritable(id: string): void {
  if (!sessionService.writable(id)) throw new AppError(403, 'FORBIDDEN', '只能修改自己的会话')
}

/** 改会话设置 / 管理成员：群主或群管理员 */
export function assertSessionManageable(id: string): void {
  if (!sessionService.manageable(id)) throw new AppError(403, 'FORBIDDEN', '只有群主或群管理员可以修改群设置')
}

/**
 * 多人群聊里，编辑重发 / 重新生成只能针对自己发的那条用户消息（会截掉之后的消息）；
 * 单人会话不受影响。messageId 为锚点用户消息。
 */
export function assertOwnUserMessage(sessionId: string, message: { id: string; senderUserId?: string | null }): void {
  if (!sessionService.hasHumans(sessionId)) return
  const me = currentActor().id
  const sender = message.senderUserId ?? null
  if (sender && sender !== me) {
    throw new AppError(403, 'NOT_YOUR_MESSAGE', '只能编辑或重新生成自己发的消息')
  }
  // 截断会删掉之后的全部消息：之后已有别人发言时不允许，免得删掉同事的消息
  const messages = sessionService.messages(sessionId)
  const index = messages.findIndex((m) => m.id === message.id)
  if (index >= 0 && messages.slice(index + 1).some((m) => m.role === 'user' && m.senderUserId && m.senderUserId !== me)) {
    throw new AppError(409, 'OTHERS_REPLIED', '之后已有同事发言，不能再编辑或重新生成这条消息')
  }
}

/** 工作流节点的隐藏会话只读：不能在里面发消息 / 重新生成 / 编辑 / 改名换成员（409 WORKFLOW_SESSION_READONLY） */
export function assertNotWorkflowSession(id: string): void {
  if (sessionService.get(id)?.workflowRunId) {
    throw new AppError(409, 'WORKFLOW_SESSION_READONLY', '这是工作流节点的运行会话，只能查看')
  }
}

/** 会话附带服务端运行状态（契约 §6.9）：running / activeRunId */
function withRun<T extends { id: string }>(session: T): T & { running: boolean; activeRunId: string | null } {
  return { ...session, ...runState(session.id) }
}

export function sessionRoutes(router: Router): void {
  router.get('/api/sessions', (ctx) => {
    // scope=all 已废弃：admin 也只看到自己的会话和自己所在的群（契约 §5.6a）
    ctx.body = { sessions: sessionService.list().map(withRun) }
  })

  /** 可邀请进群的同事（同组织、未停用、不含自己）；desktop 模式为空 */
  router.get('/api/sessions/colleagues', (ctx) => {
    const actor = currentActor()
    ctx.body = {
      users: isServerMode()
        ? teamService
            .members(actor)
            .filter((user) => !user.disabled && user.id !== actor.id)
            .map((user) => ({ id: user.id, name: user.name, email: user.email }))
        : [],
    }
  })

  router.post('/api/sessions', (ctx) => {
    const body = parse(createInput, ctx.request.body)
    if (body.members && body.kind === 'single') {
      throw new AppError(400, 'SESSION_KIND', '成员资料只属于群聊；请用 kind: group 新建群聊')
    }
    if (body.members) validateMemberModels(body.members, body.providerId ?? null)
    const requested = body.members
      ? body.members.map((member) => member.agentId)
      : (body.agentIds ?? (body.agentId ? [body.agentId] : []))
    const kind = body.members ? 'group' : (body.kind ?? (agentService.normalizeIds(requested).length > 1 ? 'group' : 'single'))
    if (kind === 'single' && (body.supervisorId !== undefined || body.groupName)) {
      throw new AppError(400, 'SESSION_KIND', '群名与主管只属于群聊；请用 kind: group 新建群聊')
    }
    if (body.permissionLevel) assertWithinCap(body.permissionLevel)
    // 先校验模型（失败时不留下半建好的会话）
    const modelChoice = body.model
      ? validateModelChoice(
          sessionModelKernel({ kind, agentIds: agentService.normalizeIds(requested.length ? requested : [BUILTIN_AGENT_ID]) }),
          { providerId: body.providerId, model: body.model },
          { providerId: body.providerId ?? null },
        )
      : null
    const session = sessionService.create({
      permissionLevel: body.permissionLevel ?? null,
      title: body.title,
      kind,
      groupName: body.groupName,
      providerId: body.providerId,
      agentIds: body.agentIds ?? (body.agentId ? [body.agentId] : undefined),
      members: body.members,
      userIds: body.userIds,
    })
    if (body.supervisorId !== undefined) {
      sessionService.setSupervisor(session.id, validSupervisor(body.supervisorId, session.agentIds))
      Object.assign(session, sessionService.get(session.id))
    }
    if (modelChoice || body.reasoningEffort) {
      sessionService.setModelChoice(session.id, {
        ...(modelChoice ? { providerId: modelChoice.providerId, model: modelChoice.model } : {}),
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      })
      Object.assign(session, sessionService.get(session.id))
    }
    ctx.status = 201
    ctx.body = { session }
  })

  router.get('/api/sessions/:id', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    const run = latestRun(session.id)
    ctx.body = { session: withRun(session), messages: sessionService.messages(session.id), run: run?.toPublic() ?? null }
  })

  router.patch('/api/sessions/:id', (ctx) => {
    const body = parse(patchInput, ctx.request.body)
    if (
      body.title === undefined &&
      body.groupName === undefined &&
      body.agentIds === undefined &&
      body.members === undefined &&
      body.supervisorId === undefined &&
      body.permissionLevel === undefined &&
      body.providerId === undefined &&
      body.model === undefined &&
      body.reasoningEffort === undefined
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        '需要提供 title、groupName、agentIds、members、supervisorId、permissionLevel、model 或 reasoningEffort',
      )
    }
    if (body.agentIds !== undefined && body.members !== undefined) {
      throw new AppError(400, 'VALIDATION_ERROR', 'agentIds 与 members 只能给一个')
    }
    const target = sessionService.visible(ctx.params.id)
    if (!target) throw notFound('会话')
    assertSessionManageable(ctx.params.id)
    assertNotWorkflowSession(ctx.params.id)
    // 先校验成员（失败时不做部分修改）
    if (body.members !== undefined && target.kind === 'group') {
      if (resolveMemberInputs(body.members).length === 0) {
        throw new AppError(400, 'GROUP_MEMBERS', '群里至少要有一个 Agent 成员')
      }
      validateMemberModels(body.members, body.providerId !== undefined ? body.providerId : target.providerId)
    }
    // 团队上限：超过上限 403 PERMISSION_LEVEL_EXCEEDED（不做部分修改）
    if (body.permissionLevel) assertWithinCap(body.permissionLevel)

    if (body.title !== undefined && !sessionService.rename(ctx.params.id, body.title)) {
      throw new AppError(400, 'VALIDATION_ERROR', '标题不能为空')
    }
    const current = sessionService.get(ctx.params.id)
    if (!current) throw notFound('会话')
    // 群聊就是群聊：单聊不能加成员 / 设主管 / 起群名变成群聊；群聊只能新建
    if (current.kind === 'single') {
      if (body.agentIds !== undefined && agentService.normalizeIds(body.agentIds).length > 1) {
        throw new AppError(400, 'SESSION_KIND', '单聊只能有一个内核；要多个成员一起聊，请新建群聊')
      }
      if (body.members !== undefined) {
        throw new AppError(400, 'SESSION_KIND', '成员资料只属于群聊；请新建群聊')
      }
      if (body.groupName != null || body.supervisorId != null) {
        throw new AppError(400, 'SESSION_KIND', '群名与主管只属于群聊；请新建群聊')
      }
    } else if (body.agentIds !== undefined && agentService.normalizeIds(body.agentIds).length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', '群聊至少需要一个成员')
    }
    // 成员先改（可能因校验失败抛错），成功后再改群名，避免只改了一半
    let session =
      body.members !== undefined
        ? sessionService.setMembers(ctx.params.id, body.members)
        : body.agentIds !== undefined
          ? sessionService.setAgents(ctx.params.id, body.agentIds)
          : sessionService.get(ctx.params.id)
    if (!session) throw notFound('会话')
    if (body.groupName !== undefined) session = sessionService.renameGroup(ctx.params.id, body.groupName) ?? sessionService.get(ctx.params.id) ?? session
    if (body.supervisorId !== undefined) {
      session = sessionService.setSupervisor(session.id, body.supervisorId === null ? null : validSupervisor(body.supervisorId, session.agentIds))
      if (!session) throw notFound('会话')
    }
    if (body.permissionLevel !== undefined) {
      session = sessionService.setPermissionLevel(session.id, body.permissionLevel)
      if (!session) throw notFound('会话')
    }
    if (body.providerId !== undefined || body.model !== undefined || body.reasoningEffort !== undefined) {
      applyModelPatch(session, body)
      session = sessionService.get(session.id)
      if (!session) throw notFound('会话')
    }
    ctx.body = { session }
  })

  router.delete('/api/sessions/:id', async (ctx) => {
    if (!sessionService.visible(ctx.params.id)) throw notFound('会话')
    assertSessionWritable(ctx.params.id)
    if (!sessionService.owned(ctx.params.id)) {
      throw new AppError(403, 'NOT_GROUP_OWNER', '只有群主可以解散群聊；你可以退出群聊')
    }
    if (!(await deleteSessionFully(ctx.params.id))) throw notFound('会话')
    ctx.status = 204
  })

  /* ── 多人群聊：真人成员（契约 §6.10） ── */

  router.get('/api/sessions/:id/participants', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    ctx.body = { participants: session.participants }
  })

  router.post('/api/sessions/:id/participants', (ctx) => {
    const body = parse(participantsInput, ctx.request.body)
    if (!sessionService.visible(ctx.params.id)) throw notFound('会话')
    assertSessionManageable(ctx.params.id)
    assertNotWorkflowSession(ctx.params.id)
    if (body.role === 'admin' && !sessionService.owned(ctx.params.id)) {
      throw new AppError(403, 'NOT_GROUP_OWNER', '只有群主可以设置群管理员')
    }
    const added = sessionService.addParticipants(ctx.params.id, body.userIds, body.role ?? 'member')
    ctx.status = 201
    ctx.body = { added, session: sessionService.get(ctx.params.id) }
  })

  router.patch('/api/sessions/:id/participants/:userId', (ctx) => {
    const body = parse(participantPatch, ctx.request.body)
    if (!sessionService.visible(ctx.params.id)) throw notFound('会话')
    if (!sessionService.owned(ctx.params.id)) throw new AppError(403, 'NOT_GROUP_OWNER', '只有群主可以设置群管理员')
    if (!sessionService.setParticipantRole(ctx.params.id, ctx.params.userId, body.role)) throw notFound('群成员')
    ctx.body = { session: sessionService.get(ctx.params.id) }
  })

  /** 移出成员（群主 / 群管理员；群管理员不能移出其他管理员）；移出自己 = 退出群聊 */
  router.delete('/api/sessions/:id/participants/:userId', (ctx) => {
    const id = ctx.params.id
    if (!sessionService.visible(id)) throw notFound('会话')
    const actor = currentActor()
    const target = ctx.params.userId === 'me' ? actor.id : ctx.params.userId
    const targetRole = sessionService.participantRole(id, target)
    if (!targetRole) throw notFound('群成员')
    if (targetRole === 'owner') throw new AppError(400, 'OWNER_CANNOT_LEAVE', '群主不能退出或被移出；可以解散群聊')
    if (target !== actor.id) {
      assertSessionManageable(id)
      if (targetRole === 'admin' && !sessionService.owned(id)) {
        throw new AppError(403, 'NOT_GROUP_OWNER', '只有群主可以移出群管理员')
      }
    }
    sessionService.removeParticipant(id, target)
    ctx.status = 204
  })

  /**
   * 会话实时事件（SSE，契约 §6.10.4）：message（新消息落库 / 草稿定稿）/ session（群设置或成员变化）/
   * run（运行开始 / 结束）/ removed（失去访问权，随后断开）。不含流式 token：要实时输出用 GET /api/sessions/:id/stream。
   */
  router.get('/api/sessions/:id/events', (ctx) => {
    const id = ctx.params.id
    if (!sessionService.visible(id)) throw notFound('会话')
    const actor = currentActor()
    ctx.respond = false
    openSse(ctx.res)
    const res = ctx.res
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      clearInterval(timer)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }
    const unsubscribe = sessionHub.subscribe(id, { actor, send: (event, payload) => sendSse(res, event, payload), close })
    sendSse(res, 'ready', { sessionId: id, at: Date.now(), ...runState(id) })
    const timer = setInterval(() => sendSse(res, 'ping', { at: Date.now() }), 25_000)
    timer.unref()
    res.on('close', close)
  })

  router.get('/api/sessions/:id/messages', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    ctx.body = { messages: sessionService.messages(session.id) }
  })

  /**
   * 内置浏览器面板的接管 / 停止（docs/browser-use.md）：pause 后本次运行里后续 browser 工具等待恢复（最长 30 分钟），
   * stop 后本次运行里后续 browser 工具直接返回“用户已停止浏览器操作”。下一次运行开始时自动回到 running。
   */
  router.post('/api/sessions/:id/browser/control', (ctx) => {
    const session = sessionService.visible(ctx.params.id)
    if (!session) throw notFound('会话')
    if (!sessionService.writable(session.id)) throw new AppError(403, 'FORBIDDEN', '只能控制自己会话里的浏览器')
    const body = parse(browserControlInput, ctx.request.body)
    ctx.body = { state: browserControl.set(session.id, body.action) }
  })

  /**
   * 电脑操作（docs/computer-use.md，实验性）：本会话的开关与状态。
   * available = 设置 computerUse='1' 且桌面端进程通道可用（团队服务器 / 纯网页端为 false）。
   * 开启只对本会话、本进程有效；关闭会同时停止并收起桌面端的边框提示。
   */
  const computerSession = (id: string, write: boolean) => {
    const session = sessionService.visible(id)
    if (!session) throw notFound('会话')
    if (write && !sessionService.writable(session.id)) throw new AppError(403, 'FORBIDDEN', '只能控制自己会话里的电脑操作')
    return session
  }
  const computerAvailable = (): boolean => settingsService.get('computerUse') === '1' && computerChannel().available()

  router.get('/api/sessions/:id/computer', (ctx) => {
    const session = computerSession(ctx.params.id, false)
    ctx.body = { enabled: computerControl.enabled(session.id), state: computerControl.state(session.id), available: computerAvailable() }
  })

  router.post('/api/sessions/:id/computer', (ctx) => {
    const session = computerSession(ctx.params.id, true)
    const body = parse(computerEnableInput, ctx.request.body)
    if (body.enabled && !computerAvailable()) {
      throw new AppError(409, 'COMPUTER_UNAVAILABLE', '电脑操作不可用：需要桌面端本地模式，并在设置里打开“电脑操作（实验性）”')
    }
    ctx.body = { enabled: computerControl.setEnabled(session.id, body.enabled), state: computerControl.state(session.id) }
  })

  router.post('/api/sessions/:id/computer/control', (ctx) => {
    const session = computerSession(ctx.params.id, true)
    const body = parse(computerControlInput, ctx.request.body)
    ctx.body = { state: computerControl.set(session.id, body.action) }
  })
}
