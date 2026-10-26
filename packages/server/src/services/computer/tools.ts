import { z } from 'zod'
import { settingsService } from '../settings-service.js'
import type { ToolContext, ToolSpec } from '../tools/registry.js'
import { ToolError } from '../tools/tool-error.js'
import { writeWorkspaceBinary } from '../tools/workspace.js'
import { computerChannel } from './channel.js'
import { COMPUTER_PAUSED_MESSAGE, COMPUTER_STOPPED_MESSAGE, computerControl } from './control.js'

/**
 * Agent 操作本机桌面（docs/computer-use.md「服务端（工具层）」）：
 * - 全部经 `services/computer/channel.ts` 的 process IPC 发给桌面主进程；没有通道（团队服务器 / 纯网页端）时不出现；
 * - 出现条件：设置 computerUse='1' 且通道可用；调用时还要求用户在本会话里手动开启，否则返回提示、不弹卡；
 * - screenshot / cursor 为 read；其余为 write 且 approval='always'（orgLevel：即使“完全权限”也逐步审批），
 *   approvalKind `computer-action`，审批卡带最近一张截图与红点坐标；可“本会话始终允许此类动作”（computer:<action>）；
 * - 模型只用截图像素坐标（截图宽度最多 1280），动作坐标都相对最近一张截图；
 * - 截图经 ctx.attachImage 交给编排层（在工具结果之后追加一条带图 user 轮），没有 attachImage 时结果文字里注明；
 * - 步数按“会话 + 本次运行”计（computerControl 在运行开始时清零）；暂停 / 停止见 control.ts。
 */

/** 用户还没在本会话开启电脑操作（不弹审批卡，直接告诉模型） */
export const COMPUTER_DISABLED_MESSAGE = '用户尚未在本会话开启电脑操作（在对话标题栏的电脑图标里开启）'
/** 设置里关掉了电脑操作（工具本不该出现，兜底给模型的原因） */
export const COMPUTER_OFF_MESSAGE = '电脑操作已在设置里关闭。'
export const COMPUTER_NO_CHANNEL_MESSAGE = '电脑操作只能在桌面端本地模式下使用（当前没有可用的桌面端通道）。'

export const COMPUTER_NO_VISION_MESSAGE = '电脑操作需要能看图的模型和支持截图的对话界面，当前调用方看不到截图，不能操作电脑。'

/**
 * 主进程错误码 → 给模型的中文提示（docs/computer-use.md「IPC 协议」的错误码）。
 * STOPPED 的提示也用在暂停超时 / 用户停止之后。
 */
const ERROR_MESSAGES: Record<string, string> = {
  STOPPED: '电脑操作已停止（用户按了急停）。不要再尝试操作电脑，把已经完成的部分告诉用户。',
  USER_INTERRUPT: '用户动了鼠标，已暂停，等待用户点继续。请先停下来，等用户恢复后再继续。',
  PERMISSION: 'macOS 未授权屏幕录制/辅助功能。请让用户在系统设置里允许 LULUX ETA 后再操作。',
  NATIVE_UNAVAILABLE: '本机不支持电脑操作（缺少原生输入模块，或当前桌面环境不支持）。',
  NO_DISPLAY: '没有可用的显示器，无法截图。',
  TIMEOUT: '电脑操作超时，请稍后重试或换一种做法。',
  DISCONNECTED: '与桌面端的连接已断开，电脑操作不可用。',
  ABORTED: '已取消。',
  BAD_ARGS: '参数不对（坐标要在最近一张截图范围内）。屏幕可能变了，先重新截图再按新图的坐标操作',
  STALE_SHOT: '显示器布局变了（拔插或调整了屏幕），旧截图的坐标已失效。请先重新截图',
  BUSY: '另一个会话正在操作电脑，同一时间只能有一个会话操作。',
}

export interface ComputerShot {
  /** 最近一张截图在会话工作区里的路径（审批卡经文件接口取缩略图；不把 base64 塞进审批事件） */
  path: string | null
  width: number
  height: number
  displayId?: number | string
  name: string
}

/** 每个会话最近一张截图（审批卡标注红点用；内存态，进程重启后清空） */
const lastShots = new Map<string, ComputerShot>()

/** 最近一张截图（测试与审批详情用） */
export function lastComputerShot(sessionId: string): ComputerShot | undefined {
  return lastShots.get(sessionId)
}

computerControl.onForget((sessionId) => lastShots.delete(sessionId))

/** 测试用：清空截图缓存 */
export function resetComputerShots(): void {
  lastShots.clear()
}

function maxSteps(): number {
  const value = Number.parseInt(settingsService.get('computerMaxSteps') ?? '', 10)
  return Number.isFinite(value) ? Math.min(300, Math.max(1, value)) : 30
}

function computerUseOn(): boolean {
  return settingsService.get('computerUse') === '1'
}

/** 工具是否出现：设置开关 + IPC 通道（“本会话已开启”只影响调用结果，不影响定义下发） */
function available(): boolean {
  return computerUseOn() && computerChannel().available()
}

/** 主进程错误文本形如 `CODE：说明`（channel 拼的）；拆出错误码与说明 */
function splitError(error: unknown): { code: string; detail: string } {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z_]+)(?:：(.*))?$/s.exec(message)
  if (!match) return { code: '', detail: message }
  return { code: match[1]!, detail: match[2] ?? '' }
}

/** 错误码映射成给模型的提示；未知错误码原样转给模型（便于排查） */
function translate(error: unknown): string {
  const { code, detail } = splitError(error)
  const mapped = ERROR_MESSAGES[code]
  if (mapped) return detail ? `${mapped}（${detail}）` : mapped
  return detail || (error instanceof Error ? error.message : String(error))
}

/**
 * 工具执行前的统一门禁：通道、设置、本会话已开启、停止 / 暂停、步数。
 * 返回要回给模型的拒绝文本，或 null 表示可以继续。
 */
async function ready(ctx: ToolContext): Promise<string | null> {
  if (!computerChannel().available()) return COMPUTER_NO_CHANNEL_MESSAGE
  if (!computerUseOn()) return COMPUTER_OFF_MESSAGE
  if (!computerControl.enabled(ctx.sessionId)) return COMPUTER_DISABLED_MESSAGE
  if (computerControl.state(ctx.sessionId) === 'stopped') return COMPUTER_STOPPED_MESSAGE
  // 看不到截图就不能操作（工作流 / 外部调用方等没有图片通道的上下文）：防止模型盲点
  if (!ctx.attachImage) return COMPUTER_NO_VISION_MESSAGE
  if (computerControl.heldByOther(ctx.sessionId)) return ERROR_MESSAGES.BUSY!
  const waited = await computerControl.waitUntilReady(ctx.sessionId, ctx.signal)
  if (waited === 'aborted') return '已取消。'
  if (waited === 'stopped') return COMPUTER_STOPPED_MESSAGE
  if (waited === 'timeout') return COMPUTER_PAUSED_MESSAGE
  const limit = maxSteps()
  if (computerControl.steps(ctx.sessionId) >= limit) {
    return `已达本次步数上限（${limit} 步）。请基于已看到的内容回答，或请用户提高 computerMaxSteps。`
  }
  return null
}

/** 本次运行首次调用时向主进程 begin（显示边框提示窗、注册急停快捷键、清除 stopped） */
async function ensureBegun(ctx: ToolContext): Promise<void> {
  if (computerControl.begun(ctx.sessionId)) return
  // 同步占住再 await：两个会话同时首次调用时只有一个能 begin
  if (!computerControl.claim(ctx.sessionId)) throw new ToolError(ERROR_MESSAGES.BUSY!)
  try {
    await computerChannel().request({ action: 'begin', sessionId: ctx.sessionId }, { signal: ctx.signal, timeoutMs: 15_000 })
  } catch (error) {
    computerControl.release(ctx.sessionId)
    throw error
  }
  computerControl.markBegun(ctx.sessionId)
}

interface CallResult<T> {
  ok: boolean
  result: T | null
  /** 失败时给模型的文本（已映射成中文） */
  message: string
}

/**
 * 发一条命令。错误码里的 USER_INTERRUPT → 会话置 paused（reason=user-moved-mouse），
 * STOPPED → 置 stopped；不抛错，由调用方决定返回文本。
 */
async function send<T>(ctx: ToolContext, cmd: Record<string, unknown>, timeoutMs?: number): Promise<CallResult<T>> {
  try {
    const result = await computerChannel().request<T>(cmd, { signal: ctx.signal, ...(timeoutMs ? { timeoutMs } : {}) })
    return { ok: true, result: result ?? null, message: '' }
  } catch (error) {
    const { code } = splitError(error)
    if (code === 'USER_INTERRUPT') computerControl.set(ctx.sessionId, 'pause', 'user-moved-mouse')
    else if (code === 'STOPPED') computerControl.set(ctx.sessionId, 'stop', 'stopped')
    return { ok: false, result: null, message: translate(error) }
  }
}

/** 成功的一步：记一步并返回结果；失败时抛 ToolError（文字已映射成中文） */
function finishStep<T>(ctx: ToolContext, call: CallResult<T>): T {
  if (!call.ok) throw new ToolError(call.message)
  computerControl.takeStep(ctx.sessionId)
  return call.result as T
}

function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  // 精确到毫秒并带随机后缀：同一秒内多次截图不能撞名（撞名会写失败，审批卡就没有图）
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${ms}-${rand}`
}

/**
 * 截图写入会话工作区（computer/shot-<时间>.jpg），审批卡经鉴权文件接口读取；不进历史正文。
 * 不发 artifact 事件：每步截图都弹“产物”面板会挡住对话和审批卡（真 Electron 验证发现）。
 */
async function saveScreenshot(ctx: ToolContext, buffer: Buffer): Promise<{ path: string; bytes: number } | null> {
  try {
    const written = await writeWorkspaceBinary(ctx.sessionId, `computer/shot-${stamp()}.jpg`, buffer)
    return { path: written.path, bytes: written.bytes }
  } catch {
    return null
  }
}

interface ScreenshotResult {
  image?: string
  width?: number
  height?: number
  displayId?: number | string
  scale?: number
}

const coord = z.number().finite().min(0).max(100_000)
const displayId = z.union([z.number(), z.string().min(1).max(40)]).optional()
const BUTTONS = ['left', 'right', 'middle'] as const

/**
 * 审批卡片详情（approvalKind `computer-action`）：动作、坐标、文本前 200 字、按键，
 * 以及本会话最近一张截图的文件地址（screenshotUrl）与红点坐标（截图坐标）。
 */
function buildDetail(action: string, args: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
  const shot = sessionId ? lastShots.get(sessionId) : undefined
  const screenshotUrl =
    shot?.path && sessionId
      ? `/api/chat/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(shot.path)}`
      : undefined
  const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const x = number(args.x)
  const y = number(args.y)
  const toX = number(args.toX)
  const toY = number(args.toY)
  const text = typeof args.text === 'string' ? args.text.slice(0, 200) : undefined
  const keys = typeof args.keys === 'string' ? args.keys : undefined
  return {
    action,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(toX !== undefined ? { toX } : {}),
    ...(toY !== undefined ? { toY } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(keys !== undefined ? { keys } : {}),
    ...(shot && screenshotUrl ? { screenshotUrl, screenshotWidth: shot.width, screenshotHeight: shot.height } : {}),
    ...(shot && x !== undefined && y !== undefined ? { marker: { x, y } } : {}),
  }
}

/** 写类工具（每一步都要用户批准）的公共字段 */
function writeTool(input: {
  name: string
  action: string
  description: string
  properties: Record<string, unknown>
  required: string[]
}): Pick<ToolSpec, 'name' | 'group' | 'risk' | 'approval' | 'orgLevel' | 'approvalKind' | 'available' | 'description' | 'inputSchema' | 'approvalDetail' | 'rememberKey'> {
  return {
    name: input.name,
    group: 'computer',
    risk: 'write',
    // 每一步都审批：即使会话是“完全权限”也问一次（orgLevel 让 toolGate 在 full 下仍返回 ask）
    approval: 'always',
    orgLevel: true,
    approvalKind: 'computer-action',
    available,
    description: input.description,
    inputSchema: { type: 'object', properties: input.properties, required: input.required },
    approvalDetail: (args, ctx) => buildDetail(input.action, args, ctx?.sessionId),
    // 允许“本会话始终允许此类动作”：按动作粒度记忆
    rememberKey: () => `computer:${input.action}`,
  }
}

export const computerTools: ToolSpec[] = [
  {
    name: 'computer_screenshot',
    group: 'computer',
    risk: 'read',
    available,
    description:
      '截取本机屏幕（宽度最多 1280 像素），返回截图尺寸与显示器编号。之后所有 click / move / drag / scroll 的坐标都以这张图为准' +
      '（左上角为 0,0，单位是截图像素）。操作电脑前先截图看清界面；操作后需要确认结果时再截一次。',
    inputSchema: {
      type: 'object',
      properties: {
        displayId: { type: ['string', 'number'], description: '显示器编号（省略时用主屏或上次用的那块）' },
      },
    },
    async run(args, ctx) {
      const input = z.object({ displayId }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      const call = await send<ScreenshotResult>(
        ctx,
        { action: 'screenshot', ...(input.displayId !== undefined ? { displayId: input.displayId } : {}) },
        60_000,
      )
      const shot = finishStep(ctx, call)
      const dataUrl = shot?.image
      if (!dataUrl) throw new ToolError('截图失败：桌面端没有返回图片。')
      const width = shot.width ?? 0
      const height = shot.height ?? 0
      const base64 = /^data:image\/[a-z]+;base64,(.+)$/i.exec(dataUrl)?.[1] ?? ''
      if (!base64) throw new ToolError('截图失败：图片格式不正确。')
      const saved = await saveScreenshot(ctx, Buffer.from(base64, 'base64'))
      const name = saved ? saved.path.replace(/\\/g, '/').split('/').pop()! : `shot-${stamp()}.jpg`
      lastShots.set(ctx.sessionId, { path: saved?.path ?? null, width, height, displayId: shot.displayId, name })
      ctx.attachImage?.({ mime: 'image/jpeg', data: base64, width, height, name })
      const lines = [`已截图 ${width}×${height}（显示器 ${shot.displayId ?? '?'}）。之后的坐标都以这张图为准（左上角为 0,0）。`]
      if (!saved) lines.push('截图没能保存到工作区，审批卡上不会显示这张图。')
      if (saved) lines.push(`截图已保存为工作区文件 ${saved.path}（${Math.round(saved.bytes / 1024)} KB）。`)
      return lines.join('\n')
    },
  },
  {
    ...writeTool({
      name: 'computer_click',
      action: 'click',
      description:
        '在截图坐标 (x, y) 处点击鼠标（默认左键单击，可指定右键 / 中键 / 双击）。每次点击都需要用户批准。',
      properties: {
        x: { type: 'number', description: '横坐标（截图像素）' },
        y: { type: 'number', description: '纵坐标（截图像素）' },
        button: { type: 'string', enum: [...BUTTONS], description: '按键，默认 left' },
        double: { type: 'boolean', description: '是否双击，默认 false' },
      },
      required: ['x', 'y'],
    }),
    async run(args, ctx) {
      const input = z.object({ x: coord, y: coord, button: z.enum(BUTTONS).optional(), double: z.boolean().optional() }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(
        ctx,
        await send(ctx, {
          action: 'click',
          x: input.x,
          y: input.y,
          ...(input.button ? { button: input.button } : {}),
          ...(input.double ? { double: true } : {}),
        }),
      )
      return `已点击 (${input.x}, ${input.y})${input.double ? '（双击）' : ''}${input.button && input.button !== 'left' ? `（${input.button}）` : ''}。`
    },
  },
  {
    ...writeTool({
      name: 'computer_move',
      action: 'move',
      description: '把鼠标移动到截图坐标 (x, y)，不点击。悬停展开菜单、拖动前定位时用。',
      properties: {
        x: { type: 'number', description: '横坐标（截图像素）' },
        y: { type: 'number', description: '纵坐标（截图像素）' },
      },
      required: ['x', 'y'],
    }),
    async run(args, ctx) {
      const input = z.object({ x: coord, y: coord }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(ctx, await send(ctx, { action: 'move', x: input.x, y: input.y }))
      return `已移动鼠标到 (${input.x}, ${input.y})。`
    },
  },
  {
    ...writeTool({
      name: 'computer_drag',
      action: 'drag',
      description: '从截图坐标 (x, y) 按住鼠标拖到 (toX, toY)：选择文字、移动窗口、拖拽文件。',
      properties: {
        x: { type: 'number', description: '起点横坐标（截图像素）' },
        y: { type: 'number', description: '起点纵坐标（截图像素）' },
        toX: { type: 'number', description: '终点横坐标（截图像素）' },
        toY: { type: 'number', description: '终点纵坐标（截图像素）' },
      },
      required: ['x', 'y', 'toX', 'toY'],
    }),
    async run(args, ctx) {
      const input = z.object({ x: coord, y: coord, toX: coord, toY: coord }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(ctx, await send(ctx, { action: 'drag', x: input.x, y: input.y, toX: input.toX, toY: input.toY }))
      return `已从 (${input.x}, ${input.y}) 拖到 (${input.toX}, ${input.toY})。`
    },
  },
  {
    ...writeTool({
      name: 'computer_scroll',
      action: 'scroll',
      description:
        '在截图坐标 (x, y) 处滚动滚轮（dx / dy 为行数，正数 = 向下 / 向右，各最多 ±30）。看长文档、长列表时用；滚动后需要确认时再截图。',
      properties: {
        x: { type: 'number', description: '横坐标（截图像素）' },
        y: { type: 'number', description: '纵坐标（截图像素）' },
        dx: { type: 'number', minimum: -30, maximum: 30, description: '水平滚动行数，正 = 向右' },
        dy: { type: 'number', minimum: -30, maximum: 30, description: '垂直滚动行数，正 = 向下' },
      },
      required: ['x', 'y'],
    }),
    async run(args, ctx) {
      const input = z
        .object({ x: coord, y: coord, dx: z.number().int().min(-30).max(30).optional(), dy: z.number().int().min(-30).max(30).optional() })
        .parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(
        ctx,
        await send(ctx, {
          action: 'scroll',
          x: input.x,
          y: input.y,
          ...(input.dx !== undefined ? { dx: input.dx } : {}),
          ...(input.dy !== undefined ? { dy: input.dy } : {}),
        }),
      )
      return `已在 (${input.x}, ${input.y}) 滚动（dx=${input.dx ?? 0}, dy=${input.dy ?? 0}）。`
    },
  },
  {
    ...writeTool({
      name: 'computer_type',
      action: 'type',
      description:
        '在当前光标位置输入文本（最多 2000 字；中文等非 ASCII 字符经剪贴板粘贴）。先 computer_click 点进输入框再输入。',
      properties: { text: { type: 'string', description: '要输入的文本（最多 2000 字）' } },
      required: ['text'],
    }),
    async run(args, ctx) {
      const input = z.object({ text: z.string().min(1).max(2000) }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(ctx, await send(ctx, { action: 'type', text: input.text }))
      return `已输入 ${input.text.length} 个字符。`
    },
  },
  {
    ...writeTool({
      name: 'computer_key',
      action: 'key',
      description:
        '按一个键或组合键，如 "enter"、"tab"、"esc"、"ctrl+c"、"cmd+shift+t"（mod = mac 上 cmd、其他平台 ctrl）。提交表单、切换窗口、复制粘贴时用。',
      properties: { keys: { type: 'string', description: '按键，如 enter、ctrl+c、cmd+shift+t' } },
      required: ['keys'],
    }),
    async run(args, ctx) {
      const input = z.object({ keys: z.string().min(1).max(100) }).parse(args)
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      finishStep(ctx, await send(ctx, { action: 'key', keys: input.keys }))
      return `已按键 ${input.keys}。`
    },
  },
  {
    name: 'computer_cursor',
    group: 'computer',
    risk: 'read',
    available,
    description: '读取当前鼠标位置（截图坐标），用来确认移动 / 拖动是否到位；光标不在最近截图的那块屏幕上时没有坐标。',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const blocked = await ready(ctx)
      if (blocked) throw new ToolError(blocked)
      await ensureBegun(ctx)
      const position = finishStep(ctx, await send<{ x?: number | null; y?: number | null }>(ctx, { action: 'cursor' }))
      if (position?.x === null || position?.x === undefined || position?.y === null || position?.y === undefined) {
        return '鼠标不在最近截图的那块显示器上（没有坐标）。'
      }
      return `鼠标在 (${position.x}, ${position.y})（截图坐标）。`
    },
  },
]
