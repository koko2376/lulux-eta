import type Router from '@koa/router'
import { AppError } from '../errors.js'
import { searchUkImporters } from '../services/trade/hmrc.js'
import { marketOverview } from '../services/trade/comtrade.js'
import { toAppError } from '../services/trade/errors.js'

/**
 * 开发客户数据源（只读查询，不写库）：
 * - GET /api/trade/uk-importers?hs=&months=&flow=&limit=  HMRC 英国进口商名录
 * - GET /api/trade/market?hs=&years=2023,2024&flow=&top=   UN Comtrade 国家市场概览
 *
 * 登录即可读（与 customers GET 一致：只有登录鉴权，没有额外权限位）。
 * Provider 错误统一经 toAppError 转成 400 / 429 / 502。
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 查询参数里的可选整数；给了但不是纯数字就 400 */
function intParam(raw: string, name: string): number | undefined {
  if (!raw) return undefined
  if (!/^\d+$/.test(raw)) throw new AppError(400, 'BAD_ARGS', `参数 ${name} 必须是整数`)
  return Number(raw)
}

export function tradeRoutes(router: Router): void {
  router.get('/api/trade/uk-importers', async (ctx) => {
    try {
      ctx.body = await searchUkImporters({
        hs: str(ctx.query.hs),
        months: intParam(str(ctx.query.months), 'months'),
        flow: str(ctx.query.flow).toLowerCase() === 'export' ? 'export' : 'import',
        limit: intParam(str(ctx.query.limit), 'limit'),
      })
    } catch (error) {
      throw toAppError(error)
    }
  })

  router.get('/api/trade/market', async (ctx) => {
    const rawYears = str(ctx.query.years)
    try {
      ctx.body = await marketOverview({
        hs: str(ctx.query.hs),
        years: rawYears ? rawYears.split(',').map((part) => Number(part.trim())) : undefined,
        flow: str(ctx.query.flow).toUpperCase() === 'X' ? 'X' : 'M',
        top: intParam(str(ctx.query.top), 'top'),
      })
    } catch (error) {
      throw toAppError(error)
    }
  })
}
