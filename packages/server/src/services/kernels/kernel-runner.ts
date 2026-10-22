import { applyCliModel } from "../models/catalog.js";
import type { EffortLevel } from "../models/effort.js";
import type { ReasoningEffort } from "../llm/types.js";
import { spawn as crossSpawn } from "cross-spawn";
import { killTree } from "../../utils/kill-tree.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { runtimeInfo } from "../../config.js";
import { AppError } from "../../errors.js";
import type { Provider } from "../../types.js";
import { gatewayTokens } from "../gateway/tokens.js";
import { currentActor } from "../../context.js";
import { luluxMcpTokens, type McpBridge } from "../lulux-mcp/server.js";
import { findKernel, type KernelDefinition } from "./catalog.js";
import { kernelDir, resolveKernelBinary } from "./kernel-service.js";
import { scopedBaseEnv, scopedLaunch } from "./scoped.js";
import { syncSkillsToKernelHome } from "../skills/cli-sync.js";
import { withNodeShim } from "./node-runtime.js";
import { kernelsRoot, sessionHomeSegment } from "./paths.js";
import { applyKernelPermission, kernelEffectiveLevel } from "./permissions.js";
import type { PermissionLevel } from "../permissions.js";
import { sessionWorkspace } from "../tools/workspace.js";

export type KernelEvent = { type: "text"; text: string };

export interface KernelRunRequest {
  kernelId: string;
  prompt: string;
  signal: AbortSignal;
  /** scoped 模式：经本机网关使用 LULUX 的 Provider/模型；缺省为 global（CLI 自己的登录） */
  scoped?: {
    provider: Provider;
    model: string;
    sessionId: string;
    /** 会话推理强度：网关转发时给上游加 reasoning_effort（契约 §6.13）；null / 省略 = 不改 */
    reasoningEffort?: ReasoningEffort | null;
  };
  /** global 模式：会话选的 CLI 模型 / 推理强度，映射成 CLI 参数（services/models/catalog.ts applyCliModel） */
  cli?: { model: string | null; effort: EffortLevel | null };
  /** scoped 模式下注入内置 LULUX MCP（CRM 工具）；写操作经 bridge 向对话请求审批 */
  mcp?: McpBridge;
  /** 最新用户消息附带图片的本机绝对路径（提示词里也已列出路径） */
  images?: string[];
  /**
   * 会话权限级别（契约 §6.11），映射成 CLI 自己的参数（见 ./permissions.ts）；缺省 read（旧行为：只读）。
   * ask / full 时工作目录为会话工作区 <dataDir>/workspace/<sessionId>/。
   */
  permission?: { level: PermissionLevel; sessionId: string };
}

/**
 * 图片的 CLI 参数（均按各 CLI 的 --help 核实，2026-10-21）：
 *  - Codex `exec -i, --image <FILE>...`：原生把图片附到首条提示；放在 exec 之后、下一个 -- 选项之前，
 *    避免可变参数吞掉末尾的 `-`（stdin 提示词）；
 *  - Claude Code 没有图片参数：路径写在提示词里，由它的 Read 工具读图；`--add-dir` 允许访问图片所在目录；
 *  - Gemini CLI / Qwen Code 没有图片参数：同样只给路径，`--include-directories` 允许访问该目录；
 *  - 其他内核：只在提示词里给路径。
 */
export function kernelImageArgs(
  def: Pick<KernelDefinition, "id">,
  args: string[],
  images: string[],
): string[] {
  if (images.length === 0) return args;
  const dirs = [...new Set(images.map((file) => dirname(file)))];
  if (def.id === "codex") {
    const at = args.indexOf("exec");
    const flags = images.flatMap((file) => ["--image", file]);
    return at >= 0
      ? [...args.slice(0, at + 1), ...flags, ...args.slice(at + 1)]
      : [...flags, ...args];
  }
  if (def.id === "claude-code")
    return [...args, ...dirs.map((dir) => `--add-dir=${dir}`)];
  if (def.id === "gemini-cli" || def.id === "qwen-code")
    return [...args, ...dirs.map((dir) => `--include-directories=${dir}`)];
  return args;
}

/** scoped 模式的错误：不是登录问题，原因来自网关/上游 */
export function scopedKernelError(
  def: KernelDefinition,
  raw: string,
  upstream: string | null,
): AppError {
  const detail = raw.trim().replace(/\s+/g, " ").slice(0, 300);
  const reason = upstream ? `网关上游错误：${upstream.slice(0, 400)}` : detail;
  return new AppError(
    502,
    "KERNEL_FAILED",
    `${def.name}（经由 LULUX 模型）运行失败${reason ? `：${reason}` : ""}`,
  );
}

const safeSegment = sessionHomeSegment;

const LOGIN_PATTERN =
  /not logged in|please run \/login|\/login|authentication|unauthori[sz]ed|\b401\b|api key|apikey|credential|auth type|auth method|login/i;

export function kernelError(def: KernelDefinition, raw: string): AppError {
  const detail = raw.trim().replace(/\s+/g, " ").slice(0, 300);
  if (LOGIN_PATTERN.test(detail)) {
    return new AppError(
      409,
      "KERNEL_LOGIN_REQUIRED",
      `${def.name} 需要登录：${def.loginHint}${detail ? `（内核返回：${detail}）` : ""}`,
    );
  }
  return new AppError(
    502,
    "KERNEL_FAILED",
    `${def.name} 运行失败${detail ? `：${detail}` : ""}`,
  );
}

/** 子进程环境：继承用户环境（内核需要自己的登录信息），但剔除 LULUX 内部变量 */
function kernelEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("LULUX_")) delete env[key];
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

interface ParseState {
  partialSinceLast: boolean;
  lastError: string;
  fatal: string | null;
  /** Pi：最近一条助手消息以 error 结束、且之后没有自动重试成功（agent_settled 时才定为失败） */
  pendingError?: string | null;
}

/** 把一行 JSON 事件翻译成文本增量；返回 null 表示无可输出内容 */
function translate(
  def: KernelDefinition,
  event: Record<string, unknown>,
  state: ParseState,
): string | null {
  const type = typeof event.type === "string" ? event.type : "";

  if (def.format === "claude-stream-json") {
    if (type === "stream_event") {
      const inner = event.event as
        { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (
        inner?.type === "content_block_delta" &&
        inner.delta?.type === "text_delta" &&
        inner.delta.text
      ) {
        state.partialSinceLast = true;
        return inner.delta.text;
      }
      return null;
    }
    if (type === "assistant") {
      const message = event.message as
        { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = (message?.content ?? [])
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
      if (event.error) {
        state.fatal = `${String(event.error)}: ${text}`;
        return null;
      }
      const skip = state.partialSinceLast;
      state.partialSinceLast = false;
      return skip || !text ? null : text;
    }
    if (type === "result") {
      if (event.is_error) {
        const error = event.error as { message?: string } | undefined;
        state.fatal =
          state.fatal ??
          (error?.message || String(event.result ?? "unknown error"));
      }
      return null;
    }
    return null;
  }

  if (def.format === "codex-jsonl") {
    if (type === "item.completed") {
      const item = event.item as
        { type?: string; text?: string; message?: string } | undefined;
      if (item?.type === "agent_message" && item.text) return item.text;
      if (item?.type === "error" && item.message)
        state.lastError = item.message;
      return null;
    }
    if (type === "error" && typeof event.message === "string") {
      state.lastError = event.message;
      return null;
    }
    if (type === "turn.failed") {
      const error = event.error as { message?: string } | undefined;
      state.fatal = error?.message || state.lastError || "turn failed";
    }
    return null;
  }

  if (def.format === "hermes-stream-json") {
    // hermes chat --format stream-json：text 为增量；result 是终止记录（error 字段表示失败，text 为完整回复）
    if (type === "text" && typeof event.text === "string") {
      state.partialSinceLast = true;
      return event.text;
    }
    if (type === "result") {
      const error = event.error;
      if (error) {
        const message =
          typeof error === "string"
            ? error
            : ((error as { message?: string }).message ??
              JSON.stringify(error));
        state.fatal = message || "error";
        return null;
      }
      // replay_gap 或没有流式增量时，用 result.text 兜底
      if (
        typeof event.text === "string" &&
        event.text &&
        (!state.partialSinceLast || event.replay_gap === true)
      ) {
        const already = state.partialSinceLast;
        state.partialSinceLast = true;
        return already ? null : event.text;
      }
    }
    return null;
  }

  if (def.format === "grok-streaming-json") {
    // grok --output-format streaming-json：{type:'text',data} 为增量；{type:'error',message}；{type:'end',stopReason}
    // （thinking / tool / usage / available_commands 等其他事件忽略）
    if (type === "text" && typeof event.data === "string")
      return event.data || null;
    if (type === "error") {
      state.fatal = String(event.message ?? "error").replace(
        /^Internal error:\s*/,
        "",
      );
      return null;
    }
    if (
      type === "end" &&
      typeof event.stopReason === "string" &&
      /error|refus/i.test(event.stopReason)
    ) {
      state.fatal = state.fatal ?? `stopReason=${event.stopReason}`;
    }
    return null;
  }

  if (def.format === "pi-json") {
    // pi --mode json：message_update 只带增量；message_end 是权威的完整消息（stopReason=error 时带 errorMessage）
    if (type === "message_update") {
      const inner = event.assistantMessageEvent as
        | { type?: string; delta?: string; error?: { errorMessage?: string } }
        | undefined;
      if (inner?.type === "text_delta" && inner.delta) {
        state.partialSinceLast = true;
        return inner.delta;
      }
      if (inner?.type === "error")
        state.lastError = inner.error?.errorMessage || state.lastError;
      return null;
    }
    if (type === "message_end") {
      const message = event.message as
        | {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
            content?: Array<{ type?: string; text?: string }> | string;
          }
        | undefined;
      if (message?.role !== "assistant") return null;
      if (message.stopReason === "error") {
        // Pi 会对连接错误自动重试（auto_retry_start），先记下，等 agent_settled 再判定
        state.lastError = message.errorMessage || state.lastError || "error";
        state.pendingError = state.lastError;
        state.partialSinceLast = false;
        return null;
      }
      state.pendingError = null;
      const skip = state.partialSinceLast;
      state.partialSinceLast = false;
      if (skip) return null;
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("");
      return text || null;
    }
    if (type === "auto_retry_start") {
      state.pendingError = null;
      return null;
    }
    if (type === "agent_settled" && state.pendingError)
      state.fatal = state.pendingError;
    return null;
  }

  // gemini-stream-json
  if (
    type === "message" &&
    event.role === "assistant" &&
    typeof event.content === "string"
  ) {
    return event.content;
  }
  if (type === "error") {
    state.lastError = String(
      event.message ?? JSON.stringify(event).slice(0, 300),
    );
    return null;
  }
  if (type === "result" && event.status === "error") {
    const error = event.error as { message?: string } | undefined;
    state.fatal = error?.message || state.lastError || "error";
  }
  return null;
}

/**
 * JSONL 逐行读取：只按 LF 切分（去掉行尾 CR）。不用 readline——它把 U+2028/U+2029 也当行尾，
 * 而这两个字符在 JSON 字符串里是合法的（Pi 的 JSON 文档特别提醒过）。
 */
export async function* jsonlLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk as Uint8Array, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer.replace(/\r$/, "");
}

/**
 * 以非交互流式模式运行第三方 CLI，提示词经 stdin 传入，
 * 把 JSON 事件流转换成文本增量。登录/Key 缺失时抛 KERNEL_LOGIN_REQUIRED。
 */
export async function* runKernel(
  request: KernelRunRequest,
): AsyncGenerator<KernelEvent> {
  const def = findKernel(request.kernelId);
  if (!def) throw new AppError(404, "NOT_FOUND", "内核不存在");
  const binary = resolveKernelBinary(def);
  if (!binary)
    throw new AppError(409, "KERNEL_UNAVAILABLE", `${def.name} 未安装`);

  const requestedLevel: PermissionLevel = request.permission?.level ?? "read";
  const effectiveLevel = kernelEffectiveLevel(
    def.id,
    requestedLevel,
    Boolean(request.mcp),
  );
  // 写 / 执行发生在会话工作区里；只读运行沿用内核自己的工作目录
  const cwd =
    effectiveLevel !== "read" && request.permission
      ? sessionWorkspace(request.permission.sessionId)
      : join(kernelDir(def.id), "workspace");
  mkdirSync(cwd, { recursive: true });

  let env = kernelEnv();
  let args = [...def.args];
  let issued: ReturnType<typeof gatewayTokens.issue> | null = null;
  let mcpIssued: ReturnType<typeof luluxMcpTokens.issue> | null = null;
  if (request.scoped) {
    const { provider, model, sessionId } = request.scoped;
    // 一次性令牌：只在这个进程运行期间有效，finally 中吊销
    issued = gatewayTokens.issue({
      providerId: provider.id,
      model,
      kernelId: def.id,
      sessionId,
      reasoningEffort: request.scoped.reasoningEffort ?? null,
    });
    const home = join(kernelDir(def.id), "home", safeSegment(sessionId));
    // 内置 LULUX MCP：只在 scoped 运行时注入，一次性令牌绑定发起者身份，finally 中吊销
    if (request.mcp)
      mcpIssued = luluxMcpTokens.issue({
        actor: currentActor(),
        kernelId: def.id,
        bridge: request.mcp,
      });
    const launch = scopedLaunch(def, {
      token: issued.token,
      port: runtimeInfo.getPort(),
      provider,
      model,
      home,
      mcpToken: mcpIssued?.token,
    });
    // 共享 LULUX 已启用的 skill（各 CLI 原生识别的用户级 skills 目录，见 services/skills/cli-sync.ts）
    try {
      syncSkillsToKernelHome(def.id, home);
    } catch (error) {
      console.warn(
        "[lulux-eta] skill sync to kernel failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    env = { ...scopedBaseEnv(), ...launch.env };
    args = launch.args;
  } else if (request.cli && (request.cli.model || request.cli.effort)) {
    const applied = applyCliModel(def.id, args, request.cli.model, request.cli.effort);
    args = applied.args;
    env = { ...env, ...applied.env };
  }
  const permitted = applyKernelPermission(def.id, requestedLevel, args, {
    mcp: Boolean(request.mcp),
  });
  args = permitted.args;
  env = { ...env, ...permitted.env };
  // 提示词经文件传入的内核（Grok：-p 只接受命令行参数，长提示词与换行不可靠）：0600 临时文件，运行结束删除
  let promptPath: string | null = null;
  if (def.promptFile) {
    const dir = join(kernelDir(def.id), "tmp");
    mkdirSync(dir, { recursive: true });
    promptPath = join(dir, `prompt-${randomBytes(8).toString("hex")}.txt`);
    writeFileSync(promptPath, request.prompt, { mode: 0o600 });
    args = args.map((arg) => (arg === "{promptFile}" ? promptPath! : arg));
  }
  args = kernelImageArgs(def, args, request.images ?? []);
  const fail = (raw: string): AppError =>
    issued
      ? scopedKernelError(def, raw, issued.target.lastError)
      : kernelError(def, raw);
  let command = binary.file;
  if (binary.viaNode) {
    // JS 入口经 process.execPath 运行（桌面端为 Electron + ELECTRON_RUN_AS_NODE，用户无需安装 Node）
    command = process.execPath;
    args = [binary.file, ...args];
  }
  // CLI 自己再启动 `node` 子进程（hooks、MCP、子 Agent）时也指向 process.execPath
  env = withNodeShim(env, kernelsRoot());

  let child: ReturnType<typeof crossSpawn>;
  try {
    child = crossSpawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    issued?.revoke();
    mcpIssued?.revoke();
    if (promptPath) rmSync(promptPath, { force: true });
    throw error;
  }

  let stderrTail = "";
  let spawnError: Error | null = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

  const onAbort = (): void => {
    killTree(child);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  child.stdin?.on("error", () => undefined);
  child.stdin?.end(promptPath ? "" : request.prompt);

  const state: ParseState = {
    partialSinceLast: false,
    lastError: "",
    fatal: null,
  };
  let produced = false;
  const stray: string[] = [];

  try {
    if (child.stdout) {
      for await (const line of jsonlLines(child.stdout)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          stray.push(trimmed);
          if (stray.length > 20) stray.shift();
          continue;
        }
        const text = translate(def, event, state);
        if (text) {
          produced = true;
          yield { type: "text", text };
        }
      }
    }

    const code = await exited;
    if (request.signal.aborted) return;
    if (spawnError) {
      throw new AppError(
        502,
        "KERNEL_FAILED",
        `无法启动 ${def.name}：${(spawnError as Error).message}`,
      );
    }
    if (state.fatal) throw fail(state.fatal);
    if (code !== 0 && !produced) {
      throw fail(
        state.lastError ||
          stray.slice(-3).join(" ") ||
          stderrTail.slice(-600) ||
          `退出码 ${code}`,
      );
    }
    if (!produced) {
      throw fail(
        state.lastError || stderrTail.slice(-600) || "内核没有返回内容",
      );
    }
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null) killTree(child);
    issued?.revoke();
    mcpIssued?.revoke();
    if (promptPath) rmSync(promptPath, { force: true });
  }
}
