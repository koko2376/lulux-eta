import { randomUUID } from 'node:crypto'

/**
 * CSV 解析：容错列数、引号、自定义分隔符、BOM、CRLF、空行。
 * 不依赖外部 CSV 库。
 */
export function parseCsv(text: string, options: { delimiter?: string; hasHeader?: boolean } = {}): { headers: string[] | null; rows: string[][] } {
  const delimiter = options.delimiter ?? ','
  const input = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(cell)
    cell = ''
    // 跳过空行（只有一个空单元）
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row.map((value) => value.trim()))
    row = []
  }
  while (i < input.length) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && input[i + 1] === '\n') i++
      i++
      continue
    }
    cell += ch
    i++
  }
  if (cell !== '' || row.length > 0) endRow()
  if (!options.hasHeader) return { headers: null, rows }
  const [headerRow, ...rest] = rows
  return { headers: headerRow ?? [], rows: rest }
}

function trimCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanOfacValue(value: string): string {
  const trimmed = trimCell(value)
  return trimmed === '-0-' || trimmed === '-0- ' ? '' : trimmed
}

function parseOfacRow(row: string[]): { entNum: string; name: string; type: string; programs: string; remarks: string } {
  return {
    entNum: cleanOfacValue(row[0] ?? ''),
    name: cleanOfacValue(row[1] ?? ''),
    type: cleanOfacValue(row[2] ?? ''),
    programs: cleanOfacValue(row[3] ?? ''),
    remarks: cleanOfacValue(row[11] ?? ''),
  }
}

export interface SanctionsEntry {
  id: string
  list: 'ofac' | 'eu' | 'un' | 'custom'
  ref: string
  name: string
  nameKey: string
  entityType: string
  programs: string
  countries: string[]
  remarks: string
  isAlias: number
  primaryName: string
}

export function nameKey(s: string): string {
  const suffixes = new Set([
    'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'gmbh',
    'sa', 's.a.', 'srl', 'bv', 'plc', 'pte', 'pvt', 'private', 'jsc', 'ooo', 'oao', 'zao', 'sarl', 'ag',
    'kg', 'spa', 'sas', 'ab', 'oy', 'as', 'llp', 'lp', 'fze', 'fzco', 'est', 'trading', 'group', 'holding',
    'holdings', 'international', 'intl', 'the',
  ])
  let value = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  // 点号缩写（S.A. / L.L.C.）先合并成一个词，再去标点
  value = value.replace(/(?:(?<![\p{L}\p{N}])\p{L}\.){2,}/gu, (m) => m.replace(/\./g, '') + ' ')
  value = value.replace(/[\p{P}\p{S}]/gu, ' ')
  const tokens = value.split(/\s+/).filter(Boolean)
  const filtered = tokens.filter((token) => {
    if (suffixes.has(token)) return false
    const stripped = token.replace(/\.$/, '')
    return !suffixes.has(stripped)
  })
  // 全是后缀词（如 “Trading Group Ltd”）时保留原词，避免得到空键
  return (filtered.length ? filtered : tokens).join(' ').trim()
}

function newId(): string {
  return randomUUID()
}

function createEntry(input: Omit<SanctionsEntry, 'id'>): SanctionsEntry {
  return { ...input, id: newId() }
}

function countryOf(value: string): string[] {
  const code = value.trim().toUpperCase()
  if (!code || code === '-0-' || code === '-0- ') return []
  if (code.length === 2) return [code]
  return [code]
}

export function parseOfac(sdnCsv: string, altCsv?: string): SanctionsEntry[] {
  const out: SanctionsEntry[] = []
  const aliases = new Map<string, { name: string; remarks: string }[]>()
  if (altCsv !== undefined && altCsv !== '') {
    const { rows: altRows } = parseCsv(altCsv, { hasHeader: false })
    for (const row of altRows) {
      if (row.length < 4) continue
      const entNum = cleanOfacValue(row[0] ?? '')
      const altName = cleanOfacValue(row[3] ?? '')
      if (!entNum || !altName) continue
      const list = aliases.get(entNum) ?? []
      list.push({ name: altName, remarks: cleanOfacValue(row[4] ?? '') })
      aliases.set(entNum, list)
    }
  }
  const { rows } = parseCsv(sdnCsv, { hasHeader: false })
  for (const row of rows) {
    if (row.length < 2) continue
    const parsed = parseOfacRow(row)
    const entNum = parsed.entNum
    const name = parsed.name
    if (!entNum || !name) continue
    // SDN_Type：individual / vessel / aircraft；公司实体为 -0-（空）
    const type = parsed.type || 'entity'
    const programs = parsed.programs
    const remarks = parsed.remarks
    const primary: SanctionsEntry = createEntry({
      list: 'ofac',
      ref: entNum,
      name,
      nameKey: nameKey(name),
      entityType: type.toLowerCase(),
      programs,
      countries: [],
      remarks,
      isAlias: 0,
      primaryName: name,
    })
    out.push(primary)
    const aliasList = aliases.get(entNum) ?? []
    for (const alias of aliasList) {
      out.push(
        createEntry({
          list: 'ofac',
          ref: entNum,
          name: alias.name,
          nameKey: nameKey(alias.name),
          entityType: type.toLowerCase(),
          programs,
          countries: [],
          remarks: alias.remarks,
          isAlias: 1,
          primaryName: name,
        }),
      )
    }
  }
  return out
}

export function parseEu(csv: string): SanctionsEntry[] {
  const { headers, rows } = parseCsv(csv, { delimiter: ';', hasHeader: true })
  const out: SanctionsEntry[] = []
  if (!headers) return out
  const index: Record<string, number> = {}
  headers.forEach((h, i) => { index[h.trim()] = i })
  const col = (row: string[], name: string) => (index[name] === undefined ? '' : (row[index[name]] ?? '').trim())
  // 欧盟文件按“实体 × 别名 × 地址 × …”展开成多行：先按实体聚合，第一个名字作主名，其余为别名
  const entities = new Map<string, { names: string[]; countries: Set<string>; programs: Set<string>; type: string }>()
  for (const row of rows) {
    const id = col(row, 'Entity_LogicalId')
    if (!id) continue
    const entity = entities.get(id) ?? { names: [], countries: new Set<string>(), programs: new Set<string>(), type: '' }
    entities.set(id, entity)
    const whole = trimCell(col(row, 'NameAlias_WholeName'))
    if (whole && !entity.names.some((n) => n.toLowerCase() === whole.toLowerCase())) entity.names.push(whole)
    const country = col(row, 'Address_CountryIso2Code').toUpperCase()
    if (/^[A-Z]{2}$/.test(country) && country !== '00') entity.countries.add(country)
    const program = col(row, 'Entity_Regulation_Programme')
    if (program) entity.programs.add(program)
    const code = col(row, 'Entity_SubjectType_ClassificationCode').toLowerCase()
    if (code && !entity.type) entity.type = code === 'person' ? 'individual' : code === 'enterprise' ? 'entity' : code
  }
  for (const [id, entity] of entities) {
    const primary = entity.names[0]
    if (!primary) continue
    entity.names.forEach((name, i) => {
      out.push(
        createEntry({
          list: 'eu',
          ref: id,
          name,
          nameKey: nameKey(name),
          entityType: entity.type,
          programs: [...entity.programs].join('; '),
          countries: [...entity.countries],
          remarks: '',
          isAlias: i === 0 ? 0 : 1,
          primaryName: primary,
        }),
      )
    })
  }
  return out
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function parseUn(xml: string): SanctionsEntry[] {
  const out: SanctionsEntry[] = []
  const cleanXml = xml.replace(/^﻿/, '')
  function extractBlock(tag: string): string[] {
    const blocks: string[] = []
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
    let match: RegExpExecArray | null
    while ((match = regex.exec(cleanXml)) !== null) {
      blocks.push(match[1]!)
    }
    return blocks
  }
  function getTag(block: string, tag: string): string {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block)
    return match ? decodeXml(match[1]!.trim()) : ''
  }
  function getAliasNames(block: string, tag: string): string[] {
    const names: string[] = []
    const wrapper = new RegExp(`<(INDIVIDUAL|ENTITY)_ALIAS>([\\s\\S]*?)<\\/(INDIVIDUAL|ENTITY)_ALIAS>`, 'g')
    let m: RegExpExecArray | null
    while ((m = wrapper.exec(block)) !== null) {
      const alias = getTag(m[2]!, 'ALIAS_NAME').trim()
      if (alias) names.push(alias)
    }
    return names
  }
  function countryFromAddress(block: string): string[] {
    const match = /<ADDRESS>([\s\S]*?)<\/ADDRESS>/.exec(block)
    if (!match) return []
    const country = getTag(match[1]!, 'COUNTRY').trim()
    return country ? [country] : []
  }
  for (const block of extractBlock('INDIVIDUAL')) {
    const ref = getTag(block, 'REFERENCE_NUMBER') || getTag(block, 'DATAID')
    const name = [getTag(block, 'FIRST_NAME'), getTag(block, 'SECOND_NAME'), getTag(block, 'THIRD_NAME')]
      .filter(Boolean)
      .join(' ')
      .trim()
    const programs = [getTag(block, 'UN_LIST_TYPE')].filter(Boolean)
    const countries = countryFromAddress(block)
    const aliases = getAliasNames(block, 'INDIVIDUAL_ALIAS')
    if (!name) continue
    out.push(createEntry({
      list: 'un',
      ref: ref || name,
      name,
      nameKey: nameKey(name),
      entityType: 'individual',
      programs: programs.join('; '),
      countries,
      remarks: '',
      isAlias: 0,
      primaryName: name,
    }))
    for (const alias of aliases) {
      out.push(createEntry({
        list: 'un',
        ref: ref || name,
        name: alias,
        nameKey: nameKey(alias),
        entityType: 'individual',
        programs: programs.join('; '),
        countries,
        remarks: '',
        isAlias: 1,
        primaryName: name,
      }))
    }
  }
  for (const block of extractBlock('ENTITY')) {
    const ref = getTag(block, 'REFERENCE_NUMBER') || getTag(block, 'DATAID')
    const name = getTag(block, 'FIRST_NAME')
    const programs = [getTag(block, 'UN_LIST_TYPE')].filter(Boolean)
    const countries = countryFromAddress(block)
    const aliases = getAliasNames(block, 'ENTITY_ALIAS')
    if (!name) continue
    out.push(createEntry({
      list: 'un',
      ref: ref || name,
      name,
      nameKey: nameKey(name),
      entityType: 'entity',
      programs: programs.join('; '),
      countries,
      remarks: '',
      isAlias: 0,
      primaryName: name,
    }))
    for (const alias of aliases) {
      out.push(createEntry({
        list: 'un',
        ref: ref || name,
        name: alias,
        nameKey: nameKey(alias),
        entityType: 'entity',
        programs: programs.join('; '),
        countries,
        remarks: '',
        isAlias: 1,
        primaryName: name,
      }))
    }
  }
  return out
}

export function parseCustomCsv(csv: string): SanctionsEntry[] {
  const { headers, rows } = parseCsv(csv, { delimiter: ',', hasHeader: true })
  const out: SanctionsEntry[] = []
  if (!headers) return out
  const index: Record<string, number> = {}
  headers.forEach((h, i) => { index[h.toLowerCase()] = i })
  if (index['name'] === undefined) return out
  const get = (row: string[], col: string): string => (row[index[col]!] ?? '').trim()
  for (const row of rows) {
    const name = get(row, 'name')
    if (!name) continue
    const ref = get(row, 'ref') || name
    const countries = countryOf(get(row, 'country'))
    const type = get(row, 'type')
    const program = get(row, 'program')
    const remarks = get(row, 'remarks')
    out.push(createEntry({
      list: 'custom',
      ref,
      name,
      nameKey: nameKey(name),
      entityType: type || '',
      programs: program || '',
      countries,
      remarks,
      isAlias: 0,
      primaryName: name,
    }))
  }
  return out
}
