import { db } from '../../db.js'
import { currentActor, runAs, type Actor } from '../../context.js'
import { AppError, messageOf, notFound } from '../../errors.js'
import { assertOwnRow, isOwnRow } from '../../security/access.js'
import type { EventScope } from '../events.js'
import { newId } from '../../utils/id.js'
import { auditService } from '../audit-service.js'
import { chatOrchestrator, type ChatSink } from '../chat/orchestrator.js'
import { isShuttingDown, SHUTDOWN_INTERRUPTED_MESSAGE } from '../chat/run-registry.js'
import { eventBus } from '../events.js'
import { sessionService } from '../session-service.js'
import { clearNonInteractiveApproval, setNonInteractiveApproval } from '../tool-approval.js'
import { permissionCaps } from '../permissions.js'
import { runDag, topologicalOrder, type NodeResult, type RunStatus, type UpstreamOutput } from './dag.js'
import { toWorkflow, visibleWorkflowRow, workflowRow, type WorkflowEdge, type WorkflowNode, type WorkflowRow } from './workflow-service.js'

/**
 * 工作流执行：拓扑 DAG，节点经正常的内核编排（chatOrchestrator：内置内核 / 命令行内核）在隐藏会话里运行。
 * - 隐藏会话：sessions.workflow_run_id 非空，不出现在会话列表，可从运行记录按 sessionId 打开；
 * - 非交互：写 / 需审批的工具在节点 allowWrite=false 时自动拒绝，true 时自动批准；
 * - 同时运行的节点最多 2 个（全局，跨运行共享）；取消会中止运行中的节点（上游请求 / CLI 子进程）。
 */

export const NODE_CONCURRENCY = 2
/** 每个上游输出带入下游提示词的最大长度 */
export const UPSTREAM_OUTPUT_LIMIT = 20_000

export interface WorkflowRunNode {
  nodeId: string
  status: RunStatus
  output: string
  error: string | null
  sessionId: string | null
  startedAt: number | null
  finishedAt: number | null
}

export interface WorkflowRun {
  id: string
  workflowId: string
  trigger: 'manual' | 'schedule'
  scheduleId: string | null
  status: RunStatus
  input: string
  startedAt: number
  finishedAt: number | null
  error: string | null
  nodes: WorkflowRunNode[]
}

interface RunRow {
  id: string
  workflow_id: string
  trigger: string
  schedule_id: string | null
  status: string
  input: string
  snapshot: string
  error: string | null
  org_id: string
  owner_id: string
  started_at: number
  finished_at: number | null
}

interface RunNodeRow {
  run_id: string
  node_id: string
  status: string
  output: string
  error: string | null
  session_id: string | null
  started_at: number | null
  finished_at: number | null
}

// ── 全局并发闸门 ─────────────────────────────────────────

let slots = NODE_CONCURRENCY
const waiters: Array<() => void> = []

function acquireSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const grant = (): void => {
      signal.removeEventListener('abort', onAbort)
      let released = false
      resolve(() => {
        if (released) return
        released = true
        const next = waiters.shift()
        if (next) next()
        else slots += 1
      })
    }
    const onAbort = (): void => {
      const index = waiters.indexOf(grant)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error('aborted'))
    }
    if (signal.aborted) return reject(new Error('aborted'))
    if (slots > 0) {
      slots -= 1
      grant()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    waiters.push(grant)
  })
}

// ── 提示词 ───────────────────────────────────────────────

/** 节点提示词 = 自己的提示词 + （根节点）运行输入 + 上游输出（节点名 + 输出） */
export function composeNodePrompt(node: Pick<WorkflowNode, 'prompt' | 'skills'>, input: string, upstream: UpstreamOutput[]): string {
  const parts: string[] = [node.prompt.trim() || '请完成这一步。']
  if (node.skills && node.skills.length > 0) {
    parts.push(`可用 Skill（需要时先用 skill_view 查看说明）：${node.skills.join('、')}`)
  }
  if (upstream.length === 0 && input.trim()) parts.push(`## 输入\n${input.trim()}`)
  if (upstream.length > 0) {
    const sections = upstream.map((up) => {
      const text = up.output.length > UPSTREAM_OUTPUT_LIMIT ? `${up.output.slice(0, UPSTREAM_OUTPUT_LIMIT)}\n…（已截断）` : up.output
      return `### ${up.name}\n${text.trim() || '（无输出）'}`
    })
    parts.push(`## 上游输出\n${sections.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

// ── 存储 ─────────────────────────────────────────────────

function runRow(id: string): RunRow | undefined {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as unknown as RunRow | undefined
}

function toRun(row: RunRow): WorkflowRun {
  const nodes = db
    .prepare('SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY position ASC')
    .all(row.id) as unknown as RunNodeRow[]
  return {
    id: row.id,
    workflowId: row.workflow_id,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    scheduleId: row.schedule_id,
    status: row.status as RunStatus,
    input: row.input,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    nodes: nodes.map((n) => ({
      nodeId: n.node_id,
      status: n.status as RunStatus,
      output: n.output,
      error: n.error,
      sessionId: n.session_id,
      startedAt: n.started_at,
      finishedAt: n.finished_at,
    })),
  }
}

/** 运行记录随工作流可见；工作流已删除时运行记录也已级联删除 */
function visibleRunRow(runId: string): { run: RunRow; workflow: WorkflowRow } {
  const run = runRow(runId)
  const workflow = run ? workflowRow(run.workflow_id) : undefined
  if (!run || !workflow || !isOwnRow(workflow)) throw notFound('运行记录')
  return { run, workflow }
}

/** 工作流事件只推给负责人本人（仅本人，契约 §5.6a） */
function scopeOf(workflow: { org_id: string; owner_id: string }): EventScope {
  return { userId: workflow.owner_id, orgId: workflow.org_id }
}

const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'cancelled', 'skipped'])

// ── 运行 ─────────────────────────────────────────────────

interface ActiveRun {
  controller: AbortController
  done: Promise<WorkflowRun>
}

const active = new Map<string, ActiveRun>()

export interface StartOptions {
  input?: string
  trigger?: 'manual' | 'schedule'
  scheduleId?: string | null
  /** 以谁的身份运行（默认当前请求的用户）；定时任务传任务负责人 */
  actor?: Actor
}

/** 运行一个节点：新建隐藏会话 → 经编排器运行 → 取最终回复 */
async function runNode(
  run: { id: string; workflowName: string; input: string; scope: EventScope; workflowId: string },
  node: WorkflowNode,
  upstream: UpstreamOutput[],
  signal: AbortSignal,
): Promise<NodeResult> {
  const session = sessionService.create({
    title: `[工作流] ${run.workflowName} · ${node.name}`.slice(0, 120),
    agentIds: [node.kernelId],
    providerId: node.providerId,
  })
  db.prepare("UPDATE sessions SET workflow_run_id = ?, origin = 'workflow' WHERE id = ?").run(run.id, session.id)
  db.prepare('UPDATE workflow_run_nodes SET session_id = ? WHERE run_id = ? AND node_id = ?').run(session.id, run.id, node.id)
  // allowWrite 不能超过运行者（工作流负责人）的权限上限（契约 §6.11）：上限“仅可查看”时一律不写。
  // 隐藏会话的级别：允许写 → 需审批（CLI 内核自带工具保持只读，LULUX 工具 / Claude Code 权限请求由 allowWrite 自动答复），否则仅可查看
  const allowWrite = node.allowWrite && permissionCaps.capFor(currentActor()) !== 'read'
  sessionService.setPermissionLevel(session.id, allowWrite ? 'ask' : 'read')
  setNonInteractiveApproval(session.id, allowWrite)
  try {
    const prepared = chatOrchestrator.prepare(session.id)
    if (node.model && prepared.provider) prepared.provider = { ...prepared.provider, model: node.model }
    let output = ''
    let error: string | null = null
    let finalMessage: string | null = null
    const sink: ChatSink = {
      send(event, payload) {
        const data = payload as Record<string, unknown>
        if (event === 'delta' && typeof data.text === 'string') {
          output += data.text
          eventBus.publish(
            'workflow.node',
            { type: 'workflow.node', runId: run.id, workflowId: run.workflowId, nodeId: node.id, status: 'running', delta: data.text },
            run.scope,
          )
        } else if (event === 'done') {
          const message = data.message as { content?: string } | undefined
          if (!data.aborted && typeof message?.content === 'string') finalMessage = message.content
        } else if (event === 'error') {
          error = typeof data.message === 'string' ? data.message : '节点运行失败'
        }
      },
    }
    const prompt = composeNodePrompt(node, run.input, upstream)
    await chatOrchestrator.run(prepared, { mode: 'send', content: prompt, appendUser: true }, sink, signal)
    if (signal.aborted) return { status: 'cancelled', output: finalMessage ?? output, error: '运行已取消' }
    // 服务关闭会中止节点所在的会话运行，但节点自身的 signal 未中止：按“被中断”记录，与启动恢复一致
    if (isShuttingDown()) return { status: 'cancelled', output: finalMessage ?? output, error: SHUTDOWN_INTERRUPTED_MESSAGE }
    if (error) return { status: 'failed', output: finalMessage ?? output, error }
    if (finalMessage === null) return { status: 'failed', output, error: '节点没有产生回复' }
    return { status: 'succeeded', output: finalMessage, error: null }
  } catch (caught) {
    if (signal.aborted) return { status: 'cancelled', output: '', error: '运行已取消' }
    if (isShuttingDown()) return { status: 'cancelled', output: '', error: SHUTDOWN_INTERRUPTED_MESSAGE }
    return { status: 'failed', output: '', error: messageOf(caught) }
  } finally {
    clearNonInteractiveApproval(session.id)
  }
}

function finishRun(runId: string, status: RunStatus, error: string | null): void {
  db.prepare('UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error, Date.now(), runId)
}

export const workflowRunner = {
  /** 创建运行记录并在后台开始执行；返回刚创建的运行（queued） */
  start(workflowId: string, options: StartOptions = {}): WorkflowRun {
    const actor = options.actor ?? currentActor()
    return runAs(actor, () => {
      const row = visibleWorkflowRow(workflowId)
      assertOwnRow(row, '工作流')
      const workflow = toWorkflow(row)
      if (workflow.nodes.length === 0) throw new AppError(400, 'EMPTY_WORKFLOW', '工作流里还没有节点')
      const order = topologicalOrder(workflow.nodes, workflow.edges)
      const input = (options.input ?? '').slice(0, 100_000)
      const now = Date.now()
      const runId = newId('wfr')
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, trigger, schedule_id, status, input, snapshot, org_id, owner_id, started_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        workflowId,
        options.trigger ?? 'manual',
        options.scheduleId ?? null,
        input,
        JSON.stringify({ name: workflow.name, nodes: workflow.nodes, edges: workflow.edges }),
        actor.orgId,
        actor.id,
        now,
      )
      const insertNode = db.prepare('INSERT INTO workflow_run_nodes (run_id, node_id, position, status) VALUES (?, ?, ?, ?)')
      order.forEach((nodeId, index) => insertNode.run(runId, nodeId, index, 'queued'))
      const scope = scopeOf(row)
      const controller = new AbortController()
      const created = toRun(runRow(runId)!)
      const done = workflowRunner.execute(runId, workflow.name, workflow.nodes, workflow.edges, input, scope, controller, actor)
      active.set(runId, { controller, done })
      void done.finally(() => active.delete(runId))
      eventBus.publish('workflow.run', { type: 'workflow.run', runId, workflowId, status: 'queued' }, scope)
      return created
    })
  },

  async execute(
    runId: string,
    workflowName: string,
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
    input: string,
    scope: EventScope,
    controller: AbortController,
    actor: Actor,
  ): Promise<WorkflowRun> {
    // 让 start() 先返回（HTTP 响应带 queued 状态）
    await new Promise((resolve) => setImmediate(resolve))
    const workflowId = runRow(runId)!.workflow_id
    const publishRun = (status: RunStatus): void =>
      eventBus.publish('workflow.run', { type: 'workflow.run', runId, workflowId, status }, scope)
    return runAs(actor, async () => {
      let started = false
      try {
        const result = await runDag({
          nodes,
          edges,
          concurrency: NODE_CONCURRENCY,
          signal: controller.signal,
          acquire: acquireSlot,
          runNode: (node, upstream, signal) => runNode({ id: runId, workflowName, input, scope, workflowId }, node, upstream, signal),
          onStatus: (nodeId, status, extra) => {
            const now = Date.now()
            if (status === 'running') {
              if (!started) {
                started = true
                db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ? AND status = 'queued'").run(runId)
                publishRun('running')
              }
              db.prepare('UPDATE workflow_run_nodes SET status = ?, started_at = ? WHERE run_id = ? AND node_id = ?').run(status, now, runId, nodeId)
            } else {
              db.prepare(
                `UPDATE workflow_run_nodes SET status = ?, output = COALESCE(?, output), error = ?, finished_at = ? WHERE run_id = ? AND node_id = ?`,
              ).run(status, extra?.output ?? null, extra?.error ?? null, terminalStatuses.has(status) ? now : null, runId, nodeId)
            }
            eventBus.publish('workflow.node', { type: 'workflow.node', runId, workflowId, nodeId, status }, scope)
          },
        })
        if (isShuttingDown() && [...result.nodes.values()].some((entry) => entry.status !== 'succeeded')) {
          finishRun(runId, 'failed', SHUTDOWN_INTERRUPTED_MESSAGE)
          db.prepare("UPDATE workflow_run_nodes SET status = 'cancelled', error = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running', 'skipped')").run(
            SHUTDOWN_INTERRUPTED_MESSAGE,
            Date.now(),
            runId,
          )
          publishRun('failed')
          return toRun(runRow(runId)!)
        }
        const failed = [...result.nodes.entries()].filter(([, entry]) => entry.status === 'failed')
        const error =
          result.status === 'cancelled'
            ? '运行已取消'
            : failed.length > 0
              ? `${failed.length} 个节点失败：${failed.map(([id, entry]) => `${nodes.find((n) => n.id === id)?.name ?? id}（${entry.error ?? '失败'}）`).join('；')}`.slice(0, 2000)
              : null
        finishRun(runId, result.status, error)
        publishRun(result.status)
      } catch (caught) {
        finishRun(runId, 'failed', messageOf(caught))
        db.prepare("UPDATE workflow_run_nodes SET status = 'skipped', finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").run(Date.now(), runId)
        publishRun('failed')
      }
      return toRun(runRow(runId)!)
    })
  },

  get(runId: string): WorkflowRun {
    return toRun(visibleRunRow(runId).run)
  },

  list(workflowId: string, limit = 20): WorkflowRun[] {
    visibleWorkflowRow(workflowId)
    const rows = db
      .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(workflowId, Math.max(1, Math.min(100, limit))) as unknown as RunRow[]
    return rows.map(toRun)
  },

  /** 取消：中止运行中的节点，未开始的节点记为 cancelled。已结束的运行原样返回 */
  async cancel(runId: string): Promise<WorkflowRun> {
    const { run, workflow } = visibleRunRow(runId)
    assertOwnRow(workflow, '工作流')
    const entry = active.get(runId)
    if (entry) {
      entry.controller.abort()
      auditService.record({ action: 'workflow.cancel', entityType: 'workflow_run', entityId: runId, summary: `取消工作流运行 ${runId}` })
      // 等运行中的节点收尾（上游请求 / 子进程中止通常很快），最多 5 秒
      await Promise.race([entry.done, new Promise((resolve) => setTimeout(resolve, 5000).unref())])
    } else if (!terminalStatuses.has(run.status as RunStatus)) {
      // 进程里已没有这次运行（例如服务重启过）：直接标记为取消
      finishRun(runId, 'cancelled', '运行已取消')
      db.prepare("UPDATE workflow_run_nodes SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").run(Date.now(), runId)
    }
    return toRun(runRow(runId)!)
  },

  /** 等待运行结束（定时任务 / 测试用）；不在运行中时直接返回当前记录 */
  async wait(runId: string): Promise<WorkflowRun> {
    const entry = active.get(runId)
    if (entry) return await entry.done
    return toRun(runRow(runId)!)
  },

  isActive(runId: string): boolean {
    return active.has(runId)
  },

  /** 启动时：上次进程退出时仍在运行的记录标记为失败 */
  recover(): number {
    const now = Date.now()
    const stale = db.prepare("SELECT id FROM workflow_runs WHERE status IN ('queued', 'running')").all() as Array<{ id: string }>
    for (const row of stale) {
      if (active.has(row.id)) continue
      finishRun(row.id, 'failed', SHUTDOWN_INTERRUPTED_MESSAGE)
      db.prepare("UPDATE workflow_run_nodes SET status = 'cancelled', error = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").run(SHUTDOWN_INTERRUPTED_MESSAGE, now, row.id)
    }
    return stale.length
  },

  /** 关闭服务时中止全部运行 */
  abortAll(): void {
    for (const entry of active.values()) entry.controller.abort()
  },
}
