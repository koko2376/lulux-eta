import type Router from '@koa/router'
import { z } from 'zod'
import { notFound } from '../errors.js'
import {
  discoverProviderModels,
  providerService,
  toPublicProvider,
} from '../services/provider-service.js'
import { settingsService } from '../services/settings-service.js'
import { REASONING_CHOICES } from '../services/llm/capabilities.js'
import { httpUrl, parse } from '../validation.js'

const kind = z.enum(['openai', 'anthropic'])
const models = z.array(z.string().max(200)).max(500)

const createInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(200),
  kind,
  baseUrl: httpUrl,
  apiKey: z.string().max(4000).optional(),
  model: z.string().max(200).optional(),
  models: models.optional(),
})

const patchInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind,
    baseUrl: httpUrl,
    // 空串表示保持原有 Key
    apiKey: z.string().max(4000),
    model: z.string().max(200),
    models,
  })
  .partial()
  .strict()

const modelCapsInput = z
  .object({
    model: z.string().trim().min(1).max(200),
    // auto = 恢复自动检测
    reasoning: z.enum([...REASONING_CHOICES, 'auto']),
  })
  .strict()

export function providerRoutes(router: Router): void {
  router.get('/api/providers', (ctx) => {
    ctx.body = { providers: providerService.list().map(toPublicProvider) }
  })

  router.post('/api/providers', (ctx) => {
    const body = parse(createInput, ctx.request.body)
    const provider = providerService.create(body)
    ctx.status = 201
    ctx.body = { provider: toPublicProvider(provider) }
  })

  router.patch('/api/providers/:id', (ctx) => {
    const body = parse(patchInput, ctx.request.body)
    const provider = providerService.update(ctx.params.id, body)
    if (!provider) throw notFound('Provider')
    ctx.body = { provider: toPublicProvider(provider) }
  })

  // 按模型设置思考强度（手动覆盖自动检测）
  router.put('/api/providers/:id/model-caps', (ctx) => {
    const body = parse(modelCapsInput, ctx.request.body)
    const provider = providerService.setModelReasoning(
      ctx.params.id,
      body.model,
      body.reasoning === 'auto' ? null : body.reasoning,
    )
    if (!provider) throw notFound('Provider')
    ctx.body = { provider: toPublicProvider(provider) }
  })

  router.post('/api/providers/:id/discover-models', async (ctx) => {
    const provider = await discoverProviderModels(ctx.params.id)
    if (!provider) throw notFound('Provider')
    ctx.body = { provider: toPublicProvider(provider), models: provider.models }
  })

  router.delete('/api/providers/:id', (ctx) => {
    if (!providerService.remove(ctx.params.id)) throw notFound('Provider')
    // 删除的是默认 Provider 时清空偏好，回退到列表第一个
    if (settingsService.get('defaultProviderId') === ctx.params.id) {
      settingsService.update({ defaultProviderId: '' })
    }
    ctx.status = 204
  })
}
