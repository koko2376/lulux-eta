import { AppError } from '../../errors.js'
import type { ChatTurn, Provider } from '../../types.js'
import { providerService } from '../provider-service.js'
import { settingsService } from '../settings-service.js'
import { capabilitiesFor } from './capabilities.js'
import { UpstreamError } from './errors.js'
import { streamResilient } from './resilient.js'
import { estimateTokens, estimateTurns } from './tokens.js'
import { emptyUsage, type Usage } from './types.js'
import { usageService, type UsagePurpose } from './usage-service.js'

/** 当前默认 Provider（与对话的选择规则一致），不可用时抛与 chat 相同的错误码 */
export function resolveDefaultProvider(): Provider {
  const defaultProviderId = settingsService.get('defaultProviderId')
  const provider =
    (defaultProviderId ? providerService.get(defaultProviderId) : undefined) ?? providerService.list()[0] ?? null
  if (!provider) throw new AppError(400, 'NO_PROVIDER', '请先在设置中添加一个模型 Provider')
  if (!provider.model) throw new AppError(400, 'NO_MODEL', `Provider「${provider.name}」还没有选择模型，请到设置中完成配置`)
  if (provider.apiKeyError) throw new AppError(409, 'API_KEY_UNAVAILABLE', `Provider「${provider.name}」的 ${provider.apiKeyError}`)
  return provider
}

/** 上游错误 → 对外 502 错误码（与 chat 一致） */
export function upstreamAppError(error: unknown, prefix = '模型调用失败'): AppError {
  if (error instanceof AppError) return error
  if (error instanceof UpstreamError) {
    const code = error.kind === 'timeout' || error.kind === 'aborted' ? 'UPSTREAM_TIMEOUT' : error.kind === 'network' ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_ERROR'
    return new AppError(502, code, `${prefix}：${error.message}`)
  }
  return new AppError(502, 'UPSTREAM_ERROR', `${prefix}：${error instanceof Error ? error.message : String(error)}`)
}

/**
 * 一次性（非流式接口层面）补全：内部走带重试/超时的流式适配器，收齐文本后返回。
 * 每次调用记一条 usage（purpose 默认 completion）。
 */
export async function completeText(
  system: string,
  user: string,
  options: {
    provider?: Provider
    signal?: AbortSignal
    timeoutMs?: number
    purpose?: UsagePurpose
    sessionId?: string | null
    maxTokens?: number
  } = {},
): Promise<{ text: string; provider: Provider; usage: Usage }> {
  const provider = options.provider ?? resolveDefaultProvider()
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 90_000)
  const messages: ChatTurn[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  let text = ''
  let usage: Usage | null = null
  try {
    for await (const event of streamResilient(
      provider.kind,
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages,
        signal,
        maxTokens: options.maxTokens,
        capabilities: capabilitiesFor(provider.model, provider),
      },
      { maxRetries: 2, timeoutMs: 60_000 },
    )) {
      if (event.type === 'text') text += event.text
      else if (event.type === 'usage') usage = event.usage
    }
  } catch (error) {
    if (signal.aborted && !(error instanceof UpstreamError && error.kind !== 'aborted')) {
      throw new AppError(502, 'UPSTREAM_TIMEOUT', '模型调用失败：超时')
    }
    throw upstreamAppError(error)
  }
  const estimated = !usage
  const finalUsage = usage ?? { ...emptyUsage(), inputTokens: estimateTurns(messages), outputTokens: estimateTokens(text) }
  try {
    usageService.record({
      provider,
      model: provider.model,
      usage: finalUsage,
      estimated,
      purpose: options.purpose ?? 'completion',
      sessionId: options.sessionId ?? null,
    })
  } catch (error) {
    console.warn('[lulux-eta] usage record failed:', error instanceof Error ? error.message : error)
  }
  if (!text.trim()) throw new AppError(502, 'UPSTREAM_ERROR', '模型没有返回内容')
  return { text, provider, usage: finalUsage }
}
