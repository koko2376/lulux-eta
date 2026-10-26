/**
 * 自动更新（契约 §9.2、docs/AUTO-UPDATE.md 第 4–5 节）。
 * - 桌面端 preload 提供 window.lulux.updater（旧 preload 为 window.luluxAgent.updater，接口相同）
 * - 浏览器 / 远程网页没有 updater：界面隐藏更新操作，只给“前往下载页”
 * - 全局只维护一份状态：关于页与全局“新版本已就绪”提示共用，订阅按引用计数，最后一个使用者离开时取消
 */
import { reactive } from 'vue'
import { t } from '../i18n'

export type UpdateChannel = 'stable' | 'beta'
export type UpdaterStatus =
  'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
export type UpdaterLimitation =
  'dev' | 'unconfigured' | 'mac-unsigned' | 'portable' | 'not-appimage' | 'unsupported-platform'

export interface UpdaterState {
  status: UpdaterStatus
  currentVersion: string
  platform: string
  arch: string
  canCheck: boolean
  canAutoInstall: boolean
  limitation: UpdaterLimitation | null
  channel: UpdateChannel
  source: { provider: 'github'; repo: string } | { provider: 'generic'; url: string; custom?: boolean } | null
  downloadPage: string | null
  available: {
    version: string
    releaseName: string | null
    releaseDate: string | null
    notes: string
    prerelease: boolean
  } | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  lastCheckedAt: string | null
  /** kind：旧版桌面端没有 */
  lastError: { message: string; at: string; interactive: boolean; kind?: UpdateErrorKind } | null
}

export type UpdateErrorKind = 'network' | 'not-found' | 'forbidden' | 'bad-feed' | 'other'

export interface UpdaterSettings {
  autoCheck: boolean
  autoDownload: boolean
  channel: UpdateChannel
  skippedVersion: string | null
  /** 自定义更新源（generic）；旧版桌面端没有 */
  feedUrl?: string | null
}

export interface UpdaterBridge {
  check(): Promise<UpdaterState>
  download(): Promise<UpdaterState>
  install(): Promise<boolean>
  getState(): Promise<UpdaterState>
  onState(listener: (state: UpdaterState) => void): () => void
  getSettings(): Promise<UpdaterSettings>
  setSettings(patch: Partial<UpdaterSettings>): Promise<UpdaterSettings>
}

export function getUpdater(
  w: Partial<Window> | undefined = typeof window === 'undefined' ? undefined : window,
): UpdaterBridge | null {
  const bridge = (w?.lulux?.updater ?? (w?.luluxAgent as { updater?: unknown } | undefined)?.updater) as
    UpdaterBridge | undefined
  return bridge && typeof bridge.getState === 'function' && typeof bridge.onState === 'function' ? bridge : null
}

/** canCheck=false 的原因（AUTO-UPDATE.md 5.2） */
export function limitationText(limitation: UpdaterLimitation | null): string {
  switch (limitation) {
    case 'unconfigured':
      return t('updater.k522dt4')
    case 'dev':
      return t('updater.ke9s551')
    case 'mac-unsigned':
      return t('updater.k1249y68')
    case 'portable':
      return t('updater.kn2agq2')
    case 'not-appimage':
      return t('updater.k8bxa1s')
    case 'unsupported-platform':
      return t('updater.k1pqb1s3')
    default:
      return ''
  }
}

/** 更新检查失败的说明：按错误类别给出可操作的提示，原始信息另行显示 */
export function updateErrorText(error: { message: string; kind?: UpdateErrorKind } | null, customFeed = false): string {
  if (!error) return ''
  switch (error.kind) {
    case 'network':
      return customFeed ? t('ops.updErrNetworkCustom') : t('ops.updErrNetwork')
    case 'not-found':
      return customFeed ? t('ops.updErrNotFoundCustom') : t('ops.updErrNotFound')
    case 'forbidden':
      return t('ops.updErrForbidden')
    case 'bad-feed':
      return t('ops.updErrBadFeed')
    default:
      return error.message
  }
}

export function formatMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  if (bytesPerSecond < 1024 * 1024) return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

/** “刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 2026-10-01” */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return t('updater.k72h7ps')
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return t('updater.k72h7ps')
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t('updater.k17y3gw2')
  if (min < 60) return t('updater.kqrn1ac', [min])
  const hours = Math.floor(min / 60)
  if (hours < 24) return t('updater.k11myqaj', [hours])
  const days = Math.floor(hours / 24)
  if (days < 7) return t('updater.k1446nw9', [days])
  return new Date(ts).toISOString().slice(0, 10)
}

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
}

interface Store {
  state: UpdaterState | null
  settings: UpdaterSettings | null
  /** 用户在全局提示上点了“稍后”的版本：同一版本不再显示提示条 */
  dismissedVersion: string | null
}

export const updater = reactive<Store>({ state: null, settings: null, dismissedVersion: null })

let users = 0
let off: (() => void) | null = null

/** 关于页 / 全局提示挂载时调用；返回释放函数（卸载时调用） */
export function useUpdaterSubscription(): () => void {
  const bridge = getUpdater()
  if (!bridge) return () => undefined
  users += 1
  if (users === 1) {
    off = bridge.onState((s) => {
      updater.state = s
    })
    void bridge
      .getState()
      .then((s) => {
        updater.state = s
      })
      .catch(() => undefined)
    void bridge
      .getSettings()
      .then((s) => {
        updater.settings = s
      })
      .catch(() => undefined)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    users -= 1
    if (users === 0) {
      off?.()
      off = null
    }
  }
}
