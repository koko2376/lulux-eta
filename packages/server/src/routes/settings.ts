import type Router from '@koa/router'
import { canonicalAgentId } from '../agents.js'
import { isKnownKernelAgentId } from '../services/agent-service.js'
import { normalizeProxyUrl } from '../services/http-client.js'
import { providerService } from '../services/provider-service.js'
import {
  registerSettingValidator,
  settingsService,
  validateSettingsPatch,
} from '../services/settings-service.js'
import { normalizeRegistryUrl } from '../services/kernels/registry.js'
import { normalizeWebhookUrl } from '../services/webhook-service.js'

registerSettingValidator('kernelRegistry', (_key, value) => normalizeRegistryUrl(value))
registerSettingValidator('proxyUrl', (_key, value) => normalizeProxyUrl(value))
registerSettingValidator('webhookUrl', (_key, value) => normalizeWebhookUrl(value))
registerSettingValidator('defaultAgentId', (_key, value) => {
  const id = canonicalAgentId(value)
  if (!isKnownKernelAgentId(id)) throw new Error('不是已知的 Agent')
  return id
})
registerSettingValidator('defaultProviderId', (_key, value) => {
  if (value && !providerService.get(value)) throw new Error('对应的 Provider 不存在')
  return value
})

export function settingsRoutes(router: Router): void {
  router.get('/api/settings', (ctx) => {
    ctx.body = { settings: settingsService.all() }
  })

  router.get('/api/settings/schema', (ctx) => {
    ctx.body = settingsService.schema()
  })

  router.patch('/api/settings', (ctx) => {
    const patch = validateSettingsPatch(ctx.request.body)
    ctx.body = { settings: settingsService.update(patch) }
  })
}
