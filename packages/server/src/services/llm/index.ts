import type { ProviderKind } from '../../types.js'
import { streamAnthropicExtended } from './anthropic.js'
import { streamOpenAIExtended } from './openai.js'
import type { ExtendedStreamChat, StreamChat, StreamEvent } from './types.js'

const adapters: Record<ProviderKind, ExtendedStreamChat> = {
  openai: streamOpenAIExtended,
  anthropic: streamAnthropicExtended,
}

/** 完整事件流（推理、usage、结束原因、ping），内置内核使用 */
export function getExtendedStreamChat(kind: ProviderKind): ExtendedStreamChat {
  const adapter = adapters[kind]
  if (!adapter) throw new Error(`Unsupported provider kind: ${kind}`)
  return adapter
}

/** 兼容旧调用方（网关、邮件分类）：只产出 text / tool_calls 两种事件 */
export function getStreamChat(kind: ProviderKind): StreamChat {
  const adapter = getExtendedStreamChat(kind)
  return async function* (request): AsyncGenerator<StreamEvent> {
    // 旧调用方不请求 usage，避免个别 Provider 不认 stream_options 而 400
    for await (const event of adapter({ includeUsage: false, ...request })) {
      if (event.type === 'text' || event.type === 'tool_calls') yield event
    }
  }
}

export const streamOpenAI: StreamChat = getStreamChat('openai')
export const streamAnthropic: StreamChat = getStreamChat('anthropic')
