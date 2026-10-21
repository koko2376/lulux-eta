import { db } from '../db.js'
import { AppError } from '../errors.js'
import {
  decryptSecret,
  encryptSecret,
  previewSecret,
  SecretUnavailableError,
} from '../security/secrets.js'
import type { Provider, ProviderKind, PublicProvider } from '../types.js'
import { newId } from '../utils/id.js'
import { assertHttpUrl } from '../validation.js'
import { fetchWithProxy } from './http-client.js'
import {
  autoReasoningChoice,
  capabilitiesFor,
  choiceOf,
  forgetLearnedReasoning,
  isReasoningChoice,
  type ModelCapEntry,
  type ModelCapsMap,
  type ReasoningChoice,
} from './llm/capabilities.js'
import { joinUrl, readErrorMessage } from './llm/stream-utils.js'

/** 模型发现请求超时 */
export const DISCOVER_TIMEOUT_MS = 15_000

interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  api_key: string
  model: string
  models: string
  model_caps?: string | null
  created_at: number
}

function parseModels(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function parseModelCaps(raw: string | null | undefined): ModelCapsMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ModelCapsMap = {}
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry: ModelCapEntry = {}
      const record = value as Record<string, unknown>
      if (isReasoningChoice(record.reasoning)) entry.reasoning = record.reasoning
      if (isReasoningChoice(record.detected)) entry.detected = record.detected
      if (entry.reasoning || entry.detected) out[model] = entry
    }
    return out
  } catch {
    return {}
  }
}

/** 只保留仍在模型列表里的条目 */
function pruneModelCaps(caps: ModelCapsMap, models: string[]): ModelCapsMap {
  const out: ModelCapsMap = {}
  for (const model of models) if (caps[model]) out[model] = caps[model]
  return out
}

function cleanModels(values: string[] | undefined): string[] {
  const result: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed && !result.includes(trimmed)) result.push(trimmed)
  }
  return result
}

/**
 * 默认模型必须存在于模型列表中。
 * 列表为空时把默认模型补进去；列表被改动且原模型已移除时回退到第一个。
 */
function resolveModel(
  model: string,
  models: string[],
): { model: string; models: string[] } {
  const preferred = model.trim()
  if (models.length === 0) {
    return preferred
      ? { model: preferred, models: [preferred] }
      : { model: '', models: [] }
  }
  if (preferred && models.includes(preferred)) {
    return { model: preferred, models }
  }
  return { model: models[0]!, models }
}

function toProvider(row: ProviderRow): Provider {
  const models = parseModels(row.models)
  // 旧数据库只有 model 一列，读出来时补进列表
  if (row.model && !models.includes(row.model)) models.unshift(row.model)

  let apiKey = ''
  let apiKeyError: string | null = null
  try {
    apiKey = decryptSecret(row.api_key)
  } catch (error) {
    apiKeyError =
      error instanceof SecretUnavailableError ? error.message : 'API Key 无法读取'
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url,
    apiKey,
    hasStoredKey: row.api_key.length > 0,
    apiKeyError,
    model: row.model,
    models,
    modelCaps: parseModelCaps(row.model_caps),
    createdAt: row.created_at,
  }
}

/** 对外结构：绝不包含明文 Key */
export function toPublicProvider(provider: Provider): PublicProvider {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    model: provider.model,
    models: provider.models,
    createdAt: provider.createdAt,
    hasApiKey: provider.hasStoredKey,
    apiKeyPreview: previewSecret(provider.apiKey),
    apiKeyError: provider.apiKeyError,
    modelReasoning: Object.fromEntries(
      provider.models.map((model) => {
        const entry = provider.modelCaps[model]
        return [
          model,
          {
            manual: entry?.reasoning ?? null,
            detected: entry?.detected ?? null,
            auto: autoReasoningChoice(model, provider),
            effective: choiceOf(capabilitiesFor(model, provider)),
          },
        ]
      }),
    ),
  }
}

export interface CreateProviderInput {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  model?: string
  models?: string[]
}

export interface UpdateProviderInput {
  name?: string
  kind?: ProviderKind
  baseUrl?: string
  apiKey?: string
  model?: string
  models?: string[]
  /** 内部使用：整体替换按模型能力（会按模型列表裁剪） */
  modelCaps?: ModelCapsMap
}

export const providerService = {
  list(): Provider[] {
    const rows = db
      .prepare('SELECT * FROM providers ORDER BY created_at ASC')
      .all() as unknown as ProviderRow[]
    return rows.map(toProvider)
  },

  get(id: string): Provider | undefined {
    const row = db
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as unknown as ProviderRow | undefined
    return row ? toProvider(row) : undefined
  },

  create(input: CreateProviderInput): Provider {
    const resolved = resolveModel(input.model ?? '', cleanModels(input.models))

    const apiKey = input.apiKey?.trim() ?? ''
    const provider: Provider = {
      id: newId('prov'),
      name: input.name.trim(),
      kind: input.kind,
      baseUrl: assertHttpUrl(input.baseUrl, 'Base URL').replace(/\/+$/, ''),
      apiKey,
      hasStoredKey: apiKey.length > 0,
      apiKeyError: null,
      model: resolved.model,
      models: resolved.models,
      modelCaps: {},
      createdAt: Date.now(),
    }

    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, api_key, model, models, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      provider.id,
      provider.name,
      provider.kind,
      provider.baseUrl,
      encryptSecret(provider.apiKey),
      provider.model,
      JSON.stringify(provider.models),
      provider.createdAt,
    )

    return provider
  },

  update(id: string, patch: UpdateProviderInput): Provider | undefined {
    const current = providerService.get(id)
    if (!current) return undefined

    const models =
      patch.models !== undefined ? cleanModels(patch.models) : current.models
    const resolved = resolveModel(
      patch.model !== undefined ? patch.model : current.model,
      models,
    )

    const newKey = patch.apiKey?.trim() ? patch.apiKey.trim() : null
    const next: Provider = {
      ...current,
      name: patch.name?.trim() || current.name,
      kind: patch.kind ?? current.kind,
      baseUrl: patch.baseUrl?.trim()
        ? assertHttpUrl(patch.baseUrl, 'Base URL').replace(/\/+$/, '')
        : current.baseUrl,
      // 空 API Key 表示保持原有 Key 不变
      apiKey: newKey ?? current.apiKey,
      hasStoredKey: newKey ? true : current.hasStoredKey,
      apiKeyError: newKey ? null : current.apiKeyError,
      model: resolved.model,
      models: resolved.models,
      modelCaps: pruneModelCaps(patch.modelCaps ?? current.modelCaps, resolved.models),
    }
    const storedKey = newKey
      ? encryptSecret(newKey)
      : ((db.prepare('SELECT api_key FROM providers WHERE id = ?').get(id) as unknown as { api_key: string })
          .api_key)

    db.prepare(
      `UPDATE providers
       SET name = ?, kind = ?, base_url = ?, api_key = ?, model = ?, models = ?, model_caps = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.kind,
      next.baseUrl,
      storedKey,
      next.model,
      JSON.stringify(next.models),
      JSON.stringify(next.modelCaps),
      next.id,
    )

    return next
  },

  /**
   * 设置某个模型的思考强度：choice 为 null 表示恢复自动检测。
   * 模型必须在该 Provider 的模型列表里（任意模型名都可以先加进列表再设置）。
   */
  setModelReasoning(id: string, model: string, choice: ReasoningChoice | null): Provider | undefined {
    const current = providerService.get(id)
    if (!current) return undefined
    const name = model.trim()
    if (!current.models.includes(name)) {
      throw new AppError(400, 'UNKNOWN_MODEL', `Provider「${current.name}」没有模型「${name.slice(0, 80)}」`)
    }
    const entry: ModelCapEntry = { ...(current.modelCaps[name] ?? {}) }
    if (choice) entry.reasoning = choice
    else delete entry.reasoning
    const modelCaps = { ...current.modelCaps }
    if (entry.reasoning || entry.detected) modelCaps[name] = entry
    else delete modelCaps[name]
    forgetLearnedReasoning(name)
    return providerService.update(id, { modelCaps })
  },

  remove(id: string): boolean {
    const result = db.prepare('DELETE FROM providers WHERE id = ?').run(id)
    return Number(result.changes) > 0
  },
}

/**
 * 从 /models 单条记录的元数据里识别推理支持（没有相关字段时返回 undefined，不做猜测）：
 *  - OpenRouter：supported_parameters 含 reasoning / include_reasoning / reasoning_effort
 *  - capabilities.reasoning / capabilities.thinking（布尔），或 capabilities / features 数组含 reasoning / thinking
 *  - supported_effort_levels / reasoning_efforts 等非空数组
 */
export function detectReasoning(item: unknown): ReasoningChoice | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>
  const list = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : null
  const params = list(record.supported_parameters)
  if (params) {
    if (params.some((p) => p === 'reasoning' || p === 'include_reasoning' || p === 'reasoning_effort')) return 'openai'
    return 'none'
  }
  for (const key of ['supported_effort_levels', 'reasoning_efforts', 'reasoning_effort_levels', 'supported_reasoning_efforts']) {
    const levels = list(record[key])
    if (levels && levels.length) return 'openai'
  }
  const caps = record.capabilities
  const capList = list(caps) ?? list(record.features)
  if (capList) {
    if (capList.some((c) => c === 'reasoning' || c === 'thinking')) return 'openai'
    return undefined
  }
  if (caps && typeof caps === 'object') {
    const c = caps as Record<string, unknown>
    const flag = c.reasoning ?? c.thinking ?? c.reasoning_effort
    if (flag === true) return 'openai'
    if (flag === false) return 'none'
    if (flag && typeof flag === 'object') {
      const supported = (flag as Record<string, unknown>).supported
      if (supported === true) return 'openai'
      if (supported === false) return 'none'
    }
  }
  return undefined
}

function extractModelMeta(payload: unknown): Map<string, ReasoningChoice> {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as { data?: unknown }).data ?? (payload as { models?: unknown }).models)
      : undefined
  const out = new Map<string, ReasoningChoice>()
  if (!Array.isArray(rows)) return out
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as { id?: unknown; name?: unknown; model?: unknown }
    const id =
      typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : typeof record.model === 'string' ? record.model : ''
    const detected = detectReasoning(item)
    if (id && detected) out.set(id, detected)
  }
  return out
}

function extractModelIds(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as { data?: unknown }).data ??
        (payload as { models?: unknown }).models)
      : undefined

  if (!Array.isArray(rows)) return []

  const ids: string[] = []
  for (const item of rows) {
    let id = ''
    if (typeof item === 'string') {
      id = item
    } else if (item && typeof item === 'object') {
      const record = item as { id?: unknown; name?: unknown; model?: unknown }
      id =
        typeof record.id === 'string'
          ? record.id
          : typeof record.name === 'string'
            ? record.name
            : typeof record.model === 'string'
              ? record.model
              : ''
    }
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * 向服务商拉取 /models 列表并合并进本地配置。
 * OpenAI 兼容接口用 Bearer，Anthropic 使用 x-api-key。
 */
export async function discoverProviderModels(
  id: string,
): Promise<Provider | undefined> {
  const provider = providerService.get(id)
  if (!provider) return undefined
  if (provider.apiKeyError) {
    throw new AppError(409, 'API_KEY_UNAVAILABLE', provider.apiKeyError)
  }
  assertHttpUrl(provider.baseUrl, 'Base URL')

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (provider.kind === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`
  }

  let response: Response
  try {
    response = await fetchWithProxy(joinUrl(provider.baseUrl, '/models'), {
      headers,
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new AppError(
      502,
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      timedOut
        ? `连接服务商超时（${DISCOVER_TIMEOUT_MS / 1000} 秒）`
        : `无法连接服务商：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new AppError(
      502,
      'UPSTREAM_ERROR',
      `服务商返回 ${response.status}：${await readErrorMessage(response)}`,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new AppError(502, 'UPSTREAM_ERROR', '服务商返回的不是 JSON，请检查 Base URL')
  }

  const discovered = extractModelIds(payload)
  if (discovered.length === 0) {
    throw new AppError(502, 'UPSTREAM_ERROR', '服务商没有返回任何模型')
  }

  // 保留手工添加、但服务商没有列出的模型
  const merged = [
    ...discovered,
    ...provider.models.filter((model) => !discovered.includes(model)),
  ]
  // 上游元数据里能识别的推理支持记为 detected（手动设置不受影响）
  const meta = extractModelMeta(payload)
  const modelCaps: ModelCapsMap = { ...provider.modelCaps }
  for (const [model, detected] of meta) {
    modelCaps[model] = { ...(modelCaps[model] ?? {}), detected }
  }
  return providerService.update(id, { models: merged, modelCaps })
}
