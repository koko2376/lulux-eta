import type { ChatTurn, ToolCall } from "../../types.js";
import { anthropicThinkingSupported, THINKING_BUDGET as BUDGET } from "./reasoning-params.js";
import { fetchWithProxy } from "../http-client.js";
import { capabilitiesFor } from "./capabilities.js";
import { ANTHROPIC_IMAGE_MAX_BYTES, base64Bytes } from "./images.js";
import {
  toUpstreamError,
  upstreamFromResponse,
  upstreamFromStreamError,
} from "./errors.js";
import type {
  ExtendedStreamEvent,
  FinishReason,
  ReasoningBlock,
  StreamRequest,
  Usage,
} from "./types.js";
import { joinUrl, readErrorMessage, readSseData } from "./stream-utils.js";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    thinking?: string;
    signature?: string;
    data?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { message?: string; type?: string };
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | ReasoningBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export { THINKING_BUDGET } from "./reasoning-params.js";

function parseInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 相邻同角色消息要合并成一条，Anthropic 不接受连续两条 user */
function toAnthropicMessages(
  turns: ChatTurn[],
  thinking: boolean,
): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const turn of turns) {
    if (turn.role === "system") continue;

    if (turn.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      // 开启 thinking 时，工具循环内的 assistant 轮次必须以原样（含签名）的思考块开头
      if (thinking && turn.reasoningBlocks?.length)
        blocks.push(...turn.reasoningBlocks);
      if (turn.content.trim())
        blocks.push({ type: "text", text: turn.content });
      for (const call of turn.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseInput(call.arguments),
        });
      }
      push("assistant", blocks);
      continue;
    }

    if (turn.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: turn.toolCallId ?? "",
          content: turn.content,
        },
      ]);
      continue;
    }

    // 图片输入：image 块（base64）放在文字前面；超过 Anthropic 单张 5 MB 上限的降级为文字说明
    const blocks: AnthropicBlock[] = [];
    const notes: string[] = [];
    for (const image of turn.images ?? []) {
      if (!image.data) continue;
      if (base64Bytes(image.data) > ANTHROPIC_IMAGE_MAX_BYTES) {
        notes.push(
          `（图片 ${image.name || image.path || ""} 超过 5 MB，未发送）`,
        );
        continue;
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mime, data: image.data },
      });
    }
    const text = [turn.content, ...notes].filter(Boolean).join("\n\n");
    if (text || blocks.length === 0) blocks.push({ type: "text", text });
    push("user", blocks);
  }

  // Anthropic 要求第一条是 user（历史窗口可能从一条助手回复开始）
  if (messages[0]?.role === "assistant")
    messages.unshift({
      role: "user",
      content: [{ type: "text", text: "（以下接续之前的对话）" }],
    });
  return messages;
}

function mapFinish(raw: string): FinishReason {
  if (raw === "end_turn" || raw === "stop_sequence") return "stop";
  if (raw === "max_tokens") return "length";
  if (raw === "tool_use") return "tool_calls";
  if (raw === "refusal") return "content_filter";
  return "other";
}

/**
 * Anthropic Messages API. The configured base URL must include the API
 * version prefix, e.g. `https://api.anthropic.com/v1`.
 */
export async function* streamAnthropicExtended(
  request: StreamRequest,
): AsyncGenerator<ExtendedStreamEvent> {
  const caps =
    request.capabilities ?? capabilitiesFor(request.model, "anthropic");
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const effort = request.reasoningEffort ?? "off";
  const thinking = anthropicThinkingSupported(caps) && effort !== "off";
  let maxTokens = request.maxTokens ?? Math.max(1024, caps.maxOutput);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: toAnthropicMessages(request.messages, thinking),
    stream: true,
  };
  if (thinking) {
    const budget = BUDGET[effort as keyof typeof BUDGET];
    maxTokens = Math.max(maxTokens, budget + 4096);
    body.max_tokens = maxTokens;
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    if (request.toolChoice === "none") body.tool_choice = { type: "none" };
  }

  let response: Response;
  try {
    response = await fetchWithProxy(joinUrl(request.baseUrl, "/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    throw toUpstreamError(error);
  }

  if (!response.ok) {
    throw upstreamFromResponse(
      response.status,
      await readErrorMessage(response),
      response.headers,
    );
  }
  if (!response.body) {
    throw upstreamFromResponse(502, "Provider returned an empty response body");
  }

  const calls = new Map<number, ToolCall>();
  const thinkingBlocks = new Map<number, ReasoningBlock>();
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  let sawUsage = false;
  let stopReason: string | null = null;

  try {
    for await (const data of readSseData(response.body)) {
      let event: AnthropicEvent;
      try {
        event = JSON.parse(data) as AnthropicEvent;
      } catch {
        yield { type: "ping" };
        continue;
      }

      if (event.type === "error") {
        throw upstreamFromStreamError(
          event.error?.type,
          event.error?.message || "Anthropic stream error",
        );
      }

      if (event.type === "message_start") {
        const u = event.message?.usage;
        if (u) {
          sawUsage = true;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          // Anthropic 的 input_tokens 不含缓存部分，统一成“含缓存的总输入”
          usage.inputTokens =
            (u.input_tokens ?? 0) +
            usage.cacheReadTokens +
            usage.cacheWriteTokens;
          usage.outputTokens = u.output_tokens ?? 0;
        }
        yield { type: "ping" };
        continue;
      }

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          calls.set(event.index ?? 0, {
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: "",
          });
        } else if (block?.type === "thinking") {
          thinkingBlocks.set(event.index ?? 0, {
            type: "thinking",
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          });
        } else if (block?.type === "redacted_thinking") {
          thinkingBlocks.set(event.index ?? 0, {
            type: "redacted_thinking",
            data: block.data ?? "",
          });
        }
        yield { type: "ping" };
        continue;
      }

      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text", text: delta.text };
          continue;
        }
        if (delta?.type === "thinking_delta" && delta.thinking) {
          const block = thinkingBlocks.get(event.index ?? 0);
          if (block?.type === "thinking") block.thinking += delta.thinking;
          yield { type: "reasoning", text: delta.thinking };
          continue;
        }
        if (delta?.type === "signature_delta" && delta.signature) {
          const block = thinkingBlocks.get(event.index ?? 0);
          if (block?.type === "thinking") block.signature += delta.signature;
        } else if (
          delta?.type === "input_json_delta" &&
          delta.partial_json !== undefined
        ) {
          const current = calls.get(event.index ?? 0);
          if (current) current.arguments += delta.partial_json;
        }
        yield { type: "ping" };
        continue;
      }

      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) {
          sawUsage = true;
          usage.outputTokens = event.usage.output_tokens;
        }
      }
      yield { type: "ping" };
    }
  } catch (error) {
    throw toUpstreamError(error);
  }

  if (thinkingBlocks.size > 0) {
    yield {
      type: "reasoning_blocks",
      blocks: [...thinkingBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, block]) => block),
    };
  }
  if (calls.size > 0) {
    const list = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call], index) => ({
        id: call.id || `toolu_${index}_${Date.now()}`,
        name: call.name,
        arguments: call.arguments || "{}",
      }))
      .filter((call) => call.name);
    if (list.length > 0) yield { type: "tool_calls", calls: list };
  }
  if (sawUsage) yield { type: "usage", usage };
  if (stopReason)
    yield { type: "finish", reason: mapFinish(stopReason), raw: stopReason };
}
