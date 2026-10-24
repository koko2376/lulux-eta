import { AppError, messageOf, notFound } from "../../errors.js";
import type {
  ChatTurn,
  HistoryMessage,
  Message,
  MessageAttachment,
  MessageRuntime,
  Provider,
  ToolTraceEntry,
} from "../../types.js";
import { agentService, type ResolvedAgent } from "../agent-service.js";
import { customerService } from "../customer-service.js";
import { runKernel } from "../kernels/kernel-runner.js";
import { kernelService } from "../kernels/kernel-service.js";
import {
  kernelMode,
  resolveScopedProvider,
  SCOPED_UNAVAILABLE_REASON,
} from "../kernels/scoped.js";
import { capabilitiesFor } from "../llm/capabilities.js";
import { completeText } from "../llm/complete.js";
import { toUpstreamError, UpstreamError } from "../llm/errors.js";
import { estimateTools, estimateTurns } from "../llm/tokens.js";
import { usageService } from "../llm/usage-service.js";
import { mcpRuntime, type ResolvedMcpTool } from "../mcp/runtime.js";
import { providerService } from "../provider-service.js";
import { quoteService } from "../quote-service.js";
import { sessionService } from "../session-service.js";
import {
  effectiveBuiltinEffort,
  effectiveGatewayEffort,
  withSessionModel,
} from "../models/catalog.js";
import type { EffortLevel } from "../models/effort.js";
import { settingsService } from "../settings-service.js";
import { BUILTIN_SERVER, listTools, type ToolSpec } from "../tools/registry.js";
import {
  buildToolSearch,
  selectInitialTools,
  toolLoadingMode,
} from "../tools/toolsets.js";
import { builtinToolsEnabled } from "./builtin-tools.js";
import { isNonInteractive } from "../tool-approval.js";
import {
  effectiveSessionLevel,
  toolGate,
  type GatedTool,
} from "../permissions.js";
import { webhookService } from "../webhook-service.js";
import {
  applyStoredSummary,
  planCompaction,
  renderTranscript,
  SUMMARY_SYSTEM_PROMPT,
  summaryStore,
  summaryTokens,
} from "./compaction.js";
import { businessContext, dateLine } from "./context-builder.js";
import {
  buildKernelPrompt,
  buildTurns,
  turnsForMessage,
  type SystemPromptExtras,
} from "./history.js";
import {
  attachmentAbsolutePaths,
  limitImages,
  MAX_IMAGE_MESSAGES,
  stripAllImages,
} from "./vision.js";
import { initialSpeakers, maxSpeaks, parseMentions } from "./mentions.js";
import {
  dispatchToolSpec,
  memberInstructions,
  parseDispatchText,
  planInstructions,
  summaryInstructions,
  SUPERVISOR_NONE,
  type DispatchPlan,
} from "./supervisor.js";
import { decorateMembers, memberIdentityPrompt } from "./group-members.js";
import { BUILTIN_AGENT_ID } from "../../agents.js";
import {
  contextBudget,
  loopSettings,
  newLoopState,
  runPersonaLoop,
  type ChatSink,
  type LoopState,
} from "./persona-loop.js";
import {
  INTERRUPTED_FINISH_REASON,
  startRun,
  STREAMING_FINISH_REASON,
  type ChatRun,
} from "./run-registry.js";
import { DEFAULT_MAX_TURNS } from "./turn-budget.js";
import { maybeGenerateTitle } from "./title.js";
import { memoryService } from "../memory/memory-service.js";
import { memoryPromptBlock } from "../memory/tools.js";
import { scheduleMemoryExtraction } from "../memory/extractor.js";
import {
  memoryToolsBlocked,
  sessionMemorySnapshot,
} from "../memory/session-policy.js";
import { preloadSkills, skillIndexFor } from "../skills/runtime.js";

export type { ChatSink } from "./persona-loop.js";

/** 草稿落库节流间隔（ms） */
const DRAFT_FLUSH_MS = 800;
/** 会改变发言内容的事件：触发草稿落库 */
const DRAFT_EVENTS = new Set([
  "delta",
  "reasoning",
  "tool_request",
  "tool_result",
]);

/** 兼容旧引用：默认的工具轮数上限（实际取设置 agent.maxTurns，0 = 不限制） */
export const MAX_TOOL_ROUNDS = DEFAULT_MAX_TURNS;

export interface PreparedChat {
  sessionId: string;
  sessionTitle: string;
  groupName: string | null;
  /** 会话是否群聊（看 session.kind，而不是成员数） */
  group: boolean;
  /** 内置内核成员用的 Provider（已叠加会话模型，契约 §6.13） */
  provider: Provider | null;
  /** scoped CLI 内核用的 Provider：单聊同 provider；群聊里会话模型只作用于 LULUX 内置成员，这里是 Provider 的默认模型 */
  kernelProvider: Provider | null;
  /** 会话推理强度（null = 默认） */
  reasoningEffort: EffortLevel | null;
  /** 单聊的 global CLI 内核：会话选的 CLI 模型（null = CLI 默认） */
  cliModel: string | null;
  members: ResolvedAgent[];
  /** 本轮可以发言的成员（不可用的成员跳过并提示） */
  available: ResolvedAgent[];
  unavailable: ResolvedAgent[];
  /** 群聊主管（单聊 / 无主管 / 主管不可用时为 null）；可以是成员，也可以是不在群里的 LULUX */
  supervisor: ResolvedAgent | null;
  /** 发言前要告诉用户的提示（主管不可用等） */
  notices: SupervisorNotice[];
  contextLimit: number;
}

export interface SupervisorNotice {
  kind: "unavailable" | "supervisor_unavailable";
  agentId: string;
  name: string;
  reason: string;
}

export interface BusinessContextInput {
  customerId?: string | null;
  quoteId?: string | null;
}

/** 一次对话请求：新消息 / 重新生成 / 编辑后重发 */
export interface RunInput {
  /** 本轮的用户消息内容（重新生成时为被重新回答的那条） */
  content: string;
  /** 是否新增一条用户消息 */
  appendUser: boolean;
  /** 分支截断：从这条消息开始（inclusive）或之后删除 */
  truncate?: { messageId: string; inclusive: boolean };
  /** 指定发言的 Agent（群聊） */
  targetAgentIds?: string[];
  /** 绑定/更新会话的业务上下文 */
  context?: BusinessContextInput;
  /** 新用户消息的图片附件（已由路由校验；只在 appendUser 时使用） */
  attachments?: MessageAttachment[];
  mode: "send" | "regenerate" | "edit";
}

function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof UpstreamError) return error.code;
  return "CHAT_FAILED";
}

function isScopedKernel(member: ResolvedAgent): boolean {
  return member.kind === "kernel" && kernelMode(member.kernelId) === "scoped";
}

function runtimeOf(
  member: ResolvedAgent,
  provider: Provider | null,
): MessageRuntime {
  if (member.kind === "kernel") {
    const version = kernelService.installedVersion(member.kernelId);
    const head = `${member.kernelName ?? member.name}${version ? ` ${version}` : ""}`;
    if (isScopedKernel(member) && provider) {
      return {
        kind: "kernel",
        kernelId: member.kernelId,
        version,
        mode: "scoped",
        providerName: provider.name,
        model: provider.model,
        label: `${head} · 经由 ${provider.name}/${provider.model}`,
      };
    }
    return {
      kind: "kernel",
      kernelId: member.kernelId,
      version,
      mode: "global",
      providerName: null,
      model: null,
      label: head,
    };
  }
  return {
    kind: "provider",
    providerName: provider?.name ?? "",
    model: provider?.model ?? "",
  };
}

/** 校验业务上下文里的客户/报价对当前用户可见（不可见按 404 处理，不泄露存在性） */
export function validateBusinessContext(
  input: BusinessContextInput | undefined,
): { customerId: string | null; quoteId: string | null } | null {
  if (!input) return null;
  const customerId = input.customerId ?? null;
  const quoteId = input.quoteId ?? null;
  if (customerId && !customerService.get(customerId)) throw notFound("客户");
  if (quoteId && !quoteService.get(quoteId)) throw notFound("报价单");
  return { customerId, quoteId };
}

/**
 * 聊天编排：选择 Provider、决定发言顺序（@ / 指定 / 全体）、上下文构建与压缩、
 * persona 的 agent 循环（persona-loop.ts）、内核运行、持久化、usage 与 Webhook。
 * 不感知 HTTP；路由层负责参数校验与把事件写成 SSE。
 */
export class ChatOrchestrator {
  /** 测试用：最近一次后台标题生成任务 */
  lastTitleJob: Promise<string | null> | null = null;

  /** 发言前的全部校验，失败直接抛 AppError（此时还没有打开 SSE） */
  prepare(sessionId: string): PreparedChat {
    const session = sessionService.visible(sessionId);
    if (!session) throw notFound("会话");
    if (!sessionService.writable(session.id))
      throw new AppError(403, "FORBIDDEN", "只能在自己的会话里发消息");

    const found = sessionService
      .members(session.id)
      .map((id) => agentService.find(id))
      .filter((agent): agent is ResolvedAgent => Boolean(agent));
    // 群聊：同一内核可多次进群，名字后跟群头衔（「Claude Code（跟单员）」），并带各自的职责 / 模型
    const members =
      session.kind === "group"
        ? decorateMembers(found, session.memberProfiles)
        : found;
    if (members.length === 0)
      throw new AppError(400, "NO_AGENT", "会话没有可用的 Agent");

    // scoped 内核的“未配置模型”按会话自己的 Provider 再判断一次
    const usable = (member: ResolvedAgent): boolean =>
      member.available ||
      (member.kind === "kernel" &&
        member.unavailableReason === SCOPED_UNAVAILABLE_REASON &&
        Boolean(resolveScopedProvider(session.providerId)));
    const available = members.filter(usable);
    const unavailable = members.filter((member) => !usable(member));
    // 群聊里不可用的成员跳过（发言时给出提示）；全部不可用才拒绝
    if (available.length === 0) {
      const first = unavailable[0]!;
      throw new AppError(
        409,
        "KERNEL_UNAVAILABLE",
        `「${first.name}」暂不可用：${first.unavailableReason ?? "未知原因"}`,
      );
    }

    // 群聊主管：默认 LULUX；'none' = 旧行为；选中的成员不可用 / 已不在群里时退回内置
    const notices: SupervisorNotice[] = [];
    let supervisor: ResolvedAgent | null = null;
    if (session.kind === "group" && session.supervisorId !== SUPERVISOR_NONE) {
      const chosen =
        session.supervisorId !== BUILTIN_AGENT_ID
          ? members.find((member) => member.id === session.supervisorId)
          : undefined;
      if (chosen && usable(chosen)) supervisor = chosen;
      else {
        if (chosen)
          notices.push({
            kind: "supervisor_unavailable",
            agentId: chosen.id,
            name: chosen.name,
            reason: chosen.unavailableReason ?? "未知原因",
          });
        supervisor =
          members.find((member) => member.id === BUILTIN_AGENT_ID) ??
          agentService.find(BUILTIN_AGENT_ID) ??
          null;
      }
    }

    const membersNeedProvider = available.some(
      (member) => member.kind === "builtin" || isScopedKernel(member),
    );
    const supervisorNeedsProvider = Boolean(
      supervisor &&
      (supervisor.kind === "builtin" || isScopedKernel(supervisor)),
    );
    let provider: Provider | null = null;
    if (membersNeedProvider || supervisorNeedsProvider) {
      const defaultProviderId = settingsService.get("defaultProviderId");
      const candidate =
        (session.providerId
          ? providerService.get(session.providerId)
          : undefined) ??
        (defaultProviderId
          ? providerService.get(defaultProviderId)
          : undefined) ??
        providerService.list()[0] ??
        null;
      let problem: AppError | null = null;
      if (!candidate)
        problem = new AppError(
          400,
          "NO_PROVIDER",
          "请先在设置中添加一个模型 Provider",
        );
      else if (!candidate.model) {
        problem = new AppError(
          400,
          "NO_MODEL",
          `Provider「${candidate.name}」还没有选择模型，请到设置中完成配置`,
        );
      } else if (candidate.apiKeyError) {
        problem = new AppError(
          409,
          "API_KEY_UNAVAILABLE",
          `Provider「${candidate.name}」的 ${candidate.apiKeyError}`,
        );
      }
      if (problem && membersNeedProvider) throw problem;
      if (problem) {
        // 只有主管需要模型（成员都是 global 内核）：不启用主管，按旧行为发言
        notices.push({
          kind: "supervisor_unavailable",
          agentId: supervisor!.id,
          name: supervisor!.name,
          reason: problem.message,
        });
        supervisor = null;
      } else provider = candidate;
    }
    const baseProvider = provider;
    if (provider) provider = withSessionModel(provider, session.model);
    const single = session.kind !== "group";
    const primary = members[0];
    const cliModel =
      single && primary?.kind === "kernel" && !isScopedKernel(primary)
        ? session.model
        : null;

    const parsedLimit = Number.parseInt(
      settingsService.get("contextLimit") ?? "",
      10,
    );
    const contextLimit = Number.isFinite(parsedLimit)
      ? Math.min(200, Math.max(2, parsedLimit))
      : 40;

    return {
      sessionId: session.id,
      sessionTitle: session.title,
      groupName: session.groupName,
      group: session.kind === "group",
      provider,
      kernelProvider: single ? provider : baseProvider,
      reasoningEffort: session.reasoningEffort,
      cliModel,
      members,
      available,
      unavailable,
      supervisor,
      notices,
      contextLimit,
    };
  }

  /** 重新生成的锚点：给定助手消息 → 它之前最近的用户消息；给定用户消息 → 它本身；缺省 → 最后一条用户消息 */
  resolveRegenerate(
    prepared: PreparedChat,
    messageId?: string,
  ): { userMessage: Message } {
    const messages = sessionService.messages(prepared.sessionId);
    let index = messages.length - 1;
    if (messageId) {
      index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) throw new AppError(404, "MESSAGE_NOT_FOUND", "消息不存在");
    }
    for (let i = index; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") return { userMessage: messages[i]! };
    }
    throw new AppError(
      400,
      "NOTHING_TO_REGENERATE",
      "没有可以重新生成的用户消息",
    );
  }

  resolveEdit(
    prepared: PreparedChat,
    messageId: string,
  ): { userMessage: Message } {
    const message = sessionService.message(prepared.sessionId, messageId);
    if (!message) throw new AppError(404, "MESSAGE_NOT_FOUND", "消息不存在");
    if (message.role !== "user")
      throw new AppError(400, "NOT_USER_MESSAGE", "只能编辑用户消息");
    return { userMessage: message };
  }

  /**
   * 执行一次对话。run 省略时（定时任务 / 工作流等内部调用）自建一个运行并占用会话，
   * external 中止视为调用方取消；路由层先 startRun()（409 在打开 SSE 之前返回）再把 run 传进来，
   * 这时运行与 HTTP 响应无关，只能显式取消（契约 §6.9）。
   * 兼容旧签名：run(prepared, content, sink, signal) 等同于发送新消息。
   */
  async run(
    prepared: PreparedChat,
    input: string | RunInput,
    sink: ChatSink,
    external?: AbortSignal,
    managed?: ChatRun,
  ): Promise<void> {
    const request: RunInput =
      typeof input === "string"
        ? { content: input, appendUser: true, mode: "send" }
        : input;
    const run = managed ?? startRun(prepared.sessionId, "internal");
    const onExternal = (): void => void run.cancel("disconnected");
    if (external?.aborted) onExternal();
    else external?.addEventListener("abort", onExternal, { once: true });
    const tee: ChatSink = {
      send: (event, payload) => {
        run.emit(event, payload);
        sink.send(event, payload);
      },
    };
    const signal = run.signal;
    try {
      await this.execute(prepared, request, tee, signal);
    } catch (error) {
      console.error("[lulux-eta] chat failed", error);
      tee.send("error", { code: "INTERNAL_ERROR", message: "对话处理失败" });
      if (!managed) throw error;
    } finally {
      external?.removeEventListener("abort", onExternal);
      if (signal.aborted && run.reason === "user")
        tee.send("stopped", { sessionId: prepared.sessionId, reason: "user" });
      run.finish();
    }
  }

  private async execute(
    prepared: PreparedChat,
    request: RunInput,
    sink: ChatSink,
    signal: AbortSignal,
  ): Promise<void> {
    const { members, available, provider, sessionId, supervisor } = prepared;
    const group = prepared.group;

    if (request.truncate)
      sessionService.truncateFrom(
        sessionId,
        request.truncate.messageId,
        request.truncate.inclusive,
      );
    const validated = validateBusinessContext(request.context);
    if (validated) sessionService.setKernelContext(sessionId, validated);
    if (request.appendUser)
      sessionService.addMessage(sessionId, "user", request.content, {
        attachments: request.attachments,
      });

    const needsTools =
      available.some((member) => member.kind === "builtin") ||
      supervisor?.kind === "builtin";
    const mcpTools = needsTools
      ? await mcpRuntime.toolDefinitions().catch((error) => {
          console.warn("[lulux-eta] MCP tools unavailable:", messageOf(error));
          return [] as ResolvedMcpTool[];
        })
      : [];
    // 会话权限级别（契约 §6.11）：“仅可查看”时写 / 执行类工具根本不提供给模型（非交互运行除外，仍由 allowWrite 答复）
    const permissionLevel = effectiveSessionLevel(sessionId);
    // 记忆工具（personal）另有限制：非交互运行、多人群聊里一律不提供
    const memoryBlocked = memoryToolsBlocked(sessionId);
    const offer = (tool: GatedTool): boolean =>
      tool.personal
        ? !memoryBlocked && toolGate(permissionLevel, tool) !== "hidden"
        : isNonInteractive(sessionId) ||
          toolGate(permissionLevel, tool) !== "hidden";
    // 内置工具（业务 + 通用，同一注册表）与 MCP 工具一起提供给模型
    const specs = new Map<string, ToolSpec>();
    const builtin: ResolvedMcpTool[] = [];
    // 电脑操作只能靠看截图：当前模型不支持看图时不提供 computer_* 工具（docs/computer-use.md）
    const visionModel = provider
      ? capabilitiesFor(provider.model, provider).vision
      : false;
    if (needsTools) {
      for (const spec of listTools()) {
        if (!offer(spec)) continue;
        if (spec.group === "computer" && !visionModel) continue;
        specs.set(spec.name, spec);
        builtin.push({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
          serverId: "builtin",
          serverName: BUILTIN_SERVER,
          originalName: spec.name,
        });
      }
    }
    const allTools = [
      ...mcpTools.filter(() => offer({ risk: "write" })),
      ...builtin,
    ];
    const names = new Map(members.map((agent) => [agent.id, agent.name]));
    const nameOf = (id: string): string | undefined =>
      names.get(id) ?? agentService.find(id)?.name;
    const caps = provider
      ? capabilitiesFor(provider.model, provider)
      : null;
    // 按需工具集（toolLoading='auto'）：加一个 tool_search 元工具；每个发言者只先拿到核心 + 意图命中的工具
    const dynamicTools =
      needsTools &&
      Boolean(caps?.tools) &&
      allTools.length > 0 &&
      toolLoadingMode() === "auto";
    if (dynamicTools) {
      const descriptions = new Map(
        allTools.map((tool) => [tool.name, tool.description ?? ""]),
      );
      const search = buildToolSearch(
        allTools,
        (name) => descriptions.get(name) ?? "",
      );
      specs.set(search.name, search);
      allTools.push({
        name: search.name,
        description: search.description,
        inputSchema: search.inputSchema,
        serverId: "builtin",
        serverName: BUILTIN_SERVER,
        originalName: search.name,
      });
    }
    const exposedTools = caps?.tools ? allTools : [];
    const historyToolNames = (): Set<string> => {
      const used = new Set<string>();
      for (const message of sessionService.recentHistory(
        sessionId,
        prepared.contextLimit,
      )) {
        for (const round of message.toolRounds ?? [])
          for (const call of round.calls) used.add(call.name);
      }
      return used;
    };

    // 发言顺序：显式指定 / @ 优先；否则有主管时主管先规划，没有主管时全体按顺序
    const initial = initialSpeakers(
      available,
      request.content,
      request.targetAgentIds,
    );
    const explicit = initial.mode !== "all";
    // 主管不能派发自己；只能派发可用成员（没有可派发的成员时不规划，按旧行为发言）
    const candidates = supervisor
      ? available.filter((member) => member.id !== supervisor.id)
      : [];
    const planning = Boolean(supervisor) && !explicit && candidates.length > 0;
    const speakMode = planning ? "supervised" : initial.mode;
    const queue: ResolvedAgent[] = planning ? [] : [...initial.order];

    sink.send("start", {
      sessionId,
      group,
      provider: provider
        ? { id: provider.id, name: provider.name, model: provider.model }
        : null,
      members: members.map((agent) => ({
        id: agent.id,
        name: agent.name,
        kernelName: agent.kernelName ?? agent.name,
        memberRole: agent.role ?? null,
        avatar: agent.avatar,
        kind: agent.kind,
        runtime: runtimeOf(agent, agent.kind === "kernel" ? prepared.kernelProvider : provider),
      })),
      tools: exposedTools.map((tool) => ({
        name: tool.name,
        server: tool.serverName,
        description: tool.description,
        builtin: tool.serverId === "builtin",
        risk:
          tool.serverId === "builtin"
            ? (specs.get(tool.name)?.risk ?? "write")
            : "write",
      })),
      mode: request.mode,
      permissionLevel,
      speakers: planning ? [supervisor!.id] : queue.map((agent) => agent.id),
      speakMode,
      supervisorId: supervisor?.id ?? null,
      capabilities: caps,
    });
    for (const member of prepared.unavailable) {
      if (group)
        sink.send("notice", {
          kind: "unavailable",
          agentId: member.id,
          name: member.name,
          reason: member.unavailableReason ?? "未知原因",
        });
    }
    for (const notice of prepared.notices) sink.send("notice", notice);

    // 图片输入：模型不支持看图时，在每个内置内核成员开始发言后提示（图片以文件路径的文字形式送达；CLI 内核自己读文件，不提示）
    const latestUser = [
      ...sessionService
        .recentHistory(sessionId, prepared.contextLimit)
        .filter((m) => m.role === "user"),
    ].pop();
    const latestImages = latestUser?.attachments.length ?? 0;

    const spoken = new Set<string>();
    // 每轮最多发言次数：成员数 + 2；有主管时规划与汇总另算一次（成员数 + 3）
    const limit = maxSpeaks(members) + (supervisor ? 1 : 0);
    let speaks = 0;
    let completed = false;
    let stopAll = false;
    let dispatchInstructions = "";
    const memberSpoken: string[] = [];

    /** 一次发言（规划 / 成员 / 汇总）。返回 null 表示本轮到此为止（用户停止或出错） */
    const speak = async (
      member: ResolvedAgent,
      role: "plan" | "member" | "summary",
      total: number,
    ): Promise<{ message: Message; dispatch: DispatchPlan | null } | null> => {
      speaks += 1;
      // 群成员可以有自己的模型（成员资料里的 model）：内置成员与 scoped 内核换成该模型，能力按该模型重新判断
      const memberProvider =
        member.kind === "builtin" && member.memberModel && provider
          ? withSessionModel(provider, member.memberModel)
          : provider;
      const memberKernelProvider =
        member.kind === "kernel" &&
        member.memberModel &&
        prepared.kernelProvider &&
        isScopedKernel(member)
          ? withSessionModel(prepared.kernelProvider, member.memberModel)
          : prepared.kernelProvider;
      const memberCaps =
        memberProvider === provider
          ? caps
          : memberProvider
            ? capabilitiesFor(memberProvider.model, memberProvider)
            : null;
      const runtime = runtimeOf(
        member,
        member.kind === "kernel" ? memberKernelProvider : memberProvider,
      );
      const supervisorRole = role === "member" ? undefined : role;
      sink.send("agent", {
        agentId: member.id,
        name: member.name,
        kernelName: member.kernelName ?? member.name,
        memberRole: member.role ?? null,
        avatar: member.avatar,
        index: speaks - 1,
        total,
        runtime,
        role,
      });
      if (
        member.kind === "builtin" &&
        latestImages > 0 &&
        memberCaps &&
        !memberCaps.vision
      ) {
        sink.send("vision", {
          agentId: member.id,
          supported: false,
          model: memberProvider?.model ?? "",
          images: latestImages,
        });
      }

      const state = newLoopState();
      let captured: DispatchPlan | null = null;
      // 逐步落库：第一段输出到达时插入草稿消息（finishReason='streaming'），之后节流更新，
      // 结束时原地改成最终状态（消息 id 不变）。进程崩溃也能保住已输出的部分。
      let draftId: string | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let finalized = false;
      const snapshot = (
        finishReason: string,
      ): Parameters<typeof sessionService.addMessage>[3] => {
        const rounds = [...state.rounds];
        if (state.pendingText)
          rounds.push({ text: state.pendingText, calls: [], results: [] });
        return {
          senderAgentId: member.id,
          toolTrace: state.trace,
          toolRounds: rounds,
          runtime,
          reasoning: state.reasoning,
          usage: usageService.summarize(state.usageRecords),
          finishReason,
          supervisorRole,
        };
      };
      const flushDraft = (): void => {
        flushTimer = null;
        if (finalized) return;
        const options = snapshot(STREAMING_FINISH_REASON);
        if (!draftId) {
          if (!hasContent()) return;
          draftId = sessionService.addMessage(
            sessionId,
            "assistant",
            state.text,
            options,
          ).id;
        } else {
          sessionService.updateMessage(sessionId, draftId, state.text, options);
        }
      };
      const scheduleDraft = (): void => {
        if (finalized || flushTimer) return;
        flushTimer = setTimeout(flushDraft, draftId ? DRAFT_FLUSH_MS : 50);
        flushTimer.unref?.();
      };
      /** 发言者的事件同时触发草稿节流落库 */
      const memberSink: ChatSink = {
        send: (event, payload) => {
          sink.send(event, payload);
          if (DRAFT_EVENTS.has(event)) scheduleDraft();
        },
      };
      const persist = (finishReason: string): Message => {
        finalized = true;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        const options = snapshot(finishReason);
        const message =
          (draftId &&
            sessionService.updateMessage(
              sessionId,
              draftId,
              state.text,
              options,
            )) ||
          sessionService.addMessage(sessionId, "assistant", state.text, options);
        usageService.attachMessage(
          state.usageRecords.map((record) => record.id),
          message.id,
        );
        return message;
      };
      /** 中止时的结束原因：服务关闭 → interrupted，用户停止 → aborted */
      const abortedReason = (): string =>
        signal.reason === "shutdown" ? INTERRUPTED_FINISH_REASON : "aborted";
      /** 中止 / 出错且没有可保留的内容时，删掉可能已落库的空草稿 */
      const dropDraft = (): void => {
        finalized = true;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        if (draftId) sessionService.deleteMessage(sessionId, draftId);
      };
      const hasContent = (): boolean =>
        Boolean(
          state.text.trim() || state.trace.length > 0 || state.reasoning.trim(),
        );
      const instructionsFor = (structured: boolean): string | undefined => {
        const identity = group ? memberIdentityPrompt(member) : "";
        let task: string | undefined;
        if (role === "plan")
          task = planInstructions(member, candidates, structured);
        else if (role === "summary")
          task = summaryInstructions(
            member,
            memberSpoken.map((id) => nameOf(id) ?? id),
          );
        else
          task =
            dispatchInstructions && supervisor
              ? memberInstructions(supervisor, dispatchInstructions)
              : undefined;
        return [identity, task].filter(Boolean).join("\n\n") || undefined;
      };

      try {
        if (member.kind === "kernel") {
          const history = sessionService.recentHistory(
            sessionId,
            prepared.contextLimit,
          );
          const lastUser = [...history]
            .reverse()
            .find((message) => message.role === "user");
          const images = attachmentAbsolutePaths(
            sessionId,
            lastUser?.attachments,
          );
          const extra = instructionsFor(false);
          const base = buildKernelPrompt(history, member, nameOf, images);
          const kp = memberKernelProvider;
          // 会话推理强度：scoped 经网关（只在单聊里生效，群聊里只作用于 LULUX 内置成员）；global 映射成 CLI 参数
          const sessionEffort = prepared.group ? null : prepared.reasoningEffort;
          const scoped =
            isScopedKernel(member) && kp
              ? {
                  provider: kp,
                  model: kp.model,
                  sessionId,
                  reasoningEffort: effectiveGatewayEffort(
                    sessionEffort,
                    kp.model,
                    kp,
                  ),
                }
              : undefined;
          // global 内核：单聊用会话模型；群聊里只有成员资料指定了模型才传
          const cli = scoped
            ? undefined
            : !prepared.group
              ? { model: prepared.cliModel, effort: sessionEffort }
              : member.memberModel
                ? { model: member.memberModel, effort: null }
                : undefined;
          // LULUX MCP：CRM 工具（builtinTools + kernelCrmMcp）或记忆工具（账号开了记忆）任一可用就接上
          const crmBridge =
            builtinToolsEnabled() &&
            settingsService.get("kernelCrmMcp") !== "0";
          const memoryOn = builtinToolsEnabled() && memoryService.enabled();
          // 记忆工具经 LULUX MCP 提供给 scoped 内核：“仅可查看”、非交互、多人群聊里不提供（MCP 侧 tools/list 同样过滤）
          const memoryToolsOn =
            memoryOn &&
            !memoryToolsBlocked(sessionId) &&
            permissionLevel !== "read";
          // CLI 内核每轮都把上下文拼成一段提示词：记忆快照放在最前面（与内置内核同一份会话快照；多人群聊默认不注入）
          const memorySnap = sessionMemorySnapshot(sessionId);
          const memoryBlock = memoryPromptBlock(
            memorySnap.snapshot,
            Boolean(scoped) && memoryToolsOn,
            { group: memorySnap.group },
          );
          const prompt = [memoryBlock, extra, base]
            .filter(Boolean)
            .join("\n\n");
          const mcp =
            scoped && (crmBridge || memoryOn)
              ? {
                  sessionId,
                  agentId: member.id,
                  signal,
                  send: (event: string, payload: unknown) =>
                    memberSink.send(event, payload),
                  trace: (entry: ToolTraceEntry) =>
                    void state.trace.push(entry),
                }
              : undefined;
          for await (const event of runKernel({
            kernelId: member.kernelId,
            prompt,
            signal,
            scoped,
            mcp,
            images,
            permission: { level: permissionLevel, sessionId },
            cli,
          })) {
            state.text += event.text;
            memberSink.send("delta", {
              text: event.text,
              agentId: member.id,
            });
          }
          state.finishReason = "stop";
        } else {
          const settings = loopSettings();
          if (memberProvider)
            settings.reasoningEffort = effectiveBuiltinEffort(
              prepared.reasoningEffort,
              memberProvider.model,
              memberProvider,
            );
          // 规划：模型支持工具时给主管一个 dispatch_members 工具（结构化派发）；否则按文本解析
          const structured = role === "plan" && Boolean(memberCaps?.tools);
          // 成员换了模型：该模型不能看图时不给 computer_* 工具
          let tools =
            memberCaps && !memberCaps.vision && memberProvider !== provider
              ? exposedTools.filter((tool) => !specs.get(tool.name) || specs.get(tool.name)!.group !== "computer")
              : exposedTools;
          let loopSpecs = specs;
          const toolset = dynamicTools
            ? selectInitialTools(
                exposedTools,
                request.content,
                historyToolNames(),
              )
            : undefined;
          if (structured) {
            const spec = dispatchToolSpec(candidates, (plan) => {
              captured = plan;
              return plan;
            });
            loopSpecs = new Map(specs);
            loopSpecs.set(spec.name, spec);
            tools = [
              ...exposedTools,
              {
                name: spec.name,
                description: spec.description,
                inputSchema: spec.inputSchema,
                serverId: "builtin",
                serverName: BUILTIN_SERVER,
                originalName: spec.name,
              },
            ];
            toolset?.add(spec.name);
          }
          // 主管不在群里（默认 LULUX）时也把它算进名单，系统提示里的参与者才完整
          const roster = members.some((m) => m.id === member.id)
            ? members
            : [...members, member];
          const turns = await this.buildContext(
            prepared,
            member,
            tools,
            nameOf,
            sink,
            signal,
            toolset,
            { supervisor: instructionsFor(structured), roster, provider: memberProvider ?? undefined },
          );
          await runPersonaLoop({
            sessionId,
            member,
            provider: memberProvider!,
            turns,
            tools,
            specs: loopSpecs,
            sink: memberSink,
            signal,
            state,
            settings,
            capabilities: memberCaps!,
            budget: contextBudget(memberCaps!, estimateTools(tools)),
            toolset,
          });
        }

        if (signal.aborted) {
          if (hasContent())
            sink.send("done", {
              message: persist(abortedReason()),
              aborted: true,
            });
          else dropDraft();
          return null;
        }
        if (!state.text.trim() && state.trace.length === 0)
          throw new AppError(502, "EMPTY_REPLY", "模型没有返回内容");

        // 规划：工具派发优先；否则从正文解析 JSON 代码块 / @成员（JSON 块不留在正文里）
        let dispatch: DispatchPlan | null = null;
        if (role === "plan") {
          if (captured) dispatch = captured;
          else {
            const parsed = parseDispatchText(state.text, candidates);
            if (parsed.members.length > 0) {
              dispatch = {
                members: parsed.members,
                instructions: parsed.instructions,
              };
              state.text = parsed.cleaned;
            }
          }
        }

        const message = persist(state.finishReason ?? "stop");
        sink.send("done", { message });

        webhookService.notifyChatCompleted({
          sessionId,
          // 首条消息可能刚触发自动命名，取库里的最新标题
          sessionTitle:
            sessionService.get(sessionId)?.title ?? prepared.sessionTitle,
          group,
          providerName:
            runtime.kind === "provider" ? runtime.providerName : member.name,
          model:
            runtime.kind === "provider"
              ? runtime.model
              : `kernel:${runtime.kernelId}@${runtime.version ?? "?"}`,
          agentId: member.id,
          agentName: member.name,
          messageId: message.id,
          content: message.content,
        });
        completed = true;
        return { message, dispatch };
      } catch (error) {
        const upstream = error instanceof UpstreamError ? error : null;
        if (signal.aborted || upstream?.kind === "aborted") {
          if (hasContent())
            sink.send("done", {
              message: persist(abortedReason()),
              aborted: true,
            });
          else dropDraft();
          return null;
        }
        const partial = hasContent() ? persist("error") : null;
        if (!partial) dropDraft();
        const normalized =
          error instanceof AppError || error instanceof UpstreamError
            ? error
            : toUpstreamError(error);
        sink.send("error", {
          agentId: member.id,
          name: member.name,
          code: errorCode(normalized),
          message: messageOf(normalized),
          retryable:
            normalized instanceof UpstreamError ? normalized.retryable : false,
          status:
            normalized instanceof UpstreamError ? normalized.status : null,
          partialMessageId: partial?.id ?? null,
        });
        return null;
      }
    };

    // 1) 主管规划
    let dispatched = false;
    if (planning && !signal.aborted) {
      const result = await speak(supervisor!, "plan", 1);
      spoken.add(supervisor!.id);
      if (!result) stopAll = true;
      else if (result.dispatch && result.dispatch.members.length > 0) {
        dispatched = true;
        dispatchInstructions = result.dispatch.instructions;
        for (const id of result.dispatch.members) {
          const next = candidates.find((member) => member.id === id);
          if (next && !queue.some((member) => member.id === id))
            queue.push(next);
        }
        sink.send("dispatch", {
          supervisorId: supervisor!.id,
          members: queue.map((member) => member.id),
          instructions: dispatchInstructions,
        });
      }
      // 主管决定自己回答：本轮到此结束，不再汇总
    }

    // 2) 成员发言（给汇总留一次）
    const reserve = supervisor ? 1 : 0;
    while (!stopAll && queue.length > 0 && speaks < limit - reserve) {
      if (signal.aborted) break;
      const member = queue.shift()!;
      spoken.add(member.id);
      const result = await speak(
        member,
        "member",
        speaks +
          1 +
          queue.length +
          (supervisor && (dispatched || explicit) ? 1 : 0),
      );
      if (!result) {
        stopAll = true;
        break;
      }
      if (!memberSpoken.includes(member.id)) memberSpoken.push(member.id);
      // 群聊：回复里 @ 了本轮还没发言的成员，让他接着说（不可用的成员不会被点名进来）
      if (group) {
        for (const id of parseMentions(result.message.content, available)) {
          if (
            id === member.id ||
            spoken.has(id) ||
            queue.some((m) => m.id === id)
          )
            continue;
          const next = available.find((m) => m.id === id);
          if (next) queue.push(next);
        }
      }
    }

    // 3) 主管汇总：派发后成员答过，或用户 @ 了 ≥2 位成员且都答了
    const needSummary =
      supervisor &&
      !stopAll &&
      !signal.aborted &&
      ((dispatched && memberSpoken.length >= 1) ||
        (explicit && memberSpoken.length >= 2));
    if (needSummary && speaks < limit) {
      await speak(supervisor!, "summary", speaks + 1);
    }

    if (completed && !signal.aborted) {
      this.lastTitleJob = maybeGenerateTitle(sessionId, provider);
      // 自动提取长期记忆：会话空闲一段时间（或每 N 轮）后在后台跑一次，失败不影响对话。
      // 会话里有 global CLI 内核（用户自己的 Claude Code / Codex 登录）时不提取：不把那段对话发给组织默认 Provider
      const hasGlobalKernel = prepared.members.some(
        (member) => member.kind === "kernel" && !isScopedKernel(member),
      );
      if (!hasGlobalKernel) scheduleMemoryExtraction(sessionId, provider);
    }
  }

  /** 当前发言者的上下文：系统提示（人设+日期+业务上下文+摘要）+ 历史；超预算时压缩较早消息 */
  private async buildContext(
    prepared: PreparedChat,
    member: ResolvedAgent & { kind: "builtin" },
    tools: ResolvedMcpTool[],
    nameOf: (id: string) => string | undefined,
    sink: ChatSink,
    signal: AbortSignal,
    toolset?: Set<string>,
    extra: { supervisor?: string; roster?: ResolvedAgent[]; provider?: Provider } = {},
  ): Promise<ChatTurn[]> {
    const { sessionId, groupName } = prepared;
    const provider = extra.provider ?? prepared.provider;
    const members = extra.roster ?? prepared.members;
    const caps = capabilitiesFor(provider!.model, provider!);
    let window: HistoryMessage[] = sessionService.recentHistory(
      sessionId,
      prepared.contextLimit,
    );

    const stored = summaryStore.get(sessionId);
    const drop = applyStoredSummary(window, stored, (id) =>
      Boolean(sessionService.message(sessionId, id)),
    );
    let summary: string | undefined;
    if (drop === null) {
      if (stored) summaryStore.clear(sessionId);
    } else {
      window = window.slice(drop);
      summary = stored!.summary;
    }

    const extras: SystemPromptExtras = {
      dateLine: dateLine(),
      supervisor: extra.supervisor,
    };
    // 长期记忆：当前发言人（群聊里是发这条消息的人；工作流 / 定时任务是负责人）的会话快照；
    // 多人群聊只有发言人打开“群聊中使用我的记忆”才注入
    try {
      const memorySnap = sessionMemorySnapshot(sessionId);
      extras.memory =
        memoryPromptBlock(
          memorySnap.snapshot,
          tools.some(
            (tool) => tool.name === "memory_add" && tool.serverId === "builtin",
          ),
          { group: memorySnap.group },
        ) || undefined;
    } catch (error) {
      console.warn("[lulux-eta] memory snapshot unavailable:", messageOf(error));
    }
    // Skill：只有提供了 skill_view 时才注入索引；用户最新消息命中关键词时预加载正文
    if (
      tools.some(
        (tool) => tool.name === "skill_view" && tool.serverId === "builtin",
      )
    ) {
      extras.skills = skillIndexFor(member.id) || undefined;
      const lastUser = [...window]
        .reverse()
        .find((message) => message.role === "user");
      if (extras.skills && lastUser) {
        const preload = preloadSkills(member.id, lastUser.content, sessionId);
        if (preload.text) {
          extras.preloadedSkills = preload.text;
          sink.send("skill_preload", {
            agentId: member.id,
            skills: preload.names,
          });
          // 预加载了技能：它的脚本与产物要用到的工具一并加载
          if (toolset)
            for (const name of [
              "skill_list",
              "run_skill_script",
              "workspace_list",
              "workspace_read",
              "workspace_write",
              "create_artifact",
            ])
              if (tools.some((t) => t.name === name)) toolset.add(name);
        }
      }
    }
    // 系统提示与历史只引用当前活动集里的工具（历史里用过的工具已在活动集中）
    if (toolset) tools = tools.filter((tool) => toolset.has(tool.name));
    try {
      extras.business =
        businessContext(sessionService.kernelContext(sessionId)) || undefined;
    } catch (error) {
      console.warn(
        "[lulux-eta] business context unavailable:",
        messageOf(error),
      );
    }

    const toolsTokens = estimateTools(tools);
    const budget = contextBudget(caps, toolsTokens);
    const primaryId = members[0]?.id ?? member.id;
    const toolNames = new Set(tools.map((tool) => tool.name));
    const fixed =
      estimateTurns(
        buildTurns([], member, members, groupName, tools, nameOf, {
          ...extras,
          summary,
        }),
      ) + summaryTokens(summary);
    // 图片：不支持看图的模型一张都不带；支持的只带最近几条消息的图。超预算时先丢旧图，再做文字压缩
    const imageIds = caps.vision
      ? window
          .filter(
            (message) =>
              message.role === "user" && message.attachments.length > 0,
          )
          .map((message) => message.id)
          .slice(-MAX_IMAGE_MESSAGES)
      : [];
    let keepImages = new Set(imageIds);
    const messageTurns = (message: HistoryMessage): ChatTurn[] => {
      const turns = turnsForMessage(
        message,
        member,
        primaryId,
        toolNames,
        nameOf,
      );
      if (!keepImages.has(message.id)) stripAllImages(turns);
      return turns;
    };
    let perMessage = window.map((message) =>
      estimateTurns(messageTurns(message)),
    );
    if (
      keepImages.size > 1 &&
      fixed + perMessage.reduce((sum, n) => sum + n, 0) > budget
    ) {
      const dropped = window
        .filter(
          (message) =>
            keepImages.has(message.id) &&
            message.id !== imageIds[imageIds.length - 1],
        )
        .reduce((sum, message) => sum + message.attachments.length, 0);
      keepImages = new Set(imageIds.slice(-1));
      perMessage = window.map((message) =>
        estimateTurns(messageTurns(message)),
      );
      sink.send("compaction", {
        agentId: member.id,
        kind: "images",
        droppedImages: dropped,
      });
    }
    const plan = planCompaction(
      perMessage,
      window.map((message) => message.role),
      fixed,
      budget,
    );

    if (plan.cut > 0) {
      const doomed = window.slice(0, plan.cut);
      window = window.slice(plan.cut);
      let ok = false;
      if (settingsService.get("contextCompaction") !== "0") {
        try {
          const input =
            (summary ? `此前对话的摘要：\n${summary}\n\n` : "") +
            `需要并入摘要的后续对话：\n${renderTranscript(doomed, nameOf)}`;
          const { text } = await completeText(SUMMARY_SYSTEM_PROMPT, input, {
            provider: provider!,
            signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
            purpose: "compaction",
            sessionId,
            maxTokens: 1500,
          });
          summary = text.trim();
          summaryStore.save({
            sessionId,
            uptoMessageId: doomed[doomed.length - 1]!.id,
            summarizedCount:
              (drop !== null && stored ? stored.summarizedCount : 0) +
              doomed.length,
            summary,
          });
          ok = true;
        } catch (error) {
          if (signal.aborted) throw new UpstreamError("aborted", "已取消");
          console.warn("[lulux-eta] compaction failed:", messageOf(error));
        }
      }
      if (!ok)
        summary = `${summary ? `${summary}\n` : ""}（更早的 ${doomed.length} 条消息因超出上下文长度已省略）`;
      sink.send("compaction", {
        agentId: member.id,
        kind: "summary",
        ok,
        summarizedMessages: doomed.length,
        tokensBefore: plan.tokensBefore,
        tokensAfter: plan.tokensAfter,
        budget,
      });
    }

    const turns = buildTurns(
      window,
      member,
      members,
      groupName,
      tools,
      nameOf,
      { ...extras, summary },
    );
    if (!caps.vision) {
      stripAllImages(turns);
      return turns;
    }
    for (const turn of turns) {
      if (
        turn.images?.length &&
        turn.messageId &&
        !keepImages.has(turn.messageId)
      ) {
        turn.content = `${turn.content}\n\n（此条消息附带的 ${turn.images.length} 张图片已省略，以节省上下文；需要时可用文件路径查看）`;
        delete turn.images;
      }
    }
    limitImages(turns);
    return turns;
  }
}

export const chatOrchestrator = new ChatOrchestrator();
