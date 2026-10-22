/** 外观偏好按设备保存（localStorage），不写入服务端设置 */
import '../styles/density.css'

export type ThemePref = 'light' | 'dark' | 'system'
export type Density = 'compact' | 'standard' | 'comfortable'
export interface Appearance {
  /** 界面字号 / 缩放，90–125%，步长 5 */
  scale: number
  reduceMotion: boolean
  theme: ThemePref
  /** 列表密度：只影响列表行高（客户 / 邮箱 / 报价 / 会话等列表） */
  density: Density
}

const KEY = 'lulux.appearance'
export const SCALES = [90, 100, 110, 125] as const
export const THEMES: ThemePref[] = ['light', 'dark', 'system']
export const DENSITIES: Density[] = ['compact', 'standard', 'comfortable']
export const SCALE_MIN = 90
export const SCALE_MAX = 125
export const DENSITY_FACTOR: Record<Density, number> = { compact: 0.72, standard: 1, comfortable: 1.3 }
const validScale = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX && v % 5 === 0

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Appearance>
    return {
      scale: validScale(raw.scale) ? raw.scale : 100,
      reduceMotion: Boolean(raw.reduceMotion),
      theme: THEMES.includes(raw.theme as ThemePref) ? (raw.theme as ThemePref) : 'light',
      density: DENSITIES.includes(raw.density as Density) ? (raw.density as Density) : 'standard',
    }
  } catch {
    return { scale: 100, reduceMotion: false, theme: 'light', density: 'standard' }
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
}

export function resolveTheme(theme: ThemePref): 'light' | 'dark' {
  return theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme
}

let current: Appearance | null = null
let listening = false

function applyTheme(theme: ThemePref): void {
  const root = document.documentElement
  const resolved = resolveTheme(theme)
  if (resolved === 'dark') root.dataset.theme = 'dark'
  else delete root.dataset.theme
  // 桌面端：让原生窗口（标题栏、滚动条、系统弹窗）跟随
  const bridge = (window as unknown as { lulux?: { setTheme?: (t: ThemePref) => void } }).lulux
  try {
    bridge?.setTheme?.(theme)
  } catch {
    /* 旧版桌面壳没有这个接口 */
  }
}

export function applyAppearance(value: Appearance): void {
  current = value
  const root = document.documentElement
  root.style.setProperty('zoom', value.scale === 100 ? '' : String(value.scale / 100))
  root.classList.toggle('reduce-motion', value.reduceMotion)
  const density = value.density ?? 'standard'
  if (density === 'standard') delete root.dataset.density
  else root.dataset.density = density
  root.style.setProperty('--density', String(DENSITY_FACTOR[density]))
  applyTheme(value.theme)
  if (!listening && typeof window !== 'undefined' && window.matchMedia) {
    listening = true
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (current?.theme === 'system') applyTheme('system')
    })
  }
}

export function saveAppearance(value: Appearance): void {
  localStorage.setItem(KEY, JSON.stringify(value))
  applyAppearance(value)
}
