import type { RunStatus, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun } from '../api/workflows'
import { t } from '../i18n'

/** 工作流画布的纯函数：新节点、连线成环检查、运行状态文案、模型选项编码 */

export function uid(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${prefix}_${rand}`
}

/** 新节点：名称“节点 N”（N 取未用过的最小编号），内核默认 LULUX */
export function newNode(existing: WorkflowNode[], position: { x: number; y: number }): WorkflowNode {
  const used = new Set(existing.map((n) => n.name))
  let i = existing.length + 1
  for (let k = 1; k <= existing.length + 1; k++) {
    if (!used.has(t('workflow.nodeName', [k]))) {
      i = k
      break
    }
  }
  return {
    id: uid('node'),
    name: t('workflow.nodeName', [i]),
    kernelId: 'builtin',
    providerId: null,
    model: null,
    prompt: '',
    joinStrategy: 'all',
    allowWrite: false,
    position,
  }
}

/** 加一条 source → target 的连线后是否成环（含自环） */
export function wouldCreateCycle(
  edges: Pick<WorkflowEdge, 'source' | 'target'>[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true
  // 从 target 出发沿现有连线能走到 source 就成环
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target])
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(out.get(cur) ?? []))
  }
  return false
}

export function hasEdge(edges: WorkflowEdge[], source: string, target: string): boolean {
  return edges.some((e) => e.source === source && e.target === target)
}

/** 新建工作流时的空白内容：一个节点 */
export function blankWorkflow(name: string): { name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return { name, nodes: [newNode([], { x: 80, y: 120 })], edges: [] }
}

export function statusLabel(status: RunStatus | null | undefined): string {
  return status ? t(`workflow.st_${status}`) : t('workflow.st_idle')
}

export function isActive(status: RunStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

/** builtin 的模型选项：'' = 默认；'providerId::model' */
export function encodeModel(providerId: string | null | undefined, model: string | null | undefined): string {
  return providerId ? `${providerId}::${model ?? ''}` : ''
}
export function decodeModel(value: string): { providerId: string | null; model: string | null } {
  if (!value) return { providerId: null, model: null }
  const i = value.indexOf('::')
  if (i < 0) return { providerId: value, model: null }
  return { providerId: value.slice(0, i), model: value.slice(i + 2) || null }
}

/** 2026-10-21 09:05（本机时区） */
export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 运行耗时：12 秒 / 3 分 4 秒 */
export function formatDuration(start: number | null, end: number | null, now = Date.now()): string {
  if (!start) return '—'
  const s = Math.max(0, Math.round(((end ?? now) - start) / 1000))
  if (s < 60) return t('workflow.durS', [s])
  const m = Math.floor(s / 60)
  if (m < 60) return t('workflow.durMS', [m, s % 60])
  return t('workflow.durHM', [Math.floor(m / 60), m % 60])
}

/** 把一条 workflow.node 事件合到运行记录上（delta 追加到输出） */
export function applyNodeEvent(
  run: WorkflowRun,
  ev: { nodeId: string; status: RunStatus; delta?: string },
  now = Date.now(),
): WorkflowRun {
  const nodes = [...run.nodes]
  const i = nodes.findIndex((n) => n.nodeId === ev.nodeId)
  const prev =
    i >= 0
      ? nodes[i]
      : {
          nodeId: ev.nodeId,
          status: 'queued' as RunStatus,
          output: '',
          error: null,
          sessionId: null,
          startedAt: null,
          finishedAt: null,
        }
  const next = {
    ...prev,
    status: ev.status,
    output: ev.delta ? prev.output + ev.delta : prev.output,
    startedAt: prev.startedAt ?? (ev.status === 'running' ? now : null),
    finishedAt: isActive(ev.status) ? null : (prev.finishedAt ?? now),
  }
  if (i >= 0) nodes[i] = next
  else nodes.push(next)
  return { ...run, nodes }
}

/** 拿来比较“是否有未保存修改”的快照（不含视口） */
export function snapshot(w: Pick<Workflow, 'name' | 'nodes' | 'edges'>): string {
  return JSON.stringify({
    name: w.name,
    nodes: w.nodes.map((n) => ({ ...n, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: w.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  })
}
