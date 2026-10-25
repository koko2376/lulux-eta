import type Router from "@koa/router";
import type Koa from "koa";
import { z } from "zod";
import { AppError, notFound } from "../errors.js";
import { isServerMode, requirePermission } from "../security/access.js";
import { agentService } from "../services/agent-service.js";
import {
  messageToMarkdown,
  sessionToMarkdown,
} from "../services/chat/export.js";
import {
  chatOrchestrator,
  validateBusinessContext,
  type PreparedChat,
  type RunInput,
} from "../services/chat/orchestrator.js";
import {
  activeRun,
  activeRuns,
  isRunning,
  latestRun,
  runState,
  startRun,
  stopRun,
  type ChatRun,
} from "../services/chat/run-registry.js";
import { acquireChatSlot } from "../services/chat/rate-limit.js";
import { resolveAttachments } from "../services/chat/vision.js";
import { MAX_IMAGES_PER_MESSAGE } from "../services/llm/images.js";
import type { MessageAttachment } from "../types.js";
import {
  capabilitiesFor,
  parseCapabilityOverrides,
} from "../services/llm/capabilities.js";
import { parsePricing, priceFor } from "../services/llm/pricing.js";
import {
  GROUP_BY,
  usageService,
  type UsageGroupBy,
} from "../services/llm/usage-service.js";
import { providerService } from "../services/provider-service.js";
import { sessionService } from "../services/session-service.js";
import {
  registerSettingValidator,
  settingsService,
} from "../services/settings-service.js";
import { currentActor } from "../context.js";
import {
  pendingForSession,
  pendingSessionOf,
  resolveApproval,
  sessionAllowList,
} from "../services/tool-approval.js";
import { listTools } from "../services/tools/registry.js";
import {
  SEARCH_PROVIDERS,
  searchConfigService,
  type SearchProvider,
} from "../services/tools/search-config.js";
import { validTimeZone } from "../services/tools/time.js";
import { openSse, sendSse, sendSseComment } from "../utils/sse.js";
import { parse } from "../validation.js";
import { assertNotWorkflowSession, assertOwnUserMessage } from "./sessions.js";

// 内置内核设置项的业务校验（JSON 结构、时区名）
registerSettingValidator("modelCapabilities", (_key, value) => {
  parseCapabilityOverrides(value);
  return value;
});
registerSettingValidator("modelPricing", (_key, value) => {
  parsePricing(value);
  return value;
});
registerSettingValidator("timezone", (_key, value) => {
  if (value && !validTimeZone(value))
    throw new Error("不是有效的 IANA 时区名（如 Asia/Shanghai）");
  return value;
});

const contextInput = z
  .object({
    customerId: z.string().min(1).max(80).nullable().optional(),
    quoteId: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();

const targetInput = z.array(z.string().min(1).max(80)).max(20).optional();

/** 图片附件引用：会话工作区内的相对路径（先经 /files 上传），每条最多 8 张 */
const attachmentsInput = z
  .array(
    z
      .object({
        path: z.string().min(1).max(400),
        name: z.string().max(200).optional(),
      })
      .strict(),
  )
  .max(MAX_IMAGES_PER_MESSAGE, `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
  .optional();

const hasText = (body: { content: string; attachments?: unknown[] }): boolean =>
  body.content.trim().length > 0 || Boolean(body.attachments?.length);

const chatInput = z
  .object({
    sessionId: z.string().min(1).max(80),
    content: z.string().max(200_000),
    targetAgentIds: targetInput,
    context: contextInput.optional(),
    attachments: attachmentsInput,
  })
  .refine(hasText, { message: "内容不能为空", path: ["content"] });

const regenerateInput = z.object({
  sessionId: z.string().min(1).max(80),
  messageId: z.string().min(1).max(80).optional(),
  targetAgentIds: targetInput,
});

const editInput = z
  .object({
    sessionId: z.string().min(1).max(80),
    messageId: z.string().min(1).max(80),
    content: z.string().max(200_000),
    targetAgentIds: targetInput,
    /** 省略时沿用原消息的附件；传 [] 表示去掉 */
    attachments: attachmentsInput,
  })
  .refine(hasText, { message: "内容不能为空", path: ["content"] });

function checkedAttachments(
  sessionId: string,
  refs: Array<{ path: string; name?: string }> | undefined,
): MessageAttachment[] | undefined {
  if (!refs) return undefined;
  try {
    return resolveAttachments(sessionId, refs);
  } catch (error) {
    throw new AppError(
      400,
      "INVALID_ATTACHMENT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const decisionInput = z.object({
  requestId: z.string().min(1).max(80),
  approved: z.boolean(),
  /** 'session'：本会话内同名工具后续不再询问 */
  remember: z.enum(["session"]).optional(),
});

const searchConfigInput = z
  .object({
    provider: z.enum(SEARCH_PROVIDERS as [SearchProvider, ...SearchProvider[]]),
    endpoint: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
    maxResults: z.number().int().min(1).max(10).optional(),
  })
  .strict();

function visibleSession(id: string) {
  const session = sessionService.visible(id);
  if (!session) throw notFound("会话");
  return session;
}

/**
 * 把一个会话运行接到 SSE 响应上：先回放 seq > after 的缓存事件，再推实时事件，运行结束时关闭。
 * 连接断开只取消订阅，不影响运行（契约 §6.9）。
 */
export function pipeRun(
  ctx: Koa.Context,
  run: ChatRun,
  after = 0,
  markReplay = false,
): Promise<void> {
  ctx.respond = false;
  openSse(ctx.res);
  const res = ctx.res;
  return new Promise<void>((resolve) => {
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const heartbeat = setInterval(() => sendSseComment(res), 15_000);
    heartbeat.unref?.();
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
      resolve();
    };
    res.on("close", close);
    unsubscribe = run.subscribe(
      after,
      (entry) => sendSse(res, entry.event, entry.payload, entry.seq),
      () => close(),
    );
    if (closed) unsubscribe();
    // 重新接上：回放（同步）结束后告诉客户端，之后都是实时事件（不带 id，不占 seq）
    else if (markReplay) sendSse(res, "replayed", { lastSeq: run.lastSeq });
  });
}

/** 开始一个服务端持有的运行（已有运行时 409 RUN_ACTIVE，此时还没打开 SSE），并把发起请求接成第一个订阅者 */
async function streamRun(
  ctx: Koa.Context,
  prepared: PreparedChat,
  input: RunInput,
): Promise<void> {
  const release = acquireChatRateSlot();
  let run: ChatRun;
  try {
    run = startRun(prepared.sessionId, "chat");
  } catch (error) {
    release();
    throw error;
  }
  void run.done.finally(release);
  void chatOrchestrator
    .run(prepared, input, { send: () => undefined }, undefined, run)
    .catch((error) => console.error("[lulux-eta] chat run failed", error));
  await pipeRun(ctx, run, 0);
}

/** 按用户限流（仅 server 模式）；返回释放函数 */
function acquireChatRateSlot(): () => void {
  if (!isServerMode()) return () => undefined;
  const actor = currentActor();
  const limit = (key: string): number => {
    const value = Number(settingsService.get(key));
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  };
  return acquireChatSlot(`${actor.orgId}:${actor.id}`, {
    maxConcurrent: limit("chatMaxConcurrentRunsPerUser"),
    perMinute: limit("chatRunsPerMinutePerUser"),
  });
}

/** 停止 / 取消：会话可见且可写的用户才能停止 */
function cancelSessionRun(sessionId: string): { stopped: boolean; runId: string | null } {
  visibleSession(sessionId);
  if (!sessionService.writable(sessionId))
    throw new AppError(403, "FORBIDDEN", "只能停止自己会话里的对话");
  const run = activeRun(sessionId);
  return { stopped: stopRun(sessionId, "user"), runId: run?.id ?? null };
}

function boolQuery(value: unknown): boolean {
  return value === "1" || value === "true";
}

function numQuery(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new AppError(400, "VALIDATION_ERROR", `参数不是数字：${value}`);
  return n;
}

function strQuery(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

/** 路由只做参数校验与 SSE 适配；编排逻辑在 services/chat/orchestrator.ts */
export function chatRoutes(router: Router): void {
  router.post("/api/chat/tool-decision", (ctx) => {
    const body = parse(decisionInput, ctx.request.body);
    const owner = pendingSessionOf(body.requestId);
    // 看不到会话（非成员）与已过期同样 404，不泄露请求是否存在；能看不能改（viewer）403
    if (owner && !sessionService.visible(owner))
      throw new AppError(
        404,
        "TOOL_REQUEST_EXPIRED",
        "这次工具调用已结束或已超时",
      );
    if (owner && !sessionService.writable(owner))
      throw new AppError(403, "FORBIDDEN", "只能审批自己会话里的工具调用");
    if (!resolveApproval(body.requestId, body.approved, body.remember)) {
      throw new AppError(
        404,
        "TOOL_REQUEST_EXPIRED",
        "这次工具调用已结束或已超时",
      );
    }
    ctx.body = { ok: true };
  });

  router.get("/api/chat/pending", (ctx) => {
    const sessionId = strQuery(ctx.query.sessionId);
    if (!sessionId)
      throw new AppError(400, "VALIDATION_ERROR", "需要 sessionId");
    visibleSession(sessionId);
    ctx.body = {
      running: isRunning(sessionId),
      requests: pendingForSession(sessionId),
      allowedTools: sessionAllowList(sessionId),
    };
  });

  router.post("/api/chat", async (ctx) => {
    const body = parse(chatInput, ctx.request.body);
    // 校验失败（会话不存在、无 Provider、内核不可用、客户不可见…）在打开 SSE 之前以 JSON 错误返回
    const prepared = chatOrchestrator.prepare(body.sessionId);
    assertNotWorkflowSession(prepared.sessionId);
    validateBusinessContext(body.context);
    const attachments = checkedAttachments(
      prepared.sessionId,
      body.attachments,
    );
    await streamRun(ctx, prepared, {
      mode: "send",
      content: body.content.trim(),
      appendUser: true,
      targetAgentIds: body.targetAgentIds,
      context: body.context,
      attachments,
    });
  });

  router.post("/api/chat/stop", (ctx) => {
    const body = parse(
      z.object({ sessionId: z.string().min(1).max(80) }),
      ctx.request.body,
    );
    ctx.body = { stopped: cancelSessionRun(body.sessionId).stopped };
  });

  // 显式取消会话运行（契约 §6.9）；与 /api/chat/stop 等价，多返回 runId
  router.post("/api/sessions/:id/cancel", (ctx) => {
    ctx.body = cancelSessionRun(ctx.params.id);
  });

  // 进行中运行的数量（桌面主进程关窗前确认用；本机账户下主进程没有本机会话，只给数量，仍要求 API token）
  router.get("/api/chat/runs/count", (ctx) => {
    ctx.body = { count: activeRuns().filter((run) => sessionService.visible(run.sessionId)).length };
  });

  // 当前用户可见的进行中运行（桌面端关窗前确认用）
  router.get("/api/chat/runs", (ctx) => {
    ctx.body = {
      runs: activeRuns()
        .filter((run) => sessionService.visible(run.sessionId))
        .map((run) => run.toPublic()),
    };
  });

  // 会话运行状态（不含事件）
  router.get("/api/sessions/:id/run", (ctx) => {
    visibleSession(ctx.params.id);
    const run = latestRun(ctx.params.id);
    ctx.body = { ...runState(ctx.params.id), run: run?.toPublic() ?? null };
  });

  /**
   * 重新接上会话运行（契约 §6.9）：SSE 先回放 seq > after 的事件再推实时，运行结束即关闭。
   * 没有运行（也没有刚结束的运行）时立刻关闭空流；客户端据此按 GET /api/sessions/:id 的消息为准。
   */
  router.get("/api/sessions/:id/stream", async (ctx) => {
    visibleSession(ctx.params.id);
    const raw = ctx.query.after ?? ctx.get("Last-Event-ID");
    const after = Math.max(0, Math.trunc(Number(raw) || 0));
    const run = latestRun(ctx.params.id);
    if (!run) {
      ctx.respond = false;
      openSse(ctx.res);
      ctx.res.end();
      return;
    }
    await pipeRun(ctx, run, after, true);
  });

  router.post("/api/chat/regenerate", async (ctx) => {
    const body = parse(regenerateInput, ctx.request.body);
    const prepared = chatOrchestrator.prepare(body.sessionId);
    assertNotWorkflowSession(prepared.sessionId);
    const { userMessage } = chatOrchestrator.resolveRegenerate(
      prepared,
      body.messageId,
    );
    assertOwnUserMessage(prepared.sessionId, userMessage);
    await streamRun(ctx, prepared, {
      mode: "regenerate",
      content: userMessage.content,
      appendUser: false,
      truncate: { messageId: userMessage.id, inclusive: false },
      targetAgentIds: body.targetAgentIds,
    });
  });

  router.post("/api/chat/edit", async (ctx) => {
    const body = parse(editInput, ctx.request.body);
    const prepared = chatOrchestrator.prepare(body.sessionId);
    assertNotWorkflowSession(prepared.sessionId);
    const { userMessage } = chatOrchestrator.resolveEdit(
      prepared,
      body.messageId,
    );
    assertOwnUserMessage(prepared.sessionId, userMessage);
    const attachments =
      checkedAttachments(prepared.sessionId, body.attachments) ??
      userMessage.attachments;
    if (!body.content.trim() && attachments.length === 0)
      throw new AppError(400, "VALIDATION_ERROR", "内容不能为空");
    await streamRun(ctx, prepared, {
      mode: "edit",
      content: body.content.trim(),
      appendUser: true,
      truncate: { messageId: userMessage.id, inclusive: true },
      targetAgentIds: body.targetAgentIds,
      attachments,
    });
  });

  router.get("/api/chat/sessions/:id/context", (ctx) => {
    visibleSession(ctx.params.id);
    ctx.body = sessionService.kernelContext(ctx.params.id);
  });

  router.put("/api/chat/sessions/:id/context", (ctx) => {
    const body = parse(contextInput, ctx.request.body);
    visibleSession(ctx.params.id);
    if (!sessionService.writable(ctx.params.id))
      throw new AppError(403, "FORBIDDEN", "只能修改自己的会话");
    const validated = validateBusinessContext(body)!;
    sessionService.setKernelContext(ctx.params.id, validated);
    ctx.body = sessionService.kernelContext(ctx.params.id);
  });

  router.get("/api/chat/sessions/:id/export", (ctx) => {
    const session = visibleSession(ctx.params.id);
    const format = ctx.query.format ?? "markdown";
    if (format !== "markdown" && format !== "md")
      throw new AppError(400, "VALIDATION_ERROR", "目前只支持 format=markdown");
    const nameOf = (id: string | null): string =>
      id ? (agentService.find(id)?.name ?? id) : "助手";
    const markdown = sessionToMarkdown(
      session,
      sessionService.messages(session.id),
      nameOf,
      {
        reasoning: boolQuery(ctx.query.reasoning),
        tools: boolQuery(ctx.query.tools),
        usage: boolQuery(ctx.query.usage),
      },
    );
    const filename = `${session.title.replace(/[\\/:*?"<>|\r\n]+/g, "-").slice(0, 60) || "session"}.md`;
    ctx.set("Content-Type", "text/markdown; charset=utf-8");
    ctx.set(
      "Content-Disposition",
      `attachment; filename="session.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    ctx.body = markdown;
  });

  router.get("/api/chat/sessions/:id/messages/:messageId/markdown", (ctx) => {
    const session = visibleSession(ctx.params.id);
    const message = sessionService.message(session.id, ctx.params.messageId);
    if (!message) throw new AppError(404, "MESSAGE_NOT_FOUND", "消息不存在");
    const speaker =
      message.role === "user"
        ? (message.senderName ?? "用户")
        : (agentService.find(message.senderAgentId ?? "")?.name ?? "助手");
    const full = boolQuery(ctx.query.full);
    ctx.set("Content-Type", "text/markdown; charset=utf-8");
    ctx.body = full
      ? messageToMarkdown(message, speaker, {
          reasoning: boolQuery(ctx.query.reasoning),
          tools: true,
          usage: true,
        })
      : message.content;
  });

  router.get("/api/chat/capabilities", (ctx) => {
    const providerId = strQuery(ctx.query.providerId);
    const provider = providerId ? providerService.get(providerId) : undefined;
    if (providerId && !provider) throw notFound("Provider");
    const model = strQuery(ctx.query.model) ?? provider?.model;
    if (!model)
      throw new AppError(400, "VALIDATION_ERROR", "需要 providerId 或 model");
    ctx.body = {
      model,
      capabilities: capabilitiesFor(model, provider),
      price: priceFor(provider?.name ?? "", model),
    };
  });

  router.get("/api/chat/tools", (ctx) => {
    ctx.body = {
      tools: listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        group: tool.group,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  router.get("/api/chat/search-config", (ctx) => {
    ctx.body = searchConfigService.toPublic();
  });

  router.put("/api/chat/search-config", (ctx) => {
    requirePermission("settings:write");
    const body = parse(searchConfigInput, ctx.request.body);
    if (body.endpoint) {
      let url: URL;
      try {
        url = new URL(body.endpoint);
      } catch {
        throw new AppError(400, "INVALID_URL", "搜索服务地址格式不正确");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new AppError(400, "INVALID_URL", "搜索服务地址只支持 http/https");
    }
    const current = searchConfigService.get();
    if (
      body.provider === "searxng" &&
      !body.endpoint &&
      (current.provider !== "searxng" || !current.endpoint)
    ) {
      throw new AppError(400, "VALIDATION_ERROR", "SearXNG 需要填写服务地址");
    }
    ctx.body = searchConfigService.update(body);
  });

  router.get("/api/usage", (ctx) => {
    const groupBy = strQuery(ctx.query.groupBy);
    if (groupBy && !(GROUP_BY as readonly string[]).includes(groupBy)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `groupBy 只能是 ${GROUP_BY.join(" / ")}`,
      );
    }
    const tz = numQuery(ctx.query.tzOffsetMinutes) ?? 0;
    ctx.body = usageService.summary(
      {
        from: numQuery(ctx.query.from),
        to: numQuery(ctx.query.to),
        sessionId: strQuery(ctx.query.sessionId),
        providerId: strQuery(ctx.query.providerId),
        model: strQuery(ctx.query.model),
        agentId: strQuery(ctx.query.agentId),
        purpose: strQuery(ctx.query.purpose),
        all: ctx.query.scope === "all",
      },
      (groupBy as UsageGroupBy | undefined) ?? null,
      Math.max(-840, Math.min(840, tz)),
    );
  });

  router.get("/api/usage/records", (ctx) => {
    const page = Math.max(1, Math.trunc(numQuery(ctx.query.page) ?? 1));
    const pageSize = Math.max(
      1,
      Math.min(200, Math.trunc(numQuery(ctx.query.pageSize) ?? 50)),
    );
    ctx.body = usageService.records(
      {
        from: numQuery(ctx.query.from),
        to: numQuery(ctx.query.to),
        sessionId: strQuery(ctx.query.sessionId),
        providerId: strQuery(ctx.query.providerId),
        model: strQuery(ctx.query.model),
        agentId: strQuery(ctx.query.agentId),
        purpose: strQuery(ctx.query.purpose),
        all: ctx.query.scope === "all",
      },
      page,
      pageSize,
    );
  });
}
