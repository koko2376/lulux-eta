import type { ImportField, ImportRequest } from '../api'
import { localized, t } from '../i18n'

export type Row = Record<string, string>

export interface ParsedSheet {
  headers: string[]
  rows: Row[]
}

export const IMPORT_FIELDS: Array<{ key: ImportField; label: string; required?: boolean }> = localized(() => [
  { key: 'company', label: t('import.field_company'), required: true },
  { key: 'country', label: t('import.field_country') },
  { key: 'website', label: t('import.field_website') },
  { key: 'contactName', label: t('import.field_contactName') },
  { key: 'contactTitle', label: t('import.field_contactTitle') },
  { key: 'contactEmail', label: t('import.field_contactEmail') },
  { key: 'contactPhone', label: t('import.field_contactPhone') },
  { key: 'contactWhatsapp', label: 'WhatsApp' },
  { key: 'stage', label: t('import.field_stage') },
  { key: 'tags', label: t('import.field_tags') },
  { key: 'source', label: t('import.field_source') },
  { key: 'notes', label: t('import.field_notes') },
])

/** 表头同义词（小写、去空格后匹配） */
const SYNONYMS: Record<ImportField, string[]> = {
  company: [
    'company',
    'companyname',
    'customer',
    'customername',
    'organization',
    'account',
    '公司',
    '公司名称',
    '客户',
    '客户名称',
    '企业名称',
    '单位',
  ],
  country: ['country', 'region', 'countryregion', 'nation', '国家', '地区', '国家地区', '国家/地区'],
  website: ['website', 'web', 'url', 'site', 'homepage', 'domain', '网站', '官网', '网址', '域名'],
  contactName: ['contact', 'contactname', 'name', 'fullname', 'person', '联系人', '姓名', '联系人姓名'],
  contactTitle: ['title', 'jobtitle', 'position', 'role', '职位', '职务', '头衔'],
  contactEmail: ['email', 'e-mail', 'mail', 'emailaddress', '邮箱', '电子邮件', '邮件', '邮箱地址'],
  contactPhone: ['phone', 'tel', 'telephone', 'mobile', 'phonenumber', 'cell', '电话', '手机', '联系电话', '手机号'],
  contactWhatsapp: ['whatsapp', 'wa', 'whatsappnumber'],
  stage: ['stage', 'status', 'pipeline', '阶段', '状态', '客户阶段'],
  tags: ['tags', 'tag', 'labels', 'category', 'industry', '标签', '分类', '行业'],
  source: ['source', 'leadsource', 'channel', '来源', '渠道', '客户来源'],
  notes: ['notes', 'note', 'remark', 'remarks', 'comment', 'comments', 'description', '备注', '说明', '描述'],
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()（）:：]/g, '')

export function guessMapping(headers: string[]): Partial<Record<ImportField, string>> {
  const mapping: Partial<Record<ImportField, string>> = {}
  const used = new Set<string>()
  // 先精确匹配，再做包含匹配，避免 "name" 抢走 "company name"
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of Object.keys(SYNONYMS) as ImportField[]) {
      if (mapping[field]) continue
      const synonyms = SYNONYMS[field].map(norm)
      const hit = headers.find((h) => {
        if (used.has(h)) return false
        const n = norm(h)
        return pass === 'exact' ? synonyms.includes(n) : synonyms.some((s) => s.length > 3 && n.includes(s))
      })
      if (hit) {
        mapping[field] = hit
        used.add(hit)
      }
    }
  }
  return mapping
}

/** RFC 4180 CSV 解析：支持引号、转义引号、字段内换行、BOM，自动识别 , ; \t 分隔 */
export function parseCsv(input: string): ParsedSheet {
  const text = input.replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  )
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      record.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else field += ch
  }
  if (field !== '' || record.length) {
    record.push(field)
    records.push(record)
  }
  return toSheet(records)
}

export function toSheet(records: unknown[][]): ParsedSheet {
  const nonEmpty = records.filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
  if (!nonEmpty.length) return { headers: [], rows: [] }
  const seen = new Map<string, number>()
  const headers = nonEmpty[0].map((h, i) => {
    let name = String(h ?? '').trim() || t('import.column', [i + 1])
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n) name = `${name} (${n + 1})`
    return name
  })
  const rows = nonEmpty.slice(1).map((r) => {
    const row: Row = {}
    headers.forEach((h, i) => {
      row[h] = String(r[i] ?? '').trim()
    })
    return row
  })
  return { headers, rows }
}

/** XLSX 用 SheetJS（Apache-2.0，官方 CDN tarball）按需加载，只读第一个工作表 */
export async function parseXlsx(buffer: ArrayBuffer): Promise<ParsedSheet> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return { headers: [], rows: [] }
  const records = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' })
  return toSheet(records)
}

export const MAX_ROWS = 5000

export interface PreviewRow {
  index: number
  company: string
  key: string
  status: 'new' | 'duplicate-in-file' | 'invalid'
  reason?: string
}

export interface ImportPreview {
  rows: PreviewRow[]
  valid: number
  duplicatesInFile: number
  invalid: number
}

export function dedupeKey(row: Row, mapping: ImportRequest['mapping'], dedupeBy: ImportRequest['dedupeBy']): string {
  const field: ImportField = dedupeBy === 'email' ? 'contactEmail' : dedupeBy
  const col = mapping[field]
  const raw = col ? (row[col] ?? '') : ''
  let key = raw.trim().toLowerCase()
  if (dedupeBy === 'website')
    key = key
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')
  if (dedupeBy === 'company')
    key = key
      .replace(/[\s.,]+/g, ' ')
      .replace(/\b(co|ltd|inc|llc|gmbh|ab|bv|srl|limited|company)\b/g, '')
      .trim()
  return key
}

/**
 * 导入前预览（只在客户端做文件内去重与必填校验；与库内已有客户的去重由服务端按 dedupeBy 处理）
 */
export function buildPreview(
  rows: Row[],
  mapping: ImportRequest['mapping'],
  dedupeBy: ImportRequest['dedupeBy'],
): ImportPreview {
  const seen = new Map<string, number>()
  const out: PreviewRow[] = rows.map((row, index) => {
    const company = mapping.company ? (row[mapping.company] ?? '').trim() : ''
    const key = dedupeKey(row, mapping, dedupeBy)
    if (!company) return { index, company, key, status: 'invalid', reason: t('import.missingCompany') }
    const email = mapping.contactEmail ? (row[mapping.contactEmail] ?? '').trim() : ''
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { index, company, key, status: 'invalid', reason: t('import.badEmail', [email]) }
    if (key && seen.has(key))
      return {
        index,
        company,
        key,
        status: 'duplicate-in-file',
        reason: t('import.dupRow', [(seen.get(key) ?? 0) + 1]),
      }
    if (key) seen.set(key, index)
    return { index, company, key, status: 'new' }
  })
  return {
    rows: out,
    valid: out.filter((r) => r.status === 'new').length,
    duplicatesInFile: out.filter((r) => r.status === 'duplicate-in-file').length,
    invalid: out.filter((r) => r.status === 'invalid').length,
  }
}

/** 只把有效行与映射到的列发给服务端，减少请求体积 */
export function rowsForImport(
  rows: Row[],
  preview: ImportPreview,
  mapping: ImportRequest['mapping'],
  onDuplicate: ImportRequest['onDuplicate'],
): Row[] {
  const cols = new Set(Object.values(mapping).filter(Boolean) as string[])
  return preview.rows
    .filter((p) => p.status === 'new' || (p.status === 'duplicate-in-file' && onDuplicate === 'merge'))
    .map((p) => {
      const row: Row = {}
      for (const c of cols) row[c] = rows[p.index][c] ?? ''
      return row
    })
}

/** 先按 UTF-8 解码，出现替换字符时退回 GBK（Excel 中文版另存的 CSV 常见） */
export async function readText(file: Pick<File, 'arrayBuffer'>): Promise<string> {
  const buffer = await file.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}
