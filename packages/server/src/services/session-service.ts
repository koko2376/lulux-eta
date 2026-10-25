import { isEffortLevel, type EffortLevel } from "./models/effort.js";
import {
  BUILTIN_AGENT_ID,
  canonicalAgentId,
  DEFAULT_AGENT_ID,
  MEMBER_INSTANCE_MAX,
  memberInstanceId,
  splitMemberId,
} from "../agents.js";

/** 群聊默认主管：LULUX（与 chat/supervisor.ts 一致；这里不引用它以免循环依赖） */
const DEFAULT_SUPERVISOR_ID = BUILTIN_AGENT_ID;
import { db } from "../db.js";
import { AppError } from "../errors.js";
import type {
  HistoryMessage,
  Message,
  ParticipantRole,
  SessionParticipant,
  MessageRole,
  MessageRuntime,
  MessageAttachment,
  MessageUsage,
  Session,
  MemberProfile,
  SessionKind,
  ToolRound,
  ToolTraceEntry,
} from "../types.js";
import { newId } from "../utils/id.js";
import { transaction } from "../utils/tx.js";
import { agentService, isKnownAgentId, memberKernelId } from "./agent-service.js";
import { currentActor, type Actor } from "../context.js";
import { can, isServerMode } from "../security/access.js";
import { teamService } from "./auth-service.js";
import { removeSessionFiles } from "./session-files.js";
import { isPermissionLevel, type PermissionLevel } from "./permissions.js";
import {
  publishMessage,
  publishSessionChanged,
  publishSessionRemoved,
  sessionAudience,
} from "./session-hub.js";

/** 多人群聊最多的真人数（含群主） */
export const MAX_GROUP_HUMANS = 20;

export const NEW_SESSION_TITLE = "新会话";

/**
 * 客户端输入框“+”添加的引用上下文块（见 client/src/lib/composer-context.ts）：
 * 附在消息正文末尾，不能被当成用户输入写进标题。
 */
const REF_CONTEXT_RE =
  /<context\s+kind="[^"\n]*"\s+label="[^"\n]*">[\s\S]*?<\/context>/g;

/** 首条用户消息自动得到的临时标题（内置内核据此判断标题是否被用户改过） */
export function provisionalTitle(content: string): string {
  const text = content
    .replace(REF_CONTEXT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 只有引用块（没有正文）时不拿块内容当标题
  if (!text) return NEW_SESSION_TITLE;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

interface SessionRow {
  id: string;
  title: string;
  provider_id: string | null;
  group_name: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  preview: string | null;
  org_id: string;
  owner_id: string;
  visibility: string;
  team_id: string | null;
  supervisor_id?: string | null;
  permission_level?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  kind?: string | null;
  workflow_run_id?: string | null;
  avatar_look?: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  sender_agent_id: string | null;
  tool_trace: string | null;
  runtime: string | null;
  tool_rounds: string | null;
  reasoning?: string | null;
  usage?: string | null;
  finish_reason?: string | null;
  supervisor_role?: string | null;
  attachments?: string | null;
  sender_user_id?: string | null;
  sender_user_name?: string | null;
  created_at: number;
}

interface MemberRow {
  session_id: string;
  agent_id: string;
}

interface ProfileRow {
  session_id: string;
  agent_id: string;
  role: string;
  instructions: string;
  model: string | null;
}

export const MEMBER_ROLE_MAX = 16;
export const MEMBER_INSTRUCTIONS_MAX = 2000;

/** 有内容的成员资料（按会话分组）；只查给定会话 */
function profilesFor(sessionIds: string[]): Map<string, Record<string, MemberProfile>> {
  const map = new Map<string, Record<string, MemberProfile>>();
  if (sessionIds.length === 0) return map;
  const rows: ProfileRow[] = [];
  for (let i = 0; i < sessionIds.length; i += 500) {
    const chunk = sessionIds.slice(i, i + 500);
    rows.push(
      ...(db
        .prepare(
          `SELECT session_id, agent_id, role, instructions, model FROM session_members
           WHERE session_id IN (${chunk.map(() => "?").join(",")})
             AND (role <> '' OR instructions <> '' OR model IS NOT NULL)`,
        )
        .all(...chunk) as unknown as ProfileRow[]),
    );
  }
  for (const row of rows) {
    const entry = map.get(row.session_id) ?? {};
    entry[row.agent_id] = {
      role: row.role ?? "",
      instructions: row.instructions ?? "",
      model: row.model || null,
    };
    map.set(row.session_id, entry);
  }
  return map;
}

interface ParticipantRow {
  session_id: string;
  user_id: string;
  role: string;
  joined_at: number;
  name: string | null;
}

function participantRows(sessionIds: string[]): ParticipantRow[] {
  if (sessionIds.length === 0) return [];
  const rows: ParticipantRow[] = [];
  // SQLite 绑定参数上限：分批
  for (let i = 0; i < sessionIds.length; i += 400) {
    const batch = sessionIds.slice(i, i + 400);
    rows.push(
      ...(db
        .prepare(
          `SELECT p.session_id, p.user_id, p.role, p.joined_at, u.name FROM session_participants p
           LEFT JOIN users u ON u.id = p.user_id
           WHERE p.session_id IN (${batch.map(() => "?").join(",")})
           ORDER BY p.joined_at ASC, p.rowid ASC`,
        )
        .all(...batch) as unknown as ParticipantRow[]),
    );
  }
  return rows;
}

function participantsFor(
  row: SessionRow,
  extra: ParticipantRow[],
): SessionParticipant[] {
  if (row.kind !== "group") return [];
  return [
    {
      userId: row.owner_id,
      name: teamService.userName(row.owner_id),
      role: "owner",
      joinedAt: row.created_at,
    },
    ...extra
      .filter((p) => p.user_id !== row.owner_id)
      .map((p) => ({
        userId: p.user_id,
        name: p.name ?? "未知用户",
        role: (p.role === "admin" ? "admin" : "member") as ParticipantRole,
        joinedAt: p.joined_at,
      })),
  ];
}

function roleOf(
  row: { owner_id: string },
  participants: SessionParticipant[],
  actor: Actor = currentActor(),
): ParticipantRole {
  if (row.owner_id === actor.id) return "owner";
  return participants.find((p) => p.userId === actor.id)?.role ?? "member";
}

/** 会话形象编号：1..6；旧数据 / 异常值按 1 */
const AVATAR_LOOKS = 6;
function avatarLookOf(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= AVATAR_LOOKS ? n : 1;
}

/** 新会话的形象：接着这个账号上一个会话的下一个，侧栏相邻会话不撞形象 */
function nextAvatarLook(ownerId: string): number {
  const last = db
    .prepare("SELECT avatar_look FROM sessions WHERE owner_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(ownerId) as { avatar_look: number | null } | undefined;
  return last ? (avatarLookOf(last.avatar_look) % AVATAR_LOOKS) + 1 : 1;
}

function toSession(
  row: SessionRow,
  agentIds: string[],
  extra: ParticipantRow[] = participantRows([row.id]),
  profiles: Record<string, MemberProfile> | undefined = row.kind === "group"
    ? profilesFor([row.id]).get(row.id)
    : undefined,
): Session {
  const participants = participantsFor(row, extra);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind === "group" ? "group" : "single",
    groupName: row.group_name ?? null,
    providerId: row.provider_id,
    agentIds,
    memberProfiles: row.kind === "group" ? (profiles ?? {}) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0),
    preview: row.preview ?? "",
    ownerId: row.owner_id,
    ownerName: teamService.userName(row.owner_id),
    visibility: "private",
    teamId: row.team_id ?? null,
    supervisorId: row.supervisor_id || DEFAULT_SUPERVISOR_ID,
    permissionLevel: isPermissionLevel(row.permission_level)
      ? row.permission_level
      : null,
    model: row.model || null,
    reasoningEffort: isEffortLevel(row.reasoning_effort)
      ? row.reasoning_effort
      : null,
    workflowRunId: row.workflow_run_id ?? null,
    avatarLook: avatarLookOf(row.avatar_look),
    participants,
    myRole: roleOf(row, participants),
  };
}

/**
 * 会话严格按账号隔离（契约 §5.6a）：只看得到自己创建的会话和自己是成员的群聊。
 * admin / owner 也没有“看全部”；不再支持 team / org 共享。
 */
function sessionScope(actor: Actor = currentActor()): {
  sql: string;
  params: string[];
} {
  return {
    sql: `(s.org_id = ? AND (s.owner_id = ? OR EXISTS (
      SELECT 1 FROM session_participants sp WHERE sp.session_id = s.id AND sp.user_id = ?)))`,
    params: [actor.orgId, actor.id, actor.id],
  };
}

interface AccessRow {
  org_id: string;
  owner_id: string;
  kind: string | null;
}

function accessRow(id: string): AccessRow | undefined {
  return db
    .prepare("SELECT org_id, owner_id, kind FROM sessions WHERE id = ?")
    .get(id) as unknown as AccessRow | undefined;
}

/** 当前用户在会话里的角色；不是成员返回 null */
function accessRole(
  id: string,
  actor: Actor = currentActor(),
): ParticipantRole | null {
  const row = accessRow(id);
  if (!row || row.org_id !== actor.orgId) return null;
  if (row.owner_id === actor.id) return "owner";
  const p = db
    .prepare(
      "SELECT role FROM session_participants WHERE session_id = ? AND user_id = ?",
    )
    .get(id, actor.id) as { role: string } | undefined;
  if (!p) return null;
  return p.role === "admin" ? "admin" : "member";
}

function parseToolTrace(raw: string | null): ToolTraceEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ToolTraceEntry[]) : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseAttachments(raw: string | null): MessageAttachment[] {
  const parsed = parseJsonValue<unknown>(raw, []);
  return Array.isArray(parsed)
    ? (parsed as MessageAttachment[]).filter(
        (a) => a && a.kind === "image" && typeof a.path === "string",
      )
    : [];
}

function toMessage(row: MessageRow): Message {
  const senderUserId = row.role === "user" ? (row.sender_user_id ?? null) : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content,
    senderAgentId: row.sender_agent_id ?? null,
    senderUserId,
    senderName: senderUserId
      ? (row.sender_user_name ??
        (senderUserId === "local" ? null : "未知用户"))
      : null,
    toolTrace: parseToolTrace(row.tool_trace),
    runtime: parseJsonValue<MessageRuntime | null>(row.runtime, null),
    reasoning: row.reasoning ?? "",
    usage: parseJsonValue<MessageUsage | null>(row.usage ?? null, null),
    finishReason: row.finish_reason ?? null,
    ...(row.supervisor_role === "plan" || row.supervisor_role === "summary"
      ? { supervisorRole: row.supervisor_role }
      : {}),
    attachments: parseAttachments(row.attachments ?? null),
    createdAt: row.created_at,
  };
}

function toHistoryMessage(row: MessageRow): HistoryMessage {
  const rounds = parseJsonValue<ToolRound[]>(row.tool_rounds, []);
  return { ...toMessage(row), toolRounds: Array.isArray(rounds) ? rounds : [] };
}

export interface AddMessageOptions {
  senderAgentId?: string | null;
  toolTrace?: ToolTraceEntry[];
  toolRounds?: ToolRound[];
  runtime?: MessageRuntime | null;
  /** 内置内核扩展 */
  reasoning?: string;
  usage?: MessageUsage | null;
  finishReason?: string | null;
  /** 群聊主管的规划 / 汇总消息 */
  supervisorRole?: "plan" | "summary" | null;
  /** 用户消息的图片附件（引用） */
  attachments?: MessageAttachment[];
  /** 用户消息的发言人；省略时取当前请求者 */
  senderUserId?: string | null;
}

/** 消息 + 发言人名字（LEFT JOIN users） */
/** 与 chat/run-registry.ts 的 STREAMING_FINISH_REASON 一致：运行中的草稿消息 */
const STREAMING_FINISH_REASON = "streaming";

const MESSAGE_SELECT = `SELECT m.*, u.name AS sender_user_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id`;

function membersOf(sessionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT session_id, agent_id FROM session_members
       WHERE session_id = ?
       ORDER BY position ASC`,
    )
    .all(sessionId) as unknown as MemberRow[];
  return rows.map((row) => row.agent_id);
}

function membersBySession(): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT session_id, agent_id FROM session_members
       ORDER BY session_id ASC, position ASC`,
    )
    .all() as unknown as MemberRow[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.session_id);
    if (list) list.push(row.agent_id);
    else map.set(row.session_id, [row.agent_id]);
  }
  return map;
}

/** 新建 / 改群成员的输入：agentId 可以是内核 id（自动分配实例序号）或已有成员实例 id */
export interface MemberInput {
  agentId: string;
  role?: string | null;
  instructions?: string | null;
  model?: string | null;
}

export interface ResolvedMemberInput {
  id: string;
  role: string;
  instructions: string;
  model: string | null;
}

/** 一个群最多的 Agent 成员数 */
export const GROUP_MEMBER_MAX = 12;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, (ch) => (ch === "\n" ? ch : " ")).trim().slice(0, max);
}

/**
 * 成员输入 → 成员实例：同一内核第 1 个用内核 id，之后依次 #2、#3…；
 * 显式给出的实例 id 优先保留（改群时成员身份不变，历史消息仍归他）。未知内核忽略。
 */
export function resolveMemberInputs(inputs: MemberInput[]): ResolvedMemberInput[] {
  const used = new Set<string>();
  const valid = inputs
    .filter((item) => item && typeof item.agentId === "string" && isKnownAgentId(item.agentId.trim()))
    .map((item) => ({ ...item, agentId: item.agentId.trim() }));
  // 先占住显式实例 id
  const explicit = new Map<number, string>();
  valid.forEach((item, index) => {
    const id = canonicalAgentId(item.agentId.trim());
    if (splitMemberId(id).n > 1 && !used.has(id)) {
      used.add(id);
      explicit.set(index, id);
    }
  });
  const result: ResolvedMemberInput[] = [];
  valid.forEach((item, index) => {
    let id = explicit.get(index);
    if (!id) {
      const base = memberKernelId(item.agentId.trim());
      for (let n = 1; n <= MEMBER_INSTANCE_MAX; n++) {
        const candidate = memberInstanceId(base, n);
        if (!used.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) throw new AppError(400, "GROUP_MEMBER_LIMIT", `同一内核最多 ${MEMBER_INSTANCE_MAX} 个成员`);
      used.add(id);
    }
    const model = cleanText(item.model, 200);
    result.push({
      id,
      role: cleanText(item.role, MEMBER_ROLE_MAX).replace(/\n/g, " "),
      instructions: cleanText(item.instructions, MEMBER_INSTRUCTIONS_MAX),
      model: model || null,
    });
  });
  if (result.length > GROUP_MEMBER_MAX)
    throw new AppError(400, "GROUP_MEMBER_LIMIT", `一个群最多 ${GROUP_MEMBER_MAX} 个 Agent 成员`);
  return result;
}

function writeMembers(sessionId: string, members: ResolvedMemberInput[]): void {
  db.prepare("DELETE FROM session_members WHERE session_id = ?").run(sessionId);
  const insert = db.prepare(
    `INSERT INTO session_members (session_id, agent_id, position, role, instructions, model)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  members.forEach((member, index) => {
    insert.run(sessionId, member.id, index, member.role, member.instructions, member.model);
  });
}

function normalizeMembers(input: string[] | undefined): string[] {
  const valid = agentService.normalizeIds(input);
  return valid.length > 0 ? valid : [DEFAULT_AGENT_ID];
}

export const sessionService = {
  /** 自己的会话 + 自己是成员的群聊（scope=all 已废弃，按普通列表处理） */
  list(): Session[] {
    const scope = sessionScope();
    const rows = db
      .prepare(
        `SELECT s.*, (
           SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id
         ) AS message_count, (
           SELECT m.content FROM messages m
           WHERE m.session_id = s.id
           ORDER BY m.created_at DESC, m.rowid DESC
           LIMIT 1
         ) AS preview
         FROM sessions s
         WHERE ${scope.sql} AND s.workflow_run_id IS NULL
         ORDER BY s.updated_at DESC`,
      )
      .all(...scope.params) as unknown as SessionRow[];
    const members = membersBySession();
    const humans = new Map<string, ParticipantRow[]>();
    for (const p of participantRows(
      rows.filter((row) => row.kind === "group").map((row) => row.id),
    )) {
      const list = humans.get(p.session_id);
      if (list) list.push(p);
      else humans.set(p.session_id, [p]);
    }
    const profiles = profilesFor(
      rows.filter((row) => row.kind === "group").map((row) => row.id),
    );
    return rows.map((row) =>
      toSession(
        row,
        members.get(row.id) ?? [DEFAULT_AGENT_ID],
        humans.get(row.id) ?? [],
        profiles.get(row.id),
      ),
    );
  },

  get(id: string): Session | undefined {
    const row = db
      .prepare(
        `SELECT s.*, (
           SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id
         ) AS message_count, (
           SELECT m.content FROM messages m
           WHERE m.session_id = s.id
           ORDER BY m.created_at DESC, m.rowid DESC
           LIMIT 1
         ) AS preview
         FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as unknown as SessionRow | undefined;
    if (!row) return undefined;
    const agentIds = membersOf(row.id);
    return toSession(row, agentIds.length > 0 ? agentIds : [DEFAULT_AGENT_ID]);
  },

  /** 当前用户可见：负责人本人或群聊成员（admin 也不例外） */
  visible(id: string): Session | undefined {
    if (!accessRole(id)) return undefined;
    return sessionService.get(id);
  },

  /** 可以在里面发消息 / 停止 / 审批 / 上传：成员 + data:write */
  writable(id: string): boolean {
    return Boolean(accessRole(id)) && can("data:write");
  },

  /** 可以改会话设置（标题、群名、Agent 成员、主管）和管理真人成员：群主或群管理员 + data:write */
  manageable(id: string): boolean {
    const role = accessRole(id);
    return (role === "owner" || role === "admin") && can("data:write");
  },

  /** 当前用户是会话负责人（群主）；只有群主能删除会话 / 解散群聊、改成员角色 */
  owned(id: string): boolean {
    return accessRole(id) === "owner";
  },

  /** 当前用户在会话里的角色；不是成员返回 null */
  roleOf(id: string): ParticipantRole | null {
    return accessRole(id);
  },

  /** 会话里有没有群主以外的真人（多人群聊） */
  hasHumans(id: string): boolean {
    return Boolean(
      db
        .prepare("SELECT 1 FROM session_participants WHERE session_id = ? LIMIT 1")
        .get(id),
    );
  },

  /**
   * 邀请同事进群（契约 §6.10.2）。只有群聊、团队服务器模式；对方须是同组织未停用的账号。
   * 已在群里的忽略；返回新加入的 id。
   */
  addParticipants(
    id: string,
    userIds: string[],
    role: "admin" | "member" = "member",
  ): string[] {
    const actor = currentActor();
    const row = accessRow(id);
    if (!row) throw new AppError(404, "NOT_FOUND", "会话不存在");
    if (row.kind !== "group")
      throw new AppError(400, "SESSION_KIND", "单聊不能邀请同事；请新建群聊");
    const unique = [...new Set(userIds.map((u) => u.trim()).filter(Boolean))].filter(
      (u) => u !== row.owner_id,
    );
    if (unique.length === 0) return [];
    if (!isServerMode())
      throw new AppError(400, "SERVER_MODE_ONLY", "只有团队服务器模式可以邀请同事进群");
    for (const userId of unique) {
      if (!teamService.isOrgMember(userId, row.org_id))
        throw new AppError(400, "USER_NOT_FOUND", "只能邀请本组织在用的同事");
    }
    const existing = new Set(
      (
        db
          .prepare("SELECT user_id FROM session_participants WHERE session_id = ?")
          .all(id) as Array<{ user_id: string }>
      ).map((r) => r.user_id),
    );
    const fresh = unique.filter((u) => !existing.has(u));
    if (existing.size + fresh.length + 1 > MAX_GROUP_HUMANS)
      throw new AppError(400, "GROUP_FULL", `一个群最多 ${MAX_GROUP_HUMANS} 位同事`);
    if (fresh.length === 0) return [];
    const now = Date.now();
    transaction(() => {
      const insert = db.prepare(
        `INSERT INTO session_participants (session_id, user_id, role, added_by, joined_at) VALUES (?, ?, ?, ?, ?)`,
      );
      fresh.forEach((userId, index) =>
        insert.run(id, userId, role, actor.id, now + index),
      );
    });
    publishSessionChanged(id, sessionService.get(id));
    return fresh;
  },

  /** 移出 / 退出群聊（群主不在表里，不能被移出） */
  removeParticipant(id: string, userId: string): boolean {
    const before = sessionAudience(id);
    const result = db
      .prepare("DELETE FROM session_participants WHERE session_id = ? AND user_id = ?")
      .run(id, userId);
    const removed = Number(result.changes) > 0;
    if (removed) publishSessionChanged(id, sessionService.get(id), before);
    return removed;
  },

  setParticipantRole(id: string, userId: string, role: "admin" | "member"): boolean {
    const result = db
      .prepare("UPDATE session_participants SET role = ? WHERE session_id = ? AND user_id = ?")
      .run(role, id, userId);
    const changed = Number(result.changes) > 0;
    if (changed) publishSessionChanged(id, sessionService.get(id));
    return changed;
  },

  participantRole(id: string, userId: string): ParticipantRole | null {
    const row = accessRow(id);
    if (!row) return null;
    if (row.owner_id === userId) return "owner";
    const p = db
      .prepare("SELECT role FROM session_participants WHERE session_id = ? AND user_id = ?")
      .get(id, userId) as { role: string } | undefined;
    return p ? (p.role === "admin" ? "admin" : "member") : null;
  },

  members(id: string): string[] {
    const list = membersOf(id);
    return list.length > 0 ? list : [DEFAULT_AGENT_ID];
  },

  create(
    input: {
      title?: string;
      /** 默认按成员数推断（多于一个即群聊）；群聊总是新建的空会话 */
      kind?: SessionKind;
      groupName?: string | null;
      providerId?: string | null;
      agentIds?: string[];
      /** 群聊成员（带群头衔 / 职责 / 模型；同一内核可多次出现）。给了就忽略 agentIds */
      members?: MemberInput[];
      supervisorId?: string | null;
      /** 群聊：一起邀请的同事（团队服务器模式） */
      userIds?: string[];
      /** 会话权限级别；省略时跟随全局默认（NULL，契约 §6.11） */
      permissionLevel?: PermissionLevel | null;
    } = {},
  ): Session {
    const now = Date.now();
    const actor = currentActor();
    const owner = {
      orgId: actor.orgId,
      ownerId: actor.id,
      visibility: "private" as const,
      teamId: null,
    };
    const memberList = input.members?.length
      ? resolveMemberInputs(input.members)
      : null;
    if (memberList && memberList.length === 0)
      throw new AppError(400, "GROUP_MEMBERS", "群成员里没有可用的内核");
    const agentIds = memberList
      ? memberList.map((member) => member.id)
      : normalizeMembers(input.agentIds);
    // 给了成员资料就是群聊（一个成员 + 同事也是群聊）
    const kind: SessionKind = memberList
      ? "group"
      : (input.kind ?? (agentIds.length > 1 ? "group" : "single"));
    if (memberList && input.kind === "single")
      throw new AppError(400, "SESSION_KIND", "成员资料只属于群聊；请用 kind: group 新建群聊");
    if (kind === "single" && agentIds.some((id) => splitMemberId(id).n > 1))
      throw new AppError(400, "SESSION_KIND", "单聊只能有一个内核；同一内核多个成员请新建群聊");
    if (kind === "single" && agentIds.length > 1) {
      throw new AppError(400, "SESSION_KIND", "单聊只能有一个内核；多个成员请新建群聊");
    }
    const session: Session = {
      id: newId("ses"),
      title: input.title?.trim() || NEW_SESSION_TITLE,
      kind,
      groupName: kind === "group" ? input.groupName?.trim() || null : null,
      providerId: input.providerId?.trim() || null,
      agentIds,
      memberProfiles: {},
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      preview: "",
      ownerId: owner.ownerId,
      ownerName: teamService.userName(owner.ownerId),
      visibility: owner.visibility,
      teamId: owner.teamId,
      supervisorId: input.supervisorId || DEFAULT_SUPERVISOR_ID,
      permissionLevel: input.permissionLevel ?? null,
      model: null,
      reasoningEffort: null,
      workflowRunId: null,
      avatarLook: nextAvatarLook(owner.ownerId),
      participants: [],
      myRole: "owner",
    };
    if (kind === "single" && input.userIds?.some((u) => u && u !== owner.ownerId))
      throw new AppError(400, "SESSION_KIND", "单聊不能邀请同事；请新建群聊");

    db.prepare(
      `INSERT INTO sessions (id, title, kind, provider_id, group_name, created_at, updated_at, org_id, owner_id, visibility, team_id, supervisor_id, permission_level, avatar_look)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.title,
      session.kind,
      session.providerId,
      session.groupName,
      session.createdAt,
      session.updatedAt,
      owner.orgId,
      owner.ownerId,
      owner.visibility,
      owner.teamId,
      input.supervisorId && input.supervisorId !== DEFAULT_SUPERVISOR_ID
        ? input.supervisorId
        : null,
      session.permissionLevel,
      session.avatarLook,
    );

    writeMembers(
      session.id,
      memberList && kind === "group"
        ? memberList
        : agentIds.map((id) => ({ id, role: "", instructions: "", model: null })),
    );
    if (kind === "group") session.memberProfiles = profilesFor([session.id]).get(session.id) ?? {};

    if (kind === "group") {
      if (input.userIds?.length) {
        try {
          sessionService.addParticipants(session.id, input.userIds);
        } catch (error) {
          db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
          throw error;
        }
      }
      return sessionService.get(session.id)!;
    }
    return session;
  },

  rename(id: string, title: string): Session | undefined {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    // 改名不算会话活跃，保持列表原有排序
    const result = db
      .prepare("UPDATE sessions SET title = ? WHERE id = ?")
      .run(trimmed, id);
    return Number(result.changes) > 0 ? sessionService.changed(id) : undefined;
  },

  renameGroup(id: string, groupName: string | null): Session | undefined {
    const trimmed = groupName?.trim() || null;
    const result = db
      .prepare("UPDATE sessions SET group_name = ? WHERE id = ?")
      .run(trimmed, id);
    return Number(result.changes) > 0 ? sessionService.changed(id) : undefined;
  },

  /** 导入/恢复用：直接设定会话类型 */
  setKind(id: string, kind: SessionKind): void {
    db.prepare("UPDATE sessions SET kind = ? WHERE id = ?").run(kind, id);
  },

  /** 会话权限级别（契约 §6.11）；null 恢复为跟随全局默认。上限由调用方校验 */
  setPermissionLevel(
    id: string,
    level: PermissionLevel | null,
  ): Session | undefined {
    const result = db
      .prepare("UPDATE sessions SET permission_level = ? WHERE id = ?")
      .run(level, id);
    return Number(result.changes) > 0 ? sessionService.changed(id) : undefined;
  },

  /**
   * 会话模型 / 推理强度（契约 §6.13）。字段为 undefined 时不改；null 恢复默认。
   * providerId 同时写回 sessions.provider_id（内置内核 / scoped 内核按它选 Provider）。
   */
  setModelChoice(
    id: string,
    patch: {
      providerId?: string | null;
      model?: string | null;
      reasoningEffort?: EffortLevel | null;
    },
  ): Session | undefined {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    if (patch.providerId !== undefined) {
      sets.push("provider_id = ?");
      values.push(patch.providerId);
    }
    if (patch.model !== undefined) {
      sets.push("model = ?");
      values.push(patch.model);
    }
    if (patch.reasoningEffort !== undefined) {
      sets.push("reasoning_effort = ?");
      values.push(patch.reasoningEffort);
    }
    if (!sets.length) return sessionService.get(id);
    const result = db
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return Number(result.changes) > 0 ? sessionService.changed(id) : undefined;
  },

  /** 群聊主管：'builtin' / 成员 Agent id / 'none'；null 恢复默认（LULUX） */
  setSupervisor(id: string, supervisorId: string | null): Session | undefined {
    const value =
      supervisorId && supervisorId !== DEFAULT_SUPERVISOR_ID
        ? supervisorId
        : null;
    const result = db
      .prepare("UPDATE sessions SET supervisor_id = ? WHERE id = ?")
      .run(value, id);
    return Number(result.changes) > 0 ? sessionService.changed(id) : undefined;
  },

  /**
   * 改成员。单聊只能换成另一个内核（仍是单聊）；群聊在自身范围内增删成员（至少一个，仍是群聊）。
   * 单聊永远不会因为加成员变成群聊——群聊要新建。
   */
  setAgents(id: string, agentIds: string[]): Session | undefined {
    const current = sessionService.get(id);
    if (!current) return undefined;
    const members = normalizeMembers(agentIds);
    if (current.kind === "single" && members.length > 1) {
      throw new AppError(400, "SESSION_KIND", "单聊只能有一个内核；要多个成员一起聊，请新建群聊");
    }

    if (current.kind === "group" && members.length > GROUP_MEMBER_MAX)
      throw new AppError(400, "GROUP_MEMBER_LIMIT", `一个群最多 ${GROUP_MEMBER_MAX} 个 Agent 成员`);
    if (current.kind === "single" && splitMemberId(members[0]).n > 1)
      throw new AppError(400, "SESSION_KIND", "单聊只能有一个内核；同一内核多个成员请新建群聊");

    transaction(() => {
      // 留下的成员保留群头衔 / 职责 / 模型
      const kept = current.memberProfiles;
      writeMembers(
        id,
        members.map((agentId) => ({
          id: agentId,
          role: kept[agentId]?.role ?? "",
          instructions: kept[agentId]?.instructions ?? "",
          model: kept[agentId]?.model ?? null,
        })),
      );
      // 单聊换了内核：模型 / 推理强度属于原内核（模型列表不同），恢复默认（契约 §6.13）
      if (current.kind === "single" && current.agentIds[0] !== members[0]) {
        db.prepare(
          "UPDATE sessions SET model = NULL, reasoning_effort = NULL WHERE id = ?",
        ).run(id);
      }
      // 主管被移出群：恢复默认主管（LULUX）
      db.prepare(
        `UPDATE sessions SET supervisor_id = NULL WHERE id = ? AND supervisor_id IS NOT NULL AND supervisor_id NOT IN ('none', ?)
           AND supervisor_id NOT IN (SELECT agent_id FROM session_members WHERE session_id = ?)`,
      ).run(id, DEFAULT_SUPERVISOR_ID, id);
    });

    return sessionService.changed(id);
  },

  /**
   * 群聊：整体替换成员（含群头衔 / 职责 / 模型）。同一内核可出现多次；
   * 给出已有实例 id 的成员保持身份（历史消息、@ 都不变）。
   */
  setMembers(id: string, inputs: MemberInput[]): Session | undefined {
    const current = sessionService.get(id);
    if (!current) return undefined;
    if (current.kind !== "group")
      throw new AppError(400, "SESSION_KIND", "只有群聊能设置成员资料");
    const members = resolveMemberInputs(inputs);
    if (members.length === 0)
      throw new AppError(400, "GROUP_MEMBERS", "群里至少要有一个 Agent 成员");
    transaction(() => {
      writeMembers(id, members);
      db.prepare(
        `UPDATE sessions SET supervisor_id = NULL WHERE id = ? AND supervisor_id IS NOT NULL AND supervisor_id NOT IN ('none', ?)
           AND supervisor_id NOT IN (SELECT agent_id FROM session_members WHERE session_id = ?)`,
      ).run(id, DEFAULT_SUPERVISOR_ID, id);
    });
    return sessionService.changed(id);
  },

  /** 群聊：成员资料（只返回内容非空的） */
  memberProfiles(id: string): Record<string, MemberProfile> {
    return profilesFor([id]).get(id) ?? {};
  },

  /** 设置变更后：取最新会话并推给其他成员（多人群聊实时同步） */
  changed(id: string): Session | undefined {
    const session = sessionService.get(id);
    if (session && session.participants.length > 1)
      publishSessionChanged(id, session);
    return session;
  },

  /** 删除会话；消息由外键级联清理，会话工作区与 scoped 内核 HOME 目录一并删除 */
  remove(id: string): boolean {
    const audience = sessionAudience(id);
    const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    const removed = Number(result.changes) > 0;
    if (removed) {
      removeSessionFiles(id);
      publishSessionRemoved(id, audience);
    }
    return removed;
  },

  /** 删除自己的全部会话（含自己建的群聊）；别人的会话、别人建的群不动 */
  clear(): number {
    const actor = currentActor();
    const ids = (
      db
        .prepare("SELECT id FROM sessions WHERE org_id = ? AND owner_id = ?")
        .all(actor.orgId, actor.id) as Array<{ id: string }>
    ).map((row) => row.id);
    let removed = 0;
    for (const id of ids) if (sessionService.remove(id)) removed += 1;
    return removed;
  },

  messages(sessionId: string): Message[] {
    const rows = db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.session_id = ?
         ORDER BY m.created_at ASC, m.rowid ASC`,
      )
      .all(sessionId) as unknown as MessageRow[];
    return rows.map(toMessage);
  },

  /** 最近 limit 条消息（含工具轮次），按时间正序；用 SQL LIMIT 避免读全量 */
  recentHistory(sessionId: string, limit: number): HistoryMessage[] {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, m.rowid AS _r, u.name AS sender_user_name FROM messages m
           LEFT JOIN users u ON u.id = m.sender_user_id
           WHERE m.session_id = ? AND (m.finish_reason IS NULL OR m.finish_reason <> 'streaming')
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
         ) ORDER BY created_at ASC, _r ASC`,
      )
      .all(sessionId, limit) as unknown as MessageRow[];
    // 发言人名字只在多人群聊里交给模型（单人会话保持原样）
    const multi = sessionService.hasHumans(sessionId);
    return rows.map((row) => {
      const message = toHistoryMessage(row);
      return multi ? message : { ...message, senderName: null };
    });
  },

  addMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    options: AddMessageOptions = {},
  ): Message {
    const assistant = role === "assistant";
    const toolTrace = assistant ? (options.toolTrace ?? []) : [];
    const toolRounds = assistant ? (options.toolRounds ?? []) : [];
    const senderUserId =
      role === "user"
        ? options.senderUserId === undefined
          ? currentActor().id
          : options.senderUserId
        : null;
    const message: Message = {
      id: newId("msg"),
      sessionId,
      role,
      content,
      senderAgentId: assistant ? (options.senderAgentId ?? null) : null,
      senderUserId,
      senderName:
        senderUserId && senderUserId !== "local"
          ? teamService.userName(senderUserId)
          : null,
      toolTrace,
      runtime: assistant ? (options.runtime ?? null) : null,
      reasoning: assistant ? (options.reasoning ?? "") : "",
      usage: assistant ? (options.usage ?? null) : null,
      finishReason: assistant ? (options.finishReason ?? null) : null,
      ...(assistant && options.supervisorRole
        ? { supervisorRole: options.supervisorRole }
        : {}),
      attachments: role === "user" ? (options.attachments ?? []) : [],
      createdAt: Date.now(),
    };

    db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, sender_agent_id, tool_trace, runtime, tool_rounds, reasoning, usage, finish_reason, supervisor_role, attachments, sender_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.senderAgentId,
      toolTrace.length > 0 ? JSON.stringify(toolTrace) : null,
      message.runtime ? JSON.stringify(message.runtime) : null,
      toolRounds.some((round) => round.calls.length > 0)
        ? JSON.stringify(toolRounds)
        : null,
      message.reasoning || null,
      message.usage ? JSON.stringify(message.usage) : null,
      message.finishReason,
      message.supervisorRole ?? null,
      message.attachments.length > 0
        ? JSON.stringify(message.attachments)
        : null,
      senderUserId,
      message.createdAt,
    );

    const current = sessionService.get(sessionId);
    const shouldSetTitle =
      role === "user" &&
      current?.title === NEW_SESSION_TITLE &&
      content.trim().length > 0;

    if (shouldSetTitle) {
      const title = provisionalTitle(content);
      db.prepare(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
      ).run(title, message.createdAt, sessionId);
    } else {
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
        message.createdAt,
        sessionId,
      );
    }

    // 实时：推给会话成员（多人群聊里其他人立刻看到；与后台运行无关，落库即推）。
    // 运行中的草稿（finishReason='streaming'）不推：它会被多次节流更新，等 updateMessage 定稿时
    // 以同一 id 推一次 message（客户端按 id upsert），避免把草稿当成新消息刷屏。
    if (message.finishReason !== STREAMING_FINISH_REASON)
      publishMessage(sessionId, message, message);
    return message;
  },

  /**
   * 运行中逐步落库：更新一条助手消息（草稿 finishReason='streaming' → 最终状态）。
   * 草稿不进模型上下文（recentHistory 过滤），进程崩溃后启动时改为 'interrupted'。
   */
  updateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    options: AddMessageOptions = {},
  ): Message | undefined {
    const toolTrace = options.toolTrace ?? [];
    const toolRounds = options.toolRounds ?? [];
    const result = db
      .prepare(
        `UPDATE messages SET content = ?, tool_trace = ?, tool_rounds = ?, reasoning = ?, usage = ?, finish_reason = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(
        content,
        toolTrace.length > 0 ? JSON.stringify(toolTrace) : null,
        toolRounds.some((round) => round.calls.length > 0)
          ? JSON.stringify(toolRounds)
          : null,
        options.reasoning || null,
        options.usage ? JSON.stringify(options.usage) : null,
        options.finishReason ?? null,
        messageId,
        sessionId,
      );
    if (Number(result.changes) === 0) return undefined;
    const row = db
      .prepare(`${MESSAGE_SELECT} WHERE m.id = ?`)
      .get(messageId) as unknown as MessageRow;
    const message = toMessage(row);
    // 草稿定稿（streaming → 最终状态）时推一次 message；中间的节流更新不推
    if (message.finishReason !== STREAMING_FINISH_REASON)
      publishMessage(sessionId, message, message);
    return message;
  },

  /** 删除一条消息（运行中止且没有可保留内容时清理空草稿） */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const result = db
      .prepare("DELETE FROM messages WHERE id = ? AND session_id = ?")
      .run(messageId, sessionId);
    return Number(result.changes) > 0;
  },

  /** 内置内核：单条消息（含工具轮次） */
  message(sessionId: string, messageId: string): HistoryMessage | undefined {
    const row = db
      .prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.session_id = ?`)
      .get(messageId, sessionId) as unknown as MessageRow | undefined;
    return row ? toHistoryMessage(row) : undefined;
  },

  /** 内置内核：消息在会话中的位置之后（inclusive 时含自身）的全部消息删除，返回删除条数（编辑重发/重新生成的分支截断） */
  truncateFrom(
    sessionId: string,
    messageId: string,
    inclusive: boolean,
  ): number {
    const ordered = db
      .prepare(
        "SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as Array<{ id: string }>;
    const index = ordered.findIndex((row) => row.id === messageId);
    if (index < 0) return 0;
    const doomed = ordered
      .slice(inclusive ? index : index + 1)
      .map((row) => row.id);
    if (doomed.length === 0) return 0;
    transaction(() => {
      const del = db.prepare("DELETE FROM messages WHERE id = ?");
      for (const id of doomed) del.run(id);
      // 覆盖范围包含被删消息的上下文摘要作废
      db.prepare(
        `DELETE FROM chat_summaries WHERE session_id = ? AND upto_message_id IN (${doomed.map(() => "?").join(",")})`,
      ).run(sessionId, ...doomed);
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
        Date.now(),
        sessionId,
      );
    });
    return doomed.length;
  },

  /** 内置内核：会话绑定的业务上下文（当前客户/报价） */
  kernelContext(sessionId: string): {
    customerId: string | null;
    quoteId: string | null;
  } {
    const row = db
      .prepare("SELECT kernel_context FROM sessions WHERE id = ?")
      .get(sessionId) as unknown as
      { kernel_context: string | null } | undefined;
    const parsed = parseJsonValue<{
      customerId?: string | null;
      quoteId?: string | null;
    }>(row?.kernel_context ?? null, {});
    return {
      customerId: parsed.customerId ?? null,
      quoteId: parsed.quoteId ?? null,
    };
  },

  setKernelContext(
    sessionId: string,
    context: { customerId: string | null; quoteId: string | null },
  ): void {
    const empty = !context.customerId && !context.quoteId;
    db.prepare("UPDATE sessions SET kernel_context = ? WHERE id = ?").run(
      empty ? null : JSON.stringify(context),
      sessionId,
    );
  },

  /** 内置内核：自动生成标题后写回（不改变 updated_at 排序） */
  setGeneratedTitle(
    sessionId: string,
    expectedTitle: string,
    title: string,
  ): boolean {
    const result = db
      .prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ?")
      .run(title, sessionId, expectedTitle);
    return Number(result.changes) > 0;
  },
};
