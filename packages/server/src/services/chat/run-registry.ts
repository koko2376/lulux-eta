/**
 * 会话运行管理（RunManager）：一次对话（单聊 / 群聊含主管规划与汇总）由服务端持有，
 * 与发起它的 HTTP 响应无关——客户端断开、刷新、关窗都不会中止它（契约 §6.9）。
 *
 * - 每个会话同一时间只有一个运行；再发起返回 409 RUN_ACTIVE（不再“新请求取代旧请求”）。
 * - 运行期间的 SSE 事件按 seq 编号缓存在内存，GET /api/sessions/:id/stream?after=<seq> 先回放再推实时。
 * - 只有显式取消（POST /api/sessions/:id/cancel 或 /api/chat/stop）或服务关闭才会中止。
 * - 服务关闭时中止所有运行，草稿消息标记为 interrupted；进程被强杀时由启动恢复兜底。
 */
import { db } from "../../db.js";
import { AppError } from "../../errors.js";
import { newId } from "../../utils/id.js";
import { eventBus } from "../events.js";
import { publishSessionEvent, sessionAudience } from "../session-hub.js";

export type StopReason = "user" | "shutdown" | "disconnected";
export type RunStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export type RunSource = "chat" | "schedule" | "workflow" | "internal";

export interface RunEvent {
  seq: number;
  event: string;
  payload: unknown;
}

interface Listener {
  onEvent(event: RunEvent): void;
  onEnd(run: ChatRun): void;
}

/** 单个运行最多缓存的事件数；超出后丢弃最早的（回放从仍在缓存的最早事件开始） */
export const MAX_BUFFERED_EVENTS = 50_000;
/** 运行结束后保留缓存的时间：让刚断线的客户端还能取到尾部事件 */
export const FINISHED_RETENTION_MS = 2 * 60_000;

/** 草稿消息的 finishReason：运行中逐步落库，不进模型上下文 */
export const STREAMING_FINISH_REASON = "streaming";
export const INTERRUPTED_FINISH_REASON = "interrupted";

export class ChatRun {
  readonly id = newId("run");
  readonly startedAt = Date.now();
  endedAt: number | null = null;
  status: RunStatus = "running";
  reason: StopReason | null = null;
  readonly controller = new AbortController();
  readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;
  private events: RunEvent[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private sawError = false;
  private sawDone = false;

  constructor(
    readonly sessionId: string,
    readonly source: RunSource,
  ) {
    this.done = new Promise<void>((resolve) => (this.resolveDone = resolve));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get running(): boolean {
    return this.status === "running";
  }

  /** 记录一个事件并推给所有订阅者 */
  emit(event: string, payload: unknown): void {
    if (!this.running) return;
    if (event === "error") this.sawError = true;
    if (event === "done") this.sawDone = true;
    const entry: RunEvent = { seq: ++this.seq, event, payload };
    this.events.push(entry);
    if (this.events.length > MAX_BUFFERED_EVENTS)
      this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    for (const listener of [...this.listeners]) {
      try {
        listener.onEvent(entry);
      } catch {
        // 订阅方自己处理断开
      }
    }
  }

  /** seq > after 的缓存事件 */
  replay(after = 0): RunEvent[] {
    return this.events.filter((entry) => entry.seq > after);
  }

  /** 先同步回放 seq > after 的事件，再订阅实时事件；运行已结束时回放后立刻 onEnd。返回取消订阅 */
  subscribe(
    after: number,
    onEvent: (event: RunEvent) => void,
    onEnd: (run: ChatRun) => void,
  ): () => void {
    for (const entry of this.replay(after)) onEvent(entry);
    if (!this.running) {
      onEnd(this);
      return () => undefined;
    }
    const listener: Listener = { onEvent, onEnd };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 中止运行；已结束或已在中止返回 false */
  cancel(reason: StopReason): boolean {
    if (!this.running || this.controller.signal.aborted) return false;
    this.reason = reason;
    this.controller.abort(reason);
    return true;
  }

  /** 运行结束（编排器 finally 调用）：确定状态、通知订阅者、移入“最近结束” */
  finish(): void {
    if (!this.running) return;
    this.status =
      this.reason === "user" || this.reason === "disconnected"
        ? "cancelled"
        : this.reason === "shutdown"
          ? "interrupted"
          : this.sawError && !this.sawDone
            ? "failed"
            : "completed";
    this.endedAt = Date.now();
    for (const listener of [...this.listeners]) {
      try {
        listener.onEnd(this);
      } catch {
        // ignore
      }
    }
    this.listeners.clear();
    if (active.get(this.sessionId) === this) active.delete(this.sessionId);
    recent.set(this.sessionId, this);
    const timer = setTimeout(() => {
      if (recent.get(this.sessionId) === this) recent.delete(this.sessionId);
    }, FINISHED_RETENTION_MS);
    timer.unref?.();
    publishRunState(this);
    this.resolveDone();
  }

  toPublic(): PublicRun {
    return {
      id: this.id,
      sessionId: this.sessionId,
      status: this.status,
      source: this.source,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastSeq: this.seq,
    };
  }
}

export interface PublicRun {
  id: string;
  sessionId: string;
  status: RunStatus;
  source: RunSource;
  startedAt: number;
  endedAt: number | null;
  lastSeq: number;
}

const active = new Map<string, ChatRun>();
const recent = new Map<string, ChatRun>();

/**
 * 运行开始 / 结束：
 * - 全局 /api/events 推 session.run，只给会话的真人成员（群主 + session_participants，契约 §5.6a / §6.10）；
 * - 会话事件流 GET /api/sessions/:id/events 推 run（多人群聊里其他成员据此接上运行流，不必轮询 pending）。
 */
function publishRunState(run: ChatRun): void {
  try {
    const audience = sessionAudience(run.sessionId);
    if (!audience) return;
    const payload = {
      sessionId: run.sessionId,
      running: run.running,
      runId: run.id,
      status: run.status,
      lastSeq: run.lastSeq,
    };
    eventBus.publish("session.run", payload, {
      userIds: audience.userIds,
      orgId: audience.orgId,
    });
    publishSessionEvent(run.sessionId, "run", payload);
  } catch {
    // 数据库已关闭（进程退出中）
  }
}

/** 开始一个运行；该会话已有运行时抛 409 RUN_ACTIVE */
export function startRun(
  sessionId: string,
  source: RunSource = "chat",
): ChatRun {
  const current = active.get(sessionId);
  if (current?.running)
    throw new AppError(
      409,
      "RUN_ACTIVE",
      "这个会话正在运行，请等它完成或先停止",
    );
  const run = new ChatRun(sessionId, source);
  active.set(sessionId, run);
  recent.delete(sessionId);
  publishRunState(run);
  return run;
}

export function activeRun(sessionId: string): ChatRun | undefined {
  return active.get(sessionId);
}

/** 进行中的运行，没有时取刚结束的（供尾部回放） */
export function latestRun(sessionId: string): ChatRun | undefined {
  return active.get(sessionId) ?? recent.get(sessionId);
}

/** 用户停止；没有进行中的对话返回 false */
export function stopRun(
  sessionId: string,
  reason: StopReason = "user",
): boolean {
  return active.get(sessionId)?.cancel(reason) ?? false;
}

export function isRunning(sessionId: string): boolean {
  return active.has(sessionId);
}

export function runState(sessionId: string): {
  running: boolean;
  activeRunId: string | null;
} {
  const run = active.get(sessionId);
  return { running: Boolean(run), activeRunId: run?.id ?? null };
}

/** 服务关闭：中止全部运行（草稿按 interrupted 落库），最多等 timeoutMs */
/** 服务关闭 / 进程被强杀后，被打断的运行统一使用的文案（与启动恢复一致） */
export const SHUTDOWN_INTERRUPTED_MESSAGE = "服务重启，运行被中断";

let shuttingDown = false;

/** 服务是否正在关闭：此时被中止的运行应记为“被中断”，而不是“没有产生回复” */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** 仅供测试：复位关闭标记 */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
}

export async function shutdownRuns(timeoutMs = 2500): Promise<number> {
  shuttingDown = true;
  const runs = [...active.values()];
  for (const run of runs) run.cancel("shutdown");
  if (runs.length > 0) {
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }
  // 兜底：超时没收尾的草稿直接标记
  recoverInterruptedMessages(true);
  return runs.length;
}

/**
 * 启动恢复：上次进程退出时还在生成的草稿消息（finishReason='streaming'）改为 interrupted。
 * 默认跳过仍有活跃运行的会话；force（关闭兜底）时全部标记。
 */
export function recoverInterruptedMessages(force = false): number {
  try {
    const rows = db
      .prepare("SELECT id, session_id FROM messages WHERE finish_reason = ?")
      .all(STREAMING_FINISH_REASON) as unknown as Array<{
      id: string;
      session_id: string;
    }>;
    const update = db.prepare(
      "UPDATE messages SET finish_reason = ? WHERE id = ?",
    );
    let changed = 0;
    for (const row of rows) {
      if (!force && active.get(row.session_id)?.running) continue;
      update.run(INTERRUPTED_FINISH_REASON, row.id);
      changed += 1;
    }
    return changed;
  } catch {
    return 0;
  }
}

/** 测试用：当前所有活跃运行 */
export function activeRuns(): ChatRun[] {
  return [...active.values()];
}
