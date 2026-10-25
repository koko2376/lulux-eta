import type Router from '@koa/router'
import { z } from 'zod'
import { requirePermission } from '../security/access.js'
import { registerSettingValidator } from '../services/settings-service.js'
import { parse } from '../validation.js'
import { fxService, parseFxLocks } from '../services/pricing/fx-service.js'
import { CONTAINERS, freightService, type FreightFilter } from '../services/pricing/freight-service.js'
import { pricingService } from '../services/pricing/pricing-service.js'

// 锁汇设置（JSON）保存前校验结构：键形如 USD/CNY，值为正数
registerSettingValidator('fxLocks', (_key, value) => parseFxLocks(value))

const fxQuery = z.object({
  base: z.string().trim().max(3).default('USD'),
  symbols: z.string().trim().max(500).default(''),
})

const freightQuery = z.object({
  pod: z.string().trim().max(100).optional(),
  pol: z.string().trim().max(100).optional(),
  container: z.enum(CONTAINERS).optional(),
  includeExpired: z
    .union([z.boolean(), z.enum(['0', '1', 'true', 'false'])])
    .optional()
    .transform((value) => value === true || value === '1' || value === 'true'),
})

export function pricingRoutes(router: Router): void {
  /* ── 汇率 ── */
  router.get('/api/fx/rates', async (ctx) => {
    const query = parse(fxQuery, ctx.query)
    const symbols = query.symbols
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    ctx.body = await fxService.table(query.base || 'USD', symbols.length > 0 ? symbols : ['CNY', 'EUR'])
  })

  router.post('/api/fx/refresh', async (ctx) => {
    requirePermission('data:write')
    const table = await fxService.refresh()
    const rates = Object.fromEntries([...table.rates.entries()].map(([quote, item]) => [quote, item.rate]))
    ctx.body = {
      base: 'USD',
      fetchedAt: table.fetchedAt,
      stale: table.stale,
      error: table.error,
      rates,
    }
  })

  /* ── 运价表 ── */
  router.get('/api/freight-rates', (ctx) => {
    const query = parse(freightQuery, ctx.query)
    const filter: FreightFilter = {
      ...(query.pod ? { pod: query.pod } : {}),
      ...(query.pol ? { pol: query.pol } : {}),
      ...(query.container ? { container: query.container } : {}),
      ...(query.includeExpired ? { includeExpired: true } : {}),
    }
    ctx.body = freightService.list(filter)
  })

  // 必须在 /api/freight-rates/:id 之前
  router.post('/api/freight-rates/import', (ctx) => {
    ctx.body = freightService.import(ctx.request.body)
  })

  router.post('/api/freight-rates', (ctx) => {
    ctx.status = 201
    ctx.body = freightService.create(ctx.request.body)
  })

  router.get('/api/freight-rates/:id', (ctx) => {
    ctx.body = freightService.require(ctx.params.id)
  })

  router.patch('/api/freight-rates/:id', (ctx) => {
    ctx.body = freightService.update(ctx.params.id, ctx.request.body)
  })

  router.delete('/api/freight-rates/:id', (ctx) => {
    freightService.remove(ctx.params.id)
    ctx.status = 204
  })

  /* ── 报价计算（纯计算，不写库；登录可读）── */
  router.post('/api/pricing/calculate', async (ctx) => {
    ctx.body = await pricingService.calculate(ctx.request.body)
  })
}

