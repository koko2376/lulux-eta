import { describe, expect, it } from 'vitest'
import type { WorkflowRun } from '../api/workflows'
import {
  applyNodeEvent,
  decodeModel,
  encodeModel,
  formatDuration,
  hasEdge,
  newNode,
  snapshot,
  wouldCreateCycle,
} from './workflow'

describe('工作流画布纯函数', () => {
  it('连线成环检查：自环、直接回边、间接回边', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true)
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true)
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true)
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false)
    expect(wouldCreateCycle(edges, 'c', 'd')).toBe(false)
    expect(hasEdge([{ id: 'e', source: 'a', target: 'b' }], 'a', 'b')).toBe(true)
  })

  it('新节点：默认 LULUX 内核、全部入口、不允许写；名称取未用过的最小编号', () => {
    const n1 = newNode([], { x: 1, y: 2 })
    expect(n1).toMatchObject({
      name: '节点 1',
      kernelId: 'builtin',
      joinStrategy: 'all',
      allowWrite: false,
      prompt: '',
    })
    const n3 = newNode([n1, { ...n1, id: 'x', name: '节点 2' }], { x: 0, y: 0 })
    expect(n3.name).toBe('节点 3')
    const gap = newNode([{ ...n1, name: '节点 2' }], { x: 0, y: 0 })
    expect(gap.name).toBe('节点 1')
  })

  it('模型选项编码', () => {
    expect(encodeModel(null, null)).toBe('')
    expect(encodeModel('p1', 'gpt-4o')).toBe('p1::gpt-4o')
    expect(decodeModel('p1::gpt-4o')).toEqual({ providerId: 'p1', model: 'gpt-4o' })
    expect(decodeModel('')).toEqual({ providerId: null, model: null })
  })

  it('workflow.node 事件合并到运行记录：状态更新、delta 追加、结束时间', () => {
    const run: WorkflowRun = {
      id: 'r',
      workflowId: 'w',
      trigger: 'manual',
      scheduleId: null,
      status: 'running',
      input: '',
      startedAt: 1,
      finishedAt: null,
      error: null,
      nodes: [
        { nodeId: 'n1', status: 'queued', output: '', error: null, sessionId: null, startedAt: null, finishedAt: null },
      ],
    }
    let r = applyNodeEvent(run, { nodeId: 'n1', status: 'running', delta: '你好' }, 100)
    r = applyNodeEvent(r, { nodeId: 'n1', status: 'running', delta: '，世界' }, 150)
    expect(r.nodes[0]).toMatchObject({ status: 'running', output: '你好，世界', startedAt: 100, finishedAt: null })
    r = applyNodeEvent(r, { nodeId: 'n1', status: 'succeeded' }, 200)
    expect(r.nodes[0]).toMatchObject({ status: 'succeeded', finishedAt: 200 })
    r = applyNodeEvent(r, { nodeId: 'n2', status: 'skipped' }, 300)
    expect(r.nodes[1]).toMatchObject({ nodeId: 'n2', status: 'skipped' })
    expect(run.nodes[0].output).toBe('')
  })

  it('耗时与修改快照', () => {
    expect(formatDuration(0, 1000)).toBe('—')
    expect(formatDuration(1000, 13_000)).toBe('12 秒')
    expect(formatDuration(1000, 1000 + 184_000)).toBe('3 分 4 秒')
    const n = newNode([], { x: 10.4, y: 20.6 })
    const a = snapshot({ name: 'w', nodes: [n], edges: [] })
    expect(snapshot({ name: 'w', nodes: [{ ...n, position: { x: 10, y: 21 } }], edges: [] })).toBe(a)
    expect(snapshot({ name: 'w', nodes: [{ ...n, prompt: 'x' }], edges: [] })).not.toBe(a)
  })
})
