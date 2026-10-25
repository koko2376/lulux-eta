import { randomBytes } from "node:crypto";
import type { ChatTurn, ToolCall, ToolDefinition } from "../../types.js";
import {
  asArray,
  asRecord,
  asString,
  extractImages,
  flattenContent,
  normalizeSchema,
  type CanonicalRequest,
  type StreamEvent,
} from "./types.js";

/** OpenAI Chat Completions ⇄ 规范请求（上游是 Anthropic 协议时使用；OpenAI 兼容上游直接透传） */
export function chatToCanonical(body: unknown): CanonicalRequest {
  const input = asRecord(body);
  const system: string[] = [];
  const turns: ChatTurn[] = [];
  for (const raw of asArray(input.messages)) {
    const message = asRecord(raw);
    const role = asString(message.role);
    const content = flattenContent(message.content);
    if (role === "system" || role === "developer") {
      system.push(content);
    } else if (role === "assistant") {
      const calls: ToolCall[] = asArray(message.tool_calls)
        .map(asRecord)
        .map((call) => {
          const fn = asRecord(call.function);
          return {
            id: asString(call.id) || `call_${randomBytes(8).toString("hex")}`,
            name: asString(fn.name),
            arguments:
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
          };
        })
        .filter((call) => call.name);
      turns.push({
        role: "assistant",
        content,
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    } else if (role === "tool") {
      turns.push({
        role: "tool",
        content,
        toolCallId: asString(message.tool_call_id),
      });
    } else {
      const images = extractImages(message.content);
      turns.push(
        images.length
          ? { role: "user", content, images }
          : { role: "user", content },
      );
    }
  }
  const tools: ToolDefinition[] = [];
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw);
    const fn = asRecord(tool.function);
    const name = asString(fn.name);
    if (tool.type !== "function" || !name) continue;
    tools.push({
      name,
      description: asString(fn.description),
      inputSchema: normalizeSchema(fn.parameters),
    });
  }
  const maxTokens =
    typeof input.max_completion_tokens === "number"
      ? input.max_completion_tokens
      : input.max_tokens;
  return {
    model: asString(input.model),
    system: system.join("\n\n"),
    turns,
    tools,
    stream: input.stream === true,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
  };
}

/** 规范流 → chat.completion.chunk SSE */
export class ChatStreamEncoder {
  readonly id = `chatcmpl-${randomBytes(12).toString("hex")}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private sentRole = false;
  private toolIndex = 0;
  private outputChars = 0;

  constructor(
    private readonly model: string,
    private readonly inputTokens: number,
    private readonly includeUsage: boolean,
  ) {}

  private chunk(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  push(event: StreamEvent): string {
    const role = this.sentRole ? {} : { role: "assistant" };
    this.sentRole = true;
    if (event.type === "text") {
      if (!event.text) return "";
      this.outputChars += event.text.length;
      return this.chunk({ ...role, content: event.text });
    }
    const tool_calls = event.calls.map((call) => {
      this.outputChars += call.arguments.length;
      return {
        index: this.toolIndex++,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      };
    });
    return this.chunk({ ...role, tool_calls });
  }

  finish(): string {
    let out = this.chunk(
      this.sentRole ? {} : { role: "assistant", content: "" },
      this.toolIndex > 0 ? "tool_calls" : "stop",
    );
    if (this.includeUsage) {
      const completion = Math.max(1, Math.ceil(this.outputChars / 4));
      out += `data: ${JSON.stringify({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [],
        usage: {
          prompt_tokens: this.inputTokens,
          completion_tokens: completion,
          total_tokens: this.inputTokens + completion,
        },
      })}\n\n`;
    }
    return `${out}data: [DONE]\n\n`;
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`;
  }
}

export function chatCompletionFrom(
  model: string,
  inputTokens: number,
  events: StreamEvent[],
): Record<string, unknown> {
  let text = "";
  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.type === "text") text += event.text;
    else calls.push(...event.calls);
  }
  const completion = Math.max(
    1,
    Math.ceil(
      (text.length + calls.reduce((s, c) => s + c.arguments.length, 0)) / 4,
    ),
  );
  return {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: call.arguments || "{}",
                  },
                })),
              }
            : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: completion,
      total_tokens: inputTokens + completion,
    },
  };
}

export function openAIError(
  status: number,
  message: string,
): Record<string, unknown> {
  const type =
    status === 401
      ? "invalid_api_key"
      : status === 400
        ? "invalid_request_error"
        : "upstream_error";
  return { error: { message, type, code: type } };
}
