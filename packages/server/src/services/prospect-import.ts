import { z } from 'zod'
import { AppError, messageOf } from '../errors.js'
import { transaction } from '../utils/tx.js'
import { requirePermission } from '../security/access.js'
import { parse } from '../validation.js'
import { prospectService, type ProspectFlag } from './prospect-service.js'
import { sanctionsService } from './sanctions/sanctions-service.js'

/**
 * 线索表格导入（CSV / Excel 由客户端解析成行，服务端按映射写入）：
 * - 每行按公司名 / 官网 upsert（重复导入只合并，不产生重复潜客）；
 * - 证据记为 kind='import'（文件名 + 行号），不会冒充海关证据；
 * - 与 Agent 保存一样做制裁名单初筛（相似度 ≥ 0.92 打 sanctions_hit 并在备注追加一行）；
 * - 单行失败不影响其他行，返回逐行错误。
 */

export const PROSPECT_IMPORT_FIELDS = ['company', 'country', 'website', 'address', 'products', 'hsCodes', 'emails', 'phones', 'notes'] as const
export type ProspectImportField = (typeof PROSPECT_IMPORT_FIELDS)[number]

const SANCTIONS_FLAG_THRESHOLD = 0.92
const MAX_ROWS = 2000

const importInput = z.object({
  fileName: z.string().trim().max(200).default(''),
  mapping: z.partialRecord(z.enum(PROSPECT_IMPORT_FIELDS), z.string().max(200)),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(MAX_ROWS),
})

const splitList = (value: string): string[] =>
  value
    .split(/[,，;；|\n]/)
    .map((part) => part.trim())
    .filter(Boolean)

export interface ProspectImportResult {
  created: number
  merged: number
  skipped: number
  sanctionsHits: number
  errors: Array<{ row: number; message: string }>
}

export function sanctionsPreScreen(company: string, country: string | undefined): { flag: ProspectFlag | null; line: string | null } {
  try {
    const hit = sanctionsService.screen(company, country ? { country } : {}).hits[0]
    if (!hit || hit.score < SANCTIONS_FLAG_THRESHOLD) return { flag: null, line: null }
    return { flag: 'sanctions_hit', line: `[制裁名单初筛] 疑似命中 ${hit.list} ${hit.primaryName}（相似度 ${hit.score.toFixed(2)}），需人工核实` }
  } catch {
    return { flag: null, line: null }
  }
}

export const prospectImportService = {
  import(input: unknown): ProspectImportResult {
    requirePermission('data:write')
    const data = parse(importInput, input)
    if (!data.mapping.company) throw new AppError(400, 'VALIDATION_ERROR', '必须指定“公司”对应的列')
    const result: ProspectImportResult = { created: 0, merged: 0, skipped: 0, sanctionsHits: 0, errors: [] }
    const cell = (row: Record<string, string | number | null>, field: ProspectImportField): string => {
      const column = data.mapping[field]
      if (!column) return ''
      const value = row[column]
      return value === null || value === undefined ? '' : String(value).trim()
    }
    const now = Date.now()
    transaction(() => data.rows.forEach((row, index) => {
      const rowNumber = index + 2 // 第 1 行是表头
      const company = cell(row, 'company')
      if (!company) {
        result.skipped += 1
        return
      }
      try {
        const country = cell(row, 'country')
        const mark = sanctionsPreScreen(company, country || undefined)
        const notes = [cell(row, 'notes'), mark.line].filter(Boolean).join('\n')
        const upserted = prospectService.upsert({
          company,
          country,
          website: cell(row, 'website'),
          address: cell(row, 'address'),
          products: cell(row, 'products'),
          hsCodes: splitList(cell(row, 'hsCodes')).map((code) => code.replace(/[.\s]/g, '')),
          emails: splitList(cell(row, 'emails')).map((email) => email.toLowerCase()),
          phones: splitList(cell(row, 'phones')),
          notes,
          flags: mark.flag ? [mark.flag] : [],
          evidence: [
            {
              kind: 'import',
              source: 'spreadsheet',
              url: '',
              title: data.fileName ? `${data.fileName} 第 ${rowNumber} 行` : `表格导入第 ${rowNumber} 行`,
              snippet: '',
              observedAt: now,
              fields: PROSPECT_IMPORT_FIELDS.filter((field) => cell(row, field)),
            },
          ],
        })
        let prospect = upserted.prospect
        // 合并到已有潜客时备注只补空值：初筛行单独追加一次
        if (mark.line && !prospect.notes.includes(mark.line)) {
          prospect = prospectService.update(prospect.id, { notes: [prospect.notes, mark.line].filter(Boolean).join('\n') })
        }
        if (mark.flag && !prospect.flags.includes('sanctions_hit')) {
          prospectService.update(prospect.id, { flags: [...prospect.flags, 'sanctions_hit'] })
        }
        if (mark.flag) result.sanctionsHits += 1
        if (upserted.created) result.created += 1
        else result.merged += 1
      } catch (error) {
        result.errors.push({ row: rowNumber, message: messageOf(error) })
      }
    }))
    return result
  },
}
