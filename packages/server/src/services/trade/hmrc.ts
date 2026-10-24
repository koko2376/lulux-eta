import { fetchWithProxy } from '../http-client.js'
import type { ProspectEvidence, ProspectFlag } from '../prospect-service.js'
import { ProviderError, messageOf } from './errors.js'
import { createSerialQueue, sleep } from './queue.js'

/**
 * 英国 HMRC uktradeinfo 开放接口（https://api.uktradeinfo.com，OData，无鉴权，
 * Open Government Licence v3）。
 *
 * 能回答的问题只有：「某个 8 位 CN 商品，在某几个月，有哪些公司申报过进口 / 出口」。
 * 没有金额、没有数量、也没有低于申报门槛的小额进口。
 *
 * 限流非常严：被拒时 HTTP 状态可能是 200，正文是纯文本
 * “Your request has been rejected. Please make sure you haven't exceeded the rate limit...”。
 * 所以这里全局串行、请求间隔 ≥1100ms，遇到该文本按 3s / 6s 退避重试两次。
 */

const BASE = 'https://api.uktradeinfo.com'
const PROVIDER = 'HMRC'
const REQUEST_INTERVAL_MS = 1100
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [3_000, 6_000]
const PAGE_SIZE = 500
const MAX_IDS_PER_QUERY = 10
const MAX_PAGES_PER_BATCH = 10
/** 一次搜索最多查多少个 CN8（2 位章节下可能有几百个；每批 10 个、每次请求间隔 1.1s，超过就截断并提示缩小范围） */
const MAX_COMMODITIES = 40
const RATE_LIMIT_RE = /request has been rejected|exceeded the rate limit/i

const COVERAGE_NOTE =
  '英国 HMRC 公布的进口商名录只到“某月进口过某 8 位商品”，没有金额和数量；低于申报门槛的小额进口不在内。'

/** HMRC 代收地址 / 货代关键词：这类“进口商”通常是报关代理，不是真正的买家 */
const FORWARDER_NAME_RE = /FREIGHT|LOGISTICS|FORWARD|SHIPPING|CARGO|EXPRESS|CUSTOMS/
const FORWARDER_ADDRESS_RE = /HM REVENUE AND CUSTOMS/
/** Title Case 时保持全大写的词（LTD 不在内：期望 “Purmo Group (UK) Ltd”） */
const KEEP_UPPER = new Set(['UK', 'USA', 'US', 'EU', 'PLC', 'LLP', 'BV', 'NV', 'AG', 'AB', 'AS', 'SA', 'GMBH', 'II', 'III'])

const queue = createSerialQueue()

/** 与 prospectService.upsert 的输入形状一致（不含 visibility / teamId 等可选项），另带 displayName */
export interface UkImporterItem {
  company: string
  /** Title Case 的展示名；company 保持 HMRC 原始大写 */
  displayName: string
  country: 'GB'
  address: string
  hsCodes: string[]
  lastImportAt: number | null
  /** 有申报的不同月份数（不是票数） */
  shipments: number
  evidence: ProspectEvidence[]
  flags: ProspectFlag[]
  /** 让 prospectService 计分时拿到目标 HS */
  searchQuery: string
}

export interface UkCoverage {
  source: 'hmrc'
  country: 'GB'
  /** 实际观察到数据的月份区间 [YYYYMM, YYYYMM]；没有数据时是查询窗口的起点 */
  months: [number, number]
  commodityIds: number[]
  truncated: boolean
  note: string
}

export interface SearchUkImportersResult {
  items: UkImporterItem[]
  coverage: UkCoverage
}

export interface SearchUkImportersOptions {
  hs: string
  /** 回溯月数，默认 12（HMRC 有约 2–3 个月发布延迟，查询起点会再往前推 3 个月） */
  months?: number
  flow?: 'import' | 'export'
  /** 返回条数上限，默认 100，最多 500 */
  limit?: number
  signal?: AbortSignal
  /** 测试用：请求间隔，默认 1100ms */
  intervalMs?: number
  /** 测试用：限流退避，默认 [3000, 6000] */
  retryDelaysMs?: number[]
  /** 测试用：当前时间 */
  now?: number
  /** 每个商品批次最多翻多少页 */
  maxPagesPerBatch?: number
}

interface CommodityRow {
  CommodityId?: number | string
  Cn8LongDescription?: string
  Hs6Description?: string
}

interface ImportRow {
  TraderId?: number | string
  CommodityId?: number | string
  MonthId?: number | string | null
  Trader?: {
    CompanyName?: string
    Address1?: string
    Address2?: string
    Address3?: string
    Address4?: string
    Address5?: string
    PostCode?: string
  } | null
}

interface ODataPage<T> {
  value?: T[]
  '@odata.nextLink'?: string
}

// ── 工具 ─────────────────────────────────────────────

/** 去掉点 / 空格后的 HS 编码；不合法抛 BAD_ARGS */
export function normalizeHs(raw: string): string {
  const cleaned = (raw ?? '').replace(/[\s.]/g, '')
  if (!/^\d{2,10}$/.test(cleaned)) throw new ProviderError('BAD_ARGS', 'HS 编码必须是 2–10 位数字', PROVIDER)
  return cleaned
}

/** HMRC 公司名 → Title Case 展示名（UK / PLC / LLP 等保持大写，LTD → Ltd） */
const ENGLISH_ONSETS = new Set(['BL', 'BR', 'CH', 'CL', 'CR', 'DR', 'FL', 'FR', 'GL', 'GR', 'KN', 'PH', 'PL', 'PR', 'SC', 'SH', 'SK', 'SL', 'SM', 'SN', 'SP', 'ST', 'SW', 'TH', 'TR', 'TW', 'WH', 'WR'])

/** 缩写词保持大写：单个字母、没有元音（BSH、DHL），或 ≤4 字母且开头两个辅音不是英文常见组合（MMPI、KTM） */
function looksLikeAcronym(word: string): boolean {
  const upper = word.toUpperCase()
  if (upper === 'LTD' || upper === 'MR' || upper === 'MRS') return false
  if (upper.length === 1) return true
  if (!/[AEIOUY]/.test(upper)) return true
  if (upper.length <= 4 && /^[^AEIOUY]{2}/.test(upper) && !ENGLISH_ONSETS.has(upper.slice(0, 2))) return true
  return false
}

export function displayCompanyName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((token) => {
      const core = token.replace(/[^A-Za-z0-9&]/g, '').toUpperCase()
      if (!core) return token
      return token.replace(/[A-Za-z]+/g, (word) =>
        KEEP_UPPER.has(core) || looksLikeAcronym(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
    })
    .join(' ')
}

function monthIdOf(date: Date): number {
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1
}

/** 当前月往前推 monthsBack 个月的 MonthId */
function monthsAgo(now: Date, monthsBack: number): number {
  return monthIdOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)))
}

/** MonthId → 该月 1 号 UTC 毫秒 */
export function monthStartUtc(monthId: number): number {
  const year = Math.floor(monthId / 100)
  const month = monthId % 100
  return Date.UTC(year, month - 1, 1)
}

function formatMonth(monthId: number): string {
  const year = Math.floor(monthId / 100)
  const month = monthId % 100
  return `${year}-${String(month).padStart(2, '0')}`
}

/** 商品编码 → 查询层级；返回 OData filter 和用于过滤结果的前缀 */
export function commodityQuery(hs: string): { filter: string; prefix: string } {
  if (hs.length <= 2) return { filter: `Hs2Code eq '${hs}'`, prefix: hs }
  if (hs.length === 3) return { filter: `Hs2Code eq '${hs.slice(0, 2)}'`, prefix: hs }
  if (hs.length === 4) return { filter: `Hs4Code eq '${hs}'`, prefix: hs }
  if (hs.length === 5) return { filter: `Hs4Code eq '${hs.slice(0, 4)}'`, prefix: hs }
  if (hs.length === 6) return { filter: `Hs6Code eq '${hs}'`, prefix: hs }
  if (hs.length === 7) return { filter: `Hs6Code eq '${hs.slice(0, 6)}'`, prefix: hs }
  // 8 位就是 CN8 本身；更长的编码按前 8 位查（HMRC 只公布到 CN8）
  const cn8 = hs.slice(0, 8)
  return { filter: `CommodityId eq ${Number(cn8)}`, prefix: cn8 }
}

// ── HTTP ─────────────────────────────────────────────

async function fetchText(url: string, signal: AbortSignal | undefined): Promise<{ status: number; text: string }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetchWithProxy(url, { headers: { Accept: 'application/json' }, signal: combined })
    return { status: response.status, text: await response.text() }
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeout.aborted) throw new ProviderError('NETWORK', 'HMRC 请求超时（30 秒）', PROVIDER)
    throw new ProviderError('NETWORK', `HMRC 请求失败：${messageOf(error)}`, PROVIDER)
  }
}

/**
 * 取一个 OData 资源。限流文本（无论状态码）与 429 都按 3s / 6s 退避重试，最多两次；
 * 仍失败抛 RATE_LIMITED。每次物理请求都排在全局串行队列里。
 */
async function requestJson<T>(
  url: string,
  options: { signal?: AbortSignal; intervalMs: number; retryDelaysMs: number[] },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const { status, text } = await queue.run(() => fetchText(url, options.signal), options.intervalMs)
    const rateLimited = RATE_LIMIT_RE.test(text) || status === 429
    if (rateLimited) {
      if (attempt >= options.retryDelaysMs.length) {
        throw new ProviderError('RATE_LIMITED', 'HMRC 拒绝了请求（可能已超出限流）', PROVIDER)
      }
      await sleep(options.retryDelaysMs[attempt]!)
      continue
    }
    if (status >= 400) throw new ProviderError('UPSTREAM', `HMRC 返回 HTTP ${status}`, PROVIDER)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ProviderError('UPSTREAM', 'HMRC 返回的不是 JSON', PROVIDER)
    }
  }
}

// ── 查询 ─────────────────────────────────────────────

/** HS → 命中的 8 位 CN8 编码（Hs2 层级的汇总行 CommodityId 只有两位，必须丢掉） */
async function commodityIdsOf(hs: string, options: { signal?: AbortSignal; intervalMs: number; retryDelaysMs: number[] }): Promise<number[]> {
  const { filter, prefix } = commodityQuery(hs)
  // 只做最小转义（空格 → %20），保留 $filter / 括号 / 单引号的原样写法（与实测可用的 URL 一致）
  const url = encodeURI(`${BASE}/Commodity?$filter=${filter}`)
  const page = await requestJson<ODataPage<CommodityRow>>(url, options)
  const ids: number[] = []
  for (const row of page.value ?? []) {
    const id = Number(row.CommodityId)
    if (!Number.isInteger(id)) continue
    if (String(id).length !== 8) continue
    if (!String(id).startsWith(prefix)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.sort((a, b) => a - b)
}

interface TraderAcc {
  traderId: number
  company: string
  address: string
  months: Set<number>
  commodities: Set<number>
  firstUrl: string
}

function addressOf(trader: NonNullable<ImportRow['Trader']>): string {
  return [trader.Address1, trader.Address2, trader.Address3, trader.Address4, trader.Address5, trader.PostCode]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

function isForwarder(company: string, address: string): boolean {
  return FORWARDER_ADDRESS_RE.test(address.toUpperCase()) || FORWARDER_NAME_RE.test(company.toUpperCase())
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size))
  return out
}

/**
 * 查英国的进口商 / 出口商名录。
 *
 * 输出按 TraderId 聚合：同一家公司在多个月、多个 CN8 下的申报合并成一条潜客，
 * shipments 是「有申报的月份数」（HMRC 不提供票数）。
 */
export async function searchUkImporters(options: SearchUkImportersOptions): Promise<SearchUkImportersResult> {
  const hs = normalizeHs(options.hs)
  const flow = options.flow ?? 'import'
  if (flow !== 'import' && flow !== 'export') throw new ProviderError('BAD_ARGS', 'flow 只能是 import 或 export', PROVIDER)
  const months = options.months ?? 12
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new ProviderError('BAD_ARGS', 'months 必须是 1–120 的整数', PROVIDER)
  }
  const limit = options.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ProviderError('BAD_ARGS', 'limit 必须是 1–500 的整数', PROVIDER)
  }
  const now = new Date(options.now ?? Date.now())
  // HMRC 有约 2–3 个月发布延迟：查询起点再往前推 3 个月
  const fromMonth = monthsAgo(now, months + 3)
  const intervalMs = options.intervalMs ?? REQUEST_INTERVAL_MS
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const maxPages = options.maxPagesPerBatch ?? MAX_PAGES_PER_BATCH
  const http = { signal: options.signal, intervalMs, retryDelaysMs }

  const allCommodityIds = await commodityIdsOf(hs, http)
  const commodityIds = allCommodityIds.slice(0, MAX_COMMODITIES)
  const traders = new Map<number, TraderAcc>()
  let truncated = allCommodityIds.length > commodityIds.length
  let observedMin = Number.POSITIVE_INFINITY
  let observedMax = 0

  const endpoint = flow === 'import' ? 'Import' : 'Export'
  for (const batch of chunk(commodityIds, MAX_IDS_PER_QUERY)) {
    // 不支持 in 运算符，也不支持 $orderby：用 or 拼接，每批最多 10 个 CommodityId
    const filter = `(${batch.map((id) => `CommodityId eq ${id}`).join(' or ')}) and MonthId ge ${fromMonth}`
    let nextUrl: string | undefined = encodeURI(`${BASE}/${endpoint}?$filter=${filter}&$expand=Trader&$top=${PAGE_SIZE}`)
    for (let page = 0; nextUrl && page < maxPages; page += 1) {
      const currentUrl: string = nextUrl
      const payload = await requestJson<ODataPage<ImportRow>>(currentUrl, http)
      for (const row of payload.value ?? []) {
        const traderId = Number(row.TraderId)
        const monthId = Number(row.MonthId)
        const company = (row.Trader?.CompanyName ?? '').trim()
        if (!Number.isInteger(traderId) || !Number.isFinite(monthId) || !company) continue
        const address = addressOf(row.Trader ?? {})
        let acc = traders.get(traderId)
        if (!acc) {
          acc = { traderId, company, address, months: new Set(), commodities: new Set(), firstUrl: currentUrl }
          traders.set(traderId, acc)
        }
        acc.months.add(monthId)
        const commodityId = Number(row.CommodityId)
        if (Number.isInteger(commodityId)) acc.commodities.add(commodityId)
        observedMin = Math.min(observedMin, monthId)
        observedMax = Math.max(observedMax, monthId)
      }
      const next = payload['@odata.nextLink']
      nextUrl = next ? new URL(next, BASE).toString() : undefined
      if (nextUrl && page === maxPages - 1) truncated = true
    }
  }

  const observedAt = now.getTime()
  const label = flow === 'import' ? '进口商名录' : '出口商名录'
  const items: UkImporterItem[] = [...traders.values()]
    .map((acc) => {
      const monthsList = [...acc.months].sort((a, b) => a - b)
      const lastMonth = monthsList[monthsList.length - 1]!
      const firstMonth = monthsList[0]!
      const codes = [...acc.commodities].sort((a, b) => a - b).map(String)
      const title = `HMRC ${label}：CN8 ${codes.slice(0, 3).join('、')}${codes.length > 3 ? ' 等' : ''}`
      const range = monthsList.length > 1 ? `${formatMonth(firstMonth)} 至 ${formatMonth(lastMonth)}` : formatMonth(lastMonth)
      const snippet = `${range} 有${flow === 'import' ? '进口' : '出口'}申报（共 ${monthsList.length} 个月），地址：${acc.address}`.slice(0, 1000)
      const flags: ProspectFlag[] = isForwarder(acc.company, acc.address) ? ['forwarder'] : []
      const evidence: ProspectEvidence[] = [
        {
          kind: 'customs',
          source: 'hmrc',
          url: acc.firstUrl,
          title,
          snippet,
          observedAt,
          fields: ['company', 'address', 'lastImportAt', 'hsCodes'],
        },
      ]
      return {
        company: acc.company,
        displayName: displayCompanyName(acc.company),
        country: 'GB' as const,
        address: acc.address,
        hsCodes: codes,
        lastImportAt: monthStartUtc(lastMonth),
        shipments: monthsList.length,
        evidence,
        flags,
        searchQuery: `hs:${hs}`,
      }
    })
    .sort((a, b) => (b.lastImportAt ?? 0) - (a.lastImportAt ?? 0) || (b.shipments ?? 0) - (a.shipments ?? 0) || a.company.localeCompare(b.company))

  if (items.length > limit) truncated = true

  const monthsRange: [number, number] = Number.isFinite(observedMin) ? [observedMin, observedMax] : [fromMonth, fromMonth]
  return {
    items: items.slice(0, limit),
    coverage: {
      source: 'hmrc',
      country: 'GB',
      months: monthsRange,
      commodityIds,
      truncated,
      note: allCommodityIds.length > commodityIds.length
        ? `${COVERAGE_NOTE} 这个编码下有 ${allCommodityIds.length} 个 8 位商品，只查了前 ${commodityIds.length} 个，请用更细的 6 位或 8 位 HS 编码。`
        : COVERAGE_NOTE,
    },
  }
}
