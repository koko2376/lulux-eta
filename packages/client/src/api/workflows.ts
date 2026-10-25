import { request } from './http'

/**
 * 工作流（画布）+ 定时任务 API（契约：工作流 + 定时任务）。
 * 服务端返回数组或 `{ workflows: [...] }` 两种形态都接受。
 */

/* ───────────────────────── 工作流 ───────────────────────── */

export type JoinStrategy = 'all' | 'any'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'
export const RUN_STATUSES: RunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped']

/** 群聊讨论节点的成员（同一内核可出现多次；role 是群头衔） */
export interface WorkflowGroupMember {
  agentId: string
  role: string
  instructions: string
  model: string | null
}

export interface WorkflowNode {
  id: string
  name: string
  /** agent：单个内核完成这一步（默认，旧数据没有该字段）；group：多个成员在群里讨论，主管汇总作为输出 */
  kind?: 'agent' | 'group'
  /** 群聊讨论节点的成员 */
  members?: WorkflowGroupMember[]
  /** 群聊讨论节点的主管：'builtin'（默认）/ 成员 id / 'none' */
  supervisorId?: string
  /** 'builtin' | 'kernel-hermes' | 'kernel-claude-code' …（与会话的 agentIds 相同） */
  kernelId: string
  /** 仅 builtin：Provider / 模型覆盖；null = 默认 */
  providerId?: string | null
  model?: string | null
  prompt: string
  joinStrategy: JoinStrategy
  allowWrite: boolean
  skills?: string[]
  position: { x: number; y: number }
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
}

export interface WorkflowViewport {
  x: number
  y: number
  zoom: number
}

export interface Workflow {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport?: WorkflowViewport
  ownerId: string
  createdAt: number
  updatedAt: number
  lastRun?: { id: string; status: RunStatus; startedAt: number } | null
  /** 列表接口可能只给计数 */
  nodeCount?: number
  edgeCount?: number
}

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

export interface WorkflowInput {
  name: string
  description?: string
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

export interface WorkflowPatch {
  name?: string
  description?: string
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
  viewport?: WorkflowViewport
}

function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}
function one<T>(value: unknown, key: string): T {
  if (value && typeof value === 'object' && key in (value as object)) return (value as Record<string, T>)[key]
  return value as T
}

const wf = (id: string): string => `/api/workflows/${encodeURIComponent(id)}`
const runPath = (id: string): string => `/api/workflow-runs/${encodeURIComponent(id)}`

/** 节点数 / 连线数：列表接口给了计数就用计数 */
export function workflowCounts(w: Pick<Workflow, 'nodes' | 'edges' | 'nodeCount' | 'edgeCount'>): {
  nodes: number
  edges: number
} {
  return { nodes: w.nodeCount ?? w.nodes?.length ?? 0, edges: w.edgeCount ?? w.edges?.length ?? 0 }
}

export const workflowsApi = {
  async list(silent = false): Promise<Workflow[]> {
    return list<Workflow>(await request('/api/workflows', { silent }), 'workflows')
  },
  async get(id: string, silent = false): Promise<Workflow> {
    return one<Workflow>(await request(wf(id), { silent }), 'workflow')
  },
  async create(input: WorkflowInput): Promise<Workflow> {
    return one<Workflow>(await request('/api/workflows', { method: 'POST', body: input }), 'workflow')
  },
  /** 400 CYCLE_DETECTED：连线成环；悬空连线 / 未知内核也是 400。silent 时由调用方展示 */
  async update(id: string, patch: WorkflowPatch, silent = false): Promise<Workflow> {
    return one<Workflow>(await request(wf(id), { method: 'PATCH', body: patch, silent }), 'workflow')
  },
  remove(id: string): Promise<void> {
    return request(wf(id), { method: 'DELETE' })
  },
  async duplicate(id: string): Promise<Workflow> {
    return one<Workflow>(await request(`${wf(id)}/duplicate`, { method: 'POST' }), 'workflow')
  },
  /** 导出：服务端返回 JSON 文件内容 */
  exportJson(id: string): Promise<unknown> {
    return request(`${wf(id)}/export`)
  },
  async importJson(json: unknown): Promise<Workflow> {
    return one<Workflow>(await request('/api/workflows/import', { method: 'POST', body: { json } }), 'workflow')
  },
  async run(id: string, input?: string): Promise<WorkflowRun> {
    const body = input ? { input } : {}
    return one<WorkflowRun>(await request(`${wf(id)}/run`, { method: 'POST', body }), 'run')
  },
  async runs(id: string, limit = 20, silent = false): Promise<WorkflowRun[]> {
    return list<WorkflowRun>(await request(`${wf(id)}/runs`, { query: { limit }, silent }), 'runs')
  },
  async getRun(runId: string, silent = false): Promise<WorkflowRun> {
    return one<WorkflowRun>(await request(runPath(runId), { silent }), 'run')
  },
  async cancelRun(runId: string): Promise<WorkflowRun> {
    return one<WorkflowRun>(await request(`${runPath(runId)}/cancel`, { method: 'POST' }), 'run')
  },
}

/* ───────────────────────── 定时任务 ───────────────────────── */

export type ScheduleSpec =
  | { type: 'once'; at: number }
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: number[]; time: string }
  | { type: 'cron'; expr: string }
export type ScheduleSpecType = ScheduleSpec['type']
export const SCHEDULE_SPEC_TYPES: ScheduleSpecType[] = ['once', 'interval', 'daily', 'weekly', 'cron']

export type ScheduleTarget =
  | { type: 'workflow'; workflowId: string; input?: string }
  | {
      type: 'prompt'
      kernelId: string
      prompt: string
      sessionMode: 'new' | 'append'
      sessionId?: string | null
    }

export interface Schedule {
  id: string
  name: string
  target: ScheduleTarget
  spec: ScheduleSpec
  /** IANA 时区 */
  timezone: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: RunStatus | null
  lastError: string | null
  ownerId: string
  createdAt: number
  updatedAt: number
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  status: RunStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
  workflowRunId: string | null
  sessionId: string | null
  /** 补跑：应用关闭期间错过、启动后补的一次（旧服务端没有该字段） */
  missed?: boolean
}

export interface ScheduleInput {
  name: string
  target: ScheduleTarget
  spec: ScheduleSpec
  timezone: string
  enabled: boolean
}

const sc = (id: string): string => `/api/schedules/${encodeURIComponent(id)}`

export const schedulesApi = {
  async list(silent = false): Promise<Schedule[]> {
    return list<Schedule>(await request('/api/schedules', { silent }), 'schedules')
  },
  async get(id: string, silent = false): Promise<Schedule> {
    return one<Schedule>(await request(sc(id), { silent }), 'schedule')
  },
  async create(input: ScheduleInput): Promise<Schedule> {
    return one<Schedule>(await request('/api/schedules', { method: 'POST', body: input, silent: true }), 'schedule')
  },
  async update(id: string, patch: Partial<ScheduleInput>, silent = false): Promise<Schedule> {
    return one<Schedule>(await request(sc(id), { method: 'PATCH', body: patch, silent }), 'schedule')
  },
  remove(id: string): Promise<void> {
    return request(sc(id), { method: 'DELETE' })
  },
  async runNow(id: string): Promise<ScheduleRun> {
    return one<ScheduleRun>(await request(`${sc(id)}/run-now`, { method: 'POST' }), 'run')
  },
  async runs(id: string, limit = 20): Promise<ScheduleRun[]> {
    return list<ScheduleRun>(await request(`${sc(id)}/runs`, { query: { limit } }), 'runs')
  },
  /** 下 5 次触发时间（ms） */
  async preview(spec: ScheduleSpec, timezone: string, signal?: AbortSignal): Promise<number[]> {
    const res = await request<{ next?: number[] }>('/api/schedules/preview', {
      method: 'POST',
      body: { spec, timezone },
      silent: true,
      signal,
    })
    return Array.isArray(res?.next) ? res.next : []
  },
}

/* ───────────────────────── 实时事件 ───────────────────────── */

export interface WorkflowRunEvent {
  type: 'workflow.run'
  runId: string
  workflowId: string
  status: RunStatus
}
export interface WorkflowNodeEvent {
  type: 'workflow.node'
  runId: string
  nodeId: string
  status: RunStatus
  delta?: string
}
export interface ScheduleRunEvent {
  type: 'schedule.run'
  scheduleId: string
  status: RunStatus
}
export type AutomationEvent = WorkflowRunEvent | WorkflowNodeEvent | ScheduleRunEvent
const AUTOMATION_TYPES = new Set(['workflow.run', 'workflow.node', 'schedule.run'])

/**
 * /api/events 上的一条事件 → 工作流 / 定时任务事件。
 * 服务端可能用 SSE 的 event 名（`event: workflow.run`），也可能放在 data.type 里；两种都认。
 */
export function toAutomationEvent(event: { event: string; data: unknown }): AutomationEvent | null {
  const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : null
  if (!data) return null
  const type = typeof data.type === 'string' && AUTOMATION_TYPES.has(data.type) ? data.type : event.event
  if (!AUTOMATION_TYPES.has(type)) return null
  if (typeof data.status !== 'string') return null
  if (type === 'schedule.run')
    return typeof data.scheduleId === 'string' ? ({ ...data, type } as ScheduleRunEvent) : null
  if (typeof data.runId !== 'string') return null
  if (type === 'workflow.node' && typeof data.nodeId !== 'string') return null
  return { ...data, type } as AutomationEvent
}
