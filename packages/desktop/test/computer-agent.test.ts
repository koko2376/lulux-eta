import { describe, expect, it, vi } from 'vitest'
import {
  ComputerAgent,
  ComputerAgentError,
  STOP_ACCELERATOR,
  type ComputerAgentEvent,
  type ComputerAgentOptions,
  type DesktopSourceLike,
  type DisplayLike,
  type NativeImageLike,
  type RobotLike,
} from '../src/computer-agent'

/* ── 假的 Electron / robotjs ─────────────────────────────── */

const DISPLAY_A: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 }, scaleFactor: 2 }
const DISPLAY_B: DisplayLike = { id: 2, bounds: { x: 1600, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }

interface Harness {
  agent: ComputerAgent
  robot: RobotLike & { calls: string[] }
  displays: DisplayLike[]
  lastCursor: { x: number; y: number }
  clipboardText: string
  activity: Array<{ action: string; x?: number; y?: number }>
  events: ComputerAgentEvent[]
  overlay: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
  shortcuts: Map<string, () => void>
  registerResult: { value: boolean }
  permission: { screen: string; accessibility: boolean }
  options: ComputerAgentOptions
}

/** 生成 returned-size 追踪的假 NativeImage */
function fakeImage(width: number, height: number): NativeImageLike {
  const image: NativeImageLike = {
    getSize: () => ({ width, height }),
    resize: (options) => fakeImage(options.width ?? width, Math.round((height * (options.width ?? width)) / width)),
    toJPEG: (quality) => Buffer.from(`jpeg:${width}x${height}:${quality}`),
    isEmpty: () => false,
  }
  return image
}

function harness(overrides: Partial<ComputerAgentOptions> = {}, platform: NodeJS.Platform = 'win32'): Harness {
  const state: Harness = {} as Harness
  state.displays = [DISPLAY_A, DISPLAY_B]
  state.lastCursor = { x: 100, y: 100 }
  state.clipboardText = '原来的剪贴板'
  state.activity = []
  state.events = []
  state.shortcuts = new Map()
  state.registerResult = { value: true }
  state.permission = { screen: 'granted', accessibility: true }
  state.overlay = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }

  const calls: string[] = []
  state.robot = {
    calls,
    moveMouse: vi.fn((x: number, y: number) => calls.push(`moveMouse:${x},${y}`)),
    mouseClick: vi.fn((button?: string, double?: boolean) => calls.push(`mouseClick:${button}:${double}`)),
    mouseToggle: vi.fn((down?: string) => calls.push(`mouseToggle:${down}`)),
    moveMouseSmooth: vi.fn((x: number, y: number) => calls.push(`moveMouseSmooth:${x},${y}`)),
    scrollMouse: vi.fn((x: number, y: number) => calls.push(`scrollMouse:${x},${y}`)),
    typeString: vi.fn((text: string) => calls.push(`typeString:${text}`)),
    keyTap: vi.fn((key: string, modifier?: string | string[]) =>
      calls.push(`keyTap:${key}:${Array.isArray(modifier) ? modifier.join('+') : modifier ?? ''}`),
    ),
    getMousePos: vi.fn(() => ({ ...state.lastCursor })),
  }

  const screen = {
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => state.displays[0]!,
    dipToScreenPoint: (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 }),
    screenToDipPoint: (point: { x: number; y: number }) => ({ x: point.x / 2, y: point.y / 2 }),
  }

  const desktopCapturer = {
    getSources: vi.fn(async ({ thumbnailSize }: { thumbnailSize: { width: number; height: number } }) => {
      const sources: DesktopSourceLike[] = state.displays.map((display) => ({
        id: `screen:${display.id}`,
        display_id: String(display.id),
        thumbnail: fakeImage(
          Math.round(display.bounds.width * display.scaleFactor),
          Math.round(display.bounds.height * display.scaleFactor),
        ),
      }))
      // thumbnailSize 只用来确认主进程按 bounds×scaleFactor 要图
      void thumbnailSize
      return sources
    }),
  }

  state.options = {
    platform,
    loadNative: () => state.robot,
    screen,
    desktopCapturer,
    globalShortcut: {
      register: (accelerator, callback) => {
        if (!state.registerResult.value) return false
        state.shortcuts.set(accelerator, callback)
        return true
      },
      unregister: (accelerator) => {
        state.shortcuts.delete(accelerator)
      },
    },
    systemPreferences: {
      getMediaAccessStatus: () => state.permission.screen,
      isTrustedAccessibilityClient: () => state.permission.accessibility,
    },
    clipboard: {
      readText: () => state.clipboardText,
      writeText: (text: string) => {
        state.clipboardText = text
      },
    },
    createWindow: () => {
      throw new Error('提示窗不应该在测试里真的创建')
    },
    overlay: state.overlay,
    onActivity: (activity) => state.activity.push(activity),
    onEvent: (event) => state.events.push(event),
    ...overrides,
  }
  state.agent = new ComputerAgent(state.options)
  return state
}

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (error) {
    return error instanceof ComputerAgentError ? error.code : 'OTHER'
  }
  return 'NO_ERROR'
}

/** 截一张 1600×900 主屏的图（win32：1600×900 DIP → 3200×1800 物理，缩到 1280 宽） */
async function shot(h: Harness): Promise<Record<string, unknown>> {
  return (await h.agent.execute({ action: 'screenshot' })) as Record<string, unknown>
}

/* ── 用例 ───────────────────────────────────────────────── */

describe('screenshot', () => {
  it('按显示器抓屏、缩到宽 ≤1280、返回 JPEG data URL 与元信息', async () => {
    const h = harness()
    const result = await shot(h)
    expect(String(result.image).startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.displayId).toBe(1)
    expect(result.scale).toBe(2)
    // 抓屏分辨率用的是 bounds × scaleFactor（2x 屏的物理像素）
    expect(h.options.desktopCapturer.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 3200, height: 1800 },
    })
  })

  it('指定 displayId 截第二块屏', async () => {
    const h = harness()
    const result = (await h.agent.execute({ action: 'screenshot', displayId: 2 })) as Record<string, unknown>
    expect(result.displayId).toBe(2)
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
  })

  it('显示器不存在 → NO_DISPLAY', async () => {
    const h = harness()
    expect(await codeOf(() => h.agent.execute({ action: 'screenshot', displayId: 99 }))).toBe('NO_DISPLAY')
  })
})

describe('坐标系换算（经 click）', () => {
  it('win32：截图坐标 → DIP → dipToScreenPoint（物理像素）', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'click', x: 640, y: 360 })
    expect(h.robot.calls).toContain('moveMouse:1600,900')
    expect(h.robot.calls).toContain('mouseClick:left:false')
  })

  it('linux：DIP × scaleFactor', async () => {
    const h = harness({}, 'linux')
    await shot(h)
    await h.agent.execute({ action: 'click', x: 640, y: 360 })
    expect(h.robot.calls).toContain('moveMouse:1600,900')
  })

  it('darwin：DIP 原样', async () => {
    const h = harness({}, 'darwin')
    await shot(h)
    await h.agent.execute({ action: 'click', x: 640, y: 360 })
    expect(h.robot.calls).toContain('moveMouse:800,450')
  })

  it('坐标越界 → BAD_ARGS', async () => {
    const h = harness()
    await shot(h)
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 5000, y: 10 }))).toBe('BAD_ARGS')
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 10, y: -1 }))).toBe('BAD_ARGS')
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: Number.NaN, y: 10 }))).toBe('BAD_ARGS')
    expect(h.robot.calls).toHaveLength(0)
  })

  it('截图后显示器布局 / 缩放变了 → STALE_SHOT，不点；重新截图后可用', async () => {
    const h = harness()
    await h.agent.execute({ action: 'screenshot' })
    h.displays = [{ ...DISPLAY_A, bounds: { ...DISPLAY_A.bounds, width: 1920 } }, DISPLAY_B]
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10 }))).toBe('STALE_SHOT')
    expect(h.robot.calls).toHaveLength(0)
    h.displays = [{ ...DISPLAY_A, scaleFactor: 1 }, DISPLAY_B]
    await h.agent.execute({ action: 'screenshot' })
    h.displays = [DISPLAY_A, DISPLAY_B]
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10 }))).toBe('STALE_SHOT')
    await h.agent.execute({ action: 'screenshot' })
    await h.agent.execute({ action: 'click', x: 10, y: 10 })
    expect(h.robot.calls.some((c) => c.startsWith('mouseClick'))).toBe(true)
  })

  it('没截图就操作 → BAD_ARGS「请先 computer_screenshot」', async () => {
    const h = harness()
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10 }))).toBe('BAD_ARGS')
    expect(await codeOf(() => h.agent.execute({ action: 'scroll', x: 10, y: 10 }))).toBe('BAD_ARGS')
    expect(await codeOf(() => h.agent.execute({ action: 'cursor' }))).toBe('BAD_ARGS')
  })
})

describe('click / move / drag / scroll', () => {
  it('click 支持右键与双击', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'click', x: 10, y: 10, button: 'right', double: true })
    expect(h.robot.calls).toContain('mouseClick:right:true')
  })

  it('click 的 button 非法 → BAD_ARGS', async () => {
    const h = harness()
    await shot(h)
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10, button: 'side' }))).toBe('BAD_ARGS')
  })

  it('拖动：按下 → 平滑移动 → 松开', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'drag', x: 100, y: 100, toX: 300, toY: 200 })
    expect(h.robot.calls).toEqual([
      'moveMouse:250,250',
      'mouseToggle:down',
      'moveMouseSmooth:750,500',
      'mouseToggle:up',
    ])
  })

  it('滚动：先移鼠标再滚，dx / dy 限幅到 ±30，并换成 robotjs 的方向与单位（win32 一格 120）', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'scroll', x: 10, y: 10, dx: 500, dy: -500 })
    expect(h.robot.calls.slice(-2)).toEqual(['moveMouse:26,26', 'scrollMouse:-3600,3600'])
    await h.agent.execute({ action: 'scroll', x: 10, y: 10, dy: -2.4 })
    expect(h.robot.calls.at(-1)).toBe('scrollMouse:0,240')
  })

  it('scroll 参数非数字 → BAD_ARGS', async () => {
    const h = harness()
    await shot(h)
    expect(await codeOf(() => h.agent.execute({ action: 'scroll', x: 10, y: 10, dy: 'down' }))).toBe('BAD_ARGS')
  })
})

describe('type', () => {
  it('纯 ASCII 用 typeString', async () => {
    const h = harness()
    const before = h.clipboardText
    await h.agent.execute({ action: 'type', text: 'Hello, World! 123' })
    expect(h.robot.calls).toEqual(['typeString:Hello, World! 123'])
    expect(h.clipboardText).toBe(before)
  })

  it('非 ASCII 走剪贴板粘贴并恢复原剪贴板', async () => {
    const h = harness()
    const before = h.clipboardText
    await h.agent.execute({ action: 'type', text: '你好，世界' })
    expect(h.robot.calls).toEqual(['keyTap:v:control'])
    expect(h.clipboardText).toBe(before)
  })

  it('读不到原剪贴板时不恢复（不能把用户剪贴板清空）', async () => {
    const h = harness({
      clipboard: {
        readText: () => {
          throw new Error('denied')
        },
        writeText: (text: string) => {
          h.clipboardText = text
        },
      },
    })
    await h.agent.execute({ action: 'type', text: '你好' })
    expect(h.robot.calls).toEqual(['keyTap:v:control'])
    expect(h.clipboardText).toBe('你好')
  })

  it('macOS 粘贴用 command', async () => {
    const h = harness({}, 'darwin')
    await h.agent.execute({ action: 'type', text: '中文' })
    expect(h.robot.calls).toEqual(['keyTap:v:command'])
  })

  it('超过 2000 字 → BAD_ARGS', async () => {
    const h = harness()
    expect(await codeOf(() => h.agent.execute({ action: 'type', text: 'a'.repeat(2001) }))).toBe('BAD_ARGS')
    expect(h.robot.calls).toHaveLength(0)
  })
})

describe('key / cursor', () => {
  it('key 走 parseKeys 映射', async () => {
    const h = harness()
    await h.agent.execute({ action: 'key', keys: 'ctrl+shift+t' })
    expect(h.robot.calls).toEqual(['keyTap:t:control+shift'])
    await h.agent.execute({ action: 'key', keys: 'enter' })
    expect(h.robot.calls.at(-1)).toBe('keyTap:enter:')
  })

  it('非法按键 → BAD_ARGS', async () => {
    const h = harness()
    expect(await codeOf(() => h.agent.execute({ action: 'key', keys: 'ctrl+nope' }))).toBe('BAD_ARGS')
  })

  it('cursor 换回截图坐标；不在该屏返回 null', async () => {
    const h = harness()
    await shot(h)
    h.lastCursor = { x: 1600, y: 900 } // DIP (800, 450) → 截图 (640, 360)
    expect(await h.agent.execute({ action: 'cursor' })).toEqual({ x: 640, y: 360 })
    h.lastCursor = { x: -100, y: 10 }
    expect(await h.agent.execute({ action: 'cursor' })).toEqual({ x: null, y: null })
  })
})

describe('用户接管检测', () => {
  it('光标移动超过 8px → USER_INTERRUPT + pause 事件，之后恢复', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'move', x: 100, y: 100 })
    expect(h.events).toEqual([])
    // 用户把鼠标挪走了
    h.lastCursor = { x: 400, y: 400 }
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 100, y: 100 }))).toBe('USER_INTERRUPT')
    expect(h.events).toEqual([{ event: 'pause', reason: 'user-moved-mouse' }])
    // 下一次动作不再误判（lastCursor 已清空）
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 100, y: 100 }))).toBe('NO_ERROR')
    expect(h.events).toHaveLength(1)
  })

  it('移动小于阈值不算接管', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'move', x: 100, y: 100 })
    h.lastCursor = { x: 104, y: 104 } // 距记录点 (100,100) 只差 4px
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 100, y: 100 }))).toBe('NO_ERROR')
    expect(h.events).toHaveLength(0)
  })

  it('drag / scroll / type / key 也会检测', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'move', x: 100, y: 100 })
    h.lastCursor = { x: 900, y: 900 }
    expect(await codeOf(() => h.agent.execute({ action: 'key', keys: 'enter' }))).toBe('USER_INTERRUPT')
    // 接管后 lastCursor 已清空：先做一次动作重新记录，再模拟用户再次挪走鼠标
    await h.agent.execute({ action: 'key', keys: 'enter' })
    h.lastCursor = { x: 0, y: 0 }
    expect(await codeOf(() => h.agent.execute({ action: 'type', text: 'x' }))).toBe('USER_INTERRUPT')
  })
})

describe('急停与 begin / end', () => {
  it('快捷键按下 → stopped、stop 事件、隐藏提示窗；之后动作 STOPPED；begin 恢复', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'begin', sessionId: 's1' })
    expect(h.overlay.show).toHaveBeenCalled()
    const stop = h.shortcuts.get(STOP_ACCELERATOR)
    expect(stop).toBeTypeOf('function')
    stop!()
    expect(h.events).toEqual([{ event: 'stop', reason: 'hotkey' }])
    expect(h.overlay.hide).toHaveBeenCalled()

    for (const cmd of [
      { action: 'screenshot' },
      { action: 'click', x: 10, y: 10 },
      { action: 'move', x: 10, y: 10 },
      { action: 'drag', x: 10, y: 10, toX: 20, toY: 20 },
      { action: 'scroll', x: 10, y: 10, dy: 1 },
      { action: 'type', text: 'x' },
      { action: 'key', keys: 'enter' },
      { action: 'cursor' },
    ]) {
      expect(await codeOf(() => h.agent.execute(cmd))).toBe('STOPPED')
    }
    // status 仍可用，并报告 stopped
    const status = (await h.agent.execute({ action: 'status' })) as Record<string, unknown>
    expect(status.stopped).toBe(true)

    await h.agent.execute({ action: 'begin', sessionId: 's1' })
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 100, y: 100 }))).toBe('NO_ERROR')
  })

  it('end 注销快捷键、隐藏提示窗', async () => {
    const h = harness()
    await h.agent.execute({ action: 'begin' })
    expect(h.shortcuts.has(STOP_ACCELERATOR)).toBe(true)
    await h.agent.execute({ action: 'end' })
    expect(h.shortcuts.has(STOP_ACCELERATOR)).toBe(false)
    expect(h.overlay.hide).toHaveBeenCalled()
    // end 之后没有边框提示和急停快捷键：动作一律拒绝，重新 begin 才能继续
    expect(await codeOf(() => h.agent.execute({ action: 'move', x: 100, y: 100 }))).toBe('STOPPED')
    await h.agent.execute({ action: 'begin' })
    const status = (await h.agent.execute({ action: 'status' })) as Record<string, unknown>
    expect(status.stopped).toBe(false)
  })

  it('快捷键注册失败不报错，status.hotkey = false', async () => {
    const h = harness()
    h.registerResult.value = false
    await h.agent.execute({ action: 'begin' })
    const status = (await h.agent.execute({ action: 'status' })) as Record<string, unknown>
    expect(status.hotkey).toBe(false)
    // 提示条不能再写快捷键
    expect(h.overlay.show).toHaveBeenLastCalledWith({ hotkey: false })
  })

  it('快捷键注册成功：begin 返回 hotkey=true，提示条带快捷键', async () => {
    const h = harness()
    expect(await h.agent.execute({ action: 'begin' })).toEqual({ hotkey: true })
    expect(h.overlay.show).toHaveBeenLastCalledWith({ hotkey: true })
  })

  it('dispose 注销快捷键并关闭提示窗', async () => {
    const h = harness()
    await h.agent.execute({ action: 'begin' })
    h.agent.dispose()
    expect(h.shortcuts.size).toBe(0)
    expect(h.overlay.dispose).toHaveBeenCalled()
  })
})

describe('status / 原生加载 / 权限', () => {
  it('status 报告 native、显示器与权限', async () => {
    const h = harness()
    const status = (await h.agent.execute({ action: 'status' })) as {
      native: boolean
      stopped: boolean
      displays: Array<{ id: number; primary: boolean }>
      permission: { screen: string; accessibility: string }
    }
    expect(status.native).toBe(true)
    expect(status.stopped).toBe(false)
    expect(status.displays).toEqual([
      { id: 1, primary: true, bounds: DISPLAY_A.bounds, scaleFactor: 2 },
      { id: 2, primary: false, bounds: DISPLAY_B.bounds, scaleFactor: 1 },
    ])
    expect(status.permission).toEqual({ screen: 'granted', accessibility: 'granted' })
  })

  it('robotjs 加载失败 → NATIVE_UNAVAILABLE（status 不抛）', async () => {
    const h = harness({
      loadNative: () => {
        throw new Error('no prebuild')
      },
    })
    expect(await codeOf(() => h.agent.execute({ action: 'screenshot' }))).toBe('NATIVE_UNAVAILABLE')
    const status = (await h.agent.execute({ action: 'status' })) as { native: boolean }
    expect(status.native).toBe(false)
  })

  it('darwin 缺屏幕录制权限：screenshot → PERMISSION', async () => {
    const h = harness({}, 'darwin')
    h.permission.screen = 'denied'
    expect(await codeOf(() => h.agent.execute({ action: 'screenshot' }))).toBe('PERMISSION')
    const status = (await h.agent.execute({ action: 'status' })) as { permission: { screen: string } }
    expect(status.permission.screen).toBe('denied')
  })

  it('darwin 缺辅助功能权限：输入类动作 → PERMISSION，授权后可用', async () => {
    const h = harness({}, 'darwin')
    await shot(h)
    h.permission.accessibility = false
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10 }))).toBe('PERMISSION')
    expect(await codeOf(() => h.agent.execute({ action: 'type', text: 'x' }))).toBe('PERMISSION')
    expect(h.robot.calls).toHaveLength(0)
    h.permission.accessibility = true
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 1200, y: 400 }))).toBe('NO_ERROR')
  })

  it('其他平台权限一律 granted，不做检查', async () => {
    const h = harness({}, 'linux')
    h.permission.screen = 'denied'
    h.permission.accessibility = false
    await shot(h)
    expect(await codeOf(() => h.agent.execute({ action: 'click', x: 10, y: 10 }))).toBe('NO_ERROR')
  })
})

describe('活动与事件推送', () => {
  it('每个动作前推 onActivity（点到类带坐标）', async () => {
    const h = harness()
    await shot(h)
    await h.agent.execute({ action: 'click', x: 640, y: 360 })
    await h.agent.execute({ action: 'key', keys: 'enter' })
    expect(h.activity).toEqual([
      { action: 'screenshot' },
      { action: 'click', x: 640, y: 360 },
      { action: 'key' },
    ])
  })

  it('未知 action → BAD_ARGS', async () => {
    const h = harness()
    expect(await codeOf(() => h.agent.execute({ action: 'teleport' }))).toBe('BAD_ARGS')
    expect(await codeOf(() => h.agent.execute({ nope: true }))).toBe('BAD_ARGS')
  })
})

describe('scrollToNative（robotjs 方向 / 单位）', () => {
  it('正 dy = 向下 → robotjs 负 y；各平台单位', async () => {
    const { scrollToNative } = await import('../src/computer-agent')
    expect(scrollToNative(0, 3, 'win32')).toEqual({ x: 0, y: -360 })
    expect(scrollToNative(2, 0, 'darwin')).toEqual({ x: -80, y: 0 })
    expect(scrollToNative(-1, -2, 'linux')).toEqual({ x: 1, y: 2 })
  })
})
