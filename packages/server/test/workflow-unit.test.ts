import { describe, expect, it } from 'vitest'
import { DagError, runDag, topologicalOrder, type DagEdge, type DagNode, type NodeResult, type RunStatus } from '../src/services/workflow/dag.js'
import {
  localParts,
  nextFire,
  normalizeSpec,
  parseCron,
  previewFires,
  SpecError,
  zonedToUtc,
  type ScheduleSpec,
} from '../src/services/schedule/schedule-spec.js'

/** 工作流 DAG 执行器与定时规则的纯逻辑单元测试（不启动服务） */

const n = (id: string, joinStrategy: 'all' | 'any' = 'all'): DagNode => ({ id, name: id.toUpperCase(), joinStrategy })
const e = (source: string, target: string): DagEdge => ({ id: `${source}-${target}`, source, target })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('DAG 校验与拓扑序', () => {
  it('拓扑序稳定：同层按声明顺序', () => {
    const nodes = [n('d'), n('a'), n('c'), n('b')]
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]
    expect(topologicalOrder(nodes, edges)).toEqual(['a', 'c', 'b', 'd'])
    expect(topologicalOrder([n('x'), n('y')], [])).toEqual(['x', 'y'])
  })

  it('环 / 自环 → CYCLE_DETECTED（列出环上的节点）', () => {
    const err = (() => {
      try {
        topologicalOrder([n('a'), n('b'), n('c'), n('z')], [e('z', 'a'), e('a', 'b'), e('b', 'c'), e('c', 'a')])
      } catch (error) {
        return error as DagError
      }
    })()!
    expect(err).toBeInstanceOf(DagError)
    expect(err.code).toBe('CYCLE_DETECTED')
    expect(err.detail.nodeIds).toEqual(['a', 'b', 'c'])
    expect(() => topologicalOrder([n('a')], [e('a', 'a')])).toThrow(/自己/)
  })

  it('悬空边 / 重复 id', () => {
    expect(() => topologicalOrder([n('a')], [e('a', 'ghost')])).toThrowError(expect.objectContaining({ code: 'DANGLING_EDGE' }))
    expect(() => topologicalOrder([n('a'), n('a')], [])).toThrowError(expect.objectContaining({ code: 'DUPLICATE_NODE' }))
    expect(() => topologicalOrder([n('a'), n('b')], [e('a', 'b'), { id: 'a-b', source: 'b', target: 'a' }])).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_EDGE' }),
    )
  })
})

type Behaviour = { delay?: number; fail?: boolean; output?: string }

async function run(nodes: DagNode[], edges: DagEdge[], behaviour: Record<string, Behaviour> = {}, options: { concurrency?: number; abortAfter?: number } = {}) {
  const controller = new AbortController()
  const log: Array<[string, RunStatus]> = []
  const inputs = new Map<string, string[]>()
  let active = 0
  let peak = 0
  if (options.abortAfter !== undefined) setTimeout(() => controller.abort(), options.abortAfter)
  const result = await runDag({
    nodes,
    edges,
    concurrency: options.concurrency ?? 2,
    signal: controller.signal,
    onStatus: (id, status) => log.push([id, status]),
    runNode: async (node, upstream, signal): Promise<NodeResult> => {
      active += 1
      peak = Math.max(peak, active)
      inputs.set(node.id, upstream.map((u) => `${u.name}:${u.output}`))
      const b = behaviour[node.id] ?? {}
      try {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, b.delay ?? 5)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            resolve()
          })
        })
        if (signal.aborted) return { status: 'cancelled', output: '', error: 'aborted' }
        if (b.fail) return { status: 'failed', output: '', error: `${node.id} boom` }
        return { status: 'succeeded', output: b.output ?? `out-${node.id}`, error: null }
      } finally {
        active -= 1
      }
    },
  })
  const status = (id: string) => result.nodes.get(id)!.status
  return { result, log, inputs, peak, status }
}

describe('DAG 执行', () => {
  it('join all：等全部上游成功，带上所有上游输出', async () => {
    const r = await run([n('a'), n('b'), n('c')], [e('a', 'c'), e('b', 'c')], { a: { delay: 30 }, b: { delay: 5 } })
    expect(r.result.status).toBe('succeeded')
    expect(r.inputs.get('c')).toEqual(['A:out-a', 'B:out-b'])
    expect(r.inputs.get('a')).toEqual([])
    // c 在 a 完成之后才开始
    const idx = (id: string, s: RunStatus) => r.log.findIndex(([x, y]) => x === id && y === s)
    expect(idx('c', 'running')).toBeGreaterThan(idx('a', 'succeeded'))
  })

  it('join any：第一个成功的上游完成即开始，只带它的输出；慢的上游继续跑完', async () => {
    const r = await run([n('fast'), n('slow'), n('j', 'any')], [e('fast', 'j'), e('slow', 'j')], { fast: { delay: 5 }, slow: { delay: 80 }, j: { delay: 5 } })
    expect(r.result.status).toBe('succeeded')
    expect(r.inputs.get('j')).toEqual(['FAST:out-fast'])
    const idx = (id: string, s: RunStatus) => r.log.findIndex(([x, y]) => x === id && y === s)
    expect(idx('j', 'succeeded')).toBeLessThan(idx('slow', 'succeeded'))
    expect(r.status('slow')).toBe('succeeded')
  })

  it('join any：一个上游失败、另一个成功 → 照常运行；全部失败 → 跳过', async () => {
    const ok = await run([n('a'), n('b'), n('j', 'any')], [e('a', 'j'), e('b', 'j')], { a: { fail: true }, b: { delay: 20 } })
    expect(ok.status('j')).toBe('succeeded')
    expect(ok.inputs.get('j')).toEqual(['B:out-b'])
    expect(ok.result.status).toBe('failed') // 有节点失败，整体记为失败
    const none = await run([n('a'), n('b'), n('j', 'any')], [e('a', 'j'), e('b', 'j')], { a: { fail: true }, b: { fail: true } })
    expect(none.status('j')).toBe('skipped')
  })

  it('上游失败 → 下游（all）跳过，跳过向下传递；无关分支照常完成', async () => {
    const r = await run([n('a'), n('b'), n('c'), n('x')], [e('a', 'b'), e('b', 'c')], { a: { fail: true } })
    expect(r.status('a')).toBe('failed')
    expect(r.status('b')).toBe('skipped')
    expect(r.status('c')).toBe('skipped')
    expect(r.status('x')).toBe('succeeded')
    expect(r.result.status).toBe('failed')
    expect(r.result.nodes.get('a')!.error).toBe('a boom')
  })

  it('并发上限 2', async () => {
    const r = await run([n('a'), n('b'), n('c'), n('d'), n('e')], [], { a: { delay: 20 }, b: { delay: 20 }, c: { delay: 20 }, d: { delay: 20 }, e: { delay: 20 } })
    expect(r.peak).toBe(2)
    expect(r.result.status).toBe('succeeded')
    const one = await run([n('a'), n('b'), n('c')], [], {}, { concurrency: 1 })
    expect(one.peak).toBe(1)
  })

  it('取消：运行中的节点被中止，未开始的记为 cancelled', async () => {
    const r = await run([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')], { a: { delay: 5000 } }, { abortAfter: 20 })
    expect(r.result.status).toBe('cancelled')
    expect(r.status('a')).toBe('cancelled')
    expect(r.status('b')).toBe('cancelled')
    expect(r.status('c')).toBe('cancelled')
  })

  it('全局闸门 acquire：被取消时等待中的节点不会运行', async () => {
    const controller = new AbortController()
    let ran = 0
    const p = runDag({
      nodes: [n('a')],
      edges: [],
      concurrency: 2,
      signal: controller.signal,
      acquire: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      runNode: async () => {
        ran += 1
        return { status: 'succeeded', output: '', error: null }
      },
    })
    await sleep(10)
    controller.abort()
    const result = await p
    expect(ran).toBe(0)
    expect(result.status).toBe('cancelled')
    expect(result.nodes.get('a')!.status).toBe('cancelled')
  })
})

// ── 定时规则 ─────────────────────────────────────────────

const NY = 'America/New_York'
const SH = 'Asia/Shanghai'
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

describe('时区换算', () => {
  it('zonedToUtc：普通时间、夏令时空档顺延、重复时间取第一次', () => {
    expect(iso(zonedToUtc(2026, 7, 1, 9, 0, NY))).toBe('2026-07-01T13:00:00.000Z') // EDT -4
    expect(iso(zonedToUtc(2026, 1, 15, 9, 0, NY))).toBe('2026-01-15T14:00:00.000Z') // EST -5
    expect(iso(zonedToUtc(2026, 7, 1, 9, 0, SH))).toBe('2026-07-01T01:00:00.000Z')
    // 2026-03-08 02:30 在纽约不存在 → 03:30 EDT = 07:30Z
    expect(iso(zonedToUtc(2026, 3, 8, 2, 30, NY))).toBe('2026-03-08T07:30:00.000Z')
    // 2026-11-01 01:30 出现两次（EDT 05:30Z / EST 06:30Z）→ 取第一次
    expect(iso(zonedToUtc(2026, 11, 1, 1, 30, NY))).toBe('2026-11-01T05:30:00.000Z')
    expect(localParts(Date.parse('2026-03-08T07:30:00Z'), NY)).toMatchObject({ hour: 3, minute: 30 })
  })
})

describe('下一次触发', () => {
  it('daily 跨春季夏令时（纽约）保持本地 09:00；上海无夏令时', () => {
    const spec: ScheduleSpec = { type: 'daily', time: '09:00' }
    const fires = previewFires(spec, NY, Date.parse('2026-03-06T12:00:00Z'), 4)
    expect(fires.map(iso)).toEqual(['2026-03-06T14:00:00.000Z', '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z'])
    const sh = previewFires(spec, SH, Date.parse('2026-10-21T02:00:00Z'), 2)
    expect(sh.map(iso)).toEqual(['2026-10-22T01:00:00.000Z', '2026-10-23T01:00:00.000Z'])
    // 当天还没到 → 今天
    expect(iso(nextFire(spec, SH, Date.parse('2026-10-21T00:30:00Z')))).toBe('2026-10-21T01:00:00.000Z')
  })

  it('daily 落在空档 / 重复时段（纽约 02:30 / 01:30）', () => {
    expect(iso(nextFire({ type: 'daily', time: '02:30' }, NY, Date.parse('2026-03-08T05:00:00Z')))).toBe('2026-03-08T07:30:00.000Z')
    const fall = previewFires({ type: 'daily', time: '01:30' }, NY, Date.parse('2026-10-31T12:00:00Z'), 2)
    expect(fall.map(iso)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']) // 只触发一次
  })

  it('weekly：周一 / 周五 18:00，跨秋季夏令时', () => {
    const spec: ScheduleSpec = { type: 'weekly', days: [1, 5], time: '18:00' }
    const fires = previewFires(spec, NY, Date.parse('2026-10-28T00:00:00Z'), 4) // 周二晚（纽约）
    expect(fires.map(iso)).toEqual([
      '2026-10-30T22:00:00.000Z', // 周五 EDT
      '2026-11-02T23:00:00.000Z', // 周一 EST
      '2026-11-06T23:00:00.000Z',
      '2026-11-09T23:00:00.000Z',
    ])
    const sh = nextFire({ type: 'weekly', days: [0], time: '08:00' }, SH, Date.parse('2026-10-21T03:00:00Z')) // 周三
    expect(iso(sh)).toBe('2026-10-25T00:00:00.000Z')
  })

  it('cron：工作日 9:30（纽约，跨夏令时）、*/15、日或星期（Vixie 规则）、宏与名称', () => {
    const weekdays = previewFires({ type: 'cron', expr: '30 9 * * 1-5' }, NY, Date.parse('2026-03-06T15:00:00Z'), 3)
    expect(weekdays.map(iso)).toEqual(['2026-03-09T13:30:00.000Z', '2026-03-10T13:30:00.000Z', '2026-03-11T13:30:00.000Z'])
    const quarter = previewFires({ type: 'cron', expr: '*/15 * * * *' }, SH, Date.parse('2026-10-21T03:07:00Z'), 3)
    expect(quarter.map(iso)).toEqual(['2026-10-21T03:15:00.000Z', '2026-10-21T03:30:00.000Z', '2026-10-21T03:45:00.000Z'])
    // 每月 1 号或每个周日的 0 点（上海）
    const either = previewFires({ type: 'cron', expr: '0 0 1 * SUN' }, SH, Date.parse('2026-10-21T00:00:00Z'), 3)
    expect(either.map(iso)).toEqual(['2026-10-24T16:00:00.000Z', '2026-10-31T16:00:00.000Z', '2026-11-07T16:00:00.000Z'])
    expect(iso(nextFire({ type: 'cron', expr: '@daily' }, SH, Date.parse('2026-10-21T03:00:00Z')))).toBe('2026-10-21T16:00:00.000Z')
    expect(iso(nextFire({ type: 'cron', expr: '0 12 * JAN,feb 7' }, SH, Date.parse('2026-10-21T00:00:00Z')))).toBe('2027-01-03T04:00:00.000Z')
    // 春季空档：每天 02:30 → 03:30 EDT
    expect(iso(nextFire({ type: 'cron', expr: '30 2 * * *' }, NY, Date.parse('2026-03-08T05:00:00Z')))).toBe('2026-03-08T07:30:00.000Z')
    // 2 月 29 日（跨年查找）
    expect(iso(nextFire({ type: 'cron', expr: '0 0 29 2 *' }, 'UTC', Date.parse('2026-10-21T00:00:00Z')))).toBe('2028-02-29T00:00:00.000Z')
    expect(nextFire({ type: 'cron', expr: '0 0 30 2 *' }, 'UTC', Date.parse('2026-10-21T00:00:00Z'))).toBeNull()
  })

  it('cron 解析错误', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(SpecError)
    }
    expect(parseCron('0 0 * * 7').weekdays.has(0)).toBe(true)
  })

  it('interval 按锚点对齐；once；规范化校验', () => {
    const anchor = Date.parse('2026-10-21T00:00:00Z')
    expect(iso(nextFire({ type: 'interval', minutes: 30 }, SH, anchor + 45 * 60_000, anchor))).toBe('2026-10-21T01:00:00.000Z')
    expect(iso(nextFire({ type: 'interval', minutes: 30 }, SH, anchor, anchor))).toBe('2026-10-21T00:30:00.000Z')
    expect(nextFire({ type: 'once', at: anchor }, SH, anchor + 1)).toBeNull()
    expect(nextFire({ type: 'once', at: anchor }, SH, anchor - 1)).toBe(anchor)
    expect(() => normalizeSpec({ type: 'interval', minutes: 4 })).toThrow(/至少 5/)
    expect(() => normalizeSpec({ type: 'daily', time: '25:00' })).toThrow(SpecError)
    expect(() => normalizeSpec({ type: 'weekly', days: [], time: '09:00' })).toThrow(SpecError)
    expect(() => normalizeSpec({ type: 'weekly', days: [7], time: '09:00' })).toThrow(SpecError)
    expect(normalizeSpec({ type: 'weekly', days: [5, 1, 1], time: '9:05' })).toEqual({ type: 'weekly', days: [1, 5], time: '09:05' })
    expect(normalizeSpec({ type: 'cron', expr: '  0   9 * * 1 ' })).toEqual({ type: 'cron', expr: '0 9 * * 1' })
  })
})
