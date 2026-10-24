/**
 * computer-use 的坐标与按键换算（docs/computer-use.md）。
 *
 * 模型只给截图像素坐标，这里负责换算成 robotjs 需要的屏幕坐标：
 *  - imageToDip：截图坐标 → DIP（显示器 bounds 是 DIP）
 *  - dipToNative：DIP → 各平台 robotjs 坐标（win32 物理像素 / darwin point / linux 物理像素）
 *  - nativeToImage：cursor 用，反向换算，不在该屏上返回 null
 *
 * 纯函数，便于单测；参数非法一律抛 BAD_ARGS。
 */

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export class ComputerGeometryError extends Error {
  readonly code = 'BAD_ARGS'

  constructor(message: string) {
    super(message)
    this.name = 'ComputerGeometryError'
  }
}

function badArgs(message: string): never {
  throw new ComputerGeometryError(message)
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) badArgs(`${what} 必须是有限数字`)
  return value
}

function positive(value: unknown, what: string): number {
  const number = finite(value, what)
  if (number <= 0) badArgs(`${what} 必须大于 0`)
  return number
}

function validPoint(point: Point, what: string): Point {
  if (!point || typeof point !== 'object') badArgs(`${what} 必须是坐标`)
  return { x: finite(point.x, `${what}.x`), y: finite(point.y, `${what}.y`) }
}

/**
 * 截图像素坐标 → DIP。坐标必须落在 [0, imageWidth) × [0, imageHeight)。
 * 结果取整（Electron 的 bounds 是 DIP，整数足够）。
 */
export function imageToDip(
  x: unknown,
  y: unknown,
  displayBounds: Bounds,
  imageWidth: unknown,
  imageHeight: unknown,
): Point {
  const px = finite(x, 'x')
  const py = finite(y, 'y')
  const width = positive(imageWidth, 'imageWidth')
  const height = positive(imageHeight, 'imageHeight')
  if (!displayBounds || typeof displayBounds !== 'object') badArgs('displayBounds 必须是区域')
  const bx = finite(displayBounds.x, 'displayBounds.x')
  const by = finite(displayBounds.y, 'displayBounds.y')
  const bw = positive(displayBounds.width, 'displayBounds.width')
  const bh = positive(displayBounds.height, 'displayBounds.height')
  if (px < 0 || px >= width || py < 0 || py >= height) {
    badArgs(`坐标超出截图范围（${Math.floor(width)}×${Math.floor(height)}）`)
  }
  return {
    x: Math.round(bx + (px * bw) / width),
    y: Math.round(by + (py * bh) / height),
  }
}

export type DipToScreenPoint = (point: Point) => Point

/**
 * DIP → robotjs 坐标：
 *  - win32：screen.dipToScreenPoint（物理像素，含多屏偏移）
 *  - darwin：CoreGraphics 用 point，原样
 *  - linux：X11 物理像素，DIP × scaleFactor
 */
export function dipToNative(
  point: Point,
  platform: NodeJS.Platform,
  scaleFactor: number,
  dipToScreenPoint?: DipToScreenPoint,
): Point {
  const dip = validPoint(point, 'point')
  if (platform === 'win32') {
    if (typeof dipToScreenPoint !== 'function') badArgs('win32 需要 dipToScreenPoint')
    return validPoint(dipToScreenPoint(dip), 'dipToScreenPoint 的返回值')
  }
  if (platform === 'darwin') return dip
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  return { x: Math.round(dip.x * scale), y: Math.round(dip.y * scale) }
}

/**
 * robotjs 屏幕坐标 → 截图像素坐标（cursor 用）。
 * 光标不在该显示器上（或换算结果越界）返回 null。
 */
export function nativeToImage(
  point: Point,
  displayBounds: Bounds,
  imageWidth: number,
  imageHeight: number,
  platform: NodeJS.Platform,
  scaleFactor: number,
  screenToDipPoint?: DipToScreenPoint,
): Point | null {
  const native = validPoint(point, 'point')
  const imageW = positive(imageWidth, 'imageWidth')
  const imageH = positive(imageHeight, 'imageHeight')
  const bx = finite(displayBounds.x, 'displayBounds.x')
  const by = finite(displayBounds.y, 'displayBounds.y')
  const bw = positive(displayBounds.width, 'displayBounds.width')
  const bh = positive(displayBounds.height, 'displayBounds.height')
  let dip: Point
  if (platform === 'win32') {
    dip = typeof screenToDipPoint === 'function' ? validPoint(screenToDipPoint(native), 'screenToDipPoint 的返回值') : native
  } else if (platform === 'darwin') {
    dip = native
  } else {
    const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
    dip = { x: native.x / scale, y: native.y / scale }
  }
  if (dip.x < bx || dip.x >= bx + bw || dip.y < by || dip.y >= by + bh) return null
  const x = Math.round(((dip.x - bx) * imageW) / bw)
  const y = Math.round(((dip.y - by) * imageH) / bh)
  if (x < 0 || x >= imageW || y < 0 || y >= imageH) return null
  return { x, y }
}

/** 等比缩到宽度 ≤ max；已经够窄时原样返回（取整） */
export function fitWidth(width: unknown, height: unknown, max = 1280): Size {
  const w = positive(width, 'width')
  const h = positive(height, 'height')
  const limit = positive(max, 'max')
  if (w <= limit) return { width: Math.round(w), height: Math.round(h) }
  return { width: Math.round(limit), height: Math.max(1, Math.round((h * limit) / w)) }
}

/** 修饰键 → robotjs 名；mod 在 mac = command，其他平台 = control */
const MODIFIERS: Record<string, { name: string; mac?: string }> = {
  ctrl: { name: 'control' },
  control: { name: 'control' },
  shift: { name: 'shift' },
  alt: { name: 'alt' },
  option: { name: 'alt' },
  opt: { name: 'alt' },
  cmd: { name: 'command' },
  command: { name: 'command' },
  win: { name: 'command' },
  meta: { name: 'command' },
  super: { name: 'command' },
  mod: { name: 'control', mac: 'command' },
}

/** 具名键 → robotjs 键名 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  space: 'space',
  spacebar: 'space',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown',
  insert: 'insert',
  ins: 'insert',
  capslock: 'capslock',
  printscreen: 'printscreen',
  plus: '+',
  minus: '-',
  equal: '=',
  equals: '=',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  grave: '`',
  backtick: '`',
  bracketleft: '[',
  leftbracket: '[',
  bracketright: ']',
  rightbracket: ']',
}

/** robotjs 能直接接受的单个符号（可打印 ASCII 标点） */
const SYMBOL_KEYS = new Set(Array.from("+-*/=.,;'[]\\`~!@#$%^&()_{}:\"<>?|"))

function keyName(token: string): string {
  if (/^[a-z0-9]$/.test(token)) return token
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(token)) return token
  const alias = KEY_ALIASES[token]
  if (alias) return alias
  if (token.length === 1 && SYMBOL_KEYS.has(token)) return token
  badArgs(`不支持的按键：${token}`)
}

export interface ParsedKeys {
  key: string
  modifiers: string[]
}

/**
 * "ctrl+shift+t" → { key: 't', modifiers: ['control', 'shift'] }。
 * 最后一段是主键，前面都是修饰键；未知键名抛 BAD_ARGS。
 */
export function parseKeys(spec: unknown, platform: NodeJS.Platform): ParsedKeys {
  if (typeof spec !== 'string') badArgs('keys 必须是字符串')
  const tokens = spec
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) badArgs('keys 不能为空')
  const keyToken = tokens[tokens.length - 1]!
  if (MODIFIERS[keyToken]) badArgs(`缺少主键：${spec}`)
  const modifiers: string[] = []
  for (const token of tokens.slice(0, -1)) {
    const mapping = MODIFIERS[token]
    if (!mapping) badArgs(`不支持的修饰键：${token}`)
    const name = platform === 'darwin' && mapping.mac ? mapping.mac : mapping.name
    if (!modifiers.includes(name)) modifiers.push(name)
  }
  return { key: keyName(keyToken), modifiers }
}

/** 光标离记录点超过 threshold 像素（任一方向） */
export function movedTooFar(
  prev: Point | null | undefined,
  current: Point | null | undefined,
  threshold = 8,
): boolean {
  if (!prev || !current) return false
  if (!Number.isFinite(prev.x) || !Number.isFinite(prev.y)) return false
  if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return false
  const dx = Math.abs(current.x - prev.x)
  const dy = Math.abs(current.y - prev.y)
  return Math.max(dx, dy) > threshold
}
