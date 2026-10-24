import { randomBytes } from "node:crypto";
import type {
  ChatTurn,
  ToolCall,
  ToolDefinition,
  TurnImage,
} from "../../types.js";
import {
  asArray,
  asRecord,
  asString,
  extractImages,
  flattenContent,
  normalizeSchema,
  type CanonicalRequest,
  type StopReason,
  type StreamEvent,
} from "./types.js";

/**
 * Anthropic Messages API ⇄ 规范请求。
 * 支持 system（字符串或块数组）、text / tool_use / tool_result 块；
 * thinking / redacted_thinking / 图片等无法转发的块按“忽略 / 文本占位”降级。
 */
export function anthropicToCanonical(body: unknown): CanonicalRequest {
  const input = asRecord(body);
  const system =
    typeof input.system === "string"
      ? input.system
      : flattenContent(input.system);
  const turns: ChatTurn[] = [];

  for (const raw of asArray(input.messages)) {
    const message = asRecord(raw);
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;
    if (typeof content === "string") {
      turns.push({ role, content });
      continue;
    }
    const blocks = asArray(content).map(asRecord);
    if (role === "assistant") {
      const text: string[] = [];
      const calls: ToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text") text.push(asString(block.text));
        else if (
          block.type === "tool_use" ||
          block.type === "server_tool_use"
        ) {
          calls.push({
            id: asString(block.id) || `toolu_${randomBytes(8).toString("hex")}`,
            name: asString(block.name),
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      }
      turns.push({
        role: "assistant",
        content: text.join(""),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      continue;
    }
    // user：tool_result 先成为 tool 轮次（OpenAI 要求紧跟 assistant），剩余文本随后作为 user 轮次
    // 图片：用户消息里的 image 块与工具结果里的图片（如 Claude Code 用 Read 读图）都随后面的 user 轮次转发
    const rest: unknown[] = [];
    const toolImages: TurnImage[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        let text = flattenContent(block.content);
        if (block.is_error) text = `[工具执行出错] ${text}`;
        toolImages.push(...extractImages(block.content));
        turns.push({
          role: "tool",
          content: text,
          toolCallId: asString(block.tool_use_id),
        });
      } else {
        rest.push(block);
      }
    }
    let text = flattenContent(rest);
    const images = [...toolImages, ...extractImages(rest)];
    if (toolImages.length > 0)
      text = `[工具返回的图片 ${toolImages.length} 张]${text ? `\n${text}` : ""}`;
    if (text.trim() || rest.length > 0 || images.length > 0) {
      turns.push(
        images.length
          ? { role: "user", content: text, images }
          : { role: "user", content: text },
      );
    }
  }

  const tools: ToolDefinition[] = [];
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw);
    // 服务端工具（web_search_20250305 等带 type 的）无法由上游执行，跳过
    if (tool.type && tool.type !== "custom") continue;
    const name = asString(tool.name);
    if (!name) continue;
    tools.push({
      name,
      description: asString(tool.description),
      inputSchema: normalizeSchema(tool.input_schema),
    });
  }

  return {
    model: asString(input.model),
    system,
    turns,
    tools,
    stream: input.stream === true,
    maxTokens:
      typeof input.max_tokens === "number" ? input.max_tokens : undefined,
  };
}

export function newAnthropicMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 把规范流事件编码成 Anthropic Messages SSE */
export class AnthropicStreamEncoder {
  private index = 0;
  private textOpen = false;
  private outputChars = 0;
  private sawToolUse = false;
  readonly id = newAnthropicMessageId();

  constructor(
    private readonly model: string,
    private readonly inputTokens: number,
  ) {}

  start(): string {
    return (
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 1 },
        },
      }) + sse("ping", { type: "ping" })
    );
  }

  push(event: StreamEvent): string {
    let out = "";
    if (event.type === "text") {
      if (!event.text) return "";
      if (!this.textOpen) {
        out += sse("content_block_start", {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "text", text: "" },
        });
        this.textOpen = true;
      }
      this.outputChars += event.text.length;
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text: event.text },
      });
      return out;
    }
    out += this.closeText();
    for (const call of event.calls) {
      this.sawToolUse = true;
      this.outputChars += call.arguments.length + call.name.length;
      out += sse("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block: {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: {
          type: "input_json_delta",
          partial_json: call.arguments || "{}",
        },
      });
      out += sse("content_block_stop", {
        type: "content_block_stop",
        index: this.index,
      });
      this.index += 1;
    }
    return out;
  }

  private closeText(): string {
    if (!this.textOpen) return "";
    this.textOpen = false;
    const out = sse("content_block_stop", {
      type: "content_block_stop",
      index: this.index,
    });
    this.index += 1;
    return out;
  }

  finish(): string {
    let out = this.closeText();
    const stopReason: StopReason = this.sawToolUse ? "tool_use" : "end_turn";
    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: Math.max(1, Math.ceil(this.outputChars / 4)) },
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }

  error(message: string): string {
    return sse("error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }
}

/** 非流式：收齐事件后返回 Anthropic Message 对象 */
export function anthropicMessageFrom(
  model: string,
  inputTokens: number,
  events: StreamEvent[],
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  let text = "";
  let outputChars = 0;
  let stopReason: StopReason = "end_turn";
  for (const event of events) {
    if (event.type === "text") {
      text += event.text;
      continue;
    }
    if (text) content.push({ type: "text", text });
    text = "";
    for (const call of event.calls) {
      stopReason = "tool_use";
      outputChars += call.arguments.length;
      let input: unknown = {};
      try {
        input = JSON.parse(call.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: call.id, name: call.name, input });
    }
  }
  if (text) content.push({ type: "text", text });
  outputChars += content.reduce(
    (sum, block) =>
      sum + (typeof block.text === "string" ? block.text.length : 0),
    0,
  );
  return {
    id: newAnthropicMessageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: Math.max(1, Math.ceil(outputChars / 4)),
    },
  };
}

export function anthropicError(
  status: number,
  message: string,
): Record<string, unknown> {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 400
            ? "invalid_request_error"
            : status === 429
              ? "rate_limit_error"
              : "api_error";
  return { type: "error", error: { type, message } };
}
