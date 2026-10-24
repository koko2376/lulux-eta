import { fetchWithProxy } from '../http-client.js'
import { M49_TO_ISO2 } from '../trade-m49.js'
import { ProviderError, messageOf } from './errors.js'
import { createSerialQueue, sleep } from './queue.js'

/**
 * UN Comtrade 公共预览接口（免 Key）：
 * https://comtradeapi.un.org/public/v1/preview/C/A/HS?cmdCode=…&flowCode=…&period=…&partnerCode=0
 *
 * 给的是「国家层面」的海关统计（金额 / 重量），不是企业名单；部分国家会晚 1–2 年。
 * 预览每次最多 500 行，这里只取世界合计（partnerCode=0）的年度数据。
 */

const BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS'
const PROVIDER = 'UN Comtrade'
const REQUEST_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 30_000
const PREVIEW_MAX_ROWS = 500

const SOURCE_NOTE = '国家层面的海关统计，不是企业名单；部分国家数据会晚 1–2 年。'

const queue = createSerialQueue()

export interface MarketRow {
  /** ISO 3166-1 alpha-2；M49 表里没有的国家为 null */
  country: string | null
  countryName: string
  valueUsd: number
  netWeightKg: number | null
  /** 与上一年比，%；上一年没有数据时为 null */
  growthPct: number | null
  /** 占「全球合计」的百分比 */
  share: number
}

export interface MarketYear {
  year: number
  rows: MarketRow[]
}

export interface MarketOverviewResult {
  year: number
  rows: MarketRow[]
  /** 最新年份有多少国家报了数；上一年报了、今年还没报的大国（按上一年金额前 10），share 只按已报国家合计算 */
  coverage: { reporters: number; previousReporters: number; missingInLatest: Array<{ country: string | null; countryName: string; previousValueUsd: number }> }
  source: { name: 'UN Comtrade'; url: string[]; note: string }
}

export interface MarketOverviewOptions {
  /** HS 编码，最多取前 6 位 */
  hs: string
  /** 默认最近两个完整年（当前年 −2、−1） */
  years?: number[]
  flow?: 'M' | 'X'
  /** 返回前多少个国家，默认 15 */
  top?: number
  signal?: AbortSignal
  /** 测试用：请求间隔，默认 1000ms */
  intervalMs?: number
  /** 测试用：当前年份 */
  now?: Date
}

interface ComtradeRow {
  reporterCode?: number | string | null
  period?: string | number | null
  cmdCode?: string | null
  flowCode?: string | null
  primaryValue?: number | string | null
  netWgt?: number | string | null
}

interface ComtradeResponse {
  count?: number
  data?: ComtradeRow[] | null
  error?: unknown
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  } catch {
    return null
  }
})()

/** M49 报告国代码 → 中文国名（拿不到就用 ISO2） */
export function countryNameOf(reporterCode: number): { country: string | null; countryName: string } {
  const iso2 = M49_TO_ISO2[reporterCode] ?? null
  // Comtrade 的 490 = “Other Asia, nes”（实际为台湾地区的统计口径）
  if (reporterCode === 490) return { country: 'TW', countryName: '中国台湾' }
  if (!iso2) return { country: null, countryName: `Comtrade 报告方 ${reporterCode}` }
  let name = iso2
  try {
    const display = regionNames?.of(iso2)
    if (display && display !== '未知地区') name = display
  } catch {
    // 未知区域代码：退回 ISO2
  }
  return { country: iso2, countryName: name }
}

function normalizeHs(raw: string): string {
  const cleaned = (raw ?? '').replace(/[\s.]/g, '')
  if (!/^\d{2,10}$/.test(cleaned)) throw new ProviderError('BAD_ARGS', 'HS 编码必须是 2–10 位数字', PROVIDER)
  return cleaned.slice(0, 6).padEnd(6, '0')
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function netWeight(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 单年请求；非 JSON / 429 重试一次，仍失败抛 RATE_LIMITED（其它网络错误抛 NETWORK） */
async function fetchYear(
  url: string,
  options: { signal?: AbortSignal; intervalMs: number },
): Promise<ComtradeResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let status = 0
    let text = ''
    try {
      const response = await queue.run(async () => {
        const res = await fetchWithProxy(url, { headers: { Accept: 'application/json' }, signal: combined })
        return { status: res.status, text: await res.text() }
      }, options.intervalMs)
      status = response.status
      text = response.text
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (timeout.aborted) throw new ProviderError('NETWORK', 'UN Comtrade 请求超时（30 秒）', PROVIDER)
      throw new ProviderError('NETWORK', `UN Comtrade 请求失败：${messageOf(error)}`, PROVIDER)
    }

    let payload: ComtradeResponse | null = null
    try {
      payload = JSON.parse(text) as ComtradeResponse
    } catch {
      payload = null
    }
    if (status === 429 || !payload) {
      if (attempt >= 1) throw new ProviderError('RATE_LIMITED', 'UN Comtrade 暂时拒绝了请求，请稍后再试', PROVIDER)
      await sleep(options.intervalMs > 0 ? Math.max(options.intervalMs, REQUEST_INTERVAL_MS) : REQUEST_INTERVAL_MS)
      continue
    }
    if (status >= 400) throw new ProviderError('UPSTREAM', `UN Comtrade 返回 HTTP ${status}`, PROVIDER)
    if (payload.error) throw new ProviderError('UPSTREAM', `UN Comtrade 返回错误：${describeError(payload.error)}`, PROVIDER)
    return payload
  }
}

function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return '未知错误'
}

/** 取某一年的国家 / 全球合计（一个年份一次请求，请求内已含所有报告国） */
function aggregateYear(payload: ComtradeResponse, year: number): Map<number, { value: number; weight: number | null }> {
  const out = new Map<number, { value: number; weight: number | null }>()
  for (const row of payload.data ?? []) {
    if (String(row.period ?? '') !== String(year)) continue
    const reporter = Number(row.reporterCode)
    if (!Number.isInteger(reporter)) continue
    const value = num(row.primaryValue)
    const weight = netWeight(row.netWgt)
    const current = out.get(reporter)
    // 同一报告国可能有多行（不同 customs / mot 口径）：金额相加，重量为空时保留已知值
    if (current) {
      current.value += value
      if (weight !== null) current.weight = (current.weight ?? 0) + weight
    } else {
      out.set(reporter, { value, weight })
    }
  }
  return out
}

/**
 * 某 HS 编码的年度市场概览：按进口额（或出口额）降序给出前 top 个国家，
 * 附上一年对比的 growthPct 与占全球合计的 share。
 *
 * years 传多个时只返回最后一个年份的行，其余年份仅用于算增长（默认最近两个完整年）。
 */
export async function marketOverview(options: MarketOverviewOptions): Promise<MarketOverviewResult> {
  const hs6 = normalizeHs(options.hs)
  const flow = options.flow ?? 'M'
  if (flow !== 'M' && flow !== 'X') throw new ProviderError('BAD_ARGS', 'flow 只能是 M 或 X', PROVIDER)
  const top = options.top ?? 15
  if (!Number.isInteger(top) || top < 1 || top > PREVIEW_MAX_ROWS) {
    throw new ProviderError('BAD_ARGS', 'top 必须是 1–500 的整数', PROVIDER)
  }
  const currentYear = (options.now ?? new Date()).getUTCFullYear()
  const years = options.years ?? [currentYear - 2, currentYear - 1]
  if (!Array.isArray(years) || years.length === 0 || years.some((year) => !Number.isInteger(year) || year < 1962 || year > 2100)) {
    throw new ProviderError('BAD_ARGS', 'years 必须是年份列表（1962–2100）', PROVIDER)
  }
  const sorted = [...new Set(years)].sort((a, b) => a - b)
  const latest = sorted[sorted.length - 1]!
  const previous = sorted.length > 1 ? sorted[sorted.length - 2]! : latest - 1
  const intervalMs = options.intervalMs ?? REQUEST_INTERVAL_MS
  const http = { signal: options.signal, intervalMs }

  const urls: string[] = []
  const byYear = new Map<number, Map<number, { value: number; weight: number | null }>>()
  for (const year of [previous, latest]) {
    if (byYear.has(year)) continue
    // partnerCode=0 表示与世界合计（不是某个伙伴国）
    const url = `${BASE}?cmdCode=${hs6}&flowCode=${flow}&period=${year}&partnerCode=0`
    urls.push(url)
    byYear.set(year, aggregateYear(await fetchYear(url, http), year))
  }

  const latestRows = byYear.get(latest) ?? new Map()
  const previousRows = byYear.get(previous) ?? new Map()
  // 预览里通常没有 reporterCode=0 的「全球合计」行：没有就用所有报告国求和
  const worldValue =
    latestRows.get(0)?.value ??
    [...latestRows.entries()].reduce((sum, [reporter, row]) => (reporter === 0 ? sum : sum + row.value), 0)
  const rows: MarketRow[] = []
  for (const [reporter, row] of latestRows) {
    if (reporter === 0) continue
    if (row.value <= 0) continue
    const { country, countryName } = countryNameOf(reporter)
    const before = previousRows.get(reporter)
    const growthPct =
      before && before.value > 0 && row.value > 0 ? Math.round(((row.value - before.value) / before.value) * 10_000) / 100 : null
    rows.push({
      country,
      countryName,
      valueUsd: Math.round(row.value * 100) / 100,
      netWeightKg: row.weight === null ? null : Math.round(row.weight * 1000) / 1000,
      growthPct,
      share: worldValue > 0 ? Math.round((row.value / worldValue) * 10_000) / 100 : 0,
    })
  }
  rows.sort((a, b) => b.valueUsd - a.valueUsd || a.countryName.localeCompare(b.countryName))

  const missingInLatest = [...previousRows.entries()]
    .filter(([reporter, row]) => reporter !== 0 && row.value > 0 && !latestRows.has(reporter))
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 10)
    .map(([reporter, row]) => ({ ...countryNameOf(reporter), previousValueUsd: Math.round(row.value * 100) / 100 }))
  return {
    year: latest,
    rows: rows.slice(0, top),
    coverage: {
      reporters: [...latestRows.keys()].filter((r) => r !== 0).length,
      previousReporters: [...previousRows.keys()].filter((r) => r !== 0).length,
      missingInLatest,
    },
    source: { name: 'UN Comtrade', url: urls, note: SOURCE_NOTE },
  }
}
