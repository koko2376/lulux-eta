import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 小型 JSON 配置文件的安全读写（auth-state.json / connection.json / desktop-prefs.json / updater.json）：
 *
 * - 写：先写同目录的 `<file>.tmp` 并 fsync，再 rename 覆盖正式文件；写之前把当前正式文件复制成 `<file>.bak`。
 *   写到一半断电 / 进程被杀时，正式文件要么是旧的完整内容，要么是新的完整内容，不会留下半截 JSON。
 * - 读：解析失败时把损坏的文件改名为 `<file>.corrupt`（留给排查，不再被覆盖成空对象），
 *   再尝试读 `<file>.bak`；都读不出来才返回 null，由调用方用默认值。
 * - mode：需要仅本用户可读时传 0o600（rename 后再 chmod 一次，覆盖旧文件残留的权限）。
 */

export interface ReadResult<T> {
  value: T | null
  /** 正式文件损坏、已改名为 .corrupt */
  corrupt: boolean
  /** 内容来自 .bak */
  fromBackup: boolean
}

function parseObject(text: string): Record<string, unknown> | null {
  const parsed = JSON.parse(text) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

export function readJsonFile<T extends object>(file: string, onWarn?: (message: string) => void): ReadResult<T> {
  if (!existsSync(file)) {
    // 正式文件不在（例如上次 rename 前被杀）：看备份
    return readBackup<T>(file, false, onWarn)
  }
  try {
    const value = parseObject(readFileSync(file, 'utf8'))
    if (value) return { value: value as T, corrupt: false, fromBackup: false }
    throw new Error('不是 JSON 对象')
  } catch (error) {
    try {
      renameSync(file, `${file}.corrupt`)
    } catch {
      // 改名失败（只读目录）：照样当作损坏处理
    }
    onWarn?.(`${file} 已损坏，已另存为 .corrupt：${error instanceof Error ? error.message : String(error)}`)
    return readBackup<T>(file, true, onWarn)
  }
}

function readBackup<T>(file: string, corrupt: boolean, onWarn?: (message: string) => void): ReadResult<T> {
  const backup = `${file}.bak`
  if (!existsSync(backup)) return { value: null, corrupt, fromBackup: false }
  try {
    const value = parseObject(readFileSync(backup, 'utf8'))
    if (value) {
      if (corrupt) onWarn?.(`${file} 已从 .bak 恢复`)
      return { value: value as T, corrupt, fromBackup: true }
    }
  } catch {
    // 备份也坏了
  }
  return { value: null, corrupt, fromBackup: false }
}

export function writeJsonFile(file: string, data: unknown, options: { mode?: number } = {}): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const text = JSON.stringify(data, null, 2)
  const fd = openSync(tmp, 'w', options.mode ?? 0o644)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (options.mode !== undefined) chmodQuiet(tmp, options.mode)
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`)
      if (options.mode !== undefined) chmodQuiet(`${file}.bak`, options.mode)
    } catch {
      // 备份失败不影响写入
    }
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  if (options.mode !== undefined) chmodQuiet(file, options.mode)
}

function chmodQuiet(file: string, mode: number): void {
  try {
    chmodSync(file, mode)
  } catch {
    // Windows 忽略
  }
}
