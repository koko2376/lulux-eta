import { describe, expect, it } from 'vitest'
import type { Product } from '../api'
import { parseCsv } from './import'
import { filterProducts, guessProductMapping, productCategories, productRowsForImport, productsToCsv } from './products'

const p = (over: Partial<Product>): Product => ({
  id: 'p',
  sku: '',
  name: 'x',
  spec: '',
  unit: 'pcs',
  price: 0,
  currency: 'USD',
  moq: 0,
  hsCode: '',
  category: '',
  ...over,
})

describe('产品库 CSV', () => {
  it('中英文表头都能识别', () => {
    expect(guessProductMapping(['型号', '品名', '分类', '规格', '单位', '单价', '币种', '起订量', 'HS编码'])).toEqual({
      sku: '型号',
      name: '品名',
      category: '分类',
      spec: '规格',
      unit: '单位',
      price: '单价',
      currency: '币种',
      moq: '起订量',
      hsCode: 'HS编码',
    })
    expect(guessProductMapping(['Item No', 'Product Name', 'Unit Price', 'HS Code', 'Other'])).toEqual({
      sku: 'Item No',
      name: 'Product Name',
      price: 'Unit Price',
      hsCode: 'HS Code',
    })
  })

  it('导出再导入字段不丢；防公式注入', () => {
    const csv = productsToCsv([
      p({ sku: 'BV-50', name: 'Ball "Valve", DN50', category: '阀门', price: 12.5, moq: 100, hsCode: '8481.80' }),
      p({ sku: '=cmd', name: 'Evil' }),
    ])
    expect(csv.startsWith('\uFEFFsku,name,category')).toBe(true)
    const sheet = parseCsv(csv)
    const rows = productRowsForImport(sheet.rows, guessProductMapping(sheet.headers))
    expect(rows[0]).toEqual({ sku: 'BV-50', name: 'Ball "Valve", DN50', category: '阀门', unit: 'pcs', price: '12.5', currency: 'USD', moq: '100', hsCode: '8481.80' })
    expect(rows[1]!.sku).toBe("'=cmd")
  })

  it('空行被丢弃', () => {
    expect(productRowsForImport([{ a: '' }, { a: 'Valve' }], { name: 'a' })).toEqual([{ name: 'Valve' }])
  })
})

describe('分类与筛选', () => {
  const list = [
    p({ id: '1', name: 'Ball Valve', category: '阀门', sku: 'BV' }),
    p({ id: '2', name: 'Gate Valve', category: '阀门', hsCode: '8481' }),
    p({ id: '3', name: 'Pump', category: '泵' }),
    p({ id: '4', name: 'Bolt' }),
  ]
  it('分类按数量排序，未分类不计入', () => {
    expect(productCategories(list)).toEqual([
      { value: '阀门', count: 2 },
      { value: '泵', count: 1 },
    ])
  })
  it('搜索 + 分类；空串表示未分类', () => {
    expect(filterProducts(list, 'valve', null).map((x) => x.id)).toEqual(['1', '2'])
    expect(filterProducts(list, '8481', '阀门').map((x) => x.id)).toEqual(['2'])
    expect(filterProducts(list, '', '').map((x) => x.id)).toEqual(['4'])
  })
})
