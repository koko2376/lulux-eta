import { Readable, Transform } from "node:stream";
import type { Provider } from "../../types.js";
import { fetchWithProxy } from "../http-client.js";
import { capabilitiesFor } from "../llm/capabilities.js";
import { getStreamChat } from "../llm/index.js";
import { applyChatReasoningParams } from "../llm/reasoning-params.js";
import { gatewayEfforts } from "../models/catalog.js";
import { joinUrl, readErrorMessage } from "../llm/stream-utils.js";
import { providerService } from "../provider-service.js";
import type { ReasoningEffort } from "../llm/types.js";
import type { GatewayTarget } from "./tokens.js";
import type { CanonicalRequest, StreamEvent } from "./types.js";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 模型别名：Claude Code 只接受 claude 开头的模型 id，因此对外统一暴露 claude-lulux-<provider>-<model> */
export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "x"
  );
}

export function modelAlias(
  provider: Pick<Provider, "name" | "id">,
  model: string,
): string {
  return `claude-lulux-${slug(provider.name || provider.id)}-${slug(model)}`;
}

export interface ResolvedRoute {
  provider: Provider;
  model: string;
  alias: string;
  /** 会话推理强度（只对 OpenAI 系推理模型生效，见 gatewayEffort） */
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * 网关给上游加的推理强度（契约 §6.13）：按模型的推理风格（含 Provider 里的手动设置）收紧到网关支持的档位。
 * 返回 null = 不改 CLI 自己的请求；'off' 只对能关闭思考的风格（qwen / 开关）有意义。
 * Anthropic 的思考块带签名，跨协议转发回不去，所以不在网关里开。
 */
export function gatewayEffort(route: ResolvedRoute): ReasoningEffort | null {
  const effort = route.reasoningEffort;
  if (!effort) return null;
  const supported = gatewayEfforts(route.model, route.provider);
  if (!supported.includes(effort)) return null;
  if (effort === "off") {
    const caps = capabilitiesFor(route.model, route.provider);
    return supported.length > 1 && caps.reasoning !== "openai" ? "off" : null;
  }
  return effort;
}

/**
 * 按令牌绑定的目标解析上游：Provider 固定为会话所选（请求体不能改 Provider），
 * 请求里的模型名若是该 Provider 的某个模型（原名或别名）就用它，否则回落到会话所选模型。
 */
export function resolveRoute(
  target: GatewayTarget,
  requested: string,
): ResolvedRoute {
  const provider = providerService.get(target.providerId);
  if (!provider)
    throw new GatewayError(503, "LULUX 中会话所选的模型 Provider 已被删除");
  if (provider.apiKeyError)
    throw new GatewayError(
      503,
      `Provider「${provider.name}」的 ${provider.apiKeyError}`,
    );
  let model = target.model || provider.model;
  const wanted = requested.trim();
  if (wanted) {
    const candidates = provider.models.length
      ? provider.models
      : [provider.model];
    const hit = candidates.find(
      (item) => item === wanted || modelAlias(provider, item) === wanted,
    );
    if (hit) model = hit;
  }
  if (!model)
    throw new GatewayError(503, `Provider「${provider.name}」还没有选择模型`);
  return {
    provider,
    model,
    alias: modelAlias(provider, model),
    reasoningEffort: target.reasoningEffort ?? null,
  };
}

/** 网关对外列出的模型：只有令牌绑定的 Provider 下的模型（会话所选模型排第一） */
export function listedModels(
  target: GatewayTarget,
): Array<{ provider: Provider; model: string; alias: string }> {
  const provider = providerService.get(target.providerId);
  if (!provider) return [];
  const models = [target.model || provider.model, ...provider.models].filter(
    Boolean,
  );
  return [...new Set(models)].map((model) => ({
    provider,
    model,
    alias: modelAlias(provider, model),
  }));
}

/** 跨协议：交给 services/llm 的适配器（与对话共用同一套 Provider 实现） */
export async function* streamUpstream(
  route: ResolvedRoute,
  request: CanonicalRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // 图片：模型支持看图时原样转发给适配器（OpenAI image_url / Anthropic image 块），否则去掉并在正文里注明
  const caps = capabilitiesFor(route.model, route.provider);
  const vision = caps.vision;
  const turns = vision
    ? request.turns
    : request.turns.map((turn) => {
        if (!turn.images?.length) return turn;
        const { images, ...rest } = turn;
        return {
          ...rest,
          content: `${rest.content}${rest.content ? "\n" : ""}[${images.length} 张图片：当前模型不支持看图，已省略]`,
        };
      });
  const messages = request.system.trim()
    ? [{ role: "system" as const, content: request.system }, ...turns]
    : turns;
  yield* getStreamChat(route.provider.kind)({
    baseUrl: route.provider.baseUrl,
    apiKey: route.provider.apiKey,
    model: route.model,
    messages,
    tools: request.tools.length ? request.tools : undefined,
    reasoningEffort: gatewayEffort(route) ?? undefined,
    capabilities: caps,
    signal,
  });
}

export interface PassthroughResult {
  status: number;
  contentType: string;
  body: Readable | string;
}

/**
 * 透传请求体：替换模型名；Chat Completions 且会话设了推理强度时按模型的推理风格补参数
 * （reasoning_effort / enable_thinking / thinking.type，CLI 自己带了就不改）
 */
export function passthroughBody(
  route: ResolvedRoute,
  path: "/messages" | "/chat/completions",
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body, model: route.model };
  const effort = path === "/chat/completions" ? gatewayEffort(route) : null;
  if (effort)
    applyChatReasoningParams(
      next,
      capabilitiesFor(route.model, route.provider),
      effort,
    );
  return next;
}

/** 同协议透传：只替换模型名与鉴权头，不转发 CLI 的任何其他头 */
export async function passthrough(
  route: ResolvedRoute,
  path: "/messages" | "/chat/completions",
  body: Record<string, unknown>,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<PassthroughResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (route.provider.kind === "anthropic") {
    headers["x-api-key"] = route.provider.apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${route.provider.apiKey}`;
  }
  const response = await fetchWithProxy(joinUrl(route.provider.baseUrl, path), {
    method: "POST",
    headers,
    body: JSON.stringify(passthroughBody(route, path, body)),
    signal,
  });
  const contentType =
    response.headers.get("content-type") || "application/json";
  if (!response.ok) {
    // 401/403 改成 400：否则 CLI 会误以为是自己的登录失效（提示 /login），且不会无谓重试
    const status =
      response.status >= 500
        ? 502
        : response.status === 401 || response.status === 403
          ? 400
          : response.status;
    throw new GatewayError(
      status,
      `上游 Provider「${route.provider.name}」返回 HTTP ${response.status}：${await readErrorMessage(response)}`,
    );
  }
  if (!response.body) return { status: response.status, contentType, body: "" };
  return {
    status: response.status,
    contentType,
    body: Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream<Uint8Array>,
    ),
  };
}

/**
 * Chat Completions 流透传时的兜底：有些 OpenAI 兼容服务（以及本地 mock）不发 finish_reason 或 [DONE]，
 * Qwen Code 等客户端会因此报 “stream ended without a finish reason”。这里逐帧原样转发，
 * 仅在结束前缺少 finish_reason 时补一帧 {finish_reason:'stop'|'tool_calls'}，缺 [DONE] 时补上。
 */
export function ensureChatFinish(model: string): Transform {
  let buffer = "";
  let finished = false;
  let sawTools = false;
  let done = false;
  let id = "chatcmpl-lulux";
  const finishFrame = (): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: sawTools ? "tool_calls" : "stop",
        },
      ],
    })}\n\n`;
  const inspect = (block: string): string => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "[DONE]") {
      done = true;
      return finished ? "" : finishFrame();
    }
    try {
      const chunk = JSON.parse(data) as {
        id?: string;
        choices?: Array<{
          finish_reason?: string | null;
          delta?: { tool_calls?: unknown[] };
        }>;
      };
      if (chunk.id) id = chunk.id;
      for (const choice of chunk.choices ?? []) {
        if (choice.delta?.tool_calls?.length) sawTools = true;
        if (choice.finish_reason) finished = true;
      }
    } catch {
      // 非 JSON 帧原样转发
    }
    return "";
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString("utf8");
      let out = "";
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        out += inspect(block) + block + "\n\n";
      }
      callback(null, out);
    },
    flush(callback) {
      let out = "";
      if (buffer.trim()) out += inspect(buffer) + buffer + "\n\n";
      if (!done) out += (finished ? "" : finishFrame()) + "data: [DONE]\n\n";
      callback(null, out);
    },
  });
}
