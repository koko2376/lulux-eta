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
  imageFromBlock,
  normalizeSchema,
  type CanonicalRequest,
  type StreamEvent,
} from "./types.js";

/**
 * Gemini generateContent / streamGenerateContent ⇄ 规范请求。
 * Gemini CLI 在设置了 GOOGLE_GEMINI_BASE_URL 时使用 “gateway” 认证类型，把 GEMINI_API_KEY 放在 x-goog-api-key 头里。
 * functionCall 没有 id 时按名字顺序与 functionResponse 配对。
 */
export function geminiToCanonical(
  body: unknown,
  model: string,
  stream: boolean,
): CanonicalRequest {
  const input = asRecord(body);
  const systemParts = asArray(
    asRecord(input.systemInstruction ?? input.system_instruction).parts,
  );
  const system = systemParts
    .map((part) => asString(asRecord(part).text))
    .filter(Boolean)
    .join("\n");
  const turns: ChatTurn[] = [];
  /** 尚未得到结果的调用：name → id 队列 */
  const pending = new Map<string, string[]>();

  for (const raw of asArray(input.contents)) {
    const content = asRecord(raw);
    const parts = asArray(content.parts).map(asRecord);
    if (content.role === "model") {
      const text: string[] = [];
      const calls: ToolCall[] = [];
      for (const part of parts) {
        if (part.thought === true) continue;
        if (typeof part.text === "string") text.push(part.text);
        const call = asRecord(part.functionCall);
        if (call.name) {
          const id =
            asString(call.id) || `gcall_${randomBytes(8).toString("hex")}`;
          const queue = pending.get(asString(call.name)) ?? [];
          queue.push(id);
          pending.set(asString(call.name), queue);
          calls.push({
            id,
            name: asString(call.name),
            arguments: JSON.stringify(call.args ?? {}),
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
    const text: string[] = [];
    const images: TurnImage[] = [];
    for (const part of parts) {
      const response = asRecord(part.functionResponse);
      if (response.name) {
        const name = asString(response.name);
        let id = asString(response.id);
        const queue = pending.get(name) ?? [];
        if (id && queue.includes(id)) queue.splice(queue.indexOf(id), 1);
        else
          id = queue.shift() || id || `gcall_${randomBytes(8).toString("hex")}`;
        turns.push({
          role: "tool",
          content: JSON.stringify(response.response ?? {}),
          toolCallId: id,
          toolName: name,
        });
      } else if (typeof part.text === "string") {
        text.push(part.text);
      } else if (part.inlineData || part.inline_data || part.fileData) {
        const image = imageFromBlock(part);
        if (image) images.push(image);
        else text.push("[文件或图片（网关只能转发内联图片，已省略）]");
      }
    }
    if (text.length || images.length) {
      const content = text.join("\n");
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
    for (const declRaw of asArray(
      tool.functionDeclarations ?? tool.function_declarations,
    )) {
      const decl = asRecord(declRaw);
      const name = asString(decl.name);
      if (!name) continue;
      tools.push({
        name,
        description: asString(decl.description),
        inputSchema: normalizeSchema(
          decl.parametersJsonSchema ??
            decl.parameters ?? { type: "object", properties: {} },
        ),
      });
    }
  }

  const generation = asRecord(input.generationConfig);
  return {
    model,
    system,
    turns,
    tools,
    stream,
    maxTokens:
      typeof generation.maxOutputTokens === "number"
        ? generation.maxOutputTokens
        : undefined,
  };
}

function usage(
  inputTokens: number,
  outputChars: number,
): Record<string, number> {
  const output = Math.max(1, Math.ceil(outputChars / 4));
  return {
    promptTokenCount: inputTokens,
    candidatesTokenCount: output,
    totalTokenCount: inputTokens + output,
  };
}

function partsOf(event: StreamEvent): Array<Record<string, unknown>> {
  if (event.type === "text") return event.text ? [{ text: event.text }] : [];
  return event.calls.map((call) => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      args = {};
    }
    return { functionCall: { id: call.id, name: call.name, args } };
  });
}

/** 规范流 → streamGenerateContent?alt=sse 帧 */
export class GeminiStreamEncoder {
  private outputChars = 0;

  constructor(
    private readonly model: string,
    private readonly inputTokens: number,
  ) {}

  push(event: StreamEvent): string {
    const parts = partsOf(event);
    if (parts.length === 0) return "";
    this.outputChars +=
      event.type === "text"
        ? event.text.length
        : event.calls.reduce((s, c) => s + c.arguments.length, 0);
    return `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts }, index: 0 }],
      modelVersion: this.model,
    })}\r\n\r\n`;
  }

  finish(): string {
    return `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: usage(this.inputTokens, this.outputChars),
      modelVersion: this.model,
    })}\r\n\r\n`;
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { code: 502, message, status: "UNAVAILABLE" } })}\r\n\r\n`;
  }
}

export function geminiResponseFrom(
  model: string,
  inputTokens: number,
  events: StreamEvent[],
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  let outputChars = 0;
  for (const event of events) {
    for (const part of partsOf(event)) {
      const last = parts[parts.length - 1];
      if (
        typeof part.text === "string" &&
        last &&
        typeof last.text === "string"
      )
        last.text += part.text;
      else parts.push(part);
    }
    outputChars +=
      event.type === "text"
        ? event.text.length
        : event.calls.reduce((s, c) => s + c.arguments.length, 0);
  }
  if (parts.length === 0) parts.push({ text: "" });
  return {
    candidates: [
      { content: { role: "model", parts }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: usage(inputTokens, outputChars),
    modelVersion: model,
  };
}

export function geminiError(
  status: number,
  message: string,
): Record<string, unknown> {
  const statusText =
    status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "PERMISSION_DENIED"
        : status === 400
          ? "INVALID_ARGUMENT"
          : status === 404
            ? "NOT_FOUND"
            : "UNAVAILABLE";
  return { error: { code: status, message, status: statusText } };
}
