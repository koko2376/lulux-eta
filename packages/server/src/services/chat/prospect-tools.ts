import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { messageOf } from '../../errors.js'
import { requirePermission } from '../../security/access.js'
import { prospectService, PROSPECT_FLAGS, PROSPECT_STATUSES, type Prospect } from '../prospect-service.js'
import { sanctionsService } from '../sanctions/sanctions-service.js'
import { marketOverview } from '../trade/comtrade.js'
import { toAppError } from '../trade/errors.js'
import { searchUkImporters, type SearchUkImportersResult, type UkCoverage, type UkImporterItem } from '../trade/hmrc.js'
import { ToolError } from '../tools/tool-error.js'
import type { CrmTool } from './crm-tools.js'

/**
 * 开发客户（prospecting）工具：英国海关进口商名录、各国市场规模、制裁名单初筛、线索库。
 *
 * - 数据边界写死在 description 里：HMRC 只公布「某月申报过某 8 位商品」，没有金额 / 数量；
 *   UN Comtrade 是国家层面的统计，不是企业名单；制裁筛查只是名称相似度初筛。
 * - find_uk_importers 的完整结果放在进程内缓存（30 分钟、最多 20 份，LRU），
 *   模型只看到精简列表 + resultId，再用 save_prospects 按 index 保存，避免大结果塞满上下文。
 * - 写工具与 CRM 工具同一套 risk / 审批 / RBAC：viewer 一律无权限，行级权限由 prospectService 校验。
 */

/** 一次搜索的完整结果在内存里保留多久 */
const RESULT_TTL_MS = 30 * 60 * 1000
/** 最多保留多少份搜索结果 */
const MAX_RESULTS = 20
/** 自动标记制裁命中的相似度门槛（低于 screen 的 0.88 初筛门槛没有意义） */
const SANCTIONS_FLAG_THRESHOLD = 0.92
/** 模型自己从网上找到的客户，证据类型只允许这几种（不能冒充海关 / 提单证据） */
const AGENT_EVIDENCE_KINDS = ['website', 'search', 'directory', 'manual'] as const
const CUSTOMS_EVIDENCE_KINDS = new Set(['customs', 'bill_of_lading'])

interface CachedSearch {
  items: UkImporterItem[]
  coverage: UkCoverage
  storedAt: number
}

const searchCache = new Map<string, CachedSearch>()

function remember(result: SearchUkImportersResult): string {
  const id = `uk_${randomBytes(4).toString('hex')}`
  searchCache.set(id, { items: result.items, coverage: result.coverage, storedAt: Date.now() })
  // Map 保持插入顺序：超限时淘汰最久没被用过的（LRU）
  while (searchCache.size > MAX_RESULTS) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
  return id
}

function recall(id: string): CachedSearch | undefined {
  const hit = searchCache.get(id)
  if (!hit) return undefined
  searchCache.delete(id)
  if (Date.now() - hit.storedAt > RESULT_TTL_MS) return undefined
  // 用一次就算“最近用过”，重新放到队尾
  searchCache.set(id, hit)
  return hit
}

function monthOf(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 7)
}

function dayOf(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10)
}

function compactProspect(prospect: Prospect) {
  return {
    id: prospect.id,
    company: prospect.company,
    country: prospect.country,
    website: prospect.website,
    score: prospect.score,
    status: prospect.status,
    flags: prospect.flags,
    lastImportAt: dayOf(prospect.lastImportAt),
    evidenceKinds: [...new Set(prospect.evidence.map((item) => item.kind))],
    customerId: prospect.customerId,
  }
}

function trim(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

/** 名称初筛：最高分 ≥ 0.92 时返回要加的标记与备注行 */
function sanctionsMark(company: string, country: string | undefined): { flag: 'sanctions_hit' | null; line: string | null } {
  try {
    const hit = sanctionsService.screen(company, { ...(country ? { country } : {}) }).hits[0]
    if (!hit || hit.score < SANCTIONS_FLAG_THRESHOLD) return { flag: null, line: null }
    return {
      flag: 'sanctions_hit',
      line: `[制裁名单初筛] 疑似命中 ${hit.list} ${hit.primaryName}（相似度 ${hit.score.toFixed(2)}），需人工核实`,
    }
  } catch {
    // 初筛只是辅助：名单索引坏了也不该阻断保存
    return { flag: null, line: null }
  }
}

function appendLine(notes: string, line: string): string {
  if (notes.includes(line)) return notes
  return `${notes}${notes ? '\n' : ''}${line}`
}

const manualEvidenceSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  url: z.string().trim().max(2000).optional(),
  title: z.string().max(500).optional(),
  snippet: z.string().max(2000).optional(),
  source: z.string().trim().max(100).optional(),
})

/** 手动录入的潜客：prospectCreateInput 的子集 + 证据 */
const manualProspectSchema = z
  .object({
    company: z.string().trim().min(1).max(300),
    country: z.string().trim().max(20).optional(),
    website: z.string().trim().max(500).optional(),
    address: z.string().trim().max(500).optional(),
    products: z.string().trim().max(2000).optional(),
    hsCodes: z.array(z.string().trim().max(40)).max(100).optional(),
    emails: z.array(z.string().trim().max(320)).max(100).optional(),
    phones: z.array(z.string().trim().max(64)).max(100).optional(),
    socialLinks: z.array(z.string().trim().max(2000)).max(50).optional(),
    notes: z.string().max(20_000).optional(),
    searchQuery: z.string().trim().max(500).optional(),
    evidence: z.array(manualEvidenceSchema).max(50),
  })
  .strict()

type ManualProspect = z.infer<typeof manualProspectSchema>

function httpUrlOf(raw: string | undefined): string | null {
  const value = trim(raw)
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** 手动证据 → prospectCreateInput 的 evidence；海关 / 提单证据不允许由模型伪造 */
function evidenceOf(company: string, evidence: ManualProspect['evidence']) {
  if (evidence.length === 0) throw new ToolError(`「${company}」至少需要 1 条证据（evidence）`)
  return evidence.map((item) => {
    const kind = item.kind.trim().toLowerCase()
    if (CUSTOMS_EVIDENCE_KINDS.has(kind)) {
      throw new ToolError(
        `「${company}」的证据 kind='${kind}' 不能由 Agent 填写：海关 / 提单证据只能来自 HMRC、提单数据源等正式来源，` +
          '模型从网上找到的公司不能冒充。请改用 website / search / directory / manual。',
      )
    }
    if (!(AGENT_EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      throw new ToolError(`「${company}」的证据 kind 只能是 website / search / directory / manual 之一`)
    }
    const url = httpUrlOf(item.url)
    if (!url && kind !== 'manual') {
      throw new ToolError(`「${company}」的 ${kind} 证据必须有 http/https 链接；没有链接的材料请用 kind='manual' 并说明来源`)
    }
    return {
      kind: kind as (typeof AGENT_EVIDENCE_KINDS)[number],
      source: trim(item.source) ?? 'agent',
      url: url ?? '',
      title: trim(item.title) ?? '',
      snippet: (item.snippet ?? '').trim().slice(0, 1000),
      observedAt: Date.now(),
      fields: [] as string[],
    }
  })
}

function manualPayload(item: ManualProspect): Record<string, unknown> {
  const payload: Record<string, unknown> = { company: item.company, evidence: evidenceOf(item.company, item.evidence) }
  if (item.country !== undefined) payload.country = item.country
  if (item.website !== undefined) payload.website = item.website
  if (item.address !== undefined) payload.address = item.address
  if (item.products !== undefined) payload.products = item.products
  if (item.hsCodes !== undefined) payload.hsCodes = item.hsCodes
  if (item.emails !== undefined) payload.emails = item.emails
  if (item.phones !== undefined) payload.phones = item.phones
  if (item.socialLinks !== undefined) payload.socialLinks = item.socialLinks
  if (item.notes !== undefined) payload.notes = item.notes
  if (item.searchQuery !== undefined) payload.searchQuery = item.searchQuery
  return payload
}

/** HMRC 条目 → prospectCreateInput（displayName 只是展示用，不写库） */
function importerPayload(item: UkImporterItem): Record<string, unknown> {
  return {
    // 存展示名（Title Case，缩写保持大写）；HMRC 原始大写名留在证据快照里，查重按规范化键不受大小写影响
    company: item.displayName,
    country: item.country,
    address: item.address,
    hsCodes: item.hsCodes,
    lastImportAt: item.lastImportAt,
    shipments: item.shipments,
    evidence: item.evidence,
    flags: item.flags,
    searchQuery: item.searchQuery,
  }
}

const HINT =
  '用 save_prospects 的 resultId + indexes 保存到线索库（index 从 1 开始）；' +
  'forwarder=true 多半是报关代理 / HMRC 代收地址，不建议保存。'

export const PROSPECT_TOOLS: CrmTool[] = [
  {
    name: 'find_uk_importers',
    description:
      '查英国 HMRC 海关公开的进口商 / 出口商名录：给一个 HS 编码，返回在最近几个月里申报过该商品的英国公司。' +
      '数据边界：只有「某月申报过某个 8 位 CN8 商品」，没有金额、没有数量，低于申报门槛的小额进口不在内；' +
      'HMRC 有约 2–3 个月发布延迟。结果只返回精简列表和 resultId，完整条目不直接给模型；' +
      '要保存线索请把 resultId 与 index（从 1 开始）交给 save_prospects。' +
      'forwarder=true 的公司多半是报关代理 / HMRC 代收地址，不是真正的买家。HS 编码越细越好（6 位或 8 位），2–4 位会命中大量商品、耗时更久。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        hs: { type: 'string', description: 'HS 编码，2–10 位数字（推荐 6 位或 8 位，如 841370）' },
        months: { type: 'integer', minimum: 1, maximum: 36, description: '回溯月数，默认 12' },
        flow: { type: 'string', enum: ['import', 'export'], description: 'import 进口商（默认）/ export 出口商' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数上限，默认 50' },
      },
      required: ['hs'],
    },
    async run(args) {
      const input = z
        .object({
          hs: z.string().trim().min(1),
          months: z.number().int().min(1).max(36).default(12),
          flow: z.enum(['import', 'export']).default('import'),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .parse(args)
      let result: SearchUkImportersResult
      try {
        result = await searchUkImporters({ hs: input.hs, months: input.months, flow: input.flow, limit: input.limit })
      } catch (error) {
        // ProviderError → AppError：runTool 会按普通错误把中文原因交回模型
        throw toAppError(error)
      }
      const resultId = remember(result)
      return {
        resultId,
        coverage: result.coverage,
        items: result.items.map((item, index) => ({
          index: index + 1,
          company: item.displayName,
          address: item.address,
          lastImport: monthOf(item.lastImportAt),
          months: item.shipments,
          cn8: item.hsCodes.slice(0, 3),
          forwarder: item.flags.includes('forwarder'),
        })),
        hint: HINT,
      }
    },
  },
  {
    name: 'market_overview',
    description:
      '查某个 HS 编码的各国市场规模（UN Comtrade 公开数据）：按进口额（flow=M）或出口额（flow=X）给出前 top 个国家、' +
      '同比增速与占全球的份额。数据边界：这是国家层面的海关统计，不是企业名单；部分国家数据会晚 1–2 年，' +
      '最新一年没报数的国家会在 coverage.missingInLatest 里列出。金额单位为美元。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        hs: { type: 'string', description: 'HS 编码，2–10 位数字（只取前 6 位）' },
        years: { type: 'array', items: { type: 'integer' }, description: '年份，如 [2023, 2024]；默认最近两个完整年' },
        flow: { type: 'string', enum: ['M', 'X'], description: 'M 进口（默认）/ X 出口' },
        top: { type: 'integer', minimum: 1, maximum: 30, description: '返回前多少个国家，默认 10' },
      },
      required: ['hs'],
    },
    async run(args) {
      const input = z
        .object({
          hs: z.string().trim().min(1),
          years: z.array(z.number().int()).min(1).max(10).optional(),
          flow: z.enum(['M', 'X']).default('M'),
          top: z.number().int().min(1).max(30).default(10),
        })
        .parse(args)
      try {
        return await marketOverview({ hs: input.hs, years: input.years, flow: input.flow, top: input.top })
      } catch (error) {
        throw toAppError(error)
      }
    },
  },
  {
    name: 'screen_sanctions',
    description:
      '制裁名单初筛：对最多 50 个公司名（names）或一个已有潜客（prospectId），按名称相似度查 OFAC SDN、EU、UN 与自定义名单。' +
      '数据边界：这只是名称相似度初筛，不是认定；命中必须人工核对官方原文。' +
      '若 listsMissing 非空，说明部分官方名单还没下载，本次筛查不完整。' +
      '本工具不写库：要对潜客打 sanctions_hit 标记，请用 update_prospect。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: '公司名，1–50 个' },
        prospectId: { type: 'string', description: '已有潜客 id（与 names 二选一，用该潜客的公司名和国家）' },
        country: { type: 'string', description: '国家代码（可选，命中该国名单时略微加分）' },
      },
    },
    run(args) {
      const input = z
        .object({
          names: z.array(z.string().trim().min(1).max(300)).min(1).max(50).optional(),
          prospectId: z.string().trim().min(1).max(80).optional(),
          country: z.string().trim().max(20).optional(),
        })
        .parse(args)
      if (Boolean(input.names) === Boolean(input.prospectId)) {
        throw new ToolError('请给出 names（1–50 个公司名）或 prospectId，二选一')
      }
      let names = input.names ?? []
      let country = input.country
      let prospect: { id: string; company: string; country: string } | undefined
      if (input.prospectId) {
        const found = prospectService.require(input.prospectId)
        names = [found.company]
        country = country || found.country || undefined
        prospect = { id: found.id, company: found.company, country: found.country }
      }
      const screened = names.map((name) => {
        const result = sanctionsService.screen(name, { ...(country ? { country } : {}), threshold: 0.88, limit: 3 })
        return {
          name,
          hits: result.hits.map((hit) => ({
            list: hit.list,
            name: hit.name,
            primaryName: hit.primaryName,
            score: hit.score,
            programs: hit.programs,
            matchedOn: hit.matchedOn,
          })),
          checkedLists: result.checkedLists,
          listsMissing: result.listsMissing,
          disclaimer: result.disclaimer,
        }
      })
      const first = screened[0]!
      const listsMissing = first.listsMissing
      return {
        items: screened.map(({ name, hits }) => ({ name, hits })),
        checkedLists: first.checkedLists,
        listsMissing,
        disclaimer: first.disclaimer,
        ...(listsMissing.length > 0
          ? { notice: `以下名单尚未下载：${listsMissing.join('、')}（设置里可以更新），本次筛查不完整` }
          : {}),
        ...(prospect ? { prospect } : {}),
      }
    },
  },
  {
    name: 'save_prospects',
    description:
      '把开发到的公司保存到线索库（按公司名 / 官网合并，重复保存不会产生重复潜客）。两种输入可以同时给：' +
      '(a) resultId + indexes：用 find_uk_importers 返回的 resultId，indexes 是 index 数组（从 1 开始），或 all=true 保存全部（结果 30 分钟内有效）；' +
      '(b) prospects：手动录入最多 50 家，每项必须有 company 与至少 1 条 evidence。' +
      '证据边界：Agent 从网上找到的客户只能填 kind=website / search / directory / manual，每条非 manual 证据必须有 http/https 链接；' +
      'customs / bill_of_lading 是海关与提单证据，只能来自正式数据源，不能用在这里。' +
      '保存前会自动做一次制裁名单初筛：相似度 ≥ 0.92 时给该条打 sanctions_hit 并在备注末尾追加一行初筛记录（需人工核实）。' +
      'forwarder=true 的条目也可以保存，是否保存由用户决定。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        resultId: { type: 'string', description: 'find_uk_importers 返回的 resultId' },
        // 不用 oneOf：部分模型服务商的工具 schema 不支持组合类型
        indexes: { type: 'array', items: { type: 'integer' }, description: 'index 数组（从 1 开始）' },
        all: { type: 'boolean', description: 'true = 保存这次结果的全部条目（代替 indexes）' },
        prospects: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              country: { type: 'string' },
              website: { type: 'string' },
              address: { type: 'string' },
              products: { type: 'string' },
              hsCodes: { type: 'array', items: { type: 'string' } },
              emails: { type: 'array', items: { type: 'string' } },
              phones: { type: 'array', items: { type: 'string' } },
              socialLinks: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
              searchQuery: { type: 'string' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: [...AGENT_EVIDENCE_KINDS] },
                    url: { type: 'string' },
                    title: { type: 'string' },
                    snippet: { type: 'string' },
                    source: { type: 'string' },
                  },
                  required: ['kind'],
                },
              },
            },
            required: ['company', 'evidence'],
          },
        },
      },
    },
    run(args) {
      const input = z
        .object({
          resultId: z.string().trim().max(40).optional(),
          indexes: z.union([z.array(z.number().int()), z.literal('all')]).optional(),
          all: z.boolean().optional(),
          prospects: z.array(manualProspectSchema).max(50).optional(),
        })
        .parse(args)
      if (input.all) input.indexes = 'all'
      if (!input.resultId && !input.prospects) {
        throw new ToolError('请给出 resultId + indexes，或 prospects 数组')
      }
      // 先按账号权限拒绝（避免逐条失败被 skipped 吞掉，模型误以为只是部分条目有问题）
      requirePermission('data:write')

      const entries: Array<{ company: string; country?: string; forwarder: boolean; payload: Record<string, unknown> }> = []
      if (input.resultId) {
        const cached = recall(input.resultId)
        if (!cached) throw new ToolError('结果已过期，请重新调用 find_uk_importers')
        if (input.indexes === undefined) {
          throw new ToolError('使用 resultId 时需要同时给出 indexes（index 数组）或 all=true')
        }
        const total = cached.items.length
        let picks: number[]
        if (input.indexes === 'all') {
          picks = cached.items.map((_, index) => index + 1)
        } else {
          const bad = input.indexes.filter((index) => !Number.isInteger(index) || index < 1 || index > total)
          if (bad.length > 0) {
            throw new ToolError(`index 超出范围：${bad.join('、')}；本次结果的有效范围是 1–${total}`)
          }
          picks = [...new Set(input.indexes)]
        }
        if (picks.length === 0) throw new ToolError('indexes 为空，没有要保存的条目')
        for (const index of picks) {
          const item = cached.items[index - 1]!
          entries.push({
            company: item.displayName,
            country: item.country,
            forwarder: item.flags.includes('forwarder'),
            payload: importerPayload(item),
          })
        }
      }
      for (const item of input.prospects ?? []) {
        entries.push({
          company: item.company,
          country: item.country,
          forwarder: false,
          payload: manualPayload(item),
        })
      }
      if (entries.length === 0) throw new ToolError('没有要保存的条目')

      const skipped: Array<{ company: string; reason: string }> = []
      const items: Array<{
        id: string
        company: string
        score: number
        created: boolean
        matchedCustomer?: { id: string; company: string }
        sanctionsHit?: boolean
        forwarder?: boolean
      }> = []
      let created = 0
      let merged = 0

      for (const entry of entries) {
        try {
          const mark = sanctionsMark(entry.company, entry.country)
          const payload: Record<string, unknown> = { ...entry.payload }
          if (mark.flag) {
            const flags = new Set<string>(Array.isArray(payload.flags) ? (payload.flags as string[]) : [])
            flags.add(mark.flag)
            payload.flags = [...flags]
            if (mark.line) payload.notes = appendLine(typeof payload.notes === 'string' ? payload.notes : '', mark.line)
          }
          const result = prospectService.upsert(payload)
          let prospect = result.prospect
          // upsert 合并时标量只补空值：已有备注的潜客不会写入新的初筛行，这里补一次
          if (mark.line && !prospect.notes.includes(mark.line)) {
            prospect = prospectService.update(prospect.id, { notes: appendLine(prospect.notes, mark.line) })
          }
          if (result.created) created += 1
          else merged += 1
          items.push({
            id: prospect.id,
            company: prospect.company,
            score: prospect.score,
            created: result.created,
            ...(result.matchedCustomer ? { matchedCustomer: result.matchedCustomer } : {}),
            ...(mark.flag ? { sanctionsHit: true } : {}),
            ...(entry.forwarder ? { forwarder: true } : {}),
          })
        } catch (error) {
          // 单条失败（例如命中别人负责的潜客、字段校验失败）不中断整批
          skipped.push({ company: entry.company, reason: messageOf(error) })
        }
      }

      return { created, merged, skipped, items }
    },
  },
  {
    name: 'list_prospects',
    description:
      '列出线索库里的潜客（按可见范围：owner / admin 看全部，其他人看自己负责或共享的）。' +
      '可按关键词（公司名 / 网站 / 主营产品 / HS 编码）、状态、最低评分、是否有海关证据、标记筛选，按评分 / 更新时间 / 最近进口排序。' +
      '只返回精简字段；完整证据用 get_prospect。',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词' },
        status: { type: 'string', enum: [...PROSPECT_STATUSES] },
        minScore: { type: 'integer', minimum: 0, maximum: 100 },
        hasCustomsEvidence: { type: 'boolean', description: '只看有海关 / 提单证据的（或只看没有的）' },
        flag: { type: 'string', enum: [...PROSPECT_FLAGS] },
        sort: { type: 'string', enum: ['score', 'updated', 'lastImport'], description: '默认 score' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 20' },
      },
    },
    run(args) {
      const input = z
        .object({
          q: z.string().trim().max(200).optional(),
          status: z.enum(PROSPECT_STATUSES).optional(),
          minScore: z.number().int().min(0).max(100).optional(),
          hasCustomsEvidence: z.boolean().optional(),
          flag: z.enum(PROSPECT_FLAGS).optional(),
          sort: z.enum(['score', 'updated', 'lastImport']).default('score'),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .parse(args)
      const result = prospectService.list({ ...input, offset: 0 })
      return { total: result.total, items: result.items.map(compactProspect) }
    },
  },
  {
    name: 'get_prospect',
    description: '读取一个潜客的完整资料：证据列表、评分理由、标记、备注与关联的客户。',
    risk: 'read',
    inputSchema: { type: 'object', properties: { prospectId: { type: 'string' } }, required: ['prospectId'] },
    run(args) {
      const { prospectId } = z.object({ prospectId: z.string().trim().min(1).max(80) }).parse(args)
      return prospectService.require(prospectId)
    },
  },
  {
    name: 'update_prospect',
    description:
      '修改潜客：状态、备注、标记、网站、邮箱、电话、主营产品、HS 编码、国家、地址。' +
      '状态：new 新潜客 / contacted 已联系 / converted 已转客户 / ignored 已忽略。' +
      '标记：forwarder（货代 / 报关代理）、sanctions_hit（制裁初筛命中）、customer_exists、stale、name_conflict、website_down。' +
      '人工核实制裁命中后，可用 flags 加上 sanctions_hit。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        prospectId: { type: 'string' },
        status: { type: 'string', enum: PROSPECT_STATUSES.filter((value) => value !== 'converted') },
        notes: { type: 'string', description: '替换备注' },
        flags: { type: 'array', items: { type: 'string', enum: [...PROSPECT_FLAGS] }, description: '整体替换标记' },
        website: { type: 'string' },
        emails: { type: 'array', items: { type: 'string' } },
        phones: { type: 'array', items: { type: 'string' } },
        products: { type: 'string' },
        hsCodes: { type: 'array', items: { type: 'string' } },
        country: { type: 'string' },
        address: { type: 'string' },
      },
      required: ['prospectId'],
    },
    run(args) {
      const input = z
        .object({
          prospectId: z.string().trim().min(1).max(80),
          status: z.enum(PROSPECT_STATUSES).optional(),
          notes: z.string().max(20_000).optional(),
          flags: z.array(z.enum(PROSPECT_FLAGS)).max(10).optional(),
          website: z.string().max(500).optional(),
          emails: z.array(z.string().max(320)).max(100).optional(),
          phones: z.array(z.string().max(64)).max(100).optional(),
          products: z.string().max(2000).optional(),
          hsCodes: z.array(z.string().max(40)).max(100).optional(),
          country: z.string().max(20).optional(),
          address: z.string().max(500).optional(),
        })
        .strict()
        .parse(args)
      const { prospectId, status, ...patch } = input
      if (status === 'converted') throw new ToolError('转客户请用 convert_prospect_to_customer（会查重并创建客户），不能直接把状态改成 converted')
      const changed = [...(status ? ['status'] : []), ...Object.keys(patch)]
      if (changed.length === 0) throw new ToolError('没有要修改的字段')
      const prospect =
        changed.length === 1 && status ? prospectService.setStatus(prospectId, status) : prospectService.update(prospectId, { ...patch, ...(status ? { status } : {}) })
      return { updated: true, changed, prospect: compactProspect(prospect) }
    },
  },
  {
    name: 'convert_prospect_to_customer',
    description:
      '把潜客转为 CRM 客户：客户来源记为 prospect，备注拼上证据摘要，潜客状态改为 converted 并关联客户。' +
      '组织内可能已有同名 / 同官网客户时不会创建，返回 duplicate 与 matches；确认后带 force=true 再调用。需要用户批准。',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        prospectId: { type: 'string' },
        force: { type: 'boolean', description: '用户确认仍然创建新客户' },
      },
      required: ['prospectId'],
    },
    run(args) {
      const input = z.object({ prospectId: z.string().trim().min(1).max(80), force: z.boolean().optional() }).parse(args)
      const result = prospectService.convertToCustomer(input.prospectId, { force: input.force })
      if (!result.converted) {
        return { ...result, hint: '组织内可能已有该客户，确认后带 force=true 再调用' }
      }
      return { converted: true, customer: result.customer, prospect: compactProspect(result.prospect) }
    },
  },
]
