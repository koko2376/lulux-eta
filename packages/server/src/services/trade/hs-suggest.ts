import { currentActor } from '../../context.js'
import { db } from '../../db.js'
import { fetchWithProxy } from '../http-client.js'
import { productService } from '../product-service.js'

/**
 * HS 编码建议：
 * 1) 自己的产品库、以前做过的单证里同类品名用过的编码（最可信，直接复用）；
 * 2) 英国 Trade Tariff 公开检索（无需 Key）给出的候选：前 6 位是国际通用的 HS 子目，
 *    中国出口报关的 10 位编码、监管条件和退税率仍以海关 / 单一窗口为准，需要人工确认。
 */

export interface HsCandidate {
  code: string
  hs6: string
  description: string
  source: 'product' | 'history' | 'uk_tariff'
  detail: string
}

export interface HsSuggestResult {
  query: string
  candidates: HsCandidate[]
  tariffError: string | null
  note: string
}

const TARIFF_BASE = 'https://www.trade-tariff.service.gov.uk/api/v2'
const TIMEOUT_MS = 15_000

function tokens(text: string): string[] {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9]{3,}/g) ?? []
  const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  const grams: string[] = []
  for (const run of cjk) for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  return [...new Set([...words.map((w) => w.replace(/(es|s)$/, '')), ...grams])]
}

function overlap(query: string[], text: string): number {
  if (query.length === 0) return 0
  const target = new Set(tokens(text))
  return query.filter((token) => target.has(token)).length / query.length
}

const digits = (code: string) => code.replace(/\D/g, '')
const strip = (html: string) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function localCandidates(query: string): HsCandidate[] {
  const q = tokens(query)
  const out: Array<HsCandidate & { score: number }> = []
  for (const product of productService.list()) {
    if (!digits(product.hsCode)) continue
    const score = overlap(q, `${product.name} ${product.spec} ${product.category}`)
    if (score >= 0.5) out.push({ code: digits(product.hsCode), hs6: digits(product.hsCode).slice(0, 6), description: product.name, source: 'product', detail: `产品库：${product.sku || product.name}`, score: score + 0.1 })
  }
  const rows = db.prepare('SELECT data_json FROM order_doc_info WHERE org_id = ? ORDER BY updated_at DESC LIMIT 500').all(currentActor().orgId) as Array<{ data_json: string }>
  for (const row of rows) {
    let lines: Array<{ description?: string; hsCode?: string }> = []
    try {
      lines = (JSON.parse(row.data_json) as { lines?: typeof lines }).lines ?? []
    } catch {
      continue
    }
    for (const line of lines) {
      const code = digits(line.hsCode ?? '')
      if (code.length < 6 || !line.description) continue
      const score = overlap(q, line.description)
      if (score >= 0.5) out.push({ code, hs6: code.slice(0, 6), description: line.description, source: 'history', detail: '以前的单证用过', score })
    }
  }
  const seen = new Set<string>()
  return out
    .sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)))
    .slice(0, 5)
    .map(({ score: _score, ...rest }) => rest)
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetchWithProxy(url, { headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

interface TariffHit {
  _source: { goods_nomenclature_item_id: string; description: string; ancestor_descriptions?: string[]; declarable?: boolean }
}

/** 检索词变体：去掉规格（含数字的词，如 600x600、40W、DN25），太长时再试“首词 + 尾词”“末两词”，命中率高得多 */
export function tariffQueries(query: string): string[] {
  const english = query.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = english.split(' ').filter((w) => w && !/\d/.test(w) && w.length > 1)
  const out: string[] = []
  const add = (list: string[]) => {
    const q = list.join(' ').trim()
    if (q.length >= 3 && !out.includes(q)) out.push(q)
  }
  add(words)
  if (words.length > 2) {
    add([words[0]!, words[words.length - 1]!])
    add(words.slice(-2))
  }
  return out.slice(0, 3)
}

async function tariffCandidates(query: string, signal?: AbortSignal): Promise<HsCandidate[]> {
  const seen = new Set<string>()
  const merged: HsCandidate[] = []
  for (const q of tariffQueries(query)) {
    for (const c of await tariffSearch(q, signal)) {
      if (seen.has(c.code)) continue
      seen.add(c.code)
      merged.push(c)
    }
    if (merged.length >= 6) break
  }
  // 按与原品名的词重合度排序（稳定排序：同分保持税则返回顺序）
  const q = tokens(query)
  return merged
    .map((c, i) => ({ c, i, score: overlap(q, `${c.description} ${c.detail}`) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.c)
    .slice(0, 8)
}

async function tariffSearch(english: string, signal?: AbortSignal): Promise<HsCandidate[]> {
  const body = (await getJson(`${TARIFF_BASE}/search?q=${encodeURIComponent(english)}`, signal)) as {
    data?: { attributes?: { type?: string; entry?: { endpoint?: string; id?: string }; goods_nomenclature_match?: { commodities?: TariffHit[]; headings?: TariffHit[] } } }
  }
  const attrs = body.data?.attributes
  if (!attrs) return []
  if (attrs.type === 'exact_match' && attrs.entry?.id && /^(subheadings|commodities|headings)$/.test(attrs.entry.endpoint ?? '')) {
    const detail = (await getJson(`${TARIFF_BASE}/${attrs.entry.endpoint}/${encodeURIComponent(attrs.entry.id)}`, signal).catch(() => null)) as {
      data?: { attributes?: { goods_nomenclature_item_id?: string; description_plain?: string; description?: string } }
    } | null
    const code = digits(detail?.data?.attributes?.goods_nomenclature_item_id ?? attrs.entry.id.split('-')[0] ?? '')
    if (code.length >= 6) {
      return [{ code: code.slice(0, 6), hs6: code.slice(0, 6), description: strip(detail?.data?.attributes?.description_plain ?? detail?.data?.attributes?.description ?? ''), source: 'uk_tariff', detail: '英国税则精确匹配（检索词命中了索引词，含义需核对）' }]
    }
    return []
  }
  const hits = [...(attrs.goods_nomenclature_match?.commodities ?? []), ...(attrs.goods_nomenclature_match?.headings ?? [])]
  const seen = new Set<string>()
  const out: HsCandidate[] = []
  for (const hit of hits) {
    const code = digits(hit._source.goods_nomenclature_item_id)
    const hs6 = code.slice(0, 6)
    if (hs6.length < 6 || hs6.endsWith('0000') || seen.has(hs6)) continue
    seen.add(hs6)
    const ancestors = (hit._source.ancestor_descriptions ?? []).slice(-2).map(strip).join(' › ')
    out.push({ code: hs6, hs6, description: strip(hit._source.description).slice(0, 200), source: 'uk_tariff', detail: ancestors ? `英国税则：${ancestors.slice(0, 200)}` : '英国税则' })
    if (out.length >= 6) break
  }
  return out
}

export async function suggestHs(query: string, signal?: AbortSignal): Promise<HsSuggestResult> {
  const local = localCandidates(query)
  let tariff: HsCandidate[] = []
  let tariffError: string | null = null
  try {
    tariff = await tariffCandidates(query, signal)
  } catch (error) {
    tariffError = `英国税则检索失败：${error instanceof Error ? error.message : String(error)}`
  }
  return {
    query,
    candidates: [...local, ...tariff],
    tariffError,
    note:
      '产品库 / 历史单证里的编码可直接复用；英国税则候选只有前 6 位国际通用，中国出口报关的 10 位编码、监管条件和退税率请在海关或单一窗口核对后再填。' +
      (local.length === 0 && tariff.length === 0 ? ' 没找到候选：换成更具体的英文品名（材质 + 用途）再试。' : ''),
  }
}
