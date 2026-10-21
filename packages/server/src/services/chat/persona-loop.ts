import { messageOf } from "../../errors.js";
import type {
  ChatTurn,
  Provider,
  ToolCall,
  ToolRound,
  ToolTraceEntry,
} from "../../types.js";
import { newId } from "../../utils/id.js";
import type { ResolvedAgent } from "../agent-service.js";
import {
  capabilitiesFor,
  type ModelCapabilities,
} from "../llm/capabilities.js";
import { toUpstreamError, UpstreamError } from "../llm/errors.js";
import { streamResilient } from "../llm/resilient.js";
import { estimateTokens, estimateTools, estimateTurns } from "../llm/tokens.js";
import {
  emptyUsage,
  type FinishReason,
  type ReasoningBlock,
  type ReasoningEffort,
  type Usage,
} from "../llm/types.js";
import {
  usageService,
  type UsagePurpose,
  type UsageRecord,
} from "../llm/usage-service.js";
import { mcpRuntime, type ResolvedMcpTool } from "../mcp/runtime.js";
import { memoryToolsBlocked } from "../memory/session-policy.js";
import { settingsService } from "../settings-service.js";
import {
  effectiveSessionLevel,
  READ_ONLY_REFUSAL,
  toolGate,
} from "../permissions.js";
import {
  approvalTimeoutMs,
  isAllowedForSession,
  isNonInteractive,
  waitForApproval,
} from "../tool-approval.js";
import {
  BUILTIN_SERVER,
  findTool,
  runTool,
  toolPermissionDenial,
  type ToolArtifact,
  type ToolFile,
  type ToolSpec,
} from "../tools/registry.js";
import { sanitizeToolPairing, shrinkToolResults } from "./compaction.js";
import { inlineTurnImages, type ImageCache } from "./vision.js";
import {
  budgetPressure,
  budgetPressureText,
  DEFAULT_MAX_TURNS,
  LOOP_GUARD_PROMPT,
  MAX_TURNS_LIMIT,
  REPEAT_LIMIT,
  RepeatGuard,
  repeatBlockedResult,
  type BudgetLevel,
} from "./turn-budget.js";

const TRACE_RESULT_LIMIT = 4000;
const ROUND_RESULT_LIMIT = 8000;
const READ_CONCURRENCY = 4;

export const CONTINUE_PROMPT =
  "（系统提示：你上一条回复因长度限制或连接中断被截断。请从中断处直接接着写，不要重复已经输出的内容，不要寒暄。）";
export const FINAL_ANSWER_PROMPT =
  "（系统提示：请基于以上思考，直接给出最终回答。）";
export const TOOL_LIMIT_PROMPT =
  "（系统提示：本次回复的工具调用次数已达上限，不能再调用工具。请基于已获得的工具结果直接回答；还缺的信息请明确告诉用户。）";

/** SSE 适配层只需要实现 send */
export interface ChatSink {
  send(event: string, payload: unknown): void;
}

export interface LoopSettings {
  /** 一次回复最多的工具调用轮数；0 = 不限制（agent.maxTurns，默认 90） */
  maxTurns: number;
  /** 70% / 90% 时注入预算提醒（agent.budgetPressure） */
  budgetPressure: boolean;
  parallelToolCalls: boolean;
  maxRetries: number;
  timeoutMs: number;
  maxContinuations: number;
  reasoningEffort: ReasoningEffort;
}

function intSetting(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt(settingsService.get(key) ?? "", 10);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function loopSettings(): LoopSettings {
  const effort = settingsService.get("reasoningEffort");
  return {
    maxTurns: intSetting(
      "agent.maxTurns",
      DEFAULT_MAX_TURNS,
      0,
      MAX_TURNS_LIMIT,
    ),
    budgetPressure: settingsService.get("agent.budgetPressure") !== "0",
    parallelToolCalls: settingsService.get("parallelToolCalls") !== "0",
    maxRetries: intSetting("llmMaxRetries", 3, 0, 8),
    timeoutMs: intSetting("llmTimeoutSeconds", 120, 10, 600) * 1000,
    maxContinuations: intSetting("maxContinuations", 2, 0, 5),
    reasoningEffort:
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh"
        ? effort
        : "off",
  };
}

/** 一次发言的累计状态；放在对象里，上游中断/用户停止抛错时已生成的部分仍能落库 */
export interface LoopState {
  text: string;
  reasoning: string;
  rounds: ToolRound[];
  trace: ToolTraceEntry[];
  usageRecords: UsageRecord[];
  finishReason: "stop" | "length" | "tool_limit" | "aborted" | "error" | null;
  /** 当前还未登记成轮次的文本（中断时补成最后一轮） */
  pendingText: string;
}

export function newLoopState(): LoopState {
  return {
    text: "",
    reasoning: "",
    rounds: [],
    trace: [],
    usageRecords: [],
    finishReason: null,
    pendingText: "",
  };
}

export interface PersonaLoopInput {
  sessionId: string;
  member: ResolvedAgent & { kind: "builtin" };
  provider: Provider;
  turns: ChatTurn[];
  /** 暴露给模型的工具（内置 + MCP） */
  tools: ResolvedMcpTool[];
  /** 内置工具的实现（按模型侧名称） */
  specs: Map<string, ToolSpec>;
  sink: ChatSink;
  signal: AbortSignal;
  state: LoopState;
  settings: LoopSettings;
  capabilities?: ModelCapabilities;
  /** 上下文预算（token），用于工具循环内截短早期工具结果 */
  budget: number;
  /**
   * 按需工具集（toolLoading='auto'）：当前发言者的活动工具名。只把这些工具的定义发给模型；
   * tool_search 往里加，下一次上游请求即生效。未提供时发送全部 tools。
   */
  toolset?: Set<string>;
}

/** 上下文预算：窗口 − 预留输出 − 工具定义 − 10% 余量 */
export function contextBudget(
  caps: ModelCapabilities,
  toolsTokens: number,
): number {
  const reserve = Math.min(
    caps.maxOutput,
    Math.max(2048, Math.floor(caps.contextWindow * 0.15)),
  );
  return Math.max(
    1024,
    Math.floor((caps.contextWindow - reserve - toolsTokens) * 0.9),
  );
}

function parseArguments(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fenced(language: string, content: string): string {
  // 现有产物面板按 ``` 提取代码块：正文里的 ``` 需打断，避免提前闭合
  const safe = content.replace(/```/g, "``\u200b`");
  return `\n\n\`\`\`${language}\n${safe.replace(/\s+$/, "")}\n\`\`\`\n`;
}

/** 等待取消：MCP 调用本身不支持取消，用户停止时不再等它的结果 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new UpstreamError("aborted", "已取消"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new UpstreamError("aborted", "已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * persona Agent 的一次发言：模型流 → 工具调用（并行/审批）→ 再请求……直到模型给出最终回答。
 * - 工具轮数上限（agent.maxTurns，默认 90，0 不限）：70% / 90% 时在工具结果后附预算提醒；到上限后再发一轮
 *   tool_choice=none 的请求让模型总结进度（finishReason='tool_limit'）；
 * - 循环保护：同一工具 + 相同参数连续 3 次 → 拦截该调用并同样收尾；
 * - 截断（finish=length / 流中断）自动续写；只有推理没有正文时追问最终回答；完全空回复重试一次；
 * - 每次上游调用记一条 usage（上游未返回则估算）。
 * 用户停止时抛 UpstreamError('aborted')，state 里保留已生成内容。
 */
export async function runPersonaLoop(input: PersonaLoopInput): Promise<void> {
  const { member, provider, turns, tools, sink, signal, state, settings } =
    input;
  const caps =
    input.capabilities ?? capabilitiesFor(provider.model, provider);
  const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));
  // 每次上游请求前按活动集重新计算（tool_search 可能在上一轮加载了新工具）
  const currentOfferable = (): ResolvedMcpTool[] =>
    !caps.tools
      ? []
      : input.toolset
        ? tools.filter((tool) => input.toolset!.has(tool.name))
        : tools;
  let offerable = currentOfferable();
  let toolsTokens = estimateTools(offerable);

  let toolRoundsUsed = 0;
  let continuations = 0;
  let emptyRetries = 0;
  let toolLimitHit = false;
  const budgetSent = new Set<BudgetLevel>();
  const repeatGuard = new RepeatGuard();
  let purpose: UsagePurpose = "chat";
  // 图片只在请求时读文件内联（不写回 turns/历史）；同一次发言里每张只读一次
  const imageCache: ImageCache = new Map();

  const recordUsage = (
    usage: Usage | null,
    requestTurns: ChatTurn[],
    output: string,
    offered: boolean,
  ): void => {
    const estimated = !usage;
    const final = usage ?? {
      ...emptyUsage(),
      inputTokens: estimateTurns(requestTurns) + (offered ? toolsTokens : 0),
      outputTokens: estimateTokens(output),
    };
    try {
      state.usageRecords.push(
        usageService.record({
          provider,
          model: provider.model,
          usage: final,
          estimated,
          purpose,
          sessionId: input.sessionId,
          agentId: member.id,
        }),
      );
    } catch (error) {
      console.warn("[lulux-eta] usage record failed:", messageOf(error));
    }
  };

  while (true) {
    if (signal.aborted) throw new UpstreamError("aborted", "已取消");

    // 工具循环内上下文超预算：截短较早的工具结果（最近一轮保持完整）
    let lastCallTurn = -1;
    for (let k = turns.length - 1; k >= 0; k -= 1) {
      if (turns[k]!.role === "assistant" && turns[k]!.toolCalls?.length) {
        lastCallTurn = k;
        break;
      }
    }
    if (lastCallTurn > 0) {
      const shrunk = shrinkToolResults(
        turns,
        input.budget,
        toolsTokens,
        lastCallTurn,
      );
      if (shrunk > 0)
        sink.send("compaction", {
          agentId: member.id,
          kind: "tool_results",
          shrunk,
        });
    }

    offerable = currentOfferable();
    toolsTokens = estimateTools(offerable);
    const offerTools = offerable.length > 0;
    const requestTurns = sanitizeToolPairing(turns);
    const upstreamTurns = await inlineTurnImages(
      requestTurns,
      input.sessionId,
      caps,
      imageCache,
    );
    let roundText = "";
    let roundReasoning = "";
    let calls: ToolCall[] = [];
    let blocks: ReasoningBlock[] = [];
    let finish: FinishReason | null = null;
    let usage: Usage | null = null;
    let interrupted = false;

    try {
      const stream = streamResilient(
        provider.kind,
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: upstreamTurns,
          tools: offerTools ? offerable : undefined,
          toolChoice: offerTools && toolLimitHit ? "none" : undefined,
          reasoningEffort: settings.reasoningEffort,
          capabilities: caps,
          signal,
        },
        {
          maxRetries: settings.maxRetries,
          timeoutMs: settings.timeoutMs,
          onRetry: (info) =>
            sink.send("retry", {
              agentId: member.id,
              attempt: info.attempt,
              maxRetries: info.maxRetries,
              delayMs: info.delayMs,
              code: info.error.code,
              status: info.error.status,
              message: info.error.message.slice(0, 300),
            }),
          onDowngrade: (what, error) =>
            sink.send("downgrade", {
              agentId: member.id,
              what,
              model: provider.model,
              message: error.message.slice(0, 300),
            }),
        },
      );
      for await (const event of stream) {
        if (event.type === "text") {
          roundText += event.text;
          state.text += event.text;
          state.pendingText += event.text;
          sink.send("delta", { text: event.text, agentId: member.id });
        } else if (event.type === "reasoning") {
          roundReasoning += event.text;
          state.reasoning += event.text;
          sink.send("reasoning", { text: event.text, agentId: member.id });
        } else if (event.type === "reasoning_blocks") {
          blocks = event.blocks;
        } else if (event.type === "tool_calls") {
          calls = event.calls;
        } else if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "finish") {
          finish = event.reason;
        }
      }
    } catch (raw) {
      const error = toUpstreamError(raw);
      if (signal.aborted || error.kind === "aborted") {
        recordUsage(null, requestTurns, roundText + roundReasoning, offerTools);
        throw new UpstreamError("aborted", "已取消");
      }
      // 已输出一部分后连接中断：当作截断，用续写补救
      if (
        roundText.trim() &&
        error.retryable &&
        continuations < settings.maxContinuations
      ) {
        interrupted = true;
        calls = [];
      } else {
        recordUsage(
          usage,
          requestTurns,
          roundText + roundReasoning,
          offerTools,
        );
        throw error;
      }
    }
    recordUsage(
      usage,
      requestTurns,
      roundText + roundReasoning + calls.map((c) => c.arguments).join(""),
      offerTools,
    );

    // 声明了 tool_choice=none 仍返回调用的（个别兼容接口）：忽略
    if (toolLimitHit || !offerTools) calls = [];

    if (calls.length === 0) {
      const truncated = finish === "length" || interrupted;
      const noText = !state.pendingText.trim();
      if (
        (truncated || (noText && roundReasoning.trim())) &&
        continuations < settings.maxContinuations
      ) {
        continuations += 1;
        purpose = "continuation";
        sink.send("continuation", {
          agentId: member.id,
          reason: interrupted
            ? "interrupted"
            : truncated
              ? "length"
              : "reasoning_only",
          attempt: continuations,
        });
        if (roundText) turns.push({ role: "assistant", content: roundText });
        turns.push({
          role: "user",
          content: noText ? FINAL_ANSWER_PROMPT : CONTINUE_PROMPT,
        });
        continue;
      }
      if (
        noText &&
        !roundReasoning.trim() &&
        emptyRetries < 1 &&
        state.trace.length === 0
      ) {
        emptyRetries += 1;
        sink.send("retry", {
          agentId: member.id,
          attempt: 1,
          maxRetries: 1,
          delayMs: 0,
          code: "EMPTY_REPLY",
          status: null,
          message: "模型返回了空回复，正在重试",
        });
        continue;
      }
      state.rounds.push({ text: state.pendingText, calls: [], results: [] });
      state.pendingText = "";
      state.finishReason = toolLimitHit
        ? "tool_limit"
        : truncated
          ? "length"
          : "stop";
      return;
    }

    // —— 工具调用 ——
    const round: ToolRound = { text: state.pendingText, calls, results: [] };
    state.pendingText = "";
    state.rounds.push(round);
    turns.push({
      role: "assistant",
      content: roundText,
      toolCalls: calls,
      reasoning: roundReasoning || undefined,
      reasoningBlocks: blocks.length > 0 ? blocks : undefined,
    });

    // 循环保护：同一工具 + 相同参数连续第 3 次不再执行，直接告诉模型并收尾
    const blocked = new Set<ToolCall>();
    for (const call of calls) if (repeatGuard.observe(call)) blocked.add(call);
    const runnable = calls.filter((call) => !blocked.has(call));
    const executed =
      runnable.length > 0
        ? await executeToolCalls(input, runnable, toolIndex)
        : [];
    const outcomes = new Map<ToolCall, string>(
      runnable.map((call, i) => [call, executed[i]!]),
    );
    for (const call of blocked) {
      const content = repeatBlockedResult(
        toolIndex.get(call.name)?.originalName ?? call.name,
      );
      outcomes.set(call, content);
      state.trace.push({
        id: newId("tool"),
        name: toolIndex.get(call.name)?.originalName ?? call.name,
        server: toolIndex.get(call.name)?.serverName ?? "未知服务",
        arguments: call.arguments || "{}",
        ok: false,
        approved: true,
        result: content,
        durationMs: 0,
        createdAt: Date.now(),
      });
    }
    const toolTurnStart = turns.length;
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const content = outcomes.get(call)!;
      round.results.push({
        toolCallId: call.id,
        toolName: call.name,
        content: content.slice(0, ROUND_RESULT_LIMIT),
      });
      turns.push({
        role: "tool",
        content,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    if (signal.aborted) throw new UpstreamError("aborted", "已取消");

    toolRoundsUsed += 1;
    if (blocked.size > 0) {
      // 停用工具，再请求一次（tool_choice=none）让模型总结
      toolLimitHit = true;
      sink.send("tool_limit", {
        agentId: member.id,
        reason: "loop_guard",
        tool:
          toolIndex.get([...blocked][0]!.name)?.originalName ??
          [...blocked][0]!.name,
        repeats: REPEAT_LIMIT,
        used: toolRoundsUsed,
        maxTurns: settings.maxTurns,
        maxToolRounds: settings.maxTurns,
      });
      turns.push({ role: "user", content: LOOP_GUARD_PROMPT });
    } else if (settings.maxTurns > 0 && toolRoundsUsed >= settings.maxTurns) {
      toolLimitHit = true;
      sink.send("tool_limit", {
        agentId: member.id,
        reason: "max_turns",
        used: toolRoundsUsed,
        maxTurns: settings.maxTurns,
        // 旧客户端读的字段
        maxToolRounds: settings.maxTurns,
      });
      turns.push({ role: "user", content: TOOL_LIMIT_PROMPT });
    } else if (settings.budgetPressure) {
      // 预算提醒附在本轮最后一条工具结果后（不插入额外的 user 消息，保持工具配对与角色交替）
      const level = budgetPressure(
        toolRoundsUsed,
        settings.maxTurns,
        budgetSent,
      );
      const last = turns[turns.length - 1];
      if (
        level &&
        last &&
        turns.length > toolTurnStart &&
        last.role === "tool"
      ) {
        budgetSent.add(level);
        if (level === "warning") budgetSent.add("caution");
        const note = budgetPressureText(
          level,
          toolRoundsUsed,
          settings.maxTurns,
        );
        last.content = `${last.content}\n\n${note}`;
        sink.send("budget", {
          agentId: member.id,
          level,
          used: toolRoundsUsed,
          maxTurns: settings.maxTurns,
        });
      }
    }
  }
}

/** 执行一轮里的全部工具调用；返回与 calls 同序的结果文本 */
async function executeToolCalls(
  input: PersonaLoopInput,
  calls: ToolCall[],
  toolIndex: Map<string, ResolvedMcpTool>,
): Promise<string[]> {
  const { member, sink, signal, state, settings } = input;
  // 轨迹按模型给出的调用顺序登记（并行执行时完成顺序不定）
  const entries = new Map<ToolCall, ToolTraceEntry>();
  const flushTrace = (): void => {
    for (const call of calls) {
      const entry = entries.get(call);
      if (entry) state.trace.push(entry);
    }
  };

  const runOne = async (call: ToolCall): Promise<string> => {
    const resolved = toolIndex.get(call.name);
    const spec =
      resolved?.serverId === "builtin" ? input.specs.get(call.name) : undefined;
    const risk: "read" | "write" = spec ? spec.risk : "write";
    const requestId = newId("tool");
    const createdAt = Date.now();
    const rawArguments = call.arguments || "{}";
    let approved = true;
    let ok = false;
    let resultText = "";
    let serverName = "未知服务";
    let displayName = call.name;
    const startedAt = Date.now();

    const hiddenSpec = resolved ? undefined : findTool(call.name);
    // 记忆工具：非交互运行 / 多人群聊里不提供；模型硬要调用（或工具列表是旧的）时明确拒绝
    const memoryRefusal = (spec ?? hiddenSpec)?.personal
      ? memoryToolsBlocked(input.sessionId) ??
        (effectiveSessionLevel(input.sessionId) === "read"
          ? READ_ONLY_REFUSAL
          : null)
      : null;
    // 账号生效权限（角色默认值 ± 管理员的覆盖项）：缺少时不弹审批、直接拒绝
    const permissionRefusal = spec ? toolPermissionDenial(spec) : null;
    if (memoryRefusal) {
      serverName = BUILTIN_SERVER;
      resultText = memoryRefusal;
    } else if (permissionRefusal && resolved) {
      serverName = resolved.serverName;
      displayName = resolved.originalName;
      resultText = permissionRefusal;
    } else if (
      hiddenSpec &&
      !isNonInteractive(input.sessionId) &&
      toolGate(effectiveSessionLevel(input.sessionId), {
        risk: hiddenSpec.risk,
        approval: hiddenSpec.approval,
        orgLevel: hiddenSpec.orgLevel,
        personal: hiddenSpec.personal,
      }) === "hidden"
    ) {
      // “仅可查看”时写工具没有提供给模型；模型硬要调用时给出明确原因（不弹卡片，轨迹记在 LULUX 名下）
      serverName = BUILTIN_SERVER;
      resultText = READ_ONLY_REFUSAL;
    } else if (!resolved) {
      resultText = `未知工具：${call.name}`;
    } else {
      serverName = resolved.serverName;
      displayName = resolved.originalName;
      const args = parseArguments(rawArguments);
      // “本会话始终允许”的粒度：默认工具名；skill 脚本按 skill 记忆；MCP 增删改不可记忆
      const toolKey =
        spec?.rememberKey && args ? spec.rememberKey(args) : call.name;
      const canRemember = !spec?.noRemember;
      const remembered =
        canRemember && isAllowedForSession(input.sessionId, toolKey);
      // 会话权限级别（契约 §6.11）：每次调用重新取，运行中切换级别对之后的调用生效
      const gate = toolGate(effectiveSessionLevel(input.sessionId), {
        risk,
        approval: spec?.approval,
        orgLevel: spec?.orgLevel,
        personal: spec?.personal,
      });
      const nonInteractive = isNonInteractive(input.sessionId);
      // 非交互运行（工作流 / 定时任务）：写工具一律经审批通道，由 allowWrite 自动答复
      const needsApproval =
        risk === "write" &&
        spec?.approval !== "never" &&
        (nonInteractive || (gate === "ask" && !remembered));
      const refused = gate === "hidden" && !nonInteractive;
      let detail: unknown = null;
      if (spec?.approvalDetail) {
        // 有审批详情的工具：参数不合法时也给出说明，审批卡片不留空
        if (!args)
          detail = {
            invalid: true,
            errors: ["参数不是合法的 JSON 对象"],
            arguments: {},
          };
        else {
          try {
            detail = spec.approvalDetail(args) ?? {
              invalid: true,
              errors: ["参数不合法"],
              arguments: {},
            };
          } catch (error) {
            detail = {
              invalid: true,
              errors: [error instanceof Error ? error.message : String(error)],
              arguments: {},
            };
          }
        }
      }
      sink.send("tool_request", {
        requestId,
        agentId: member.id,
        name: resolved.originalName,
        server: resolved.serverName,
        arguments: rawArguments,
        auto: !needsApproval,
        builtin: Boolean(spec),
        risk,
        toolCallId: call.id,
        approvalKind: spec?.approvalKind ?? "tool",
        detail,
        canRemember,
        toolKey,
      });
      if (refused) {
        approved = false;
      } else if (needsApproval) {
        approved = await waitForApproval(
          requestId,
          signal,
          approvalTimeoutMs(),
          {
            sessionId: input.sessionId,
            agentId: member.id,
            name: resolved.originalName,
            server: resolved.serverName,
            arguments: rawArguments,
            risk,
            builtin: Boolean(spec),
            toolKey,
            approvalKind: spec?.approvalKind ?? "tool",
            detail,
            canRemember,
          },
        );
      }
      if (!approved) {
        resultText = refused
          ? READ_ONLY_REFUSAL
          : signal.aborted
            ? "用户停止了对话，工具未执行。"
            : "用户拒绝了这次工具调用。";
      } else {
        if (!args) {
          resultText = `工具参数不是合法的 JSON（可能因输出长度被截断）：${rawArguments.slice(0, 200)}`;
        } else if (spec) {
          const outcome = await runTool(spec, args, {
            sessionId: input.sessionId,
            agentId: member.id,
            signal,
            addArtifact: (artifact: ToolArtifact, content: string) => {
              const block = fenced(artifact.language, content);
              state.text += block;
              sink.send("artifact", { agentId: member.id, artifact });
              sink.send("delta", { text: block, agentId: member.id });
            },
            loadTools: (names: string[]) => {
              const set = input.toolset;
              if (!set) return [];
              const added = names.filter(
                (name) => toolIndex.has(name) && !set.has(name),
              );
              for (const name of added) set.add(name);
              return added;
            },
            emitFile: (file: ToolFile) => {
              const ext = file.path.includes(".")
                ? file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase()
                : "bin";
              sink.send("artifact", {
                agentId: member.id,
                artifact: {
                  id: newId("art"),
                  title: file.title,
                  language: ext,
                  filename: file.title,
                  path: file.path,
                  size: file.size,
                  binary: true,
                  mime: file.mime,
                  downloadUrl: `/api/chat/sessions/${encodeURIComponent(input.sessionId)}/files?path=${encodeURIComponent(file.path)}`,
                },
              });
            },
          });
          ok = outcome.ok;
          resultText = outcome.text;
        } else {
          try {
            const result = await raceAbort(
              mcpRuntime.call(call.name, args, signal),
              signal,
            );
            ok = result.ok;
            resultText = result.text;
          } catch (error) {
            resultText = signal.aborted
              ? "已取消。"
              : `工具执行失败：${messageOf(error)}`;
          }
        }
      }
    }

    const durationMs = resolved ? Date.now() - startedAt : 0;
    const entry: ToolTraceEntry = {
      id: requestId,
      name: displayName,
      server: serverName,
      arguments: rawArguments,
      ok,
      approved,
      result: resultText.slice(0, TRACE_RESULT_LIMIT),
      durationMs,
      createdAt,
      builtin: Boolean(spec),
      risk,
    };
    entries.set(call, entry);
    sink.send("tool_result", {
      requestId,
      agentId: member.id,
      name: displayName,
      server: serverName,
      ok,
      approved,
      result: resultText.slice(0, TRACE_RESULT_LIMIT),
      durationMs,
      builtin: Boolean(spec),
      risk,
      toolCallId: call.id,
    });
    return resultText;
  };

  const isRead = (call: ToolCall): boolean => {
    const resolved = toolIndex.get(call.name);
    return (
      resolved?.serverId === "builtin" &&
      input.specs.get(call.name)?.risk === "read"
    );
  };
  // 同一轮里只要有写工具（或 MCP 等可能有副作用的工具），全部按模型给出的顺序串行执行：
  // 否则“改了再查”时并行的读工具可能先于写工具完成，读到旧数据
  if (
    !settings.parallelToolCalls ||
    calls.length === 1 ||
    !calls.every(isRead)
  ) {
    const out: string[] = [];
    for (const call of calls)
      out.push(
        signal.aborted ? "用户停止了对话，工具未执行。" : await runOne(call),
      );
    flushTrace();
    return out;
  }

  // 全是只读工具：并发执行
  const results = await mapLimit(calls, READ_CONCURRENCY, async (call) =>
    signal.aborted ? "用户停止了对话，工具未执行。" : await runOne(call),
  );
  flushTrace();
  return results;
}

export { BUILTIN_SERVER };
