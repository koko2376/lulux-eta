import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'
import { buildPreview, dedupeKey, lineOf, parseCsv, parseXlsx, readText, rowsForImport, toSheet } from './import'
import { companyNorm } from '../../../server/src/utils/customer-keys'

/** 回归：客户 / 线索导入（数字电话、UTF-16 文本、行号、公司名查重口径） */

function xlsxOf(aoa: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'S')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('XLSX：数字单元格里的电话按原值转文本', () => {
  it('8613800138000 / 4915112345678 不会变成科学计数法；小数、文本、日期照常', async () => {
    const sheet = await parseXlsx(
      xlsxOf([
        ['Company', 'Phone', 'WhatsApp', 'Price', 'Note'],
        ['Acme', 8613800138000, 4915112345678, 0.0875, 'tel 123'],
      ]),
    )
    expect(sheet.rows[0]).toEqual({
      Company: 'Acme',
      Phone: '8613800138000',
      WhatsApp: '4915112345678',
      Price: '0.0875',
      Note: 'tel 123',
    })
  })

  it('带前导 0 的自定义格式（编号）保留表格里显示的文本', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Company', 'Code'],
      ['Acme', 123],
    ])
    ws['B2']!.z = '00000'
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const sheet = await parseXlsx(buf)
    expect(sheet.rows[0]!.Code).toBe('00123')
  })

  it('XLSX 的行号就是工作表的行号（中间有空行也对得上）', async () => {
    const sheet = await parseXlsx(xlsxOf([['Company'], ['A'], [''], ['B']]))
    expect(sheet.rows.map((r, i) => lineOf(r, i))).toEqual([2, 4])
  })
})

describe('文本文件：UTF-16（“Unicode 文本”另存格式）正确解码', () => {
  const toBuf = (b: Buffer) => ({
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
  })
  const text = 'Company\tCountry\r\n阀门有限公司\tDE\r\n'

  it('UTF-16LE + BOM', async () => {
    const out = await readText(toBuf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])))
    expect(out).toBe(text)
    expect(parseCsv(out).rows[0]).toEqual({ Company: '阀门有限公司', Country: 'DE' })
  })

  it('UTF-16BE + BOM', async () => {
    const le = Buffer.from(text, 'utf16le')
    const be = Buffer.alloc(le.length)
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!
      be[i + 1] = le[i]!
    }
    expect(await readText(toBuf(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toBe(text)
  })

  it('没有 BOM 的 UTF-16LE（以 ASCII 为主）也能认出', async () => {
    expect(await readText(toBuf(Buffer.from('Company,Country\r\nAcme,DE\r\n', 'utf16le')))).toBe(
      'Company,Country\r\nAcme,DE\r\n',
    )
  })

  it('UTF-8 与 GBK 不受影响', async () => {
    expect(await readText(toBuf(Buffer.from('公司,国家\n阀门,DE\n', 'utf8')))).toBe('公司,国家\n阀门,DE\n')
    const gbk = Buffer.from([0xb9, 0xab, 0xcb, 0xbe, 0x0a]) // “公司\n”
    expect(await readText(toBuf(gbk))).toBe('公司\n')
  })
})

describe('导入行号与文件行号一致', () => {
  it('预览、文件内重复提示、发给服务端的行都用文件行号', () => {
    const sheet = toSheet([
      ['Company', 'Email'],
      ['', 'nobody@x.com'], // 第 2 行：缺公司名
      ['Acme', 'a@acme.com'], // 第 3 行
      ['', ''], // 第 4 行：空行
      ['Acme', 'a@acme.com'], // 第 5 行：与第 3 行重复
      ['Beta', 'b@beta.io'], // 第 6 行
    ])
    const mapping = { company: 'Company', contactEmail: 'Email' }
    const preview = buildPreview(sheet.rows, mapping, 'email')
    expect(preview.rows.map((r) => r.line)).toEqual([2, 3, 5, 6])
    const dup = preview.rows.find((r) => r.status === 'duplicate-in-file')!
    expect(dup.line).toBe(5)
    expect(dup.reason).toContain('3')
    const sent = rowsForImport(sheet.rows, preview, mapping, 'skip')
    expect(sent.find((r) => r.Company === 'Beta')!.__line).toBe('6')
    expect(sent.find((r) => r.Company === 'Acme')!.__line).toBe('3')
  })

  it('CSV：引号内换行和空行都按物理行号算', () => {
    const sheet = parseCsv('Company,Notes\n"Acme","line1\nline2"\n\nBeta,x\n')
    expect(sheet.rows.map((r, i) => lineOf(r, i))).toEqual([2, 5])
    // 行号是不可枚举属性，不出现在列里
    expect(Object.keys(sheet.rows[0]!)).toEqual(['Company', 'Notes'])
  })
})

describe('文件内按公司名去重与服务端口径一致', () => {
  it('dedupeKey(company) 与服务端 companyNorm 相同', () => {
    const mapping = { company: 'C' }
    for (const name of [
      'ACME Trading Co., Ltd.',
      'Acme Trading',
      '温州阀门有限公司',
      'Müller GmbH & Co. KG',
      'The Acme Group Inc.',
    ]) {
      expect(dedupeKey({ C: name }, mapping, 'company')).toBe(companyNorm(name))
    }
    const preview = buildPreview([{ C: 'ACME Trading Co., Ltd.' }, { C: 'Acme Trading' }], mapping, 'company')
    expect(preview.rows[1]!.status).toBe('duplicate-in-file')
  })
})
