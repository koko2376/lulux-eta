import { z } from 'zod'
import { db } from '../db.js'
import { currentActor } from '../context.js'
import { AppError, notFound } from '../errors.js'
import { requirePermission } from '../security/access.js'
import { newId } from '../utils/id.js'
import { transaction } from '../utils/tx.js'
import { parse } from '../validation.js'

export interface Product {
  id: string
  sku: string
  name: string
  spec: string
  unit: string
  price: number
  currency: string
  moq: number
  hsCode: string
  category: string
  createdAt: number
  updatedAt: number
}

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, '币种必须是 3 位字母代码，如 USD')

const productShape = {
  sku: z.string().trim().max(100),
  name: z.string().trim().min(1, '产品名不能为空').max(300),
  spec: z.string().max(5000),
  unit: z.string().trim().max(30),
  price: z.number().finite().min(0, '价格不能为负数').max(1e12),
  currency: currencyCode,
  moq: z.number().int().min(0).max(1e9),
  hsCode: z.string().trim().max(20).regex(/^[0-9.]*$/, 'HS 编码只能包含数字和点'),
  category: z.string().trim().max(100),
}

export const productCreateInput = z.object({
  ...productShape,
  sku: productShape.sku.default(''),
  spec: productShape.spec.default(''),
  unit: productShape.unit.default('pcs'),
  price: productShape.price.default(0),
  currency: productShape.currency.default('USD'),
  moq: productShape.moq.default(0),
  hsCode: productShape.hsCode.default(''),
  category: productShape.category.default(''),
})

export const productPatchInput = z.object(productShape).partial().strict()

/** 批量导入（CSV 在客户端解析成行）：按 SKU 匹配已有产品时更新，否则新建 */
export const productImportInput = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
    onDuplicate: z.enum(['update', 'skip']).default('update'),
  })
  .strict()

interface ProductRow {
  id: string
  sku: string
  name: string
  spec: string
  unit: string
  price: number
  currency: string
  moq: number
  hs_code: string
  category: string | null
  created_at: number
  updated_at: number
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    spec: row.spec,
    unit: row.unit,
    price: Number(row.price),
    currency: row.currency,
    moq: Number(row.moq),
    hsCode: row.hs_code,
    category: row.category ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** CSV 单元格常见写法转数字：去千分位与货币符号；空串视为未填 */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[,\s$€£¥]/g, '')
  if (!cleaned) return undefined
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : Number.NaN
}

function textCell(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

const orgId = (): string => currentActor().orgId

export const productService = {
  /** 当前组织的产品 */
  list(): Product[] {
    return (
      db.prepare('SELECT * FROM products WHERE org_id = ? ORDER BY created_at DESC, rowid DESC').all(orgId()) as unknown as ProductRow[]
    ).map(toProduct)
  },

  get(id: string): Product | undefined {
    const row = db.prepare('SELECT * FROM products WHERE id = ? AND org_id = ?').get(id, orgId()) as unknown as ProductRow | undefined
    return row ? toProduct(row) : undefined
  },

  create(input: unknown): Product {
    requirePermission('catalog:write')
    const data = parse(productCreateInput, input)
    return productService.insert(data)
  },

  insert(data: z.infer<typeof productCreateInput>): Product {
    const now = Date.now()
    const id = newId('prd')
    db.prepare(
      `INSERT INTO products (id, org_id, sku, name, spec, unit, price, currency, moq, hs_code, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId(), data.sku, data.name, data.spec, data.unit, data.price, data.currency, data.moq, data.hsCode, data.category, now, now)
    return productService.get(id)!
  },

  update(id: string, input: unknown): Product {
    requirePermission('catalog:write')
    const patch = parse(productPatchInput, input)
    const current = productService.get(id)
    if (!current) throw notFound('产品')
    const next = { ...current, ...patch }
    db.prepare(
      `UPDATE products SET sku = ?, name = ?, spec = ?, unit = ?, price = ?, currency = ?, moq = ?, hs_code = ?, category = ?, updated_at = ?
       WHERE id = ? AND org_id = ?`,
    ).run(next.sku, next.name, next.spec, next.unit, next.price, next.currency, next.moq, next.hsCode, next.category, Date.now(), id, orgId())
    return productService.get(id)!
  },

  remove(id: string): void {
    requirePermission('catalog:write')
    const result = db.prepare('DELETE FROM products WHERE id = ? AND org_id = ?').run(id, orgId())
    if (Number(result.changes) === 0) throw notFound('产品')
  },

  /** 批量导入：每行校验，出错的行记下原因跳过，其余在一个事务里写入 */
  import(input: unknown): { created: number; updated: number; skipped: number; errors: Array<{ row: number; message: string }> } {
    requirePermission('catalog:write')
    const data = parse(productImportInput, input)
    const result = { created: 0, updated: 0, skipped: 0, errors: [] as Array<{ row: number; message: string }> }
    transaction(() => {
      data.rows.forEach((raw, index) => {
        const row = index + 1
        const candidate: Record<string, unknown> = {}
        for (const key of ['sku', 'name', 'spec', 'unit', 'currency', 'hsCode', 'category'] as const) {
          const value = textCell(raw[key])
          if (value !== undefined) candidate[key] = value
        }
        for (const key of ['price', 'moq'] as const) {
          const value = numeric(raw[key])
          if (value !== undefined) candidate[key] = value
        }
        const parsed = productCreateInput.safeParse(candidate)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          result.errors.push({ row, message: `${issue?.path.join('.') || 'row'}：${issue?.message ?? '格式不正确'}` })
          return
        }
        const value = parsed.data
        const existing = value.sku
          ? (db.prepare('SELECT id FROM products WHERE org_id = ? AND lower(sku) = lower(?) LIMIT 1').get(orgId(), value.sku) as unknown as { id: string } | undefined)
          : undefined
        if (!existing) {
          productService.insert(value)
          result.created += 1
          return
        }
        if (data.onDuplicate === 'skip') {
          result.skipped += 1
          return
        }
        const patch: Record<string, unknown> = {}
        for (const key of Object.keys(candidate)) patch[key] = value[key as keyof typeof value]
        try {
          productService.update(existing.id, patch)
          result.updated += 1
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          result.errors.push({ row, message: error.message })
        }
      })
    })
    return result
  },
}
