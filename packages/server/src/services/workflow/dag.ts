/**
 * 工作流 DAG：结构校验（悬空边、环）、拓扑序，以及与内核无关的执行器（汇合策略、上游失败跳过、并发上限、取消）。
 * 纯逻辑，runner 注入“运行一个节点”的实现；单元测试直接驱动它。
 */

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export interface DagNode {
  id: string
  name: string
  joinStrategy: 'all' | 'any'
}

export interface DagEdge {
  id: string
  source: string
  target: string
}

export class DagError extends Error {
  constructor(
    readonly code: 'CYCLE_DETECTED' | 'DANGLING_EDGE' | 'DUPLICATE_NODE' | 'DUPLICATE_EDGE',
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** 结构校验 + 拓扑序（Kahn；同层按节点声明顺序，结果稳定）。有环 / 悬空边 / 重复 id 抛 DagError */
export function topologicalOrder(nodes: DagNode[], edges: DagEdge[]): string[] {
  const index = new Map<string, number>()
  nodes.forEach((node, i) => {
    if (index.has(node.id)) throw new DagError('DUPLICATE_NODE', `节点 id 重复：${node.id}`, { nodeId: node.id })
    index.set(node.id, i)
  })
  const edgeIds = new Set<string>()
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const out = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new DagError('DUPLICATE_EDGE', `连线 id 重复：${edge.id}`, { edgeId: edge.id })
    edgeIds.add(edge.id)
    if (!index.has(edge.source) || !index.has(edge.target)) {
      throw new DagError('DANGLING_EDGE', `连线 ${edge.id} 指向不存在的节点`, { edgeId: edge.id })
    }
    if (edge.source === edge.target) {
      throw new DagError('CYCLE_DETECTED', `节点「${nameOf(nodes, edge.source)}」连向了自己`, { nodeIds: [edge.source] })
    }
    out.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
  }
  const byDeclared = (a: string, b: string): number => index.get(a)! - index.get(b)!
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const order: string[] = []
  while (ready.length > 0) {
    ready.sort(byDeclared)
    const id = ready.shift()!
    order.push(id)
    for (const target of out.get(id)!) {
      const left = indegree.get(target)! - 1
      indegree.set(target, left)
      if (left === 0) ready.push(target)
    }
  }
  if (order.length !== nodes.length) {
    const inCycle = nodes.filter((node) => indegree.get(node.id)! > 0).map((node) => node.id)
    throw new DagError('CYCLE_DETECTED', `连线形成了环：${inCycle.map((id) => nameOf(nodes, id)).join('、')}`, { nodeIds: inCycle })
  }
  return order
}

function nameOf(nodes: DagNode[], id: string): string {
  return nodes.find((node) => node.id === id)?.name || id
}

export interface UpstreamOutput {
  nodeId: string
  name: string
  output: string
}

export interface NodeResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  output: string
  error: string | null
}

export interface DagRunOptions<N extends DagNode> {
  nodes: N[]
  edges: DagEdge[]
  /** 同时运行的节点数上限 */
  concurrency: number
  signal: AbortSignal
  /** 运行一个节点；roots 的 upstream 为空 */
  runNode(node: N, upstream: UpstreamOutput[], signal: AbortSignal): Promise<NodeResult>
  /** 节点状态变化（queued 之外的每次变化都会调用） */
  onStatus?(nodeId: string, status: RunStatus, result?: { output?: string; error?: string | null }): void
  /** 可选：全局并发闸门（多次运行共享）。返回释放函数 */
  acquire?(signal: AbortSignal): Promise<() => void>
}

export interface DagRunResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  nodes: Map<string, { status: RunStatus; output: string; error: string | null }>
}

/**
 * 执行：
 * - all：全部上游成功才开始；任一上游失败 / 跳过 / 取消 → 跳过；
 * - any：第一个成功的上游完成即开始（只带它的输出）；全部上游都结束且无成功 → 跳过；
 * - 取消：运行中的节点收到 abort，尚未开始的节点记为 cancelled；
 * - 运行结果：取消 > 任一节点失败 → failed > succeeded。
 */
export async function runDag<N extends DagNode>(options: DagRunOptions<N>): Promise<DagRunResult> {
  const { nodes, edges, signal } = options
  const order = topologicalOrder(nodes, edges)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const upstreamOf = new Map<string, string[]>(nodes.map((node) => [node.id, []]))
  for (const edge of edges) upstreamOf.get(edge.target)!.push(edge.source)
  const state = new Map<string, { status: RunStatus; output: string; error: string | null; firstSuccess?: string }>(
    nodes.map((node) => [node.id, { status: 'queued', output: '', error: null }]),
  )
  const concurrency = Math.max(1, options.concurrency)
  const terminal = (s: RunStatus): boolean => s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'skipped'
  const set = (id: string, status: RunStatus, extra: { output?: string; error?: string | null } = {}): void => {
    const entry = state.get(id)!
    entry.status = status
    if (extra.output !== undefined) entry.output = extra.output
    if (extra.error !== undefined) entry.error = extra.error
    options.onStatus?.(id, status, extra)
  }

  let running = 0
  const started = new Set<string>()
  const scheduled = new Set<string>() // 已判定可以运行、等待并发槽位
  return await new Promise<DagRunResult>((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      const statuses = [...state.values()].map((entry) => entry.status)
      const status = signal.aborted ? 'cancelled' : statuses.includes('failed') ? 'failed' : 'succeeded'
      resolve({ status, nodes: new Map([...state].map(([id, entry]) => [id, { status: entry.status, output: entry.output, error: entry.error }])) })
    }

    /** 判定还在等待的节点：可以运行 / 应当跳过 / 继续等 */
    const evaluate = (): void => {
      let changed = true
      while (changed) {
        changed = false
        for (const id of order) {
          const entry = state.get(id)!
          if (entry.status !== 'queued' || scheduled.has(id)) continue
          const node = byId.get(id)!
          const ups = upstreamOf.get(id)!
          if (ups.length === 0) {
            scheduled.add(id)
            continue
          }
          const upStates = ups.map((u) => state.get(u)!.status)
          if (node.joinStrategy === 'any') {
            const firstSuccess = entry.firstSuccess ?? null
            if (firstSuccess) scheduled.add(id)
            else if (upStates.every(terminal)) {
              set(id, 'skipped', { error: '上游没有成功的节点' })
              changed = true
            }
          } else if (upStates.every((s) => s === 'succeeded')) {
            scheduled.add(id)
          } else if (upStates.some((s) => s === 'failed' || s === 'skipped' || s === 'cancelled')) {
            set(id, 'skipped', { error: '上游节点未成功' })
            changed = true
          }
        }
      }
    }

    const pump = (): void => {
      if (finished) return
      if (signal.aborted) {
        for (const id of order) {
          const entry = state.get(id)!
          if (entry.status === 'queued') set(id, 'cancelled', { error: '运行已取消' })
        }
        if (running === 0) finish()
        return
      }
      evaluate()
      for (const id of order) {
        if (running >= concurrency) break
        if (!scheduled.has(id) || started.has(id)) continue
        started.add(id)
        running += 1
        void launch(byId.get(id)!)
      }
      if (running === 0 && [...state.values()].every((entry) => terminal(entry.status))) finish()
      else if (running === 0 && [...scheduled].every((id) => started.has(id))) {
        // 没有可运行的节点但仍有排队节点（不应发生：校验保证无环）→ 跳过剩余节点
        for (const id of order) if (state.get(id)!.status === 'queued') set(id, 'skipped', { error: '无法满足汇合条件' })
        finish()
      }
    }

    const launch = async (node: N): Promise<void> => {
      let release: (() => void) | null = null
      try {
        if (options.acquire) {
          try {
            release = await options.acquire(signal)
          } catch {
            release = null
          }
        }
        if (signal.aborted || (options.acquire && !release)) {
          set(node.id, 'cancelled', { error: '运行已取消' })
          return
        }
        const entry = state.get(node.id)!
        const ups = upstreamOf.get(node.id)!
        const sources = node.joinStrategy === 'any' && entry.firstSuccess ? [entry.firstSuccess] : ups
        const upstream: UpstreamOutput[] = sources.map((u) => ({ nodeId: u, name: byId.get(u)!.name, output: state.get(u)!.output }))
        set(node.id, 'running')
        let result: NodeResult
        try {
          result = await options.runNode(node, upstream, signal)
        } catch (error) {
          result = { status: signal.aborted ? 'cancelled' : 'failed', output: '', error: error instanceof Error ? error.message : String(error) }
        }
        if (signal.aborted && result.status !== 'succeeded') result = { ...result, status: 'cancelled', error: result.error ?? '运行已取消' }
        set(node.id, result.status, { output: result.output, error: result.error })
        if (result.status === 'succeeded') {
          for (const edge of edges) {
            if (edge.source !== node.id) continue
            const target = state.get(edge.target)!
            if (target.firstSuccess === undefined) target.firstSuccess = node.id
          }
        }
      } finally {
        release?.()
        running -= 1
        pump()
      }
    }

    const onAbort = (): void => pump()
    signal.addEventListener('abort', onAbort, { once: true })
    pump()
  })
}
