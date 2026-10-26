import type { ImportField, ImportRequest } from '../api'
import { localized, t } from '../i18n'
// 公司名规范化与服务端共用同一份纯函数，保证文件内去重和服务端按公司名查重的口径一致
import { companyNorm } from '../../../server/src/utils/customer-keys'

export type Row = Record<string, string>

/** 行在源文件里的行号（表头是第 1 行）：存成不可枚举属性，不出现在列里，也不影响按列比较 */
export const LINE_KEY = '__line'

function setLine(row: Row, line: number): Row {
  Object.defineProperty(row, LINE_KEY, { value: String(line), enumerable: false, configurable: true, writable: true })
  return row
}

/** 取行的源文件行号；没有记录时按“表头 + 下标”推算 */
export function lineOf(row: Row | undefined, index: number): number {
  const raw = row ? Number((row as Record<string, unknown>)[LINE_KEY]) : NaN
  return Number.isInteger(raw) && raw > 0 ? raw : index + 2
}

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
  const lines: number[] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  // 物理行号：字段内换行也算一行，与文本编辑器里看到的行号一致
  let line = 1
  let recordLine = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++
        field += ch
      }
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
      lines.push(recordLine)
      line++
      recordLine = line
      record = []
      field = ''
    } else field += ch
  }
  if (field !== '' || record.length) {
    record.push(field)
    records.push(record)
    lines.push(recordLine)
  }
  return toSheet(records, lines)
}

/**
 * 记录 → 表头 + 行。空行丢掉，但每行都记下它在源文件里的行号（lines[i] 是 records[i] 的行号；
 * 不给时按第 i 条记录是第 i + 1 行算），预览、重复提示和服务端报错都用这个行号。
 */
export function toSheet(records: unknown[][], lines?: number[]): ParsedSheet {
  const numbered = records.map((r, i) => ({ r, line: lines?.[i] ?? i + 1 }))
  const kept = numbered.filter(({ r }) => r.some((c) => String(c ?? '').trim() !== ''))
  const nonEmpty = kept.map(({ r }) => r)
  if (!nonEmpty.length) return { headers: [], rows: [] }
  const seen = new Map<string, number>()
  const headers = nonEmpty[0].map((h, i) => {
    let name = String(h ?? '').trim() || t('import.column', [i + 1])
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n) name = `${name} (${n + 1})`
    return name
  })
  const rows = nonEmpty.slice(1).map((r, index) => {
    const row: Row = {}
    headers.forEach((h, i) => {
      row[h] = String(r[i] ?? '').trim()
    })
    return setLine(row, kept[index + 1]!.line)
  })
  return { headers, rows }
}

/** 科学计数法写法（8.6138E+12） */
const SCIENTIFIC = /\d[eE][+-]?\d/

/**
 * 单元格转文本：数字按原值转（整数直接写全，电话 / 编号不会变成 8.6138E+12）；
 * 日期和带前导 0 的自定义格式（邮编、编号）用表格软件显示的文本。
 */
function cellText(cell: { t?: string; v?: unknown; w?: string } | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return ''
  if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
    const shown = typeof cell.w === 'string' ? cell.w.trim() : ''
    if (/^0\d+$/.test(shown)) return shown
    if (Number.isInteger(cell.v)) return Math.abs(cell.v) < 1e21 ? cell.v.toFixed(0) : String(cell.v)
    return shown && !SCIENTIFIC.test(shown) ? shown : String(cell.v)
  }
  if (cell.t === 'd' || cell.v instanceof Date) return typeof cell.w === 'string' ? cell.w : String(cell.v)
  if (cell.t === 'b') return typeof cell.w === 'string' ? cell.w : String(cell.v).toUpperCase()
  if (cell.t === 'e') return typeof cell.w === 'string' ? cell.w : ''
  return String(cell.v)
}

/** XLSX 用 SheetJS（Apache-2.0，官方 CDN tarball）按需加载，只读第一个工作表 */
export async function parseXlsx(buffer: ArrayBuffer): Promise<ParsedSheet> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return { headers: [], rows: [] }
  const ws = wb.Sheets[sheetName]
  if (!ws || !ws['!ref']) return { headers: [], rows: [] }
  // 逐个单元格取值：格式化文本会把长整数写成科学计数法，号码就丢了
  const range = XLSX.utils.decode_range(ws['!ref'])
  const records: string[][] = []
  const lines: number[] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const record: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      record.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as { t?: string; v?: unknown; w?: string } | undefined))
    }
    records.push(record)
    lines.push(r + 1) // 工作表行号从 1 开始
  }
  return toSheet(records, lines)
}

export const MAX_ROWS = 5000

export interface PreviewRow {
  index: number
  /** 源文件行号（与表格软件 / 文本编辑器里看到的一致） */
  line: number
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
  if (dedupeBy === 'company') key = companyNorm(raw)
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
  // key → 第一次出现时的源文件行号
  const seen = new Map<string, number>()
  const out: PreviewRow[] = rows.map((row, index) => {
    const line = lineOf(row, index)
    const company = mapping.company ? (row[mapping.company] ?? '').trim() : ''
    const key = dedupeKey(row, mapping, dedupeBy)
    if (!company) return { index, line, company, key, status: 'invalid', reason: t('import.missingCompany') }
    const email = mapping.contactEmail ? (row[mapping.contactEmail] ?? '').trim() : ''
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { index, line, company, key, status: 'invalid', reason: t('import.badEmail', [email]) }
    if (key && seen.has(key))
      return {
        index,
        line,
        company,
        key,
        status: 'duplicate-in-file',
        reason: t('import.dupRow', [seen.get(key) ?? line]),
      }
    if (key) seen.set(key, line)
    return { index, line, company, key, status: 'new' }
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
      // 带上源文件行号，服务端报错时按文件行号说
      const line = Number((rows[p.index] as Record<string, unknown>)[LINE_KEY])
      if (Number.isInteger(line) && line > 0 && !cols.has(LINE_KEY)) row[LINE_KEY] = String(line)
      return row
    })
}

/** 看 BOM 和 0x00 的分布判断是不是 UTF-16（表格软件另存的“Unicode 文本”是 UTF-16LE + BOM） */
function utf16Encoding(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  // 没有 BOM：ASCII 为主的 UTF-16 文本，奇数位（LE）或偶数位（BE）大量是 0x00
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  if (sample.length < 4) return null
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0) evenZero++
    if (sample[i + 1] === 0) oddZero++
  }
  const pairs = Math.floor(sample.length / 2)
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le'
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be'
  return null
}

/** 先认 UTF-16（BOM / 0x00 分布），再按 UTF-8 解码，出现替换字符时退回 GBK（中文版表格软件另存的 CSV 常见） */
export async function readText(file: Pick<File, 'arrayBuffer'>): Promise<string> {
  const buffer = await file.arrayBuffer()
  const utf16 = utf16Encoding(new Uint8Array(buffer))
  if (utf16) {
    try {
      // TextDecoder 会自动去掉 BOM
      return new TextDecoder(utf16).decode(buffer)
    } catch {
      // 运行环境不支持该编码时按下面的流程处理
    }
  }
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}
