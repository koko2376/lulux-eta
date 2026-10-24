import { z } from 'zod'
import { db } from '../../db.js'
import { AppError } from '../../errors.js'
import { fetchWithProxy } from '../http-client.js'
import { settingsService } from '../settings-service.js'
import { transaction } from '../../utils/tx.js'

/**
 * 汇率：只按 USD 为基准存一份（1 USD = rate × quote），交叉汇率现算。
 * 数据源都免注册：Frankfurter（欧洲央行）为主，open.er-api.com 为备。
 * 缓存 6 小时；拉取失败时继续用旧数据并标记 stale。
 */

export const FX_CACHE_MS = 6 * 60 * 60 * 1000
export const FX_BASE = 'USD'

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?base=USD'
const ERAPI_URL = 'https://open.er-api.com/v6/latest/USD'

export type FxSourceSetting = 'auto' | 'frankfurter' | 'erapi'
export type FxSource = 'locked' | 'frankfurter' | 'erapi' | 'identity'

export interface FxRate {
  pair: string
  from: string
  to: string
  rate: number
  source: FxSource
  asOf: string
  locked: boolean
  stale: boolean
}

interface RateRow {
  base: string
  quote: string
  rate: number
  source: string
  as_of: string
  fetched_at: number
}

interface FxTable {
  /** quote 币种 → 1 USD 等于多少 */
  rates: Map<string, { rate: number; source: 'frankfurter' | 'erapi'; asOf: string }>
  fetchedAt: number
  stale: boolean
  error: string | null
}

/** 最近一次刷新的状态（stale / error），供 rate() / table() 带上 */
let lastStatus: { stale: boolean; error: string | null } = { stale: false, error: null }
/** 同一时刻的并发调用复用同一个进行中的请求 */
let inFlight: Promise<FxTable> | null = null
/** 上次拉取失败的时间：失败后 10 分钟内不再重试（离线时避免每次计算都等两次超时） */
let lastFailureAt = 0
export const FX_RETRY_MS = 10 * 60 * 1000

const FX_LOCKS = z.record(
  z
    .string()
    .regex(/^[A-Z]{3}\/[A-Z]{3}$/, '锁汇的键应形如 USD/CNY（三位大写币种）'),
  z.number().finite().positive('锁定的汇率必须大于 0'),
)

/** 设置项 fxLocks 的校验（settings-service 保存前调用） */
export function parseFxLocks(raw: string): string {
  if (!raw.trim()) return '{}'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('必须是合法的 JSON，如 {"USD/CNY":7.1}')
  }
  const result = FX_LOCKS.safeParse(parsed)
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? '格式不正确')
  return JSON.stringify(result.data)
}

export function fxLocks(): Record<string, number> {
  const raw = settingsService.get('fxLocks') ?? '{}'
  try {
    const parsed = FX_LOCKS.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function readRows(): RateRow[] {
  return db.prepare('SELECT * FROM fx_rates WHERE base = ?').all(FX_BASE) as unknown as RateRow[]
}

function tableFromRows(rows: RateRow[], stale: boolean, error: string | null): FxTable {
  const rates = new Map<string, { rate: number; source: 'frankfurter' | 'erapi'; asOf: string }>()
  let fetchedAt = 0
  for (const row of rows) {
    rates.set(row.quote, {
      rate: Number(row.rate),
      source: row.source === 'erapi' ? 'erapi' : 'frankfurter',
      asOf: row.as_of,
    })
    fetchedAt = Math.max(fetchedAt, Number(row.fetched_at))
  }
  return { rates, fetchedAt, stale, error }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchWithProxy(url, { method: 'GET', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchFrankfurter(): Promise<{ rates: Map<string, number>; asOf: string }> {
  const data = (await fetchJson(FRANKFURTER_URL)) as { base?: string; date?: string; rates?: Record<string, number> }
  if (!data || typeof data.rates !== 'object' || data.rates === null) throw new Error('返回格式不正确')
  const rates = new Map<string, number>()
  for (const [quote, value] of Object.entries(data.rates)) {
    const rate = Number(value)
    if (Number.isFinite(rate) && rate > 0) rates.set(quote.toUpperCase(), rate)
  }
  rates.set(FX_BASE, 1)
  if (rates.size <= 1) throw new Error('没有返回汇率')
  return { rates, asOf: typeof data.date === 'string' ? data.date : '' }
}

async function fetchErApi(): Promise<{ rates: Map<string, number>; asOf: string }> {
  const data = (await fetchJson(ERAPI_URL)) as {
    result?: string
    time_last_update_unix?: number
    rates?: Record<string, number>
  }
  if (!data || data.result !== 'success' || typeof data.rates !== 'object' || data.rates === null) {
    throw new Error('返回格式不正确')
  }
  const rates = new Map<string, number>()
  for (const [quote, value] of Object.entries(data.rates)) {
    const rate = Number(value)
    if (Number.isFinite(rate) && rate > 0) rates.set(quote.toUpperCase(), rate)
  }
  rates.set(FX_BASE, 1)
  if (rates.size <= 1) throw new Error('没有返回汇率')
  const asOf =
    typeof data.time_last_update_unix === 'number'
      ? new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 10)
      : ''
  return { rates, asOf }
}

function store(fetched: { rates: Map<string, number>; asOf: string }, source: 'frankfurter' | 'erapi'): FxTable {
  const now = Date.now()
  transaction(() => {
    db.prepare('DELETE FROM fx_rates WHERE base = ?').run(FX_BASE)
    const insert = db.prepare(
      `INSERT INTO fx_rates (base, quote, rate, source, as_of, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const [quote, rate] of fetched.rates) {
      if (quote === FX_BASE) continue
      insert.run(FX_BASE, quote, rate, source, fetched.asOf, now)
    }
  })
  return tableFromRows(readRows(), false, null)
}

/** 真正拉取一次：按 fxSource 选择来源（auto = 先主后备） */
async function fetchRates(): Promise<FxTable> {
  const setting = (settingsService.get('fxSource') ?? 'auto') as FxSourceSetting
  const sources: Array<'frankfurter' | 'erapi'> =
    setting === 'frankfurter' ? ['frankfurter'] : setting === 'erapi' ? ['erapi'] : ['frankfurter', 'erapi']
  const errors: string[] = []
  for (const source of sources) {
    try {
      const fetched = source === 'frankfurter' ? await fetchFrankfurter() : await fetchErApi()
      lastStatus = { stale: false, error: null }
      lastFailureAt = 0
      return store(fetched, source)
    } catch (error) {
      errors.push(`${source}: ${messageOf(error)}`)
    }
  }
  throw new Error(errors.join('；') || '没有可用的汇率来源')
}

/**
 * 当前汇率表：缓存 6 小时内直接读库；否则拉取，失败时退回旧数据（stale）。
 * 从未成功拉取过且失败 → 502 FX_UNAVAILABLE。
 */
export async function getRates(force = false): Promise<FxTable> {
  const rows = readRows()
  const current = tableFromRows(rows, lastStatus.stale, lastStatus.error)
  if (!force && current.rates.size > 0 && Date.now() - current.fetchedAt < FX_CACHE_MS) return { ...current, stale: false, error: null }
  if (!force && current.rates.size > 0 && Date.now() - lastFailureAt < FX_RETRY_MS) return { ...current, stale: true }
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      return await fetchRates()
    } catch (error) {
      const message = messageOf(error)
      lastFailureAt = Date.now()
      const old = tableFromRows(readRows(), true, message)
      if (old.rates.size === 0) {
        throw new AppError(
          502,
          'FX_UNAVAILABLE',
          '汇率暂时获取不到，请稍后再试，或在设置里手动锁定汇率',
        )
      }
      lastStatus = { stale: true, error: message }
      return old
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function lockedRate(from: string, to: string): number | null {
  const locks = fxLocks()
  const direct = locks[`${from}/${to}`]
  if (direct !== undefined) return direct
  const inverse = locks[`${to}/${from}`]
  if (inverse !== undefined && inverse > 0) return 1 / inverse
  return null
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** 交叉汇率：A→B = (USD→B) / (USD→A) */
export async function rate(fromInput: string, toInput: string): Promise<FxRate> {
  const from = fromInput.trim().toUpperCase()
  const to = toInput.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new AppError(400, 'BAD_ARGS', `币种代码不正确：${from}/${to}`)
  }
  if (from === to) {
    return { pair: `${from}/${to}`, from, to, rate: 1, source: 'identity', asOf: '', locked: false, stale: false }
  }
  const locked = lockedRate(from, to)
  if (locked !== null) {
    return { pair: `${from}/${to}`, from, to, rate: locked, source: 'locked', asOf: '', locked: true, stale: false }
  }
  // 两条腿经 USD 换算：每条腿先看锁汇，没有再用实时表；两条都锁定时完全不请求网络
  const legLocks = [from === FX_BASE ? 1 : lockedRate(FX_BASE, from), to === FX_BASE ? 1 : lockedRate(FX_BASE, to)]
  const anyLocked = (from !== FX_BASE && legLocks[0] !== null) || (to !== FX_BASE && legLocks[1] !== null)
  const table = legLocks[0] !== null && legLocks[1] !== null ? null : await getRates()
  const usdTo = (code: string, lock: number | null): number | undefined => (lock !== null ? lock : table?.rates.get(code)?.rate)
  const fromRate = usdTo(from, legLocks[0]!)
  const toRate = usdTo(to, legLocks[1]!)
  if (!fromRate || !toRate) {
    const missing = !fromRate ? from : to
    throw new AppError(502, 'FX_UNAVAILABLE', `汇率数据里没有币种 ${missing}，请稍后再试或在设置里手动锁定`)
  }
  const liveLeg = [legLocks[0] === null ? from : null, legLocks[1] === null ? to : null].filter((code): code is string => code !== null)
  const liveSources = liveLeg.map((code) => table?.rates.get(code)?.source)
  const source: FxSource = liveLeg.length === 0 ? 'locked' : liveSources.includes('erapi') ? 'erapi' : 'frankfurter'
  const asOf = liveLeg.length === 0 ? '' : (table?.rates.get(liveLeg[0]!)?.asOf ?? '')
  return {
    pair: `${from}/${to}`,
    from,
    to,
    rate: round6(toRate / fromRate),
    source,
    asOf,
    locked: anyLocked,
    stale: liveLeg.length > 0 ? Boolean(table?.stale) : false,
  }
}

/** 换算金额（结果保留 2 位） */
export async function convert(amount: number, from: string, to: string): Promise<{ amount: number; fx: FxRate }> {
  const fx = await rate(from, to)
  return { amount: Math.round(amount * fx.rate * 100) / 100, fx }
}

/** 界面展示用：base → quotes 的汇率列表（base 自身为 1） */
export async function table(baseInput: string, quotes: string[]): Promise<{ base: string; stale: boolean; error: string | null; rates: FxRate[] }> {
  const base = baseInput.trim().toUpperCase() || FX_BASE
  const pairs = [...new Set(quotes.map((quote) => quote.trim().toUpperCase()).filter((quote) => /^[A-Z]{3}$/.test(quote)))]
  const rates = await Promise.all(pairs.map((quote) => rate(base, quote)))
  return { base, stale: rates.some((item) => item.stale), error: rates.find((item) => item.stale) ? lastStatus.error : null, rates }
}

/** 强制刷新（设置里的“立即更新”/POST /api/fx/refresh） */
export async function refresh(): Promise<FxTable> {
  return getRates(true)
}

/** 测试用：清掉失败退避 */
export function resetFxBackoff(): void {
  lastFailureAt = 0
}

export const fxService = { rate, convert, table, refresh, getRates, parseFxLocks, locks: fxLocks }
