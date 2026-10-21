import { describe, expect, it } from 'vitest'
import { buildPreview, dedupeKey, guessMapping, parseCsv, rowsForImport, toSheet } from './import'

describe('CSV 解析', () => {
  it('支持 BOM、引号、转义引号与字段内换行', () => {
    const csv = '\uFEFFCompany,Email,Notes\r\n"Acme, Inc.",a@acme.com,"said ""hi""\nsecond line"\r\nBeta,b@beta.io,\r\n'
    const { headers, rows } = parseCsv(csv)
    expect(headers).toEqual(['Company', 'Email', 'Notes'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ Company: 'Acme, Inc.', Email: 'a@acme.com', Notes: 'said "hi"\nsecond line' })
  })
  it('自动识别分号与制表符分隔', () => {
    expect(parseCsv('a;b\n1;2').rows[0]).toEqual({ a: '1', b: '2' })
    expect(parseCsv('a\tb\n1\t2').rows[0]).toEqual({ a: '1', b: '2' })
  })
  it('重复表头与空表头被重命名，空行被忽略', () => {
    const sheet = toSheet([
      ['Name', 'Name', ''],
      ['x', 'y', 'z'],
      ['', '', ''],
    ])
    expect(sheet.headers).toEqual(['Name', 'Name (2)', '列3'])
    expect(sheet.rows).toHaveLength(1)
  })
})

describe('字段映射', () => {
  it('中英文表头自动匹配', () => {
    const m = guessMapping(['公司名称', '国家', '联系人', '邮箱', '手机', '备注'])
    expect(m).toMatchObject({
      company: '公司名称',
      country: '国家',
      contactName: '联系人',
      contactEmail: '邮箱',
      contactPhone: '手机',
      notes: '备注',
    })
    const e = guessMapping(['Company Name', 'Contact Name', 'E-mail', 'Website', 'WhatsApp'])
    expect(e).toMatchObject({
      company: 'Company Name',
      contactName: 'Contact Name',
      contactEmail: 'E-mail',
      website: 'Website',
      contactWhatsapp: 'WhatsApp',
    })
  })
  it('同一列不会被映射两次', () => {
    const m = guessMapping(['Name'])
    expect(Object.values(m).filter((v) => v === 'Name')).toHaveLength(1)
  })
})

describe('去重预览', () => {
  const rows = [
    { C: 'Acme Co., Ltd.', E: 'A@acme.com', W: 'https://www.acme.com/en' },
    { C: 'Acme', E: 'a@ACME.com', W: 'acme.com' },
    { C: '', E: 'x@y.com', W: '' },
    { C: 'Beta', E: 'not-an-email', W: '' },
    { C: 'Gamma', E: '', W: '' },
  ]
  const mapping = { company: 'C', contactEmail: 'E', website: 'W' }

  it('按邮箱去重（忽略大小写）', () => {
    const p = buildPreview(rows, mapping, 'email')
    expect(p.rows.map((r) => r.status)).toEqual(['new', 'duplicate-in-file', 'invalid', 'invalid', 'new'])
    expect(p).toMatchObject({ valid: 2, duplicatesInFile: 1, invalid: 2 })
  })
  it('按网站去重会规范化协议、www 与路径', () => {
    expect(dedupeKey(rows[0], mapping, 'website')).toBe('acme.com')
    expect(buildPreview(rows, mapping, 'website').rows[1].status).toBe('duplicate-in-file')
  })
  it('按公司去重忽略公司后缀', () => {
    expect(dedupeKey(rows[0], mapping, 'company')).toBe('acme')
  })
  it('导入行只包含映射列；merge 时保留文件内重复交给服务端合并', () => {
    const p = buildPreview(rows, mapping, 'email')
    const skip = rowsForImport(rows, p, { company: 'C', contactEmail: 'E' }, 'skip')
    expect(skip).toEqual([
      { C: 'Acme Co., Ltd.', E: 'A@acme.com' },
      { C: 'Gamma', E: '' },
    ])
    expect(rowsForImport(rows, p, mapping, 'merge')).toHaveLength(3)
  })
})
