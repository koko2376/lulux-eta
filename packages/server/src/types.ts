import type { ModelCapsMap, ReasoningChoice } from "./services/llm/capabilities.js";
export type ProviderKind = "openai" | "anthropic";

export type MessageRole = "system" | "user" | "assistant";

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 解密后的 Key；解密失败时为空串且 apiKeyError 有值 */
  apiKey: string;
  /** 库里存有 Key（无论能否解密） */
  hasStoredKey: boolean;
  apiKeyError: string | null;
  /** 当前使用的默认模型 */
  model: string;
  /** 服务商可用模型，默认模型一定在其中 */
  models: string[];
  /** 按模型保存的能力（手动设置的思考强度 / 发现模型时识别到的能力），键为模型名 */
  modelCaps: ModelCapsMap;
  createdAt: number;
}

export interface PublicProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  models: string[];
  createdAt: number;
  hasApiKey: boolean;
  /** 形如 `sk-…abcd`；没有 Key 或无法解密时为空串 */
  apiKeyPreview: string;
  /** Key 无法解密时的提示，正常为 null */
  apiKeyError: string | null;
  /** 每个模型的思考强度：manual = 手动设置（null = 自动检测），detected = 上游元数据，auto = 自动检测结果，effective = 实际生效 */
  modelReasoning: Record<
    string,
    {
      manual: ReasoningChoice | null;
      detected: ReasoningChoice | null;
      auto: ReasoningChoice;
      effective: ReasoningChoice;
    }
  >;
}

export type AgentKind = "builtin" | "kernel";

export interface Agent {
  id: string;
  name: string;
  description: string;
  avatar: string;
  accent: string;
  kind: AgentKind;
  kernelId: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export type MessageRuntime =
  | { kind: "provider"; providerName: string; model: string }
  | {
      kind: "kernel";
      kernelId: string;
      version: string | null;
      /** 内核模式（契约“内核网关”）；旧消息没有该字段 */
      mode?: "scoped" | "global";
      /** scoped：经由的 Provider 名与模型；global 为 null */
      providerName?: string | null;
      model?: string | null;
      /** 给界面直接显示的一行，如 “Claude Code 2.1.304 · 经由 DeepSeek/deepseek-chat” */
      label?: string;
    };

export type SessionKind = "single" | "group";

/** 群聊里的真人：owner = 群主（创建者），admin = 群管理员，member = 普通成员（契约 §6.10） */
export type ParticipantRole = "owner" | "admin" | "member";

export interface SessionParticipant {
  userId: string;
  name: string;
  role: ParticipantRole;
  joinedAt: number;
}

export interface Session {
  id: string;
  title: string;
  /** 会话类型：单聊恰好一个内核；群聊只能新建，单聊不会变成群聊 */
  kind: SessionKind;
  /** 群聊显示名；单聊为 null */
  groupName: string | null;
  providerId: string | null;
  /** 会话成员，第一个是主 Agent；单聊恰好一个，群聊一个或多个（是否群聊看 kind）。
   *  群聊里同一内核可多次进群：第 2 个起 id 带序号（kernel-claude-code#2） */
  agentIds: string[];
  /** 群聊成员资料（按成员 id）：群头衔、职责、模型；没设置的成员不出现 */
  memberProfiles: Record<string, MemberProfile>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  ownerId: string;
  ownerName: string;
  visibility: "private" | "team" | "org";
  teamId: string | null;
  /** 群聊主管：'builtin'（默认，LULUX）/ 成员 Agent id / 'none'（无主管） */
  supervisorId: string;
  /** 会话权限级别（契约 §6.11）：read | ask | full；null = 跟随全局默认 defaultPermissionLevel */
  permissionLevel: "read" | "ask" | "full" | null;
  /** 会话模型（契约 §6.13）：Provider 的模型名或 global CLI 内核的模型名；null = 默认 */
  model: string | null;
  /** 会话推理强度：off | low | medium | high | xhigh；null = 默认（内置内核跟随全局设置，CLI 内核用 CLI 自己的默认） */
  reasoningEffort: "off" | "low" | "medium" | "high" | "xhigh" | null;
  /** 工作流节点的隐藏会话：所属运行 id（不进会话列表，只读）；普通会话为 null */
  workflowRunId: string | null;
  /** 形象编号 1..6：单聊头像按它换形象（同一内核的会话在侧栏不重样） */
  avatarLook: number;
  /** 群聊的真人成员（群主在第一个）；单聊为空数组。多于一人即多人群聊 */
  participants: SessionParticipant[];
  /** 当前用户在本会话里的角色（列表 / 详情按请求者计算） */
  myRole: ParticipantRole;
}

/** 群聊成员资料：名字始终是内核原名，role 是贴在名字旁的群头衔（如“跟单员”） */
export interface MemberProfile {
  role: string;
  /** 职责说明：进入该成员的系统提示 */
  instructions: string;
  /** 该成员用的模型；null = 跟随会话 / 内核默认 */
  model: string | null;
}

export interface ToolCall {
  /** Provider 分配的调用 ID，回传工具结果时使用 */
  id: string;
  /** 暴露给模型的完整工具名（服务前缀 + 原工具名） */
  name: string;
  /** JSON 字符串，流式传输期间逐步拼出 */
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolTraceEntry {
  id: string;
  /** MCP Server 里的原始工具名 */
  name: string;
  server: string;
  arguments: string;
  ok: boolean;
  /** 用户是否批准；未要求确认时为 true */
  approved: boolean;
  result: string;
  durationMs: number;
  createdAt: number;
  /** 内置业务工具（契约 4.9）；旧数据没有该字段 */
  builtin?: boolean;
  risk?: "read" | "write";
}

/** 一轮模型输出：文本 + 模型发起的工具调用 + 对应结果（用于重建下一轮上下文） */
export interface ToolRound {
  text: string;
  calls: ToolCall[];
  results: Array<{ toolCallId: string; toolName: string; content: string }>;
}

/** 消息附件（目前只有图片）：文件在会话工作区里，消息只存引用，base64 只在请求上游时临时内联 */
export interface MessageAttachment {
  kind: "image";
  /** 会话工作区内的相对路径 */
  path: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  /** 助手消息的发言 Agent；用户消息为 null */
  senderAgentId: string | null;
  /** 用户消息由谁发出（账号 id）；助手 / 系统消息为 null */
  senderUserId: string | null;
  /** 用户消息发言人的显示名（多人群聊里显示）；查不到时为 null */
  senderName: string | null;
  /** 助手消息里执行过的工具调用，仅用于界面展示 */
  toolTrace: ToolTraceEntry[];
  /** 助手消息的实际运行者 */
  runtime: MessageRuntime | null;
  /** 内置内核：推理/思考内容（无则空串） */
  reasoning: string;
  /** 内置内核：本条回复累计 token 用量与估算费用（内核类或旧消息为 null） */
  usage: MessageUsage | null;
  /** 结束原因：stop | length | tool_limit | aborted | error；用户消息/旧消息为 null */
  finishReason: string | null;
  /** 群聊主管的规划 / 汇总消息（其他消息没有该字段） */
  supervisorRole?: "plan" | "summary";
  /** 用户消息的附件（图片）；没有为空数组 */
  attachments: MessageAttachment[];
  createdAt: number;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** 上游未返回 usage、按字符估算 */
  estimated: boolean;
  /** 上游调用次数（含重试成功的那次、续写、工具轮次） */
  calls: number;
  cost: number | null;
  currency: string | null;
}

/** 内部使用：带工具轮次的消息，用于构建上下文 */
export interface HistoryMessage extends Message {
  toolRounds: ToolRound[];
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** 命令是否已经过确认（与当前 command/args/env 匹配） */
  approved: boolean;
  createdAt: number;
  /** 传输：stdio（本机命令，默认）| http（远程 Streamable HTTP，见契约 §8） */
  transport: "stdio" | "http";
  /** http 传输的地址；stdio 为 '' */
  url: string;
  /** http 传输的请求头（如 Authorization）；加密存储，接口只返回键名 headerKeys */
  headers: Record<string, string>;
  /** 创建者：user（设置页）| agent（Agent 经 mcp_add 添加） */
  createdBy: "user" | "agent";
}

export interface ChatTurn {
  role: MessageRole | "tool";
  content: string;
  /** role=assistant 时模型发起的工具调用 */
  toolCalls?: ToolCall[];
  /** role=tool 时对应的调用 ID 与工具名 */
  toolCallId?: string;
  toolName?: string;
  /**
   * 内置内核：本次回复工具循环内的推理内容，只在同一回复的后续轮次回传
   * （DeepSeek 思考模式工具调用需要 reasoning_content；Anthropic 需要带签名的 thinking 块）。
   * 历史消息不带，适配器对未设置的字段不发送。
   */
  reasoning?: string;
  reasoningBlocks?: Array<
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
  >;
  /** 内部：该轮次来自哪条已落库消息（压缩时定位摘要覆盖范围），不发给上游 */
  messageId?: string;
  /**
   * role=user 时附带的图片。历史里只有引用（path）；请求上游前由 services/chat/vision.ts 读文件内联 data（base64）。
   * 适配器只发送带 data 的图片；模型不支持看图时整段被去掉（消息正文里已有文件路径作为文字兜底）。
   */
  images?: TurnImage[];
  /** 内部：这条 user 轮是工具（电脑操作）交给模型的截图，不是用户发言；不落库、不发给上游的字段 */
  toolImages?: boolean;
}

export interface TurnImage {
  mime: string;
  /** 会话工作区相对路径（来自消息附件）；网关转发的图片没有 */
  path?: string;
  name?: string;
  /** base64（不含 data: 前缀），只在请求时存在 */
  data?: string;
  width?: number | null;
  height?: number | null;
}
