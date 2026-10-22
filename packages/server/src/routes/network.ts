import type Router from '@koa/router'
import { ProxyAgent } from 'undici'
import { z } from 'zod'
import { AppError, messageOf } from '../errors.js'
import { normalizeProxyUrl } from '../services/http-client.js'
import { joinUrl } from '../services/llm/stream-utils.js'
import { providerService } from '../services/provider-service.js'
import { settingsService } from '../services/settings-service.js'
import { normalizeWebhookUrl, webhookService } from '../services/webhook-service.js'
import { assertHttpUrl, parse } from '../validation.js'

const PROXY_TEST_TIMEOUT_MS = 15_000

/** 优先用默认 Provider 的 /models 做测试，没有 Provider 时才用公共地址 */
function proxyTestTarget(): string {
  const preferredId = settingsService.get('defaultProviderId')
  const provider = (preferredId ? providerService.get(preferredId) : undefined) ?? providerService.list()[0]
  const target = provider ? joinUrl(provider.baseUrl, '/models') : 'https://api.openai.com/v1/models'
  return assertHttpUrl(target, '测试地址')
}

function normalizeOr400(fn: () => string): string {
  try {
    return fn()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'INVALID_URL', messageOf(error))
  }
}

export function networkRoutes(router: Router): void {
  router.post('/api/proxy/test', async (ctx) => {
    const body = parse(z.object({ proxyUrl: z.string().max(2000).optional() }), ctx.request.body)
    const target = normalizeOr400(() => normalizeProxyUrl(body.proxyUrl ?? settingsService.get('proxyUrl') ?? ''))
    if (!target) throw new AppError(400, 'VALIDATION_ERROR', '请先填写代理地址')

    const agent = new ProxyAgent(target)
    try {
      // 能拿到任意 HTTP 响应（包括 401）就算链路可用
      const response = await fetch(proxyTestTarget(), {
        dispatcher: agent,
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PROXY_TEST_TIMEOUT_MS),
      } as RequestInit)
      ctx.body = { ok: true, status: response.status }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(502, 'PROXY_UNREACHABLE', `代理连接失败：${messageOf(error)}`)
    } finally {
      await agent.close().catch(() => undefined)
    }
  })

  router.post('/api/webhook/test', async (ctx) => {
    const body = parse(z.object({ url: z.string().max(2000).optional() }), ctx.request.body)
    const target = normalizeOr400(() => normalizeWebhookUrl(body.url ?? settingsService.get('webhookUrl') ?? ''))
    if (!target) throw new AppError(400, 'VALIDATION_ERROR', '请先填写 Webhook 地址')

    let result: { ok: boolean; status: number }
    try {
      result = await webhookService.test(target)
    } catch (error) {
      throw new AppError(502, 'WEBHOOK_FAILED', `Webhook 发送失败：${messageOf(error)}`)
    }
    if (!result.ok) throw new AppError(502, 'WEBHOOK_FAILED', `Webhook 返回 HTTP ${result.status}`)
    ctx.body = result
  })
}
