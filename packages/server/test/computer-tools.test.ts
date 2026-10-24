import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

/**
 * 电脑操作工具层（docs/computer-use.md「服务端（工具层）」）：
 * - 出现条件：computerUse='1' 且 IPC 通道可用；调用时还要求本会话已开启；
 * - screenshot：begin 只发一次、attachImage（不带前缀的 base64）、不发 emitFile、结果文字带尺寸；
 * - 写工具：risk 'write' / approval 'always' / orgLevel / approvalKind 'computer-action' / rememberKey computer:<action>，
 *   approvalDetail 带红点 marker 与 screenshotUrl（文件地址，不塞 base64）；
 * - USER_INTERRUPT → 暂停等待恢复；stop → 已停止文本 + 通知主进程 end；步数上限；
 * - 主进程无 id 事件只作用于“已 markBegun 的会话”；beginRun / endRun 的 end 语义。
 *
 * 通道用注入的假实现（setComputerChannel）；工具直接调 spec.run（审批流程不经编排层，spec 字段单独断言）。
 * 主进程事件经 channel.ts 导出的 notifyComputerEvent 注入（与真实 IPC 通道收到通知时走同一条路）。
 */

interface FakeResult {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

let server: TestServer
/** 假通道收到的全部命令（含 begin / end） */
const calls: Array<Record<string, unknown>> = []
let handler: (cmd: Record<string, unknown>) => FakeResult | Promise<FakeResult> = () => ({ ok: true, result: {} })
let channelAvailable = true

beforeAll(async () => {
  // 只需要数据目录 / 设置持久化，不起真正会用的路由（工作区文件接口由 src 自带）
  server = await startTestServer({ LULUX_MODE: 'server', LULUX_PUBLIC_ORIGIN: 'https://lulux.example.com' })
  const { setComputerChannel } = await import('../src/services/computer/channel.js')
  setComputerChannel({
    available: () => channelAvailable,
    async request<T>(cmd: Record<string, unknown>): Promise<T> {
      calls.push(cmd)
      const reply = await handler(cmd)
      if (!reply.ok) {
        const { ToolError } = await import('../src/services/tools/tool-error.js')
        throw new ToolError(reply.error ? `${reply.error.code}：${reply.error.message}` : 'FAILED')
      }
      return reply.result as T
    },
  })
}, 60_000)

afterAll(async () => {
  await server?.close()
})

beforeEach(async () => {
  calls.length = 0
  channelAvailable = true
  handler = () => ({ ok: true, result: {} })
  const { computerControl } = await import('../src/services/computer/control.js')
  computerControl.reset()
  const { resetComputerShots } = await import('../src/services/computer/tools.js')
  resetComputerShots()
  const { settingsService } = await import('../src/services/settings-service.js')
  settingsService.update({
    computerUse: '1',
    computerMaxSteps: '30',
    builtinTools: '1',
    kernelTools: '1',
    browserAgent: '0',
  })
})

/** 直接调 spec.run 的上下文（固定会话 id，审批不经编排层） */
function ctx(sessionId = 's-test', signal = new AbortController().signal) {
  return {
    sessionId,
    agentId: 'builtin',
    signal,
    addArtifact: () => undefined,
    emitFile: vi.fn(),
    attachImage: vi.fn(),
  }
}
type Ctx = ReturnType<typeof ctx>

async function spec(name: string) {
  const { computerTools } = await import('../src/services/computer/tools.js')
  const found = computerTools.find((tool) => tool.name === name)
  expect(found, name).toBeTruthy()
  return found!
}

async function run(name: string, args: Record<string, unknown>, context: Ctx = ctx()) {
  return (await spec(name)).run(args, context as never)
}

/** 执行成功则返回文本；失败返回 ToolError 实例（runTool 之外直接调 run，错误以异常抛出） */
async function outcome(name: string, args: Record<string, unknown>, context: Ctx = ctx()): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await run(name, args, context)
    return { ok: true, text: String(result) }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

const SHOT_B64 = Buffer.from('fake-jpeg-bytes').toString('base64')
const shotResult = { image: `data:image/jpeg;base64,${SHOT_B64}`, width: 1280, height: 800, displayId: 1, scale: 1 }

/** 开启会话并截一张图（填充 lastShots，供审批详情用） */
async function enableAndShoot(sessionId: string): Promise<Ctx> {
  const { computerControl } = await import('../src/services/computer/control.js')
  computerControl.setEnabled(sessionId, true)
  handler = (cmd) => (cmd.action === 'screenshot' ? { ok: true, result: shotResult } : { ok: true, result: {} })
  const context = ctx(sessionId)
  const res = await outcome('computer_screenshot', {}, context)
  expect(res.ok, res.text).toBe(true)
  return context
}

describe('工具注册与可用性', () => {
  it("computerUse='0' 时 computer_* 不出现；='1' 且通道可用时出现；通道不可用时消失", async () => {
    const { listTools } = await import('../src/services/tools/registry.js')
    const { settingsService } = await import('../src/services/settings-service.js')

    settingsService.update({ computerUse: '0' })
    expect(listTools().some((t) => t.group === 'computer')).toBe(false)

    settingsService.update({ computerUse: '1' })
    const names = listTools()
      .filter((t) => t.group === 'computer')
      .map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        'computer_screenshot',
        'computer_click',
        'computer_move',
        'computer_drag',
        'computer_scroll',
        'computer_type',
        'computer_key',
        'computer_cursor',
      ].sort(),
    )

    channelAvailable = false
    expect(listTools().some((t) => t.group === 'computer')).toBe(false)
  })
})

describe('本会话未开启', () => {
  it('未 setEnabled 时 computer_screenshot 返回“用户尚未在本会话开启电脑操作”，通道不收到任何命令', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    expect(computerControl.enabled('s-test')).toBe(false)
    const res = await outcome('computer_screenshot', {})
    expect(res.ok).toBe(false)
    expect(res.text).toContain('用户尚未在本会话开启电脑操作')
    expect(calls).toHaveLength(0)
  })
})

describe('截图', () => {
  it('开启后：begin 只发一次再发 screenshot；attachImage 一次且无 data: 前缀；不发 emitFile；文字含尺寸', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    computerControl.setEnabled('s-test', true)
    handler = (cmd) => (cmd.action === 'screenshot' ? { ok: true, result: shotResult } : { ok: true, result: {} })

    const context = ctx()
    const first = await outcome('computer_screenshot', {}, context)
    expect(first.ok, first.text).toBe(true)
    expect(first.text).toContain('1280×800')

    expect(calls[0]).toMatchObject({ action: 'begin', sessionId: 's-test' })
    expect(calls[1]).toMatchObject({ action: 'screenshot' })

    expect(context.attachImage).toHaveBeenCalledTimes(1)
    const image = context.attachImage.mock.calls[0]![0] as { mime: string; data: string; width: number; height: number }
    expect(image.mime).toBe('image/jpeg')
    expect(image.data).toBe(SHOT_B64)
    expect(image.data.startsWith('data:')).toBe(false)

    // 截图只落工作区供审批卡读取，不发 artifact（否则每步都弹“产物”面板挡住审批卡）
    expect(context.emitFile).not.toHaveBeenCalled()

    // 第二次截图不再发 begin
    const second = await outcome('computer_screenshot', {}, context)
    expect(second.ok, second.text).toBe(true)
    expect(calls.filter((c) => c.action === 'begin')).toHaveLength(1)
    expect(calls.filter((c) => c.action === 'screenshot')).toHaveLength(2)
  })
})

describe('写工具 spec（审批不经编排层，单测字段）', () => {
  it("computer_click：risk 'write'、approval 'always'、orgLevel true、approvalKind 'computer-action'、rememberKey computer:click", async () => {
    const click = await spec('computer_click')
    expect(click.risk).toBe('write')
    expect(click.approval).toBe('always')
    expect(click.orgLevel).toBe(true)
    expect(click.approvalKind).toBe('computer-action')
    expect(click.rememberKey?.({ x: 1, y: 2 })).toBe('computer:click')
  })

  it('approvalDetail({x:10,y:20}, {sessionId}) 在截过图之后返回 marker 与 screenshotUrl（文件地址，不含 base64）', async () => {
    await enableAndShoot('s-test')
    const click = await spec('computer_click')
    const detail = click.approvalDetail?.({ x: 10, y: 20 }, { sessionId: 's-test' }) as Record<string, unknown>
    expect(detail).toMatchObject({ action: 'click', x: 10, y: 20, marker: { x: 10, y: 20 } })
    const url = detail.screenshotUrl as string
    expect(typeof url).toBe('string')
    expect(url.startsWith('/api/chat/sessions/')).toBe(true)
    expect(url).toContain('computer%2Fshot-')
    // 审批事件不塞 base64 截图（走文件接口取缩略图）
    expect(detail.screenshot).toBeUndefined()
    expect(JSON.stringify(detail)).not.toContain(SHOT_B64)
  })
})

describe('暂停 / 停止', () => {
  it('click 返回 USER_INTERRUPT → 错误文字含“用户动了鼠标”，状态 paused；之后调用等待，resume 后继续执行', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-test')
    handler = (cmd) =>
      cmd.action === 'click' ? { ok: false, error: { code: 'USER_INTERRUPT', message: '光标偏离记录点' } } : { ok: true, result: {} }

    const interrupted = await outcome('computer_click', { x: 10, y: 20 })
    expect(interrupted.ok).toBe(false)
    expect(interrupted.text).toContain('用户动了鼠标')
    expect(computerControl.state('s-test')).toBe('paused')

    // 暂停中再调用会等待，不发命令；resume 后继续执行
    handler = () => ({ ok: true, result: {} })
    const before = calls.length
    let done = false
    const pendingCall = outcome('computer_click', { x: 30, y: 40 }).then((res) => {
      done = true
      return res
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(done).toBe(false)
    expect(calls.length).toBe(before)
    computerControl.set('s-test', 'resume')
    const res = await pendingCall
    expect(done).toBe(true)
    expect(res.ok, res.text).toBe(true)
    expect(calls.some((c) => c.action === 'click' && c.x === 30 && c.y === 40)).toBe(true)
  })

  it("computerControl.set(session,'stop') 后调用返回已停止文本；假通道收到 {action:'end'}", async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-test')
    expect(calls.some((c) => c.action === 'begin')).toBe(true)

    computerControl.set('s-test', 'stop')
    expect(calls.some((c) => c.action === 'end')).toBe(true)

    const res = await outcome('computer_click', { x: 1, y: 1 })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('电脑操作已停止')
    expect(calls.some((c) => c.action === 'click')).toBe(false)
  })
})

describe('步数上限', () => {
  it('computerMaxSteps=2：第 3 次调用返回含“步数上限”的文本', async () => {
    const { settingsService } = await import('../src/services/settings-service.js')
    settingsService.update({ computerMaxSteps: '2' })
    await enableAndShoot('s-test') // 第 1 步
    const second = await outcome('computer_click', { x: 1, y: 1 }) // 第 2 步
    expect(second.ok, second.text).toBe(true)
    const third = await outcome('computer_click', { x: 1, y: 1 })
    expect(third.ok).toBe(false)
    expect(third.text).toContain('步数上限')
  })
})

describe('主进程事件与运行生命周期', () => {
  it('computer-event {event:stop} 作用于已 markBegun 的会话；只 beginRun 的会话不抢走 active、不触发 end', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    const { notifyComputerEvent } = await import('../src/services/computer/channel.js')

    await enableAndShoot('s-test')
    expect(computerControl.activeSession()).toBe('s-test')
    // 同一会话的新运行开始 = 上一次运行已结束（run-registry 在 finish 时 endRun）：这里只验证别的会话不受影响
    calls.length = 0

    // 另一个会话只是 beginRun（没用电脑操作）：不抢走 active，也不触发 end
    computerControl.beginRun('s-other', 'run_2')
    expect(computerControl.activeSession()).toBe('s-test')
    expect(calls.some((c) => c.action === 'end')).toBe(false)

    // 主进程急停通知 → 作用在 s-test 上
    notifyComputerEvent({ event: 'stop', reason: 'hotkey' })
    expect(computerControl.state('s-test')).toBe('stopped')
    expect(computerControl.state('s-other')).toBe('running')
    expect(calls.some((c) => c.action === 'end')).toBe(true)
    expect(computerControl.activeSession()).toBe(null)
  })

  it('beginRun(sessionA) 不会给正在使用电脑操作的 sessionB 发 end', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-b')
    expect(computerControl.begun('s-b')).toBe(true)
    calls.length = 0

    computerControl.beginRun('s-a', 'run_a')
    expect(calls.some((c) => c.action === 'end')).toBe(false)
    expect(computerControl.begun('s-b')).toBe(true)
    expect(computerControl.activeSession()).toBe('s-b')
  })

  it('endRun：对已 begin 的会话发 end，未 begin 的不发', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-test')
    calls.length = 0

    computerControl.endRun('s-test')
    expect(calls.some((c) => c.action === 'end')).toBe(true)
    expect(computerControl.begun('s-test')).toBe(false)

    calls.length = 0
    computerControl.endRun('s-never')
    expect(calls).toHaveLength(0)
  })
})

describe('审查后加固（K3 交叉审查）', () => {
  it('别的会话正持有电脑操作时，本会话调用返回“另一个会话正在操作电脑”，不发命令', async () => {
    await enableAndShoot('s-a')
    const { computerControl } = await import('../src/services/computer/control.js')
    computerControl.setEnabled('s-b', true)
    calls.length = 0
    const res = await outcome('computer_screenshot', {}, ctx('s-b'))
    expect(res.ok).toBe(false)
    expect(res.text).toContain('另一个会话正在操作电脑')
    expect(calls).toHaveLength(0)
    // s-a 运行结束后 s-b 可以用
    computerControl.endRun('s-a')
    expect((await outcome('computer_screenshot', {}, ctx('s-b'))).ok).toBe(true)
  })

  it('两个会话同时首次调用（begin 还在路上）：只有一个能 begin，另一个返回忙；begin 失败会放开占用（V4-Pro 审查）', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    computerControl.setEnabled('s-a', true)
    computerControl.setEnabled('s-b', true)
    let releaseBegin: () => void = () => undefined
    handler = (cmd) => {
      if (cmd.action === 'begin') return new Promise((resolve) => (releaseBegin = () => resolve({ ok: true, result: {} })))
      return cmd.action === 'screenshot' ? { ok: true, result: shotResult } : { ok: true, result: {} }
    }
    const a = outcome('computer_screenshot', {}, ctx('s-a'))
    await new Promise((r) => setTimeout(r, 20))
    const b = await outcome('computer_screenshot', {}, ctx('s-b'))
    expect(b.ok).toBe(false)
    expect(b.text).toContain('另一个会话正在操作电脑')
    releaseBegin()
    expect((await a).ok).toBe(true)
    expect(calls.filter((c) => c.action === 'begin').map((c) => c.sessionId)).toEqual(['s-a'])
    // begin 失败：放开占用，别的会话随后可以用
    computerControl.endRun('s-a')
    computerControl.beginRun('s-c', 'r1')
    computerControl.setEnabled('s-c', true)
    handler = (cmd) => (cmd.action === 'begin' ? { ok: false, error: { code: 'FAILED', message: 'x' } } : { ok: true, result: shotResult })
    expect((await outcome('computer_screenshot', {}, ctx('s-c'))).ok).toBe(false)
    handler = (cmd) => (cmd.action === 'screenshot' ? { ok: true, result: shotResult } : { ok: true, result: {} })
    expect((await outcome('computer_screenshot', {}, ctx('s-b'))).ok).toBe(true)
  })

  it('停止后作废“本会话始终允许”的电脑动作；停止后“继续”不能恢复', async () => {
    const { allowForSession, isAllowedForSession } = await import('../src/services/tool-approval.js')
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-test')
    allowForSession('s-test', 'computer:click')
    allowForSession('s-test', 'browser:other')
    computerControl.set('s-test', 'stop')
    expect(isAllowedForSession('s-test', 'computer:click')).toBe(false)
    expect(isAllowedForSession('s-test', 'browser:other')).toBe(true)
    expect(computerControl.set('s-test', 'resume')).toBe('stopped')
    expect(computerControl.set('s-test', 'pause')).toBe('stopped')
    expect(computerControl.state('s-test')).toBe('stopped')
  })

  it('关闭电脑操作同样作废记住的电脑动作', async () => {
    const { allowForSession, isAllowedForSession } = await import('../src/services/tool-approval.js')
    const { computerControl } = await import('../src/services/computer/control.js')
    await enableAndShoot('s-test')
    allowForSession('s-test', 'computer:type')
    computerControl.setEnabled('s-test', false)
    expect(isAllowedForSession('s-test', 'computer:type')).toBe(false)
  })

  it('删除会话：暂停中等待的调用立刻以“已停止”结束，截图记录清掉', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    const { lastComputerShot } = await import('../src/services/computer/tools.js')
    await enableAndShoot('s-test')
    expect(lastComputerShot('s-test')).toBeTruthy()
    computerControl.set('s-test', 'pause')
    const pending = computerControl.waitUntilReady('s-test', new AbortController().signal, 60_000)
    computerControl.forget('s-test')
    await expect(pending).resolves.toBe('stopped')
    expect(lastComputerShot('s-test')).toBeUndefined()
  })

  it('调用方没有图片通道（attachImage 缺失）时拒绝，不发命令', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    computerControl.setEnabled('s-test', true)
    const context = { ...ctx('s-test'), attachImage: undefined } as unknown as Ctx
    const res = await outcome('computer_click', { x: 1, y: 1 }, context)
    expect(res.ok).toBe(false)
    expect(res.text).toContain('看不到截图')
    expect(calls).toHaveLength(0)
  })

  it('BAD_ARGS / STALE_SHOT 提示模型先重新截图', async () => {
    await enableAndShoot('s-test')
    handler = () => ({ ok: false, error: { code: 'STALE_SHOT', message: '显示器布局变了，请重新截图' } })
    const stale = await outcome('computer_click', { x: 1, y: 1 })
    expect(stale.text).toContain('请先重新截图')
    handler = () => ({ ok: false, error: { code: 'BAD_ARGS', message: '坐标超出截图范围' } })
    const bad = await outcome('computer_click', { x: 1, y: 1 })
    expect(bad.text).toContain('先重新截图')
  })

  it('endRun 带旧运行 id 时不收起新运行的电脑操作', async () => {
    const { computerControl } = await import('../src/services/computer/control.js')
    computerControl.beginRun('s-test', 'run_new')
    await enableAndShoot('s-test')
    calls.length = 0
    computerControl.endRun('s-test', 'run_old')
    expect(computerControl.begun('s-test')).toBe(true)
    expect(calls.some((c) => c.action === 'end')).toBe(false)
    computerControl.endRun('s-test', 'run_new')
    expect(computerControl.begun('s-test')).toBe(false)
  })

  it('同一秒内连续截图文件名不撞（都能保存）', async () => {
    const context = await enableAndShoot('s-test')
    const { lastComputerShot } = await import('../src/services/computer/tools.js')
    const first = lastComputerShot('s-test')!.path
    await outcome('computer_screenshot', {}, context)
    const second = lastComputerShot('s-test')!.path
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })
})
