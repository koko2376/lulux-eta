/**
 * 制裁名单名称匹配。
 * - nameKey：NFKD 去重音、转小写、去标点、剥离常见公司后缀、合并空白。
 * - similarity：基于 nameKey 的 token 集合 Jaccard + Jaro-Winkler 组合。
 * - screen：支持 name_key 精确命中、token 预筛、国家加成。
 */
import { nameKey } from './parse.js'

export { nameKey }

function jaro(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const matchDistance = Math.floor(Math.max(a.length, b.length) / 2) - 1
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  return ((matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3)
}

function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b)
  let prefix = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  const scaling = 0.1
  return j + Math.min(prefix, 4) * scaling * (1 - j)
}

/** 软 token Jaccard：两个词 Jaro-Winkler ≥ 0.9 视为同一个词（容忍拼写差一两个字母） */
function softJaccard(keyA: string, keyB: string): number {
  const a = [...new Set(keyA.split(' ').filter(Boolean))]
  const b = [...new Set(keyB.split(' ').filter(Boolean))]
  if (a.length === 0 && b.length === 0) return 1
  const used = new Array<boolean>(b.length).fill(false)
  let matched = 0
  for (const token of a) {
    let best = -1
    let bestScore = 0.9
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue
      const score = token === b[j] ? 1 : jaroWinkler(token, b[j])
      if (score >= bestScore) {
        best = j
        bestScore = score
        if (score === 1) break
      }
    }
    if (best >= 0) {
      used[best] = true
      matched++
    }
  }
  return matched / (a.length + b.length - matched)
}

export function similarity(a: string, b: string): number {
  return similarityOfKeys(nameKey(a), nameKey(b))
}

function similarityOfKeys(keyA: string, keyB: string): number {
  if (!keyA || !keyB) return 0
  const jw = jaroWinkler(keyA, keyB)
  const jac = softJaccard(keyA, keyB)
  return Math.min(1, jw * 0.7 + jac * 0.3)
}

export interface ScreeningEntry {
  id: string
  list: string
  ref: string
  name: string
  primaryName: string
  entityType: string
  programs: string
  countries: string[]
  isAlias: number
  nameKey: string
}

export interface ScreeningResult {
  list: string
  ref: string
  name: string
  primaryName: string
  entityType: string
  programs: string
  countries: string[]
  score: number
  matchedOn: 'exact' | 'fuzzy'
}

function normalizeCountry(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
}

export interface ScreeningOptions {
  country?: string
  threshold?: number
  limit?: number
}

const MAX_CANDIDATES = 2000

/** 名单内存索引：精确键 → 条目、token → 条目；只对与查询共享 ≥3 字符 token 的条目算相似度 */
export class SanctionsIndex {
  private readonly keys: string[]
  private readonly exact = new Map<string, number[]>()
  private readonly byToken = new Map<string, number[]>()

  constructor(readonly entries: ScreeningEntry[]) {
    this.keys = entries.map((entry) => entry.nameKey || nameKey(entry.name))
    this.keys.forEach((key, index) => {
      if (!key) return
      push(this.exact, key, index)
      for (const token of new Set(key.split(' ').filter((t) => t.length >= 3))) push(this.byToken, token, index)
    })
  }

  get size(): number {
    return this.entries.length
  }

  screen(name: string, options: ScreeningOptions = {}): ScreeningResult[] {
    const threshold = options.threshold ?? 0.88
    const limit = options.limit ?? 10
    const key = nameKey(name)
    if (!key) return []
    const targetCountry = options.country ? normalizeCountry(options.country) : ''
    const scored = new Map<number, { score: number; matchedOn: 'exact' | 'fuzzy' }>()
    for (const index of this.exact.get(key) ?? []) scored.set(index, { score: 1, matchedOn: 'exact' })
    // 候选：与查询共享 ≥3 字符的词；按共享词数排序，只细算最相关的前 MAX_CANDIDATES 个
    const shared = new Map<number, number>()
    const queryTokens = [...new Set(key.split(' ').filter((t) => t.length >= 3))]
    for (const token of queryTokens) {
      for (const index of this.byToken.get(token) ?? []) if (!scored.has(index)) shared.set(index, (shared.get(index) ?? 0) + 1)
    }
    let candidates = [...shared.keys()]
    if (candidates.length > MAX_CANDIDATES) {
      candidates = candidates
        .sort((x, y) => shared.get(y)! - shared.get(x)! || Math.abs(this.keys[x].length - key.length) - Math.abs(this.keys[y].length - key.length))
        .slice(0, MAX_CANDIDATES)
    }
    for (const index of candidates) {
      const score = similarityOfKeys(key, this.keys[index])
      if (score >= threshold) scored.set(index, { score, matchedOn: 'fuzzy' })
    }
    const results: ScreeningResult[] = []
    for (const [index, hit] of scored) {
      const entry = this.entries[index]
      let score = hit.score
      if (targetCountry && entry.countries.some((c) => normalizeCountry(c) === targetCountry)) score = Math.min(1, score + 0.03)
      results.push({
        list: entry.list,
        ref: entry.ref,
        name: entry.name,
        primaryName: entry.primaryName || entry.name,
        entityType: entry.entityType,
        programs: entry.programs,
        countries: entry.countries,
        score: Math.round(score * 1000) / 1000,
        matchedOn: hit.matchedOn,
      })
    }
    results.sort((a, b) => b.score - a.score || (a.matchedOn === 'exact' ? -1 : 1))
    // 同一名单同一编号（主名与别名都命中）只留分最高的一条
    const seen = new Set<string>()
    return results.filter((r) => (seen.has(`${r.list}:${r.ref}`) ? false : (seen.add(`${r.list}:${r.ref}`), true))).slice(0, limit)
  }
}

function push(map: Map<string, number[]>, key: string, index: number): void {
  const list = map.get(key)
  if (list) list.push(index)
  else map.set(key, [index])
}

/** 便捷函数（测试 / 一次性使用）：每次建索引；服务里用缓存的 SanctionsIndex */
export function screen(name: string, options: ScreeningOptions & { entries: ScreeningEntry[] }): ScreeningResult[] {
  return new SanctionsIndex(options.entries).screen(name, options)
}
