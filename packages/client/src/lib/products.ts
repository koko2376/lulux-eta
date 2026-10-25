import type { Product } from '../api'
import type { Row } from './import'

/** 产品库 CSV 的列：导出用 key 作表头；导入时同时认中文 / 英文常见写法 */
export const PRODUCT_CSV_FIELDS = ['sku', 'name', 'category', 'spec', 'unit', 'price', 'currency', 'moq', 'hsCode'] as const
export type ProductCsvField = (typeof PRODUCT_CSV_FIELDS)[number]

const ALIASES: Record<ProductCsvField, string[]> = {
  sku: ['sku', 'model', 'item no', 'item', 'part no', 'code', '型号', '货号', '编号', '料号'],
  name: ['name', 'product', 'product name', 'description', '名称', '品名', '产品名', '产品名称', '产品'],
  category: ['category', 'type', 'group', '分类', '类别', '品类'],
  spec: ['spec', 'specs', 'specification', 'specifications', '规格', '规格型号', '参数'],
  unit: ['unit', 'uom', '单位'],
  price: ['price', 'unit price', 'list price', '单价', '价格', '报价'],
  currency: ['currency', 'ccy', '币种', '货币'],
  moq: ['moq', 'min order', 'minimum order', '起订量', '最小起订量'],
  hsCode: ['hscode', 'hs code', 'hs', 'hs编码', '海关编码', '商品编码'],
}

const squash = (value: string) => value.trim().toLowerCase().replace(/[\s_\-./]+/g, ' ').trim()

/** 表头 → 字段；认不出的列忽略 */
export function guessProductMapping(headers: string[]): Partial<Record<ProductCsvField, string>> {
  const mapping: Partial<Record<ProductCsvField, string>> = {}
  for (const field of PRODUCT_CSV_FIELDS) {
    const names = ALIASES[field].map(squash)
    const hit = headers.find((h) => names.includes(squash(h)) || squash(h).replace(/ /g, '') === field.toLowerCase())
    if (hit && !Object.values(mapping).includes(hit)) mapping[field] = hit
  }
  return mapping
}

/** 按映射把表格行转成导入接口的行（只带有值的字段） */
export function productRowsForImport(rows: Row[], mapping: Partial<Record<ProductCsvField, string>>): Array<Record<string, string>> {
  return rows
    .map((row) => {
      const out: Record<string, string> = {}
      for (const field of PRODUCT_CSV_FIELDS) {
        const column = mapping[field]
        const value = column ? (row[column] ?? '').trim() : ''
        if (value) out[field] = value
      }
      return out
    })
    .filter((row) => Object.keys(row).length > 0)
}

function csvCell(value: unknown): string {
  let text = String(value ?? '')
  // 防公式注入
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出 CSV（UTF-8 BOM，Excel 直接打开不乱码） */
export function productsToCsv(products: Product[]): string {
  const lines = [PRODUCT_CSV_FIELDS.join(',')]
  for (const p of products) lines.push(PRODUCT_CSV_FIELDS.map((field) => csvCell(p[field])).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 分类列表（按产品数降序、同数按名称） */
export function productCategories(products: Product[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const p of products) {
    const key = (p.category ?? '').trim()
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** 搜索（SKU / 名称 / 规格 / HS 编码）+ 分类筛选；category 为 null 表示全部，'' 表示未分类 */
export function filterProducts(products: Product[], query: string, category: string | null): Product[] {
  const needle = query.trim().toLowerCase()
  return products.filter((p) => {
    if (category !== null && (p.category ?? '').trim() !== category) return false
    if (!needle) return true
    return [p.sku, p.name, p.spec, p.hsCode, p.category].some((v) => (v ?? '').toLowerCase().includes(needle))
  })
}
