import type { ModelCapabilities } from "./capabilities.js";
import type { ReasoningEffort } from "./types.js";

/** 推理强度 → 思考预算（Anthropic thinking.budget_tokens / Qwen thinking_budget） */
export const THINKING_BUDGET = {
  low: 2048,
  medium: 8192,
  high: 24_576,
  /** 只对单次输出上限 ≥ 64K 的模型开放（见 services/models/catalog.ts） */
  xhigh: 32_000,
} as const;

type Caps = Pick<ModelCapabilities, "reasoning" | "thinkingToggle">;

/** 该能力组合是否会往请求里加推理参数（用于判断上游 400 是不是这些参数引起的） */
export function sendsReasoningParams(caps: Caps): boolean {
  if (caps.reasoning === "deepseek") return caps.thinkingToggle;
  return caps.reasoning !== "none";
}

/** Anthropic 协议上能否开扩展思考：Anthropic 协议只有 thinking 一种开法，任何可调节的风格都按预算发 */
export function anthropicThinkingSupported(caps: Caps): boolean {
  return (
    caps.reasoning === "anthropic" ||
    caps.reasoning === "openai" ||
    caps.reasoning === "qwen" ||
    (caps.reasoning === "deepseek" && caps.thinkingToggle)
  );
}

/**
 * OpenAI 兼容 Chat Completions 请求体里按推理风格加参数（已存在的字段不覆盖）：
 *  - openai：reasoning_effort（off 不发，沿用模型默认）
 *  - qwen：enable_thinking（off → false）+ thinking_budget
 *  - deepseek + thinkingToggle：thinking.type = enabled / disabled
 *  - anthropic（经 OpenAI 兼容中转）：thinking = {type: enabled, budget_tokens}，并保证输出上限大于预算
 * effort 为 undefined / null 时什么都不加（调用方没有指定强度）。
 */
export function applyChatReasoningParams(
  body: Record<string, unknown>,
  caps: Caps,
  effort: ReasoningEffort | null | undefined,
): void {
  if (!effort) return;
  const off = effort === "off";
  const setIfMissing = (key: string, value: unknown): void => {
    if (body[key] === undefined) body[key] = value;
  };
  if (caps.reasoning === "openai") {
    if (!off) setIfMissing("reasoning_effort", effort);
  } else if (caps.reasoning === "qwen") {
    if (body.enable_thinking !== undefined) return;
    body.enable_thinking = !off;
    if (!off) setIfMissing("thinking_budget", THINKING_BUDGET[effort]);
  } else if (caps.reasoning === "deepseek" && caps.thinkingToggle) {
    setIfMissing("thinking", { type: off ? "disabled" : "enabled" });
  } else if (caps.reasoning === "anthropic" && !off) {
    if (body.thinking !== undefined) return;
    const budget = THINKING_BUDGET[effort];
    body.thinking = { type: "enabled", budget_tokens: budget };
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const value = body[key];
      if (typeof value === "number" && value < budget + 4096) body[key] = budget + 4096;
    }
  }
}
