import { z } from 'zod'
import { BUILTIN_AGENT_ID } from '../../agents.js'
import { currentActor } from '../../context.js'
import { messageOf } from '../../errors.js'
import { agentService, type ResolvedAgent } from '../agent-service.js'
import { eventBus } from '../events.js'
import { sessionService, type MemberInput } from '../session-service.js'
import { effectiveSessionLevel } from '../permissions.js'
import { clearNonInteractiveApproval, getNonInteractiveApproval, setNonInteractiveApproval } from '../tool-approval.js'
import type { ToolContext, ToolSpec } from '../tools/registry.js'
import { ToolError } from '../tools/tool-error.js'
import type { Session } from '../../types.js'
import { decorateMembers, validateMemberModels } from './group-members.js'
import { activeRun, startRun } from './run-registry.js'
import { deleteSessionFully } from './session-delete.js'
import { SUPERVISOR_NONE } from './supervisor.js'

/**
 * 群聊工具（一句话建群并讨论）：list_group_options / create_group / update_group / post_to_group / delete_group。
 * 内置内核直接调用；命令行内核经 LULUX MCP 调用；工作流里由“群聊讨论”节点使用。
 *
 * - 同一内核可以多次进群（成员实例 kernel-x、kernel-x#2…），名字始终是内核原名，role 是贴在名字旁的群头衔。
 * - 写操作走会话权限（“需审批”时弹卡片）；解散群聊即使“完全权限”也要确认。
 * - post_to_group 在目标群里以用户消息发起一轮讨论（群里照常可见、可停止），默认等讨论结束把结论带回来。
 *   不能往自己所在的群发、不能形成 A→B→A 的循环；目标群正在讨论时拒绝。
 */

const MAX_WAIT_SECONDS = 900
const DEFAULT_WAIT_SECONDS = 300
const REPLY_CLIP = 1500
const RESULT_CLIP = 8000

/** 进行中的 post_to_group：目标群 → 发起方会话（防循环） */
const driving = new Map<string, string>()

const memberSchema = z.object({
  kernel: z.string().trim().min(1).max(84),
  role: z.string().max(40).optional(),
  instructions: z.string().max(4000).optional(),
  model: z.string().max(200).optional(),
})

const memberJsonSchema = {
  type: 'object',
  properties: {
    kernel: { type: 'string', description: '内核：list_group_options 里的 id 或名字（如 builtin / LULUX、kernel-claude-code / Claude Code）。同一内核可以出现多次' },
    role: { type: 'string', description: '群头衔（显示在名字旁，最多 16 字），如“跟单员”“写信员”“报价员”' },
    instructions: { type: 'string', description: '这位成员的职责说明（进入它的系统提示），选填' },
    model: { type: 'string', description: '这位成员用的模型（选填，默认跟随群 / 内核默认）' },
  },
  required: ['kernel'],
}

const groupRefSchema = { type: 'string', description: '群聊 id，或群名（与 list_group_options 返回的一致）' }

function clip(text: string, max: number): string {
  const flat = text.trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 内核引用 → 内核 Agent id（认 id、内核 id、名字，大小写不敏感） */
function resolveKernel(ref: string): ResolvedAgent {
  const key = ref.trim().replace(/^[@＠]/, '').toLowerCase()
  const agents = agentService.list()
  const hit =
    agents.find((agent) => agent.id.toLowerCase() === key) ??
    agents.find((agent) => (agent.kernelId ?? '').toLowerCase() === key) ??
    agents.find((agent) => agent.name.toLowerCase() === key) ??
    (key === 'lulux' ? agents.find((agent) => agent.id === BUILTIN_AGENT_ID) : undefined)
  const found = hit ? agentService.find(hit.id) : undefined
  if (!found) {
    throw new ToolError(`没有名为「${ref}」的内核。可用内核：${agents.map((agent) => `${agent.name}（${agent.id}）`).join('、')}`)
  }
  return found
}

function ownGroups(): Session[] {
  return sessionService.list().filter((session) => session.kind === 'group' && session.workflowRunId === null)
}

function groupName(session: Session): string {
  return session.groupName || session.title
}

/** 群引用 → 群聊（id 精确匹配优先，其次群名 / 标题；重名时要求用 id） */
function resolveGroup(ref: string): Session {
  const key = ref.trim()
  const groups = ownGroups()
  const byId = groups.find((session) => session.id === key)
  if (byId) return byId
  const lower = key.toLowerCase()
  const byName = groups.filter((session) => groupName(session).toLowerCase() === lower)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new ToolError(`有 ${byName.length} 个群都叫「${key}」，请用群 id：${byName.map((session) => session.id).join('、')}`)
  }
  throw new ToolError(
    groups.length > 0
      ? `没有找到群聊「${key}」。现有群聊：${groups.slice(0, 20).map((session) => `${groupName(session)}（${session.id}）`).join('、')}`
      : `没有找到群聊「${key}」，当前还没有群聊，可以用 create_group 新建。`,
  )
}

function decorated(session: Session): ResolvedAgent[] {
  const agents = session.agentIds
    .map((id) => agentService.find(id))
    .filter((agent): agent is ResolvedAgent => Boolean(agent))
  return decorateMembers(agents, session.memberProfiles)
}

/** 群内成员引用 → 成员实例 id（认实例 id、显示名、群头衔、唯一的内核原名） */
function resolveMember(session: Session, ref: string): string {
  const key = ref.trim().replace(/^[@＠]/, '').toLowerCase()
  const members = decorated(session)
  const exact = members.find((member) => member.id.toLowerCase() === key || member.name.toLowerCase() === key)
  if (exact) return exact.id
  for (const pick of [
    (member: ResolvedAgent) => (member.role ?? '').toLowerCase() === key,
    (member: ResolvedAgent) => (member.kernelName ?? '').toLowerCase() === key,
  ]) {
    const hits = members.filter(pick)
    if (hits.length === 1) return hits[0]!.id
    if (hits.length > 1) {
      throw new ToolError(`「${ref}」对应多个成员：${hits.map((member) => `${member.name}（${member.id}）`).join('、')}，请用成员 id`)
    }
  }
  throw new ToolError(`群里没有成员「${ref}」。成员：${members.map((member) => `${member.name}（${member.id}）`).join('、')}`)
}

function describeGroup(session: Session): string {
  const members = decorated(session)
  const supervisor =
    session.supervisorId === SUPERVISOR_NONE
      ? '无主管（成员按顺序发言）'
      : (members.find((member) => member.id === session.supervisorId)?.name ?? 'LULUX')
  return [
    `群聊「${groupName(session)}」（id: ${session.id}）`,
    `成员：${members.map((member) => `${member.name}（${member.id}）`).join('、')}`,
    `主管：${supervisor}`,
  ].join('\n')
}

function supervisorFor(session: Session, ref: string | undefined): string | null | undefined {
  if (ref === undefined) return undefined
  const key = ref.trim()
  if (!key) return null
  if (['none', '无', '无主管'].includes(key.toLowerCase())) return SUPERVISOR_NONE
  if (['lulux', 'builtin'].includes(key.toLowerCase()) && !session.agentIds.includes(BUILTIN_AGENT_ID)) return null
  return resolveMember(session, key)
}

function notifySidebar(session: Session): void {
  const actor = currentActor()
  eventBus.publish('session.updated', { sessionId: session.id }, { userIds: [actor.id], orgId: actor.orgId })
}

function assertNotSelf(ctx: ToolContext, sessionId: string, action: string): void {
  if (ctx.sessionId === sessionId) throw new ToolError(`你就在这个群里，不能${action}自己所在的群；直接在群里回复即可。`)
}

function assertNotRunning(sessionId: string, action: string): void {
  if (activeRun(sessionId)?.running) throw new ToolError(`这个群正在讨论，不能${action}。等这一轮结束或先在群里停止。`)
}

function toInputs(members: Array<z.infer<typeof memberSchema>>): MemberInput[] {
  return members.map((member) => ({
    agentId: resolveKernel(member.kernel).id.replace(/#\d+$/, ''),
    role: member.role ?? '',
    instructions: member.instructions ?? '',
    model: member.model?.trim() || null,
  }))
}

/** 等一轮讨论结束：超时只停止等待，不打断群里的讨论 */
async function waitDone(done: Promise<unknown>, seconds: number, signal: AbortSignal): Promise<'done' | 'timeout' | 'aborted'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      done.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), seconds * 1000)
        timer.unref?.()
      }),
      new Promise<'aborted'>((resolve) => {
        if (signal.aborted) return resolve('aborted')
        onAbort = () => resolve('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export const groupTools: ToolSpec[] = [
  {
    name: 'list_group_options',
    group: 'group',
    risk: 'read',
    description: '列出可以拉进群的内核（同一内核可以多次进群、各带群头衔），以及用户现有的群聊和成员。建群、改群、往群里发消息前先调用。',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const kernels = agentService.list().map((agent) => ({
        id: agent.id,
        name: agent.name,
        available: agent.available,
        ...(agent.available ? {} : { reason: agent.unavailableReason }),
      }))
      const groups = ownGroups()
        .slice(0, 30)
        .map((session) => ({
          id: session.id,
          name: groupName(session),
          supervisor: session.supervisorId,
          running: Boolean(activeRun(session.id)?.running),
          members: decorated(session).map((member) => ({ id: member.id, name: member.name, role: member.role ?? null })),
        }))
      return { kernels, groups }
    },
  },
  {
    name: 'create_group',
    group: 'group',
    risk: 'write',
    description:
      '新建一个多 Agent 群聊并配置成员：同一内核可以多次加入（例如两个 Claude Code，一个“跟单员”一个“写信员”），名字保持内核原名，role 作为群头衔显示在名字旁。' +
      '建好后群会出现在用户侧栏；要让大家开始讨论，再调用 post_to_group。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '群名，如“BV-50 报价小组”' },
        members: { type: 'array', minItems: 1, maxItems: 12, items: memberJsonSchema, description: '成员（1–12 个）' },
        supervisor: { type: 'string', description: '主管：成员 id / 群头衔，"LULUX"（默认），或 "none"（无主管，成员按顺序发言）' },
      },
      required: ['name', 'members'],
    },
    run(args) {
      const input = z
        .object({ name: z.string().trim().min(1).max(200), members: z.array(memberSchema).min(1).max(12), supervisor: z.string().max(84).optional() })
        .parse(args)
      const members = toInputs(input.members)
      validateMemberModels(members, null)
      let session = sessionService.create({ kind: 'group', groupName: input.name, title: input.name, members })
      try {
        const supervisor = supervisorFor(session, input.supervisor)
        if (supervisor !== undefined) session = sessionService.setSupervisor(session.id, supervisor) ?? session
      } catch (error) {
        // 主管写错：群已建好，按默认主管，并告诉模型
        notifySidebar(session)
        return `${describeGroup(session)}\n注意：主管设置失败（${messageOf(error)}），已使用默认主管 LULUX。\n群已出现在侧栏；用 post_to_group 发起讨论。`
      }
      notifySidebar(session)
      return `已建群。\n${describeGroup(session)}\n群已出现在用户侧栏；用 post_to_group 发起讨论。`
    },
  },
  {
    name: 'update_group',
    group: 'group',
    risk: 'write',
    description: '修改群聊：改群名、加成员（同一内核可再加一个）、移除成员、改成员的群头衔 / 职责 / 模型、换主管。',
    inputSchema: {
      type: 'object',
      properties: {
        group: groupRefSchema,
        name: { type: 'string', description: '新群名' },
        add_members: { type: 'array', items: memberJsonSchema, description: '要加入的成员' },
        remove_members: { type: 'array', items: { type: 'string' }, description: '要移除的成员（成员 id / 显示名 / 群头衔）' },
        update_members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              member: { type: 'string', description: '成员 id / 显示名 / 群头衔' },
              role: { type: 'string', description: '新群头衔（空字符串清除）' },
              instructions: { type: 'string', description: '新职责（空字符串清除）' },
              model: { type: 'string', description: '新模型（空字符串恢复默认）' },
            },
            required: ['member'],
          },
        },
        supervisor: { type: 'string', description: '新主管：成员 id / 群头衔，"LULUX"，或 "none"' },
      },
      required: ['group'],
    },
    run(args) {
      const input = z
        .object({
          group: z.string().min(1).max(200),
          name: z.string().trim().min(1).max(200).optional(),
          add_members: z.array(memberSchema).max(12).optional(),
          remove_members: z.array(z.string().min(1).max(84)).max(12).optional(),
          update_members: z
            .array(
              z.object({
                member: z.string().min(1).max(84),
                role: z.string().max(40).optional(),
                instructions: z.string().max(4000).optional(),
                model: z.string().max(200).optional(),
              }),
            )
            .max(12)
            .optional(),
          supervisor: z.string().max(84).optional(),
        })
        .parse(args)
      let session = resolveGroup(input.group)
      if (!sessionService.owned(session.id)) throw new ToolError('只有群主能修改这个群。')
      assertNotRunning(session.id, '修改成员')
      // 先在内存里算出新成员表，全部校验通过后一次写入
      const current: MemberInput[] = session.agentIds.map((id) => ({
        agentId: id,
        role: session.memberProfiles[id]?.role ?? '',
        instructions: session.memberProfiles[id]?.instructions ?? '',
        model: session.memberProfiles[id]?.model ?? null,
      }))
      const removed = new Set((input.remove_members ?? []).map((ref) => resolveMember(session, ref)))
      for (const change of input.update_members ?? []) {
        const id = resolveMember(session, change.member)
        const entry = current.find((member) => member.agentId === id)!
        if (change.role !== undefined) entry.role = change.role
        if (change.instructions !== undefined) entry.instructions = change.instructions
        if (change.model !== undefined) entry.model = change.model.trim() || null
      }
      const next = [...current.filter((member) => !removed.has(member.agentId)), ...toInputs(input.add_members ?? [])]
      if (next.length === 0) throw new ToolError('群里至少要留一个 Agent 成员；要整个删除请用 delete_group。')
      const membersChanged = Boolean(input.add_members?.length || input.remove_members?.length || input.update_members?.length)
      if (membersChanged) validateMemberModels(next, session.providerId)
      if (membersChanged) session = sessionService.setMembers(session.id, next) ?? session
      if (input.name) {
        sessionService.renameGroup(session.id, input.name)
        session = sessionService.get(session.id) ?? session
      }
      if (input.supervisor !== undefined) {
        const supervisor = supervisorFor(session, input.supervisor)
        if (supervisor !== undefined) session = sessionService.setSupervisor(session.id, supervisor) ?? session
      }
      session = sessionService.get(session.id) ?? session
      notifySidebar(session)
      return `已更新。\n${describeGroup(session)}`
    },
  },
  {
    name: 'post_to_group',
    group: 'group',
    risk: 'write',
    description:
      '在群聊里发一条消息并发起一轮讨论（用户能在群里看到全过程，也能随时停止）。没有点名时由主管派发成员、最后汇总；' +
      '用「@群头衔」或「@成员名」可以只叫某几位。默认等这一轮讨论结束，把主管汇总 / 各成员的回答带回来。',
    inputSchema: {
      type: 'object',
      properties: {
        group: groupRefSchema,
        message: { type: 'string', description: '要说的话；成员看不到你所在的对话，请写清背景与要求' },
        wait: { type: 'boolean', description: '是否等讨论结束并带回结论（默认 true）；false 时发起后立刻返回' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: MAX_WAIT_SECONDS, description: `最多等多久（默认 ${DEFAULT_WAIT_SECONDS} 秒）；超时只是不再等，群里的讨论继续` },
      },
      required: ['group', 'message'],
    },
    async run(args, ctx) {
      const input = z
        .object({
          group: z.string().min(1).max(200),
          message: z.string().trim().min(1).max(20_000),
          wait: z.boolean().optional(),
          timeout_seconds: z.number().int().min(10).max(MAX_WAIT_SECONDS).optional(),
        })
        .parse(args)
      const session = resolveGroup(input.group)
      assertNotSelf(ctx, session.id, '往')
      if (!sessionService.writable(session.id)) throw new ToolError('没有权限在这个群里发消息。')
      // 防循环：A 正在驱动 B 时，B 里的成员不能再往 A（或链路上的任何群）发
      let depth = 0
      for (let cursor: string | undefined = ctx.sessionId; cursor; cursor = driving.get(cursor)) {
        if (cursor === session.id) throw new ToolError('不能往正在等你回复的群里再发起讨论（会形成循环）。')
        depth += 1
        if (depth > 3) throw new ToolError('群聊之间的转发层级太深（最多 3 层），请直接在群里继续。')
      }
      assertNotRunning(session.id, '再发起讨论')

      const { chatOrchestrator } = await import('./orchestrator.js')
      const prepared = chatOrchestrator.prepare(session.id)
      const caller = agentService.find(ctx.agentId)
      const content = `${input.message}\n\n（由「${caller?.name ?? 'Agent'}」代用户在另一个会话里发起）`
      const run = startRun(session.id, 'chat')
      const startedAt = Date.now()
      // 发起方是非交互运行（工作流 / 定时任务）：群里同样没人审批，沿用发起方登记的 allowWrite，
      // 但不超过目标群自己的级别（群是“仅可查看”时不写）；群里 CLI 成员的级别同样取二者更严的一个（见 unattendedKernelLevel）
      const inherited = getNonInteractiveApproval(ctx.sessionId)
      const inheritNonInteractive = inherited !== undefined
      if (inheritNonInteractive) setNonInteractiveApproval(session.id, inherited && effectiveSessionLevel(session.id) !== 'read')
      driving.set(session.id, ctx.sessionId)
      void chatOrchestrator
        .run(prepared, { mode: 'send', content, appendUser: true }, { send: () => undefined }, undefined, run)
        .catch((error) => console.error('[lulux-eta] post_to_group run failed', error))
      void run.done.finally(() => {
        if (driving.get(session.id) === ctx.sessionId) driving.delete(session.id)
        if (inheritNonInteractive) clearNonInteractiveApproval(session.id)
      })

      if (input.wait === false) return `已在群聊「${groupName(session)}」发起讨论（id: ${session.id}），用户可以在侧栏打开查看。`
      const outcome = await waitDone(run.done, input.timeout_seconds ?? DEFAULT_WAIT_SECONDS, ctx.signal)
      if (outcome === 'aborted') return `已在群聊「${groupName(session)}」（id: ${session.id}）发起讨论；你这边被停止了，群里的讨论不受影响。`
      const members = new Map(decorated(sessionService.get(session.id) ?? session).map((member) => [member.id, member.name]))
      const replies = sessionService
        .messages(session.id)
        .filter((message) => message.role === 'assistant' && message.createdAt >= startedAt && message.content.trim())
      const head = outcome === 'timeout' ? `群聊「${groupName(session)}」还在讨论（已等 ${input.timeout_seconds ?? DEFAULT_WAIT_SECONDS} 秒），目前的回答：` : `群聊「${groupName(session)}」讨论结束：`
      const ref = `（id: ${session.id}）`
      if (replies.length === 0) return `${head}\n（还没有成员回答）\n${ref}`
      const summary = replies.filter((message) => message.supervisorRole === 'summary').pop()
      const name = (id: string | null) => (id ? (members.get(id) ?? agentService.find(id)?.name ?? id) : '成员')
      const body = summary
        ? `主管汇总（${name(summary.senderAgentId)}）：\n${clip(summary.content, RESULT_CLIP)}`
        : replies
            .filter((message) => message.supervisorRole !== 'plan')
            .map((message) => `【${name(message.senderAgentId)}】\n${clip(message.content, REPLY_CLIP)}`)
            .join('\n\n')
      return `${clip(`${head}\n${body}`, RESULT_CLIP + 400)}\n${ref}`
    },
  },
  {
    name: 'delete_group',
    group: 'group',
    risk: 'write',
    approval: 'always',
    // 不可恢复：即使“完全权限”也逐次确认（与电脑操作相同的 orgLevel 语义）；非交互运行里直接拒绝
    orgLevel: true,
    noRemember: true,
    description: '解散（删除）一个群聊，聊天记录一并删除，不能恢复。只在用户明确要求时使用。',
    inputSchema: { type: 'object', properties: { group: groupRefSchema }, required: ['group'] },
    async run(args, ctx) {
      const input = z.object({ group: z.string().min(1).max(200) }).parse(args)
      const session = resolveGroup(input.group)
      assertNotSelf(ctx, session.id, '解散')
      if (!sessionService.owned(session.id)) throw new ToolError('只有群主能解散这个群。')
      const name = groupName(session)
      if (!(await deleteSessionFully(session.id))) throw new ToolError('群聊已不存在。')
      return `已解散群聊「${name}」。`
    },
  },
]

/** 测试用：清空防循环状态 */
export function resetGroupToolStateForTests(): void {
  driving.clear()
}

