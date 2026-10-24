import type { ProviderKind } from "../../types.js";
import {
  capabilitiesFor,
  learnCapability,
  learnedPatchFor,
  type ModelCapabilities,
} from "./capabilities.js";
import { sendsReasoningParams } from "./reasoning-params.js";
import { backoffDelay, toUpstreamError, UpstreamError } from "./errors.js";
import { getExtendedStreamChat } from "./index.js";
import type { ExtendedStreamEvent, StreamRequest } from "./types.js";

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: UpstreamError;
}

export interface ResilientOptions {
  /** 最多重试次数（不含首次） */
  maxRetries: number;
  /** 首包超时与流空闲超时（毫秒） */
  timeoutMs: number;
  onRetry?(info: RetryInfo): void;
  /** 上游明确不支持某项参数时自动降级（tools / stream_options / 图片 / 推理强度参数） */
  onDowngrade?(
    what: "tools" | "stream_usage" | "vision" | "reasoning",
    error: UpstreamError,
  ): void;
  /** 测试注入 */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
}

/** 可被取消的等待 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UpstreamError("aborted", "已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new UpstreamError("aborted", "已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const TOOLS_UNSUPPORTED =
  /(tool|function).{0,40}(not support|unsupported|not allowed|invalid|unknown|not available|does not support)|(does not support|unsupported).{0,40}(tool|function)/i;
const USAGE_UNSUPPORTED = /stream_options|include_usage/i;
const REASONING_PARAM =
  /reasoning_effort|reasoningeffort|enable_thinking|thinking_budget|budget_tokens|thinking|reasoning/i;

/** 上游拒绝推理参数后的降级：仍会输出思考的风格保留 reasoning_content 回传，只是不再发参数 */
function reasoningFallback(
  caps: ModelCapabilities,
): Pick<ModelCapabilities, "reasoning" | "thinkingToggle"> {
  return caps.reasoning === "qwen" || caps.reasoning === "deepseek"
    ? { reasoning: "deepseek", thinkingToggle: false }
    : { reasoning: "none", thinkingToggle: false };
}
const IMAGES_UNSUPPORTED =
  /(image|vision|multimodal|multi-modal|image_url).{0,60}(not support|unsupported|not allowed|invalid|unknown|not available|does not support|cannot)|(does not support|unsupported|cannot (read|process)|not support).{0,60}(image|vision|multimodal|image_url)|content.{0,30}(must be|should be|expected).{0,20}string/i;

/**
 * 在适配器外层加：首包/空闲超时、错误分类、指数退避重试、参数降级。
 * 只在**尚未产出任何内容**时重试（已输出一半的流不重放，避免重复文本；由编排层用续写补救）。
 */
export async function* streamResilient(
  kind: ProviderKind,
  request: StreamRequest,
  options: ResilientOptions,
): AsyncGenerator<ExtendedStreamEvent> {
  const adapter = getExtendedStreamChat(kind);
  const sleep = options.sleep ?? abortableSleep;
  const userSignal = request.signal;
  let attempt = 0;
  let current: StreamRequest = { ...request };
  // 调用方传入的能力是本轮开始时算的：叠加之前几轮学到的降级，避免每轮都撞同一个 400
  const learnedPatch = learnedPatchFor(request.model);
  if (current.capabilities && learnedPatch)
    current.capabilities = { ...current.capabilities, ...learnedPatch };

  while (true) {
    if (userSignal?.aborted) throw new UpstreamError("aborted", "已取消");
    const timeoutController = new AbortController();
    let timedOut = false;
    const fire = (): void => {
      timedOut = true;
      timeoutController.abort();
    };
    let timer = setTimeout(fire, options.timeoutMs);
    const signal = userSignal
      ? AbortSignal.any([userSignal, timeoutController.signal])
      : timeoutController.signal;
    let emitted = false;

    try {
      for await (const event of adapter({ ...current, signal })) {
        clearTimeout(timer);
        timer = setTimeout(fire, options.timeoutMs);
        if (event.type === "ping") continue;
        emitted = true;
        yield event;
      }
      return;
    } catch (raw) {
      if (userSignal?.aborted) throw new UpstreamError("aborted", "已取消");
      const error = timedOut
        ? new UpstreamError(
            "timeout",
            `模型服务超过 ${Math.round(options.timeoutMs / 1000)} 秒没有响应`,
          )
        : toUpstreamError(raw);
      if (emitted) throw error;

      if (error.kind === "bad_request") {
        if (
          current.includeUsage !== false &&
          USAGE_UNSUPPORTED.test(error.message)
        ) {
          learnCapability(current.model, { streamUsage: false });
          options.onDowngrade?.("stream_usage", error);
          current = { ...current, includeUsage: false };
          continue;
        }
        if (
          current.messages.some((turn) => turn.images?.length) &&
          IMAGES_UNSUPPORTED.test(error.message)
        ) {
          // 上游拒绝图片：记住该模型不支持看图，去掉图片重发（正文里有文件路径作为文字兜底）
          learnCapability(current.model, { vision: false });
          options.onDowngrade?.("vision", error);
          current = {
            ...current,
            messages: current.messages.map(
              ({ images: _images, ...turn }) => turn,
            ),
          };
          continue;
        }
        const caps =
          current.capabilities ?? capabilitiesFor(current.model, kind);
        if (
          current.reasoningEffort &&
          sendsReasoningParams(caps) &&
          REASONING_PARAM.test(error.message) &&
          !TOOLS_UNSUPPORTED.test(error.message)
        ) {
          // 上游不认推理强度参数：记住该模型不支持调节，去掉参数重发，并通知界面
          const patch = reasoningFallback(caps);
          learnCapability(current.model, patch);
          options.onDowngrade?.("reasoning", error);
          current = {
            ...current,
            reasoningEffort: undefined,
            capabilities: current.capabilities
              ? { ...current.capabilities, ...patch }
              : undefined,
          };
          continue;
        }
        if (current.tools?.length && TOOLS_UNSUPPORTED.test(error.message)) {
          learnCapability(current.model, { tools: false });
          options.onDowngrade?.("tools", error);
          current = { ...current, tools: undefined };
          continue;
        }
      }

      if (error.retryable && attempt < options.maxRetries) {
        const delayMs = backoffDelay(attempt, error.retryAfterMs, {
          random: options.random,
        });
        attempt += 1;
        options.onRetry?.({
          attempt,
          maxRetries: options.maxRetries,
          delayMs,
          error,
        });
        await sleep(delayMs, userSignal);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
