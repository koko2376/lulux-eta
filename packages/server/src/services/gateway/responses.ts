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

/**
 * OpenAI Responses API ⇄ 规范请求。
 * 支持 instructions、input（字符串或 item 数组：message / function_call / function_call_output /
 * custom_tool_call / custom_tool_call_output）、function 工具与 custom（自由文本）工具。
 * reasoning、web_search 等内置工具无法由上游执行，忽略。
 */
export interface ResponsesCanonical extends CanonicalRequest {
  /** custom 工具名：模型调用时要回成 custom_tool_call，参数是 {input: string} */
  customTools: Set<string>;
}

export function responsesToCanonical(body: unknown): ResponsesCanonical {
  const input = asRecord(body);
  const system: string[] = [];
  if (typeof input.instructions === "string" && input.instructions.trim())
    system.push(input.instructions);
  const turns: ChatTurn[] = [];

  const lastAssistant = (): ChatTurn => {
    const last = turns[turns.length - 1];
    if (last && last.role === "assistant") return last;
    const turn: ChatTurn = { role: "assistant", content: "" };
    turns.push(turn);
    return turn;
  };

  const items =
    typeof input.input === "string"
      ? [{ type: "message", role: "user", content: input.input }]
      : asArray(input.input);
  for (const raw of items) {
    const item = asRecord(raw);
    const type = asString(item.type) || (item.role ? "message" : "");
    if (type === "message") {
      const role = asString(item.role);
      const content = flattenContent(item.content);
      if (role === "system" || role === "developer") system.push(content);
      else if (role === "assistant") {
        const last = turns[turns.length - 1];
        // 同一轮里先文本后工具调用：合并到一条 assistant
        if (last && last.role === "assistant" && !last.toolCalls?.length)
          last.content += content;
        else turns.push({ role: "assistant", content });
      } else {
        const images = extractImages(item.content);
        turns.push(
          images.length
            ? { role: "user", content, images }
            : { role: "user", content },
        );
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      const turn = lastAssistant();
      const call: ToolCall = {
        id:
          asString(item.call_id) ||
          asString(item.id) ||
          `call_${randomBytes(8).toString("hex")}`,
        name: asString(item.name),
        arguments:
          type === "custom_tool_call"
            ? JSON.stringify({ input: asString(item.input) })
            : typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
      };
      turn.toolCalls = [...(turn.toolCalls ?? []), call];
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      turns.push({
        role: "tool",
        content: flattenContent(item.output),
        toolCallId: asString(item.call_id),
      });
    }
    // reasoning / local_shell_call / web_search_call 等：无法转发，忽略
  }

  const tools: ToolDefinition[] = [];
  const customTools = new Set<string>();
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw);
    const name = asString(tool.name);
    if (!name) continue;
    if (tool.type === "function") {
      tools.push({
        name,
        description: asString(tool.description),
        inputSchema: normalizeSchema(tool.parameters),
      });
    } else if (tool.type === "custom") {
      customTools.add(name);
      tools.push({
        name,
        description: asString(tool.description),
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "工具的原始文本输入" },
          },
          required: ["input"],
        },
      });
    }
  }

  return {
    model: asString(input.model),
    system: system.join("\n\n"),
    turns,
    tools,
    customTools,
    stream: input.stream === true,
    maxTokens:
      typeof input.max_output_tokens === "number"
        ? input.max_output_tokens
        : undefined,
  };
}

function hex(n: number): string {
  return randomBytes(n).toString("hex");
}

type OutputItem = Record<string, unknown>;

/** 规范流 → Responses SSE（response.created … response.completed） */
export class ResponsesStreamEncoder {
  readonly id = `resp_${hex(12)}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private seq = 0;
  private output: OutputItem[] = [];
  private text: { itemId: string; index: number; value: string } | null = null;
  private outputChars = 0;

  constructor(
    private readonly model: string,
    private readonly inputTokens: number,
    private readonly customTools: Set<string> = new Set(),
  ) {}

  private sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`;
  }

  private response(
    status: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.output,
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      error: null,
      incomplete_details: null,
      ...extra,
    };
  }

  start(): string {
    return (
      this.sse("response.created", {
        response: this.response("in_progress", { output: [] }),
      }) +
      this.sse("response.in_progress", {
        response: this.response("in_progress", { output: [] }),
      })
    );
  }

  push(event: StreamEvent): string {
    let out = "";
    if (event.type === "text") {
      if (!event.text) return "";
      if (!this.text) {
        const itemId = `msg_${hex(12)}`;
        const index = this.output.length;
        this.output.push({
          id: itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        });
        this.text = { itemId, index, value: "" };
        out += this.sse("response.output_item.added", {
          output_index: index,
          item: {
            id: itemId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        });
        out += this.sse("response.content_part.added", {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      this.text.value += event.text;
      this.outputChars += event.text.length;
      out += this.sse("response.output_text.delta", {
        item_id: this.text.itemId,
        output_index: this.text.index,
        content_index: 0,
        delta: event.text,
        logprobs: [],
      });
      return out;
    }
    out += this.closeText();
    for (const call of event.calls) {
      this.outputChars += call.arguments.length;
      const index = this.output.length;
      if (this.customTools.has(call.name)) {
        let inputText = "";
        try {
          inputText = String(
            (JSON.parse(call.arguments || "{}") as { input?: unknown }).input ??
              "",
          );
        } catch {
          inputText = call.arguments;
        }
        const item = {
          id: `ctc_${hex(12)}`,
          type: "custom_tool_call",
          status: "completed",
          call_id: call.id,
          name: call.name,
          input: inputText,
        };
        this.output.push(item);
        out += this.sse("response.output_item.added", {
          output_index: index,
          item: { ...item, input: "", status: "in_progress" },
        });
        out += this.sse("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: index,
          delta: inputText,
        });
        out += this.sse("response.custom_tool_call_input.done", {
          item_id: item.id,
          output_index: index,
          input: inputText,
        });
        out += this.sse("response.output_item.done", {
          output_index: index,
          item,
        });
        continue;
      }
      const item = {
        id: `fc_${hex(12)}`,
        type: "function_call",
        status: "completed",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      };
      this.output.push(item);
      out += this.sse("response.output_item.added", {
        output_index: index,
        item: { ...item, arguments: "", status: "in_progress" },
      });
      out += this.sse("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      out += this.sse("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
      out += this.sse("response.output_item.done", {
        output_index: index,
        item,
      });
    }
    return out;
  }

  private closeText(): string {
    if (!this.text) return "";
    const { itemId, index, value } = this.text;
    this.text = null;
    const part = { type: "output_text", text: value, annotations: [] };
    const item = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [part],
    };
    this.output[index] = item;
    return (
      this.sse("response.output_text.done", {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        text: value,
        logprobs: [],
      }) +
      this.sse("response.content_part.done", {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part,
      }) +
      this.sse("response.output_item.done", { output_index: index, item })
    );
  }

  private usage(): Record<string, unknown> {
    const output = Math.max(1, Math.ceil(this.outputChars / 4));
    return {
      input_tokens: this.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: this.inputTokens + output,
    };
  }

  finish(): string {
    const out = this.closeText();
    return (
      out +
      this.sse("response.completed", {
        response: this.response("completed", { usage: this.usage() }),
      })
    );
  }

  /** 非流式：返回最终 response 对象（push 的输出可丢弃） */
  final(): Record<string, unknown> {
    this.closeText();
    return this.response("completed", { usage: this.usage() });
  }

  error(message: string): string {
    return this.sse("response.failed", {
      response: this.response("failed", {
        error: { code: "server_error", message },
      }),
    });
  }
}

export function responsesFrom(
  model: string,
  inputTokens: number,
  events: StreamEvent[],
  customTools: Set<string> = new Set(),
): Record<string, unknown> {
  const encoder = new ResponsesStreamEncoder(model, inputTokens, customTools);
  for (const event of events) encoder.push(event);
  return encoder.final();
}
