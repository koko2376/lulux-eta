import { db } from '../db.js'
import { AppError } from '../errors.js'
import {
  SETTING_KEYS,
  SETTINGS_SCHEMA,
  type SettingDefinition,
} from '../settings-schema.js'

interface SettingRow {
  key: string
  value: string
}

export type SettingsValidator = (key: string, value: string) => string

/** 额外的业务校验（例如 Agent / Provider 是否存在、URL 规范化），由上层注册，避免循环依赖 */
const extraValidators = new Map<string, SettingsValidator>()

export function registerSettingValidator(key: string, validator: SettingsValidator): void {
  extraValidators.set(key, validator)
}

function invalid(key: string, message: string): AppError {
  return new AppError(400, 'INVALID_SETTING', `设置项 ${key} ${message}`)
}

function coerce(def: SettingDefinition, raw: unknown): string {
  switch (def.type) {
    case 'boolean': {
      if (raw === true || raw === '1' || raw === 'true' || raw === 1) return '1'
      if (raw === false || raw === '0' || raw === 'false' || raw === 0) return '0'
      throw invalid(def.key, '必须是布尔值（true/false 或 "1"/"0"）')
    }
    case 'integer': {
      const value =
        typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN
      if (!Number.isInteger(value)) throw invalid(def.key, '必须是整数')
      if (def.min !== undefined && value < def.min) throw invalid(def.key, `不能小于 ${def.min}`)
      if (def.max !== undefined && value > def.max) throw invalid(def.key, `不能大于 ${def.max}`)
      return String(value)
    }
    case 'enum': {
      if (typeof raw !== 'string' || !def.enum?.includes(raw)) {
        throw invalid(def.key, `必须是 ${def.enum?.join(' / ')} 之一`)
      }
      return raw
    }
    default: {
      if (typeof raw !== 'string') throw invalid(def.key, '必须是字符串')
      if (raw.length > 2000) throw invalid(def.key, '过长')
      return raw.trim()
    }
  }
}

const defs = new Map(SETTINGS_SCHEMA.map((def) => [def.key, def]))

/** 校验并规范化一个设置补丁；未知键 400 UNKNOWN_SETTING */
export function validateSettingsPatch(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'VALIDATION_ERROR', '请求体必须是设置项对象')
  }
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = defs.get(key)
    if (!def) throw new AppError(400, 'UNKNOWN_SETTING', `未知设置项：${key}`)
    let value = coerce(def, raw)
    const extra = extraValidators.get(key)
    if (extra) {
      try {
        value = extra(key, value)
      } catch (error) {
        if (error instanceof AppError) throw error
        throw invalid(key, error instanceof Error ? error.message : String(error))
      }
    }
    result[key] = value
  }
  return result
}

/**
 * 旧键 toolApproval 与新键 defaultPermissionLevel 保持同步（契约 §6.11）：
 * 只改旧键时换算成新键（ask → ask，auto → full）；改新键时旧键跟着写（full → auto，其余 → ask）。
 */
function syncPermissionKeys(patch: Record<string, string>): Record<string, string> {
  const next = { ...patch }
  const level = next.defaultPermissionLevel
  if (level === 'read' || level === 'ask' || level === 'full') next.toolApproval = level === 'full' ? 'auto' : 'ask'
  else if (next.toolApproval === 'ask' || next.toolApproval === 'auto') next.defaultPermissionLevel = next.toolApproval === 'auto' ? 'full' : 'ask'
  return next
}

export const settingsService = {
  get(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as SettingRow | undefined
    return row?.value ?? defs.get(key)?.default
  },

  /** 只返回白名单内的键 */
  all(): Record<string, string> {
    const rows = db.prepare('SELECT key, value FROM settings ORDER BY key ASC').all() as unknown as SettingRow[]
    const stored = new Map(rows.map((row) => [row.key, row.value]))
    const result: Record<string, string> = {}
    for (const def of SETTINGS_SCHEMA) result[def.key] = stored.get(def.key) ?? def.default
    return result
  },

  schema() {
    return SETTINGS_SCHEMA.map(({ key, type, default: def, enum: values, min, max, description }) => ({
      key,
      type,
      default: def,
      ...(values ? { enum: values } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      description,
    }))
  },

  /** 写入已校验的值。内部调用（非 HTTP）也只能写白名单键 */
  update(input: Record<string, string>): Record<string, string> {
    const patch = syncPermissionKeys(input)
    const statement = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTING_KEYS.has(key)) continue
      statement.run(key, String(value))
    }
    return settingsService.all()
  },
}
