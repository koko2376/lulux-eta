import { readJsonFile, writeJsonFile } from './json-file'

/**
 * 界面偏好随端口迁移（userData/ui-storage.json）：
 * 页面的 localStorage 按 origin（http://127.0.0.1:<端口>）隔离，本地服务换了端口，界面里存的偏好
 * （面板宽度、已读标记、视图选项等 lulux.* 键）就整个变成空的。
 * preload 定期把这些键的快照交给主进程保管；下次在新的 origin 打开、而这个 origin 还没有任何 lulux.* 键时，
 * preload 在页面脚本运行前把快照写回去。
 *
 * 登录会话不在这里：会话由主进程单独保管（auth-state.json / connection.json），快照里一律剔除。
 */

export interface UiStorageSnapshot {
  origin: string
  items: Record<string, string>
  savedAt: number
}

/** 不随快照保存的键：会话类（由主进程单独保管） */
const EXCLUDED_KEYS = new Set(['lulux.session', 'lulux.localSession'])
const MAX_KEYS = 400
const MAX_BYTES = 512 * 1024

/** 校验 preload 送来的快照：只收 lulux.* 字符串键值，剔除会话，限制数量与大小 */
export function sanitizeUiStorage(input: unknown): UiStorageSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as { origin?: unknown; items?: unknown }
  if (typeof raw.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw.origin)) return null
  if (!raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) return null
  const items: Record<string, string> = {}
  let bytes = 0
  let count = 0
  for (const [key, value] of Object.entries(raw.items as Record<string, unknown>)) {
    if (!key.startsWith('lulux.') || key.length > 200 || EXCLUDED_KEYS.has(key)) continue
    if (typeof value !== 'string') continue
    bytes += key.length + value.length
    count += 1
    if (bytes > MAX_BYTES || count > MAX_KEYS) break
    items[key] = value
  }
  return { origin: raw.origin, items, savedAt: Date.now() }
}

export class UiStorageStore {
  constructor(private readonly file: string) {}

  get(): UiStorageSnapshot | null {
    const value = readJsonFile<Partial<UiStorageSnapshot>>(this.file).value
    if (!value) return null
    const clean = sanitizeUiStorage(value)
    return clean ? { ...clean, savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0 } : null
  }

  save(input: unknown): boolean {
    const snapshot = sanitizeUiStorage(input)
    if (!snapshot) return false
    writeJsonFile(this.file, snapshot)
    return true
  }
}
