import { z } from 'zod'
import { canonicalAgentId } from '../../agents.js'
import { db } from '../../db.js'
import { currentActor } from '../../context.js'
import { AppError, notFound } from '../../errors.js'
import { assertOwnRow, isOwnRow, requirePermission, ownerOnlyClause, type OwnedRow, type Visibility } from '../../security/access.js'
import { newId } from '../../utils/id.js'
import { parse } from '../../validation.js'
import { isKnownAgentId } from '../agent-service.js'
import { providerService } from '../provider-service.js'
import { DagError, topologicalOrder, type RunStatus } from './dag.js'

/**
 * 工作流（多 Agent DAG）的存储与校验。契约见 docs/API-CONTRACT.md「工作流」一节。
 * 仅本人（契约 §5.6a）：工作流只有负责人自己可见、可改、可运行；admin/owner 也看不到别人的，
 * 不支持 team / org 共享（visibility 只接受 'private'）。
 */

export const MAX_NODES = 100
export const MAX_EDGES = 500

export interface WorkflowNode {
  id: string
  name: string
  kernelId: string
  providerId: string | null
  model: string | null
  prompt: string
  joinStrategy: 'all' | 'any'
  allowWrite: boolean
  skills: string[]
  position: { x: number; y: number }
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
}

export interface Viewport {
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
  viewport: Viewport | null
  nodeCount: number
  edgeCount: number
  ownerId: string
  visibility: Visibility
  teamId: string | null
  createdAt: number
  updatedAt: number
  lastRun: { id: string; status: RunStatus; startedAt: number } | null
}

export interface WorkflowRow extends OwnedRow {
  id: string
  name: string
  description: string
  nodes: string
  edges: string
  viewport: string | null
  visibility: string
  team_id: string | null
  created_at: number
  updated_at: number
}

const idText = z.string().trim().min(1).max(80)
const finite = z.number().finite()

const nodeInput = z
  .object({
    id: idText,
    name: z.string().trim().min(1, '节点名称不能为空').max(100),
    kernelId: z.string().trim().min(1).max(80),
    providerId: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().max(20_000).default(''),
    joinStrategy: z.enum(['all', 'any']).default('all'),
    allowWrite: z.boolean().default(false),
    skills: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    position: z.object({ x: finite, y: finite }).optional(),
  })
  .passthrough()

const edgeInput = z.object({ id: idText, source: idText, target: idText }).passthrough()
const viewportInput = z.object({ x: finite, y: finite, zoom: finite.positive() })

export const workflowCreateInput = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(120),
    description: z.string().max(2000).default(''),
    nodes: z.array(nodeInput).max(MAX_NODES, `节点最多 ${MAX_NODES} 个`).default([]),
    edges: z.array(edgeInput).max(MAX_EDGES, `连线最多 ${MAX_EDGES} 条`).default([]),
    viewport: viewportInput.nullable().optional(),
    visibility: z.literal('private', { message: '仅本人可见，不支持共享（team / org）' }).optional(),
    teamId: z.null().optional(),
  })
  .strip()

export const workflowPatchInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    nodes: z.array(nodeInput).max(MAX_NODES, `节点最多 ${MAX_NODES} 个`),
    edges: z.array(edgeInput).max(MAX_EDGES, `连线最多 ${MAX_EDGES} 条`),
    viewport: viewportInput.nullable(),
    visibility: z.literal('private', { message: '仅本人可见，不支持共享（team / org）' }),
    teamId: z.null(),
  })
  .partial()
  .strip()

type NodeInput = z.infer<typeof nodeInput>
type EdgeInput = z.infer<typeof edgeInput>

/** 节点/连线的业务校验：已知内核、Provider 存在、无悬空边、无环。返回规范化后的图 */
export function validateGraph(rawNodes: NodeInput[], rawEdges: EdgeInput[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = rawNodes.map((node) => {
    const kernelId = canonicalAgentId(node.kernelId)
    if (!isKnownAgentId(kernelId)) {
      throw new AppError(400, 'UNKNOWN_KERNEL', `节点「${node.name}」的内核不存在：${node.kernelId}`)
    }
    const builtin = kernelId === 'builtin'
    const providerId = builtin ? (node.providerId || null) : null
    if (providerId && !providerService.get(providerId)) {
      throw new AppError(400, 'UNKNOWN_PROVIDER', `节点「${node.name}」的 Provider 不存在：${providerId}`)
    }
    return {
      id: node.id,
      name: node.name,
      kernelId,
      providerId,
      model: builtin ? (node.model || null) : null,
      prompt: node.prompt,
      joinStrategy: node.joinStrategy,
      allowWrite: node.allowWrite,
      skills: [...new Set(node.skills ?? [])],
      position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
    }
  })
  // 同一对节点之间的重复连线合并为一条
  const seenPairs = new Set<string>()
  const edges: WorkflowEdge[] = []
  for (const edge of rawEdges) {
    const pair = `${edge.source}\u0000${edge.target}`
    if (seenPairs.has(pair)) continue
    seenPairs.add(pair)
    edges.push({ id: edge.id, source: edge.source, target: edge.target })
  }
  try {
    topologicalOrder(nodes, edges)
  } catch (error) {
    if (error instanceof DagError) {
      const code = error.code === 'DUPLICATE_NODE' || error.code === 'DUPLICATE_EDGE' ? 'VALIDATION_ERROR' : error.code
      throw new AppError(400, code, error.message)
    }
    throw error
  }
  return { nodes, edges }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function lastRunOf(workflowId: string): Workflow['lastRun'] {
  const row = db
    .prepare('SELECT id, status, started_at FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(workflowId) as unknown as { id: string; status: string; started_at: number } | undefined
  return row ? { id: row.id, status: row.status as RunStatus, startedAt: row.started_at } : null
}

export function toWorkflow(row: WorkflowRow): Workflow {
  const nodes = parseJson<WorkflowNode[]>(row.nodes, [])
  const edges = parseJson<WorkflowEdge[]>(row.edges, [])
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes,
    edges,
    viewport: parseJson<Viewport | null>(row.viewport, null),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    ownerId: row.owner_id,
    visibility: (row.visibility as Visibility) ?? 'private',
    teamId: row.team_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: lastRunOf(row.id),
  }
}

export function workflowRow(id: string): WorkflowRow | undefined {
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as unknown as WorkflowRow | undefined
}

/** 可见的工作流行；不可见按不存在处理（不泄露存在性） */
export function visibleWorkflowRow(id: string): WorkflowRow {
  const row = workflowRow(id)
  if (!row || !isOwnRow(row)) throw notFound('工作流')
  return row
}

export const EXPORT_FORMAT = 'lulux-workflow'

const importInput = z.object({ json: z.union([z.string().max(5_000_000), z.record(z.string(), z.unknown())]) })

export const workflowService = {
  list(): Workflow[] {
    const scope = ownerOnlyClause('w')
    const rows = db
      .prepare(`SELECT w.* FROM workflows w WHERE ${scope.sql} ORDER BY w.updated_at DESC`)
      .all(...scope.params) as unknown as WorkflowRow[]
    return rows.map(toWorkflow)
  },

  get(id: string): Workflow {
    return toWorkflow(visibleWorkflowRow(id))
  },

  create(input: unknown): Workflow {
    requirePermission('workflow:manage')
    const data = parse(workflowCreateInput, input)
    const graph = validateGraph(data.nodes, data.edges)
    const actor = currentActor()
    const owner = { orgId: actor.orgId, ownerId: actor.id, visibility: 'private' as const, teamId: null }
    const now = Date.now()
    const id = newId('wf')
    db.prepare(
      `INSERT INTO workflows (id, name, description, nodes, edges, viewport, org_id, owner_id, visibility, team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.name,
      data.description,
      JSON.stringify(graph.nodes),
      JSON.stringify(graph.edges),
      data.viewport ? JSON.stringify(data.viewport) : null,
      owner.orgId,
      owner.ownerId,
      owner.visibility,
      owner.teamId,
      now,
      now,
    )
    return workflowService.get(id)
  },

  update(id: string, input: unknown): Workflow {
    requirePermission('workflow:manage')
    const patch = parse(workflowPatchInput, input)
    const row = visibleWorkflowRow(id)
    assertOwnRow(row, '工作流')
    const current = toWorkflow(row)
    const graph =
      patch.nodes !== undefined || patch.edges !== undefined
        ? validateGraph((patch.nodes ?? current.nodes) as NodeInput[], (patch.edges ?? current.edges) as EdgeInput[])
        : { nodes: current.nodes, edges: current.edges }
    const visibility = 'private'
    const teamId = null
    db.prepare(
      `UPDATE workflows SET name = ?, description = ?, nodes = ?, edges = ?, viewport = ?, visibility = ?, team_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.name ?? row.name,
      patch.description ?? row.description,
      JSON.stringify(graph.nodes),
      JSON.stringify(graph.edges),
      patch.viewport !== undefined ? (patch.viewport ? JSON.stringify(patch.viewport) : null) : row.viewport,
      visibility,
      teamId,
      Date.now(),
      id,
    )
    return workflowService.get(id)
  },

  /** 删除工作流；运行记录级联删除，节点的隐藏会话一并删除（由调用方传入删除函数，避免循环依赖） */
  remove(id: string, removeSession: (sessionId: string) => void): void {
    requirePermission('workflow:manage')
    const row = visibleWorkflowRow(id)
    assertOwnRow(row, '工作流')
    const sessions = db
      .prepare(
        `SELECT n.session_id AS id FROM workflow_run_nodes n JOIN workflow_runs r ON r.id = n.run_id
         WHERE r.workflow_id = ? AND n.session_id IS NOT NULL`,
      )
      .all(id) as Array<{ id: string }>
    db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
    for (const session of sessions) removeSession(session.id)
  },

  duplicate(id: string): Workflow {
    const source = workflowService.get(id)
    return workflowService.create({
      name: `${source.name} 副本`.slice(0, 120),
      description: source.description,
      nodes: source.nodes,
      edges: source.edges,
      viewport: source.viewport,
    })
  },

  export(id: string): Record<string, unknown> {
    const wf = workflowService.get(id)
    return {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      name: wf.name,
      description: wf.description,
      nodes: wf.nodes,
      edges: wf.edges,
      viewport: wf.viewport,
    }
  },

  import(input: unknown): Workflow {
    const { json } = parse(importInput, input)
    let data: unknown = json
    if (typeof json === 'string') {
      try {
        data = JSON.parse(json)
      } catch {
        throw new AppError(400, 'INVALID_IMPORT', '导入内容不是合法的 JSON')
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError(400, 'INVALID_IMPORT', '导入内容不是工作流')
    const record = data as Record<string, unknown>
    if (record.format !== undefined && record.format !== EXPORT_FORMAT) {
      throw new AppError(400, 'INVALID_IMPORT', `不支持的导入格式：${String(record.format)}`)
    }
    return workflowService.create({
      name: typeof record.name === 'string' && record.name.trim() ? record.name : '导入的工作流',
      description: typeof record.description === 'string' ? record.description : '',
      nodes: Array.isArray(record.nodes) ? record.nodes : [],
      edges: Array.isArray(record.edges) ? record.edges : [],
      viewport: record.viewport ?? null,
    })
  },
}
