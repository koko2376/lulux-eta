import type { ChatTurn, ToolDefinition, TurnImage } from "../../types.js";
import { IMAGE_MIMES, parseImageDataUrl } from "../llm/images.js";
import type { StreamEvent } from "../llm/types.js";

/**
 * 网关内部的规范请求：三种外部协议（Anthropic Messages / OpenAI Responses / OpenAI Chat / Gemini）
 * 都先转成它，再交给 services/llm 的 provider 适配器（OpenAI 兼容 / Anthropic）。
 */
export interface CanonicalRequest {
  /** 客户端请求的模型名（可能是别名），只用于路由与回显 */
  model: string;
  system: string;
  turns: ChatTurn[];
  tools: ToolDefinition[];
  stream: boolean;
  maxTokens?: number;
}

export type { StreamEvent };

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

/** 粗略估算 token 数（不依赖分词器）：ASCII 约 4 字符 1 token，CJK 约 1 字 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide));
}

export function estimateRequestTokens(request: CanonicalRequest): number {
  let text = request.system;
  for (const turn of request.turns) {
    text += turn.content;
    for (const call of turn.toolCalls ?? []) text += call.name + call.arguments;
  }
  for (const tool of request.tools)
    text += tool.name + tool.description + JSON.stringify(tool.inputSchema);
  return estimateTokens(text);
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 各协议的 base64 图片块 → 规范图片（只支持内联 base64；远程 URL 无法转发，返回 null）：
 * Anthropic `{type:'image', source:{type:'base64'}}`、OpenAI Chat `{type:'image_url'}`、
 * Responses `{type:'input_image', image_url}`、Gemini `{inlineData:{mimeType,data}}`。
 */
export function imageFromBlock(raw: unknown): TurnImage | null {
  const block = asRecord(raw);
  const type = asString(block.type);
  if (type === "image") {
    const source = asRecord(block.source);
    const mime = asString(source.media_type).toLowerCase();
    if (
      source.type === "base64" &&
      (IMAGE_MIMES as readonly string[]).includes(mime) &&
      asString(source.data)
    ) {
      return { mime, data: asString(source.data) };
    }
    return null;
  }
  if (type === "image_url" || type === "input_image") {
    const url =
      typeof block.image_url === "string"
        ? block.image_url
        : asString(asRecord(block.image_url).url);
    return parseImageDataUrl(url);
  }
  const inline = asRecord(block.inlineData ?? block.inline_data);
  const mime = asString(inline.mimeType ?? inline.mime_type).toLowerCase();
  if (
    mime &&
    (IMAGE_MIMES as readonly string[]).includes(mime) &&
    asString(inline.data)
  )
    return { mime, data: asString(inline.data) };
  return null;
}

/** 内容块数组里的全部可转发图片 */
export function extractImages(content: unknown): TurnImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .map(imageFromBlock)
    .filter((image): image is TurnImage => image !== null);
}

/** 把各种“内容块数组”压成纯文本；能转发的 base64 图片由 extractImages 单独取出，其余非文本块用占位说明代替 */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return content == null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    const block = asRecord(raw);
    const type = asString(block.type);
    if (
      typeof block.text === "string" &&
      (type === "" || type.includes("text"))
    )
      parts.push(block.text);
    else if (type.includes("image")) {
      if (!imageFromBlock(block))
        parts.push("[图片（网关只能转发内联图片，已省略）]");
    } else if (type === "document" || type === "input_file" || type === "file")
      parts.push("[文件（网关仅转发文本，已省略）]");
    else if (
      type === "tool_result" ||
      type === "tool_use" ||
      type === "thinking" ||
      type === "redacted_thinking"
    )
      continue;
    else if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** 规范化 JSON Schema：Gemini 的 OpenAPI 风格大写 type → 小写，去掉上游常拒绝的字段 */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "$schema") continue;
      if (key === "type" && typeof value === "string")
        out.type = value.toLowerCase();
      else if (key === "type" && Array.isArray(value))
        out.type = value.map((item) =>
          typeof item === "string" ? item.toLowerCase() : item,
        );
      else out[key] = walk(value);
    }
    return out;
  };
  const result = asRecord(walk(schema));
  if (!result.type) result.type = "object";
  if (result.type === "object" && !result.properties) result.properties = {};
  return result;
}
