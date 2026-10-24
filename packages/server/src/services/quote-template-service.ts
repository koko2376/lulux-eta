import { z } from 'zod'
import { db } from '../db.js'
import { notFound } from '../errors.js'
import { newId } from '../utils/id.js'
import { parse } from '../validation.js'
import { currencyCode } from './product-service.js'

export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const
export type Incoterm = (typeof INCOTERMS)[number]

export interface QuoteTemplate {
  id: string
  name: string
  isDefault: boolean
  company: { name: string; address: string; phone: string; email: string; logoDataUrl: string }
  defaultIncoterm: Incoterm
  defaultCurrency: string
  defaultPaymentTerms: string
  footer: string
  createdAt: number
  updatedAt: number
}

/** logo 只接受位图 data URL（png/jpeg/webp/gif），最大约 1 MB */
const logoDataUrl = z
  .string()
  .max(1_400_000, 'Logo 太大（上限约 1 MB）')
  .refine(
    (value) => value === '' || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value),
    'Logo 必须是 png/jpeg/webp/gif 的 data URL',
  )

const companyInput = z.object({
  name: z.string().trim().max(300).default(''),
  address: z.string().trim().max(1000).default(''),
  phone: z.string().trim().max(100).default(''),
  email: z.string().trim().max(320).default(''),
  logoDataUrl: logoDataUrl.default(''),
})

const shape = {
  name: z.string().trim().min(1, '模板名不能为空').max(200),
  isDefault: z.boolean(),
  company: companyInput,
  defaultIncoterm: z.enum(INCOTERMS),
  defaultCurrency: currencyCode,
  defaultPaymentTerms: z.string().trim().max(1000),
  footer: z.string().max(5000),
}

export const templateCreateInput = z.object({
  ...shape,
  isDefault: shape.isDefault.default(false),
  company: companyInput.default({ name: '', address: '', phone: '', email: '', logoDataUrl: '' }),
  defaultIncoterm: shape.defaultIncoterm.default('FOB'),
  defaultCurrency: shape.defaultCurrency.default('USD'),
  defaultPaymentTerms: shape.defaultPaymentTerms.default(''),
  footer: shape.footer.default(''),
})

export const templatePatchInput = z.object(shape).partial().strict()

interface TemplateRow {
  id: string
  name: string
  is_default: number
  company: string
  default_incoterm: string
  default_currency: string
  default_payment_terms: string
  footer: string
  created_at: number
  updated_at: number
}

function toTemplate(row: TemplateRow): QuoteTemplate {
  let company: QuoteTemplate['company'] = { name: '', address: '', phone: '', email: '', logoDataUrl: '' }
  try {
    company = { ...company, ...(JSON.parse(row.company) as Partial<QuoteTemplate['company']>) }
  } catch {
    // 保持默认
  }
  return {
    id: row.id,
    name: row.name,
    isDefault: Number(row.is_default) === 1,
    company,
    defaultIncoterm: row.default_incoterm as Incoterm,
    defaultCurrency: row.default_currency,
    defaultPaymentTerms: row.default_payment_terms,
    footer: row.footer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const quoteTemplateService = {
  list(): QuoteTemplate[] {
    return (
      db.prepare('SELECT * FROM quote_templates ORDER BY is_default DESC, created_at ASC').all() as unknown as TemplateRow[]
    ).map(toTemplate)
  },

  get(id: string): QuoteTemplate | undefined {
    const row = db.prepare('SELECT * FROM quote_templates WHERE id = ?').get(id) as unknown as TemplateRow | undefined
    return row ? toTemplate(row) : undefined
  },

  getDefault(): QuoteTemplate | undefined {
    const row = db
      .prepare('SELECT * FROM quote_templates ORDER BY is_default DESC, created_at ASC LIMIT 1')
      .get() as unknown as TemplateRow | undefined
    return row ? toTemplate(row) : undefined
  },

  create(input: unknown): QuoteTemplate {
    const data = parse(templateCreateInput, input)
    const now = Date.now()
    const id = newId('qtpl')
    const first = quoteTemplateService.list().length === 0
    if (data.isDefault) db.prepare('UPDATE quote_templates SET is_default = 0').run()
    db.prepare(
      `INSERT INTO quote_templates (id, name, is_default, company, default_incoterm, default_currency, default_payment_terms, footer, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.name,
      data.isDefault || first ? 1 : 0,
      JSON.stringify(data.company),
      data.defaultIncoterm,
      data.defaultCurrency,
      data.defaultPaymentTerms,
      data.footer,
      now,
      now,
    )
    return quoteTemplateService.get(id)!
  },

  update(id: string, input: unknown): QuoteTemplate {
    const patch = parse(templatePatchInput, input)
    const current = quoteTemplateService.get(id)
    if (!current) throw notFound('报价模板')
    const next = { ...current, ...patch, company: patch.company ?? current.company }
    if (patch.isDefault === true) db.prepare('UPDATE quote_templates SET is_default = 0 WHERE id <> ?').run(id)
    db.prepare(
      `UPDATE quote_templates SET name = ?, is_default = ?, company = ?, default_incoterm = ?, default_currency = ?,
         default_payment_terms = ?, footer = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.name,
      next.isDefault ? 1 : 0,
      JSON.stringify(next.company),
      next.defaultIncoterm,
      next.defaultCurrency,
      next.defaultPaymentTerms,
      next.footer,
      Date.now(),
      id,
    )
    return quoteTemplateService.get(id)!
  },

  remove(id: string): void {
    const current = quoteTemplateService.get(id)
    if (!current) throw notFound('报价模板')
    db.prepare('DELETE FROM quote_templates WHERE id = ?').run(id)
    if (current.isDefault) {
      // 删除默认模板后，把最早的一个设为默认
      db.prepare(
        'UPDATE quote_templates SET is_default = 1 WHERE id = (SELECT id FROM quote_templates ORDER BY created_at ASC LIMIT 1)',
      ).run()
    }
  },
}
