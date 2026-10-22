import type { ChatTurn, ToolCall } from "../../types.js";
import { fetchWithProxy } from "../http-client.js";
import { capabilitiesFor } from "./capabilities.js";
import { applyChatReasoningParams } from "./reasoning-params.js";
import {
  toUpstreamError,
  upstreamFromResponse,
  upstreamFromStreamError,
} from "./errors.js";
import type {
  ExtendedStreamEvent,
  FinishReason,
  StreamRequest,
  Usage,
} from "./types.js";
import { joinUrl, readErrorMessage, readSseData } from "./stream-utils.js";

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek */
  prompt_cache_hit_tokens?: number;
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
  error?: { message?: string; type?: string; code?: string };
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | OpenAIContentPart[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

function toOpenAIMessage(
  turn: ChatTurn,
  passReasoning: boolean,
): OpenAIMessage {
  if (turn.role === "assistant" && turn.toolCalls?.length) {
    const message: OpenAIMessage = {
      role: "assistant",
      content: turn.content || null,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments || "{}",
        },
      })),
    };
    // DeepSeek/Qwen 思考模式：同一回复内的工具调用轮次需要回传 reasoning_content
    if (passReasoning && turn.reasoning)
      message.reasoning_content = turn.reasoning;
    return message;
  }

  if (turn.role === "tool") {
    return {
      role: "tool",
      content: turn.content,
      tool_call_id: turn.toolCallId ?? "",
    };
  }

  // 图片输入：多模态 content parts（只发已内联 data 的图片；模型不支持看图时上游已去掉 images）
  const images =
    turn.role === "user"
      ? (turn.images ?? []).filter((image) => image.data)
      : [];
  if (images.length > 0) {
    const parts: OpenAIContentPart[] = [];
    if (turn.content) parts.push({ type: "text", text: turn.content });
    for (const image of images)
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.mime};base64,${image.data}` },
      });
    return { role: "user", content: parts };
  }

  return {
    role: turn.role === "assistant" ? "assistant" : turn.role,
    content: turn.content,
  };
}

function mapFinish(raw: string): FinishReason {
  if (raw === "stop" || raw === "end_turn") return "stop";
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "tool_calls" || raw === "function_call") return "tool_calls";
  if (raw === "content_filter") return "content_filter";
  return "other";
}

function mapUsage(raw: OpenAIUsage): Usage {
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cacheReadTokens:
      raw.prompt_tokens_details?.cached_tokens ??
      raw.prompt_cache_hit_tokens ??
      0,
    cacheWriteTokens: 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * 一些部署（Ollama / vLLM 上的 R1、QwQ）把思考写在正文开头的 <think>…</think> 里。
 * 只处理回复最开头的 think 块，其余原样当正文。
 */
class ThinkTagSplitter {
  private state: "detect" | "think" | "text" = "detect";
  private buffer = "";

  push(text: string): Array<{ kind: "text" | "reasoning"; text: string }> {
    const out: Array<{ kind: "text" | "reasoning"; text: string }> = [];
    this.buffer += text;
    while (this.buffer) {
      if (this.state === "text") {
        out.push({ kind: "text", text: this.buffer });
        this.buffer = "";
      } else if (this.state === "detect") {
        const trimmed = this.buffer.trimStart();
        if (trimmed.length < 7 && "<think>".startsWith(trimmed)) break;
        if (trimmed.startsWith("<think>")) {
          this.state = "think";
          this.buffer = trimmed.slice(7);
        } else {
          this.state = "text";
        }
      } else {
        const end = this.buffer.indexOf("</think>");
        if (end >= 0) {
          if (end > 0)
            out.push({ kind: "reasoning", text: this.buffer.slice(0, end) });
          this.buffer = this.buffer.slice(end + 8).replace(/^\s+/, "");
          this.state = "text";
        } else {
          // 保留可能是半个结束标签的尾巴
          const keep = Math.min(this.buffer.length, 7);
          const emit = this.buffer.slice(0, this.buffer.length - keep);
          if (emit) out.push({ kind: "reasoning", text: emit });
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
      }
    }
    return out;
  }

  flush(): Array<{ kind: "text" | "reasoning"; text: string }> {
    if (!this.buffer) return [];
    const kind = this.state === "think" ? "reasoning" : "text";
    const text = this.buffer;
    this.buffer = "";
    return [{ kind, text }];
  }
}

/**
 * OpenAI-compatible chat completions (OpenAI, DeepSeek, Moonshot, Qwen, local
 * gateways, etc.). The configured base URL must include the API version
 * prefix, e.g. `https://api.openai.com/v1`.
 * 产出完整事件流（推理、usage、结束原因）；旧调用方经 index.ts 的 getStreamChat 只拿到 text/tool_calls。
 */
export async function* streamOpenAIExtended(
  request: StreamRequest,
): AsyncGenerator<ExtendedStreamEvent> {
  const caps = request.capabilities ?? capabilitiesFor(request.model, "openai");
  const passReasoning =
    caps.reasoning === "deepseek" || caps.reasoning === "qwen";
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((turn) =>
      toOpenAIMessage(turn, passReasoning),
    ),
    stream: true,
  };

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = request.toolChoice ?? "auto";
  }
  if (request.includeUsage ?? caps.streamUsage)
    body.stream_options = { include_usage: true };
  if (request.maxTokens) {
    if (caps.reasoning === "openai")
      body.max_completion_tokens = request.maxTokens;
    else body.max_tokens = request.maxTokens;
  }
  applyChatReasoningParams(body, caps, request.reasoningEffort);

  let response: Response;
  try {
    response = await fetchWithProxy(
      joinUrl(request.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );
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
  const splitter = new ThinkTagSplitter();
  let finish: string | null = null;
  let usage: Usage | null = null;

  try {
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") break;

      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data) as OpenAIChunk;
      } catch {
        yield { type: "ping" };
        continue;
      }

      if (chunk.error?.message) {
        throw upstreamFromStreamError(
          chunk.error.type ?? chunk.error.code,
          chunk.error.message,
        );
      }
      if (chunk.usage) usage = mapUsage(chunk.usage);

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      let produced = false;
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        produced = true;
        yield { type: "reasoning", text: reasoning };
      }
      if (delta?.content) {
        for (const part of splitter.push(delta.content)) {
          produced = true;
          yield part.kind === "text"
            ? { type: "text", text: part.text }
            : { type: "reasoning", text: part.text };
        }
      }

      for (const part of delta?.tool_calls ?? []) {
        const index = part.index ?? 0;
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments)
          current.arguments += part.function.arguments;
        calls.set(index, current);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (!produced) yield { type: "ping" };
    }
  } catch (error) {
    throw toUpstreamError(error);
  }

  for (const part of splitter.flush()) {
    yield part.kind === "text"
      ? { type: "text", text: part.text }
      : { type: "reasoning", text: part.text };
  }

  if (calls.size > 0) {
    const list = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${Date.now()}`,
        name: call.name,
        arguments: call.arguments || "{}",
      }))
      .filter((call) => call.name);
    if (list.length > 0) yield { type: "tool_calls", calls: list };
  }
  if (usage) yield { type: "usage", usage };
  if (finish) yield { type: "finish", reason: mapFinish(finish), raw: finish };
}
