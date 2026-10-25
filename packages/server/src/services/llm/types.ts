import type { ChatTurn, ToolCall, ToolDefinition } from '../../types.js'
import type { ModelCapabilities } from './capabilities.js'

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

export interface StreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatTurn[]
  /** 本轮可以使用的工具；为空表示不启用工具 */
  tools?: ToolDefinition[]
  signal?: AbortSignal
  /** 以下为内置内核扩展字段，均可省略（省略时与旧行为一致） */
  /** 最大输出 token（Anthropic max_tokens；OpenAI 兼容只在显式给出时发送） */
  maxTokens?: number
  /** 推理强度：Anthropic thinking 预算 / OpenAI reasoning_effort */
  reasoningEffort?: ReasoningEffort
  /** 模型能力（缺省时按模型名查能力矩阵） */
  capabilities?: ModelCapabilities
  /** OpenAI 兼容：请求 stream_options.include_usage（默认按能力矩阵） */
  includeUsage?: boolean
  /** 'none'：仍声明工具（历史里有工具调用时 Anthropic 要求声明）但禁止本轮再调用 */
  toolChoice?: 'auto' | 'none'
}

/** 旧事件：网关等调用方只处理这两种（getStreamChat 只产出这两种） */
export type StreamEvent =
  | { type: 'text'; text: string }
  /** 一轮回复结束时模型请求的工具调用 */
  | { type: 'tool_calls'; calls: ToolCall[] }

/** 统一的 token 用量；inputTokens 含缓存命中/写入部分 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'

/** Anthropic 思考块（工具循环内回传时需要原样带签名） */
export type ReasoningBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** 内置内核使用的完整事件流 */
export type ExtendedStreamEvent =
  | StreamEvent
  | { type: 'reasoning'; text: string }
  | { type: 'reasoning_blocks'; blocks: ReasoningBlock[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; raw: string }
  /** 收到了上游数据但没有可交付内容（例如工具参数分片），用于空闲超时计时 */
  | { type: 'ping' }

export type StreamChat = (request: StreamRequest) => AsyncGenerator<StreamEvent>
export type ExtendedStreamChat = (request: StreamRequest) => AsyncGenerator<ExtendedStreamEvent>

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

export function addUsage(into: Usage, more: Usage): Usage {
  into.inputTokens += more.inputTokens
  into.outputTokens += more.outputTokens
  into.cacheReadTokens += more.cacheReadTokens
  into.cacheWriteTokens += more.cacheWriteTokens
  into.reasoningTokens += more.reasoningTokens
  return into
}
