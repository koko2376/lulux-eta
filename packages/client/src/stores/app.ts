import { sessionModelKernel, type EffortLevel, type ModelCatalog } from '../lib/models'
import { defaultLevelFromSettings, effectiveLevel, type PermissionInfo, type PermissionLevel } from '../lib/permissions'
import { defineStore, getActivePinia } from 'pinia'
import * as api from '../api'
import { sessionFileUrl } from '../api/skills'
import { localized, t, withParen } from '../i18n'
import {
  draftKey,
  emptyDraft,
  isEmptyDraft,
  mergeDrafts,
  type ComposerAttachment,
  type ReturnedDraft,
  type SessionDraft,
} from '../lib/composer-draft'
import { onAccountReset } from '../lib/session'
import { clearSessionImageCache } from '../lib/session-images'
import { resetBrowserAgent } from './browser-agent'
import { resetComputerAgent } from './computer-agent'
import { isGroupSession } from '../lib/session-name'
import { mergeMessage } from '../lib/group-members'
import { findMemberAgent } from '../lib/members'
import { syncTrashRetention } from '../lib/trash'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每个会话一个本地流（切到别的会话时流继续在后台读，切回来能接着显示） */
const controllers = new Map<string, AbortController>()
/** 远端运行中（本窗口没有持有流，例如刷新后）的会话：轮询 /api/chat/pending */
const pollers = new Map<string, number>()
/** 最近一次应用的运行状态（runId:running）：全局 session.run 与会话事件流 run 会推同一次变化，只处理一次 */
const lastRunState = new Map<string, string>()
/** 本窗口删掉的会话：删除前发出、删除后才返回的列表请求不能把它写回侧栏 */
const deletedIds = new Set<string>()
/** 正在新建的会话（没有会话时连发几条 / 同时粘贴附件，只建一个） */
let creatingSession: Promise<string> | null = null
/** 账户切换计数：退出登录 / 会话失效 / 换账号后，之前发出的请求结果一律丢弃 */
let accountEpoch = 0
let noticeSeq = 0

/** 断网后最多重连几次（离线时等到恢复联网再试，不计次） */
const MAX_RECONNECTS = 8

/** 等到恢复联网或退避时间到（先到者为准）；离线时只等 online 事件 */
function waitForNetwork(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    let timer: number | null = null
    const done = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('online', done)
      resolve()
    }
    window.addEventListener('online', done)
    if (!offline) timer = window.setTimeout(done, delayMs)
  })
}

// 退出登录 / 会话失效 / 换账号：清空内存里上一个账号的数据，停掉后台流与轮询
onAccountReset(() => {
  const pinia = getActivePinia()
  if (pinia) useAppStore(pinia).resetForAccountSwitch()
})

/** 发消息前校验失败时，告诉用户去哪里解决 */
const ERROR_HINTS: Record<string, string> = localized(() => ({
  KERNEL_UNAVAILABLE: t('storeApp.kdcyudm'),
  KERNEL_LOGIN_REQUIRED: t('storeApp.kid6inf'),
  NO_PROVIDER: t('storeApp.k3hxcmv'),
  NO_MODEL: t('storeApp.k1pctwdq'),
  API_KEY_UNAVAILABLE: t('storeApp.k1to7wxf'),
}))

function withHint(error: api.ApiError): string {
  const hint = ERROR_HINTS[error.code]
  return hint ? withParen(error.message, hint) : error.message
}

/** 脚本生成的二进制产物（docx/xlsx/pptx/pdf…） */
export interface FileArtifact {
  path: string
  title: string
  size: number
  mime: string
  downloadUrl: string
  createdAt: number
}

/** 流式过程中正在展示的工具调用状态 */
export interface StreamToolView {
  requestId: string
  agentId: string
  name: string
  server: string
  arguments: string
  status: 'pending' | 'running' | 'done' | 'error' | 'denied'
  result: string
  durationMs: number
  risk?: 'read' | 'write'
  approvalKind?: string
  detail?: unknown
  canRemember?: boolean
}

/** 生成过程中的状态提示（契约 §6.8-8） */
export interface RunNotice {
  id: number
  kind:
    | 'retry'
    | 'continuation'
    | 'tool_limit'
    | 'compaction'
    | 'downgrade'
    | 'stopped'
    | 'skill'
    | 'vision'
    | 'unavailable'
    | 'reconnecting'
  text: string
}

/** 一个会话正在进行的生成 */
export interface RunState {
  sessionId: string
  /** true = 本窗口持有 SSE 流；false = 只知道服务端在跑（切回会话 / 刷新后用 pending 恢复） */
  local: boolean
  mode: 'send' | 'regenerate' | 'edit'
  agentId: string | null
  runtime: api.Runtime | null
  text: string
  reasoning: string
  tools: StreamToolView[]
  notices: RunNotice[]
  /** start.speakers：本轮将由谁回答（群聊）；主管派发后更新为 主管 → 成员… → 主管 */
  speakers: string[]
  /** 本轮的主管（群聊，无主管为 null） */
  supervisorId: string | null
  /** 当前发言者的角色（群聊主管：plan / summary） */
  role: 'plan' | 'member' | 'summary' | null
  stopping: boolean
  /** 本轮（群聊为当前成员）开始等待/思考的时间；切回会话恢复的运行不知道起点，为 null */
  thinkStartedAt: number | null
  /** 第一个正文 token 或工具调用到达的时间（思考结束） */
  thinkEndedAt: number | null
  /** 已收到的最后一个运行事件 seq（断线后从这里续接，契约 §6.9） */
  lastSeq: number
  /** 重新接上的运行：缓存事件还在回放（回放期间不计思考用时） */
  replaying: boolean
  /** 流因断网中断，正在等待重新接上 */
  reconnecting: boolean
  /** 本次断网已重连的次数（收到新事件后清零） */
  reconnects: number
}

/** 流的结束情况：是否收到过服务端事件、是否被停止 */
interface StreamFlags {
  started: boolean
  aborted: boolean
  /** 流已开始后因断网中断（服务端可能还在生成） */
  network?: boolean
}

/** 运行中的草稿消息（服务端逐步落库，契约 §6.9）：本窗口持有流时由流渲染，列表里不重复显示 */
function withoutDrafts(messages: api.Message[]): api.Message[] {
  return messages.filter((m) => m.finishReason !== 'streaming')
}

function newRun(sessionId: string, local: boolean, mode: RunState['mode'] = 'send'): RunState {
  return {
    sessionId,
    local,
    mode,
    agentId: null,
    runtime: null,
    text: '',
    reasoning: '',
    tools: [],
    notices: [],
    speakers: [],
    supervisorId: null,
    role: null,
    stopping: false,
    thinkStartedAt: local ? Date.now() : null,
    thinkEndedAt: null,
    lastSeq: 0,
    replaying: false,
    reconnecting: false,
    reconnects: 0,
  }
}

/** 思考阶段结束（第一个正文 token / 工具调用） */
function endThinking(run: RunState): void {
  if (run.thinkStartedAt !== null && run.thinkEndedAt === null) run.thinkEndedAt = Date.now()
}

export function retryNoticeText(data: api.StreamRetry): string {
  const seconds = Math.max(0, Math.round(data.delayMs / 100) / 10)
  const why =
    data.code === 'EMPTY_REPLY'
      ? t('storeApp.k17e6wjh')
      : data.code === 'UPSTREAM_RATE_LIMITED'
        ? t('storeApp.kywh87')
        : data.code === 'UPSTREAM_OVERLOADED'
          ? t('storeApp.klcnmyf')
          : data.code === 'UPSTREAM_TIMEOUT'
            ? t('storeApp.k1if30hw')
            : data.code === 'UPSTREAM_UNREACHABLE'
              ? t('storeApp.kjjs74u')
              : data.status
                ? t('storeApp.k1kqw8kd', [data.status])
                : t('storeApp.k4iacy1')
  return t('storeApp.kqq5v9q', [why, data.attempt, data.maxRetries, seconds])
}

export function compactionNoticeText(data: api.StreamCompaction): string {
  if (data.kind === 'tool_results') return t('storeApp.khp76b8')
  if (data.kind === 'images') return t('vision.droppedOld', [data.droppedImages])
  return data.ok ? t('storeApp.klqriu5', [data.summarizedMessages]) : t('storeApp.k52dhoi')
}

let selectTicket = 0
/** 有会话正在打开（用户刚点了某个会话，结果还没回来） */
export function sessionSelectPending(): boolean {
  return selectPending > 0
}
let selectPending = 0

export const useAppStore = defineStore('app', {
  state: () => ({
    sessions: [] as api.Session[],
    providers: [] as api.Provider[],
    agents: [] as api.Agent[],
    mcpServers: [] as api.McpServer[],
    settings: {} as Record<string, string>,
    currentSessionId: null as string | null,
    messages: [] as api.Message[],
    /** 按会话的进行中生成 */
    runs: {} as Record<string, RunState>,
    /** 已完成消息上保留的状态提示（只在本窗口，刷新后不保留） */
    messageNotices: {} as Record<string, RunNotice[]>,
    /** 已完成消息的思考用时（ms，只在本窗口；刷新后没有） */
    thinkDurations: {} as Record<string, number>,
    /** artifact 事件：让产物面板打开并定位（seq 每次递增以触发 watch） */
    artifactFocus: null as {
      sessionId: string
      title: string
      language: string
      seq: number
      /** 二进制产物：工作区相对路径 */
      path?: string
    } | null,
    /** 脚本生成的二进制产物（artifact 事件 binary=true），按会话记录；面板另从工作区文件列表补齐 */
    fileArtifacts: {} as Record<string, FileArtifact[]>,
    /** 正在“编辑重发”的用户消息（内容放进输入框） */
    editing: null as { messageId: string; content: string; dropCount: number } | null,
    /** 当前会话绑定的客户 / 报价（契约 §6.4） */
    context: { customerId: null, quoteId: null } as api.SessionContext,
    /** 绑定的客户公司名 / 报价单号（标题栏插头与输入框固定标签共用，由 ChatView 解析） */
    contextNames: { customer: '', quote: '' },
    error: '',
    ready: false,
    /** 请求未被服务端接受时退回给输入框的草稿（用户原文 + 原附件；只填回它所属的会话） */
    failedDraft: null as ReturnedDraft | null,
    /** 按会话保存的输入框草稿（不在看的会话；正在看的会话由输入框自己持有） */
    drafts: {} as Record<string, SessionDraft>,
    /** 最近一次在本窗口新建的会话：从“还没有会话”的新对话进入它时，输入框的草稿跟过去 */
    createdSessionId: null as string | null,
    /** 账户切换计数（退出登录 / 会话失效 / 换账号时递增），输入框据此丢掉上一个账号的草稿 */
    accountEpoch: 0,
    /** 权限选择器信息（GET /api/permissions，契约 §6.11）；旧服务端为 null */
    permissionInfo: null as PermissionInfo | null,
    /** 还没有会话时在选择器里选的级别：新建会话时带上 */
    pendingPermissionLevel: null as PermissionLevel | null,
    /** 模型选择器（契约 §6.13）：各内核的模型列表缓存；还没有会话时选的模型 / 推理强度（新建会话时带上） */
    modelCatalogs: {} as Record<string, ModelCatalog | null>,
    pendingModel: null as { kernel: string; providerId: string | null; model: string | null } | null,
    pendingEffort: null as { kernel: string; effort: EffortLevel | null } | null,
  }),

  getters: {
    currentSession(state): api.Session | null {
      return state.sessions.find((session) => session.id === state.currentSessionId) ?? null
    },
    currentRun(state): RunState | null {
      return state.currentSessionId ? (state.runs[state.currentSessionId] ?? null) : null
    },
    /** 当前查看的会话是否在生成（其它会话可以同时在后台生成） */
    streaming(): boolean {
      return this.currentRun !== null
    },
    streamingAgentId(): string | null {
      return this.currentRun?.agentId ?? null
    },
    streamRuntime(): api.Runtime | null {
      return this.currentRun?.runtime ?? null
    },
    streamText(): string {
      return this.currentRun?.text ?? ''
    },
    streamReasoning(): string {
      return this.currentRun?.reasoning ?? ''
    },
    streamTools(): StreamToolView[] {
      return this.currentRun?.tools ?? []
    },
    streamNotices(): RunNotice[] {
      return this.currentRun?.notices ?? []
    },
    defaultProvider(state): api.Provider | null {
      const preferredId = state.settings.defaultProviderId
      const preferred = preferredId ? state.providers.find((provider) => provider.id === preferredId) : undefined
      return preferred ?? state.providers[0] ?? null
    },
    currentAgents(state): api.Agent[] {
      const session = state.sessions.find((item) => item.id === state.currentSessionId)
      if (!session) return []
      const ids = session.agentIds
      return ids
        .map((id) => findMemberAgent(state.agents, id))
        .filter((agent): agent is api.Agent => Boolean(agent))
    },
    /** 当前会话是否群聊：看会话类型，不看成员数 */
    isGroupChat(): boolean {
      return isGroupSession(this.currentSession)
    },
    toolApprovalMode(state): 'ask' | 'auto' {
      return state.settings.toolApproval === 'auto' ? 'auto' : 'ask'
    },
    /** 新会话默认级别（设置 defaultPermissionLevel；旧服务端按 toolApproval 换算） */
    defaultPermissionLevel(state): PermissionLevel {
      if (state.settings.defaultPermissionLevel || state.settings.toolApproval)
        return defaultLevelFromSettings(state.settings)
      return state.permissionInfo?.defaultLevel ?? 'ask'
    },
    /** 当前用户的上限（desktop / 旧服务端为 full） */
    permissionCap(state): PermissionLevel {
      return state.permissionInfo?.cap ?? 'full'
    },
    /** 模型选择器按哪个内核列模型：群聊 → LULUX；单聊 → 它的内核；还没有会话 → 默认 Agent */
    currentModelKernel(): string {
      return sessionModelKernel(this.currentSession, this.agents, this.settings.defaultAgentId || 'builtin')
    },
    /** 当前会话（或待建会话）选的模型 */
    currentModelChoice(): { providerId: string | null; model: string | null } {
      const session = this.currentSession
      if (session) return { providerId: session.providerId, model: session.model ?? null }
      const pending = this.pendingModel?.kernel === this.currentModelKernel ? this.pendingModel : null
      return { providerId: pending?.providerId ?? null, model: pending?.model ?? null }
    },
    /** 当前会话（或待建会话）设置的推理强度（null = 默认） */
    currentEffortSetting(): EffortLevel | null {
      const session = this.currentSession
      if (session) return session.reasoningEffort ?? null
      return this.pendingEffort?.kernel === this.currentModelKernel ? this.pendingEffort.effort : null
    },
    /** 当前会话（或待建会话）实际生效的级别 */
    currentPermissionLevel(): PermissionLevel {
      const stored = this.currentSession ? (this.currentSession.permissionLevel ?? null) : this.pendingPermissionLevel
      return effectiveLevel(stored, this.defaultPermissionLevel, this.permissionCap)
    },
  },

  actions: {
    /**
     * 退出登录 / 会话失效 / 换账号：停掉所有后台流与轮询，清空上一个账号的会话、消息、设置和草稿，
     * 下一个账号进入 Agent 页时重新 bootstrap。
     */
    resetForAccountSwitch(): void {
      accountEpoch += 1
      selectTicket += 1
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      for (const timer of pollers.values()) window.clearInterval(timer)
      pollers.clear()
      lastRunState.clear()
      deletedIds.clear()
      creatingSession = null
      for (const draft of Object.values(this.drafts)) revokePreviews(draft.attachments)
      if (this.failedDraft) revokePreviews(this.failedDraft.attachments)
      this.$reset()
      this.accountEpoch = accountEpoch
      resetBrowserAgent()
      resetComputerAgent()
      clearSessionImageCache()
    },

    /** 把一个会话的草稿存进草稿表（空草稿则删掉该项；已删除的会话不再保存） */
    stashDraft(sessionId: string | null, draft: SessionDraft): void {
      const key = draftKey(sessionId)
      if (sessionId && deletedIds.has(sessionId)) return
      if (isEmptyDraft(draft)) delete this.drafts[key]
      else this.drafts[key] = { text: draft.text, attachments: [...draft.attachments], refs: [...draft.refs] }
    },

    /** 取出（并移出草稿表）某个会话的草稿 */
    takeDraft(sessionId: string | null): SessionDraft {
      const key = draftKey(sessionId)
      const draft = this.drafts[key]
      delete this.drafts[key]
      return draft ? { text: draft.text, attachments: [...draft.attachments], refs: [...draft.refs] } : emptyDraft()
    },

    /** 往不在看的会话的草稿里加一个附件（上传途中切走了会话），返回响应式的那一项 */
    addDraftAttachment(sessionId: string | null, attachment: ComposerAttachment): ComposerAttachment {
      const key = draftKey(sessionId)
      if (!this.drafts[key]) this.drafts[key] = emptyDraft()
      const list = this.drafts[key].attachments
      list.push(attachment)
      return list[list.length - 1]
    },

    /** 请求没被接受：草稿退回它所属的会话（正在看就填回输入框，否则存进草稿表），不丢字也不串会话 */
    returnDraft(sessionId: string | null, draft: SessionDraft): void {
      if (isEmptyDraft(draft)) return
      if (draftKey(this.currentSessionId) === draftKey(sessionId)) {
        const pending = this.failedDraft
        this.failedDraft =
          pending && draftKey(pending.sessionId) === draftKey(sessionId)
            ? { sessionId, ...mergeDrafts(pending, draft) }
            : { sessionId, ...draft }
        if (pending && draftKey(pending.sessionId) !== draftKey(sessionId)) this.stashReturned(pending)
        return
      }
      const key = draftKey(sessionId)
      const existing = this.drafts[key]
      if (sessionId && deletedIds.has(sessionId)) return
      this.drafts[key] = existing ? mergeDrafts(draft, existing) : { ...draft }
    },

    /** 输入框还没取走、会话却已切走的退回草稿：存回它自己会话的草稿表 */
    stashReturned(returned: ReturnedDraft): void {
      const { sessionId, prefill, ...draft } = returned
      void prefill
      const key = draftKey(sessionId)
      if (sessionId && deletedIds.has(sessionId)) return
      const existing = this.drafts[key]
      this.drafts[key] = existing ? mergeDrafts(draft, existing) : draft
    },

    /** 预填输入框（问 LULUX / 核价入口）：只在当前会话的输入框为空时填入 */
    prefillDraft(text: string): void {
      if (!text) return
      this.failedDraft = { sessionId: this.currentSessionId, text, attachments: [], refs: [], prefill: true }
    },

    /** 没有会话时新建一个；并发调用复用同一次创建 */
    async ensureSession(): Promise<string> {
      if (this.currentSessionId) return this.currentSessionId
      if (!creatingSession) {
        const pending = this.newSession()
        creatingSession = pending
        void pending
          .catch(() => undefined)
          .finally(() => {
            if (creatingSession === pending) creatingSession = null
          })
      }
      return creatingSession
    },

    /** 本窗口在跑 / 服务端报告在跑（侧栏运行中标记，契约 §6.9） */
    isRunning(sessionId: string): boolean {
      if (this.runs[sessionId]) return true
      return Boolean(this.sessions.find((session) => session.id === sessionId)?.running)
    },

    /**
     * /api/events 的 session.run：服务端运行开始 / 结束（可能来自另一个窗口、定时任务或刷新前发起的请求）。
     * 正在看的会话开始运行且本窗口没有持有流时接上；结束时以落库消息为准。
     */
    async applyRunState(sessionId: string, running: boolean, runId?: string): Promise<void> {
      const key = `${runId ?? ''}:${running}`
      if (runId && lastRunState.get(sessionId) === key) return
      lastRunState.set(sessionId, key)
      const session = this.sessions.find((item) => item.id === sessionId)
      if (session) {
        session.running = running
        session.activeRunId = running ? (runId ?? null) : null
      }
      if (this.currentSessionId !== sessionId || this.runs[sessionId]?.local) return
      if (running) {
        void this.attachRun(sessionId)
      } else {
        if (this.runs[sessionId]) {
          delete this.runs[sessionId]
          this.stopPolling(sessionId)
        }
        const reloaded = await api.getSession(sessionId).catch(() => null)
        if (reloaded && this.currentSessionId === sessionId && !this.runs[sessionId]) this.messages = reloaded.messages
        await this.refreshSessions().catch(() => undefined)
      }
    },

    async bootstrap(): Promise<void> {
      const epoch = accountEpoch
      const results = await Promise.allSettled([
        this.refreshAgents(),
        this.refreshSessions(),
        this.refreshProviders(),
        this.refreshMcpServers(),
        this.refreshSettings(),
        this.refreshPermissions(),
      ])
      const failure = results.find((result) => result.status === 'rejected')
      // 等待期间账号已切换：这次结果作废，留给新账号重新 bootstrap
      if (epoch !== accountEpoch) return
      if (failure?.status === 'rejected') {
        this.error = messageOf(failure.reason)
      }
      this.ready = true
    },

    async refreshAgents(): Promise<void> {
      this.agents = await api.listAgents()
    },

    async refreshSessions(): Promise<void> {
      // 工作流节点的隐藏会话永远不进侧栏（服务端已过滤，这里兜底）
      const epoch = accountEpoch
      const listed = await api.listSessions()
      if (epoch !== accountEpoch) return
      // 删除前发出、删除后才返回的列表：已删的会话不写回侧栏
      const sessions = listed.filter((session) => !session.workflowRunId && !deletedIds.has(session.id))
      this.sessions = sessions
      if (this.currentSessionId && !sessions.some((session) => session.id === this.currentSessionId)) {
        this.currentSessionId = null
        this.messages = []
      }
    },

    /** /api/events 的 session.title：自动标题生成完成（契约 §6.3） */
    applySessionTitle(sessionId: string, title: string): void {
      const session = this.sessions.find((item) => item.id === sessionId)
      if (session && title) session.title = title
    },

    async refreshProviders(): Promise<void> {
      this.providers = await api.listProviders()
    },

    async refreshMcpServers(): Promise<void> {
      this.mcpServers = await api.listMcpServers()
    },

    async reconnectMcpServer(id: string): Promise<void> {
      await api.refreshMcpServer(id)
      await this.refreshMcpServers()
    },

    async toggleMcpServer(id: string, enabled: boolean): Promise<void> {
      await api.updateMcpServer(id, { enabled })
      await this.refreshMcpServers()
    },

    async refreshSettings(): Promise<void> {
      this.settings = await api.listSettings()
      syncTrashRetention(this.settings)
    },

    async saveSettings(patch: Record<string, string>): Promise<void> {
      this.settings = await api.updateSettings(patch)
      syncTrashRetention(this.settings)
      if ('defaultPermissionLevel' in patch || 'toolApproval' in patch) void this.refreshPermissions()
    },

    async refreshPermissions(): Promise<void> {
      this.permissionInfo = await api.getPermissions()
    },

    /**
     * 切换当前会话的权限级别（契约 §6.11）。还没有会话时先记下，新建会话时带上。
     * 超过管理员上限时服务端返回 403 PERMISSION_LEVEL_EXCEEDED（选择器本来就把超出的级别置灰）。
     */
    async setPermissionLevel(level: PermissionLevel): Promise<void> {
      const id = this.currentSessionId
      if (!id) {
        this.pendingPermissionLevel = level
        return
      }
      const session = await api.patchSession(id, { permissionLevel: level })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    /** 读取某内核的模型列表（契约 §6.13）；force 时忽略缓存（Provider / 内核模式可能刚改过） */
    async loadModels(kernel: string, force = false): Promise<ModelCatalog | null> {
      if (!force && kernel in this.modelCatalogs) return this.modelCatalogs[kernel]
      const catalog = await api.getModels(kernel)
      this.modelCatalogs = { ...this.modelCatalogs, [kernel]: catalog }
      return catalog
    },

    /** Provider 的模型能力刚改过：重新读取已加载过的模型列表，输入框的思考强度滑块立即跟着变 */
    async refreshModelCatalogs(): Promise<void> {
      const kernels = Object.keys(this.modelCatalogs)
      await Promise.all(kernels.map((kernel) => this.loadModels(kernel, true).catch(() => null)))
    },

    /** 切换当前会话的模型（null 模型 = 默认）。还没有会话时先记下 */
    async setModelChoice(choice: { providerId: string | null; model: string | null }): Promise<void> {
      const id = this.currentSessionId
      if (!id) {
        this.pendingModel = { kernel: this.currentModelKernel, ...choice }
        return
      }
      const body = this.modelCatalogs[this.currentModelKernel]?.mode === 'global' ? { model: choice.model } : choice
      const session = await api.patchSession(id, body)
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    /** 切换当前会话的推理强度（null = 默认） */
    async setReasoningEffort(effort: EffortLevel | null): Promise<void> {
      const id = this.currentSessionId
      if (!id) {
        this.pendingEffort = { kernel: this.currentModelKernel, effort }
        return
      }
      const session = await api.patchSession(id, { reasoningEffort: effort })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    async selectSession(id: string): Promise<void> {
      // 后发先至：进入页面时的自动选中与用户点击并发时，只采用最后一次请求的结果
      const ticket = ++selectTicket
      selectPending++
      let detail: Awaited<ReturnType<typeof api.getSession>>
      try {
        detail = await api.getSession(id)
      } finally {
        selectPending--
      }
      if (ticket !== selectTicket) return
      const holding = Boolean(this.runs[id]?.local)
      this.currentSessionId = id
      // 本窗口持有流时，进行中的发言由流渲染，草稿不重复显示
      this.messages = holding ? withoutDrafts(detail.messages) : detail.messages
      this.editing = null
      this.error = ''
      this.context = { customerId: null, quoteId: null }
      void this.loadContext(id)
      if (holding) return
      const listed = this.sessions.find((session) => session.id === id)
      const running = detail.session?.running
      if (listed && running !== undefined) {
        listed.running = running
        listed.activeRunId = detail.session?.activeRunId ?? null
      }
      if (running) {
        // 服务端还在跑（刷新 / 关窗重开 / 另一个窗口发起）：接上运行流，实时显示（契约 §6.9）
        void this.attachRun(id)
      } else if (running === undefined) {
        // 旧服务端：问 pending 是否还在跑、有没有待审批的工具（契约 §6.8-3）
        await this.restorePending(id)
      } else if (this.runs[id]) {
        delete this.runs[id]
        this.stopPolling(id)
      }
    },

    async loadContext(sessionId: string): Promise<void> {
      const ctx = await api.getSessionContext(sessionId).catch(() => null)
      if (ctx && this.currentSessionId === sessionId) this.context = ctx
    },

    async setContext(next: api.SessionContext): Promise<void> {
      const sessionId = this.currentSessionId
      if (!sessionId) return
      const saved = await api.putSessionContext(sessionId, next)
      if (this.currentSessionId === sessionId) this.context = saved
    },

    /** 用 GET /api/chat/pending 恢复“运行中”与审批卡片；运行中则轮询直到结束 */
    async restorePending(sessionId: string): Promise<void> {
      const pending = await api.getChatPending(sessionId).catch(() => null)
      if (!pending) return
      const existing = this.runs[sessionId]
      if (existing?.local) return
      if (!pending.running && pending.requests.length === 0) {
        if (existing) {
          delete this.runs[sessionId]
          this.stopPolling(sessionId)
          if (this.currentSessionId === sessionId) {
            const reloaded = await api.getSession(sessionId).catch(() => null)
            if (reloaded && this.currentSessionId === sessionId) this.messages = reloaded.messages
          }
        }
        return
      }
      if (!existing) this.runs[sessionId] = newRun(sessionId, false)
      const live = this.runs[sessionId]
      const seen = new Set(pending.requests.map((r) => r.requestId))
      live.tools = live.tools.filter((t) => seen.has(t.requestId) || t.status !== 'pending')
      for (const request of pending.requests) {
        if (live.tools.some((t) => t.requestId === request.requestId)) continue
        live.tools.push({
          requestId: request.requestId,
          agentId: request.agentId,
          name: request.name,
          server: request.server,
          arguments: request.arguments,
          status: 'pending',
          result: '',
          durationMs: 0,
          risk: request.risk,
          approvalKind: request.approvalKind,
          detail: request.detail,
          canRemember: request.canRemember,
        })
      }
      if (!live.agentId && pending.requests[0]) live.agentId = pending.requests[0].agentId
      this.startPolling(sessionId)
    },

    startPolling(sessionId: string): void {
      if (pollers.has(sessionId)) return
      const timer = window.setInterval(() => {
        if (this.runs[sessionId]?.local) return this.stopPolling(sessionId)
        void this.restorePending(sessionId)
      }, 1500)
      pollers.set(sessionId, timer)
    },

    stopPolling(sessionId: string): void {
      const timer = pollers.get(sessionId)
      if (timer !== undefined) window.clearInterval(timer)
      pollers.delete(sessionId)
    },

    async newSession(agentId?: string): Promise<string> {
      const epoch = accountEpoch
      // 优先使用调用方指定的内核，其次沿用当前会话的主 Agent，最后用设置里的默认 Agent
      const preferred = agentId || this.currentSession?.agentIds[0] || this.settings.defaultAgentId
      const pending = this.pendingPermissionLevel
      this.pendingPermissionLevel = null
      // 待建会话选的模型 / 推理强度：只在内核没变时带上（模型列表按内核来）
      const kernel = sessionModelKernel(null, this.agents, preferred || 'builtin')
      const model = this.pendingModel?.kernel === kernel ? this.pendingModel : null
      const effort = this.pendingEffort?.kernel === kernel ? this.pendingEffort.effort : null
      this.pendingModel = null
      this.pendingEffort = null
      const session = await api.createSession({
        kind: 'single',
        ...(preferred ? { agentIds: [preferred] } : {}),
        ...(pending ? { permissionLevel: pending } : {}),
        ...(model?.model ? { model: model.model, ...(model.providerId ? { providerId: model.providerId } : {}) } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      })
      if (epoch !== accountEpoch) throw new api.ApiError('ACCOUNT_CHANGED', t('storeApp.accountChanged'), 0)
      this.sessions.unshift(session)
      this.createdSessionId = session.id
      this.currentSessionId = session.id
      this.messages = []
      this.editing = null
      this.context = { customerId: null, quoteId: null }
      this.error = ''
      return session.id
    },

    /**
     * 新建群聊：总是一个全新的会话（空历史），不会转换或复制已有会话。
     */
    async newGroup(input: {
      agentIds: string[]
      /** 带群头衔的成员（同一内核可多次出现）；给了就按它建群 */
      members?: api.MemberInput[]
      groupName?: string
      supervisorId?: string
      /** 一起邀请的同事（团队服务器模式，契约 §6.10） */
      userIds?: string[]
    }): Promise<api.Session> {
      const session = await api.createSession({
        kind: 'group',
        ...(input.members?.length ? { members: input.members } : { agentIds: input.agentIds }),
        groupName: input.groupName?.trim() || null,
        ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
        ...(input.userIds?.length ? { userIds: input.userIds } : {}),
      })
      this.sessions.unshift(session)
      this.createdSessionId = session.id
      this.currentSessionId = session.id
      this.messages = []
      this.editing = null
      this.context = { customerId: null, quoteId: null }
      this.error = ''
      return session
    },

    /** 单聊：换成另一个内核（仍是单聊）；群聊：在群内增删成员 */
    async setSessionAgents(id: string, agentIds: string[]): Promise<void> {
      if (this.runs[id] || agentIds.length === 0) return
      const session = await api.patchSession(id, { agentIds })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    /** 群聊：整体替换成员（含群头衔；已有成员带实例 id 保持身份） */
    async setSessionMembers(id: string, members: api.MemberInput[]): Promise<void> {
      if (this.runs[id] || members.length === 0) return
      const session = await api.patchSession(id, { members })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    /** 群聊主管：'builtin' / 成员 Agent id / 'none' */
    async setSupervisor(id: string, supervisorId: string): Promise<void> {
      if (this.runs[id]) return
      const session = await api.patchSession(id, { supervisorId })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    async renameSession(id: string, title: string): Promise<void> {
      const trimmed = title.trim()
      if (!trimmed) return
      const current = this.sessions.find((session) => session.id === id)
      if (current?.title === trimmed) return
      const session = await api.patchSession(id, { title: trimmed })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    async renameGroup(id: string, groupName: string): Promise<void> {
      const trimmed = groupName.trim()
      const current = this.sessions.find((session) => session.id === id)
      if (!current || (current.groupName ?? '') === trimmed) return
      const session = await api.patchSession(id, { groupName: trimmed || null })
      const index = this.sessions.findIndex((item) => item.id === id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    async removeSession(id: string): Promise<void> {
      if (this.runs[id]) {
        // 生成中的会话：先停止，最多等 4 秒让流收尾
        await this.stop(id)
        for (let i = 0; i < 40 && this.runs[id]; i++) await new Promise((r) => window.setTimeout(r, 100))
        controllers.get(id)?.abort()
        delete this.runs[id]
        this.stopPolling(id)
      }
      // 先记下：删除前发出、删除后才返回的列表请求（例如流收尾的刷新）不会把它写回侧栏
      deletedIds.add(id)
      try {
        await api.deleteSession(id)
      } catch (error) {
        deletedIds.delete(id)
        throw error
      }
      const draft = this.drafts[draftKey(id)]
      if (draft) revokePreviews(draft.attachments)
      delete this.drafts[draftKey(id)]
      this.sessions = this.sessions.filter((session) => session.id !== id)
      if (this.currentSessionId === id) {
        this.currentSessionId = null
        this.messages = []
      }
    },

    /**
     * 发送一条消息。options.draft 是输入框里用户敲的原文和原附件：请求没被接受时原样退回它所属的会话，
     * 而不是退回展开后的整条消息（附件说明、引用资料块、框选上下文）。
     */
    async send(
      content: string,
      options: { targetAgentIds?: string[]; attachments?: api.MessageAttachment[]; draft?: SessionDraft } = {},
    ): Promise<void> {
      const text = content.trim()
      const images = options.attachments ?? []
      if (!text && !images.length) return
      const draft: SessionDraft = options.draft ?? { text, attachments: [], refs: [] }
      if (this.streaming) {
        this.returnDraft(this.currentSessionId, draft)
        return
      }

      let sessionId = this.currentSessionId
      if (!sessionId) {
        try {
          sessionId = await this.ensureSession()
        } catch (error) {
          // 新对话建不出来：文字退回输入框，不丢
          if (error instanceof api.ApiError && error.code === 'ACCOUNT_CHANGED') return
          this.returnDraft(null, draft)
          this.error = error instanceof api.ApiError ? withHint(error) : messageOf(error)
          return
        }
      }
      // 没有会话时连发：后一条等到的是同一个新会话，而前一条已经在里面生成了
      if (this.runs[sessionId]) {
        this.returnDraft(sessionId, draft)
        return
      }
      const optimistic = this.optimisticUser(sessionId, text)
      if (images.length) optimistic.attachments = images
      this.messages.push(optimistic)
      await this.runStream(
        {
          kind: 'send',
          sessionId,
          content: text,
          targetAgentIds: options.targetAgentIds,
          ...(images.length ? { attachments: images.map((a) => ({ path: a.path, name: a.name })) } : {}),
        },
        { optimisticId: optimistic.id, draft },
      )
    },

    /** 重新生成（契约 §6.2）：先在本地删掉该用户消息之后的消息，再渲染新流 */
    async regenerate(messageId?: string): Promise<void> {
      const sessionId = this.currentSessionId
      if (!sessionId || this.streaming) return
      const userIndex = regenerateAnchor(this.messages, messageId)
      if (userIndex < 0) return
      this.messages = this.messages.slice(0, userIndex + 1)
      await this.runStream({ kind: 'regenerate', sessionId, messageId })
    },

    /** 进入编辑重发：内容放进输入框，提示之后的消息会被删除 */
    startEdit(messageId: string): void {
      if (this.streaming) return
      const index = this.messages.findIndex((m) => m.id === messageId)
      const message = this.messages[index]
      if (!message || message.role !== 'user') return
      this.editing = { messageId, content: message.content, dropCount: this.messages.length - index - 1 }
    },

    cancelEdit(): void {
      this.editing = null
    },

    /** 编辑重发（契约 §6.2）：该用户消息及之后全部删除，以新内容重跑 */
    async submitEdit(content: string): Promise<void> {
      const editing = this.editing
      const sessionId = this.currentSessionId
      const text = content.trim()
      if (!editing || !sessionId || !text || this.streaming) return
      const index = this.messages.findIndex((m) => m.id === editing.messageId)
      if (index < 0) {
        this.editing = null
        return
      }
      const removed = this.messages.slice(index)
      this.editing = null
      this.messages = this.messages.slice(0, index)
      const optimistic = this.optimisticUser(sessionId, text)
      // 编辑重发沿用原消息的图片（服务端省略 attachments 时同样沿用）
      if (removed[0]?.attachments?.length) optimistic.attachments = removed[0].attachments
      this.messages.push(optimistic)
      await this.runStream(
        { kind: 'edit', sessionId, messageId: editing.messageId, content: text },
        { optimisticId: optimistic.id, draft: { text, attachments: [], refs: [] }, restore: removed },
      )
    },

    optimisticUser(sessionId: string, text: string): api.Message {
      return {
        id: `tmp_${Date.now()}`,
        sessionId,
        role: 'user',
        content: text,
        senderAgentId: null,
        toolTrace: [],
        createdAt: Date.now(),
      }
    },

    addFileArtifact(sessionId: string, artifact: api.StreamArtifact['artifact']): void {
      const list = this.fileArtifacts[sessionId] ?? []
      const item: FileArtifact = {
        path: artifact.path,
        title: artifact.title || artifact.filename || artifact.path,
        size: artifact.size,
        mime: artifact.mime ?? '',
        downloadUrl: artifact.downloadUrl ?? sessionFileUrl(sessionId, artifact.path),
        createdAt: Date.now(),
      }
      this.fileArtifacts[sessionId] = [...list.filter((f) => f.path !== item.path), item]
    },

    pushNotice(run: RunState, kind: RunNotice['kind'], text: string): void {
      // 同类提示只保留最新一条（重试会连发多次）
      // 同类同文的提示（每轮都截短一次工具结果）也只留一条，不刷屏
      const index = run.notices.findIndex((n) => n.kind === kind && (kind === 'retry' || n.text === text))
      const notice = { id: ++noticeSeq, kind, text }
      if (index >= 0) run.notices.splice(index, 1, notice)
      else run.notices.push(notice)
    },

    /** 一个会话流的事件处理（POST 对话流与重新接上的流共用） */
    streamHandlers(sessionId: string, run: RunState, flags: StreamFlags): api.StreamHandlers {
      const live = (): RunState => this.runs[sessionId] ?? run
      const visible = (): boolean => this.currentSessionId === sessionId
      return {
        onSeq: (seq) => {
          flags.started = true
          const r = live()
          r.lastSeq = seq
          if (r.reconnecting) {
            // 重新接上了：去掉“正在重连”
            r.reconnecting = false
            r.reconnects = 0
            r.notices = r.notices.filter((n) => n.kind !== 'reconnecting')
          }
        },
        onReplayed: () => {
          const r = live()
          r.replaying = false
          // 回放结束时正在发言：从现在开始计思考用时（真实起点未知）
          if (r.agentId && r.thinkStartedAt === null && !r.text) r.thinkStartedAt = Date.now()
        },
        onStart: (info) => {
          flags.started = true
          const r = live()
          if (info.provider) {
            r.runtime = { kind: 'provider', providerName: info.provider.name, model: info.provider.model }
          }
          if (info.mode) r.mode = info.mode
          r.speakers = info.speakers ?? []
          r.supervisorId = info.supervisorId ?? null
        },
        onDispatch: (data) => {
          const r = live()
          r.speakers = [data.supervisorId, ...data.members, data.supervisorId]
        },
        onNotice: (data) => {
          const text =
            data.kind === 'supervisor_unavailable'
              ? t('supervisor.unavailableSupervisor', [data.name, data.reason])
              : t('supervisor.unavailableMember', [data.name, data.reason])
          live().notices.push({ id: ++noticeSeq, kind: 'unavailable', text })
        },
        onAgent: (agent) => {
          flags.started = true
          const r = live()
          r.agentId = agent.agentId
          r.role = agent.role ?? null
          if (agent.runtime) r.runtime = agent.runtime
          r.text = ''
          r.reasoning = ''
          r.tools = []
          // 发言前的“成员不可用”提示保留到第一条消息上
          r.notices = r.notices.filter((n) => n.kind === 'unavailable')
          // 群聊：每个成员各自计时（回放中的发言不知道真实起点）
          r.thinkStartedAt = r.replaying ? null : Date.now()
          r.thinkEndedAt = null
        },
        onDelta: (delta) => {
          const r = live()
          if (delta) endThinking(r)
          r.text += delta
        },
        onReasoning: (data) => {
          live().reasoning += data.text
        },
        onToolRequest: (request) => {
          endThinking(live())
          live().tools.push({
            requestId: request.requestId,
            agentId: request.agentId,
            name: request.name,
            server: request.server,
            arguments: request.arguments,
            status: request.auto ? 'running' : 'pending',
            result: '',
            durationMs: 0,
            risk: request.risk,
            approvalKind: request.approvalKind,
            detail: request.detail,
            canRemember: request.canRemember,
          })
        },
        onToolResult: (result) => {
          const entry = live().tools.find((item) => item.requestId === result.requestId)
          if (!entry) return
          entry.status = result.approved ? (result.ok ? 'done' : 'error') : 'denied'
          entry.result = result.result
          entry.durationMs = result.durationMs
        },
        onRetry: (data) => this.pushNotice(live(), 'retry', retryNoticeText(data)),
        onDowngrade: (data) =>
          this.pushNotice(
            live(),
            'downgrade',
            data.what === 'tools'
              ? t('storeApp.k152qz3y')
              : data.what === 'vision'
                ? t('vision.downgraded')
                : t('storeApp.kmpqhac'),
          ),
        onContinuation: () => this.pushNotice(live(), 'continuation', t('storeApp.ka9bbq5')),
        onToolLimit: (data) =>
          this.pushNotice(
            live(),
            'tool_limit',
            data.reason === 'loop_guard'
              ? t('storeApp.loopGuard', [data.tool ?? '', data.repeats ?? 3])
              : t('storeApp.kfh2s32', [data.maxTurns ?? data.maxToolRounds]),
          ),
        onCompaction: (data) => this.pushNotice(live(), 'compaction', compactionNoticeText(data)),
        onVision: (data) => {
          if (!data.supported) this.pushNotice(live(), 'vision', t('vision.unsupportedRun', [data.model, data.images]))
        },
        onSkillPreload: (data) => {
          if (data.skills?.length)
            this.pushNotice(live(), 'skill', t('storeApp.k1drw64', [data.skills.join(t('fmt.listSep'))]))
        },
        onArtifact: (data) => {
          if (data.artifact.binary) this.addFileArtifact(sessionId, data.artifact)
          // 回放的产物只登记，不抢焦点
          if (live().replaying) return
          this.artifactFocus = {
            sessionId,
            title: data.artifact.title,
            language: data.artifact.language,
            path: data.artifact.binary ? data.artifact.path : undefined,
            seq: (this.artifactFocus?.seq ?? 0) + 1,
          }
        },
        onStopped: () => {
          flags.aborted = true
        },
        onDone: (message, wasAborted) => {
          const r = live()
          if (wasAborted) flags.aborted = true
          const notices = r.notices.filter((n) => n.kind !== 'retry' && n.kind !== 'reconnecting')
          if (notices.length) this.messageNotices[message.id] = notices
          if (message.reasoning && r.thinkStartedAt !== null) {
            this.thinkDurations[message.id] = (r.thinkEndedAt ?? Date.now()) - r.thinkStartedAt
          }
          if (visible()) {
            // 草稿（同一 id）换成最终消息
            const index = this.messages.findIndex((m) => m.id === message.id)
            if (index >= 0) this.messages.splice(index, 1, message)
            else this.messages.push(message)
          }
          r.text = ''
          r.reasoning = ''
          r.tools = []
          r.notices = []
          r.agentId = null
          r.role = null
        },
        onError: (message) => {
          const r = live()
          if (visible()) this.error = message
          r.text = ''
          r.reasoning = ''
          r.tools = []
          r.agentId = null
        },
      }
    },

    async runStream(
      req: api.ChatStreamRequest,
      opts: { optimisticId?: string; draft?: SessionDraft; restore?: api.Message[] } = {},
    ): Promise<void> {
      const { sessionId } = req
      this.stopPolling(sessionId)
      this.error = ''
      this.runs[sessionId] = newRun(sessionId, true, req.kind)
      // 取回响应式代理（直接改原始对象不会触发渲染）
      const run = this.runs[sessionId]
      const visible = (): boolean => this.currentSessionId === sessionId

      const controller = new AbortController()
      controllers.set(sessionId, controller)
      const flags: StreamFlags = { started: false, aborted: false }
      let reattach = false

      try {
        await api.streamChatRequest(req, this.streamHandlers(sessionId, run, flags), controller.signal)
      } catch (error) {
        const isAbort = (error as Error)?.name === 'AbortError'
        const busy = error instanceof api.ApiError && error.code === 'RUN_ACTIVE'
        if (!flags.started) {
          // 服务端没有接受这条请求（409/400 等）：撤回乐观插入的气泡，被截掉的消息放回；
          // 用户原文和原附件退回发起时的会话（正在看别的会话时存进那个会话的草稿）
          if (visible()) {
            this.messages = this.messages.filter((m) => m.id !== opts.optimisticId)
            if (opts.restore) this.messages.push(...opts.restore)
          }
          if (!isAbort && opts.draft) this.returnDraft(sessionId, opts.draft)
        } else if (error instanceof api.ApiError && error.code === 'NETWORK') {
          // 生成中途断网：服务端可能还在跑，收尾时重新接上，不当作失败
          flags.network = true
        }
        if (!isAbort && visible() && !flags.network) {
          this.error = error instanceof api.ApiError ? withHint(error) : messageOf(error)
        }
        if (isAbort) flags.aborted = true
        // 这个会话已经在服务端运行（另一个窗口 / 刷新前发起）：接上它
        if (busy) reattach = true
      } finally {
        await this.settleStream(sessionId, run, controller, flags)
        if (reattach && !this.runs[sessionId]) void this.attachRun(sessionId)
      }
    },

    /**
     * 重新接上服务端的会话运行（契约 §6.9）：回放 seq > after 的事件再推实时，直到运行结束。
     * continueRun 给出时在原有状态上续接（流意外断开后），否则从头回放。
     */
    async attachRun(sessionId: string, continueRun?: RunState, attempt = 0): Promise<void> {
      const existing = this.runs[sessionId]
      if (existing?.local && existing !== continueRun) return
      this.stopPolling(sessionId)
      if (!continueRun) {
        const fresh = newRun(sessionId, true)
        fresh.thinkStartedAt = null
        fresh.replaying = true
        this.runs[sessionId] = fresh
        // 草稿由回放的事件重建，避免重复显示
        if (this.currentSessionId === sessionId) this.messages = withoutDrafts(this.messages)
      } else {
        this.runs[sessionId] = continueRun
      }
      const run = this.runs[sessionId]
      const after = continueRun ? run.lastSeq : 0
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      const flags: StreamFlags = { started: Boolean(continueRun), aborted: false }
      try {
        await api.attachRunStream(sessionId, after, this.streamHandlers(sessionId, run, flags), controller.signal)
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') flags.aborted = true
        else if (flags.started && error instanceof api.ApiError && error.code === 'NETWORK') flags.network = true
        else if (!flags.started) {
          // 接不上（旧服务端没有该接口）：退回 pending 轮询
          if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
          if (this.runs[sessionId] === run) delete this.runs[sessionId]
          await this.restorePending(sessionId)
          return
        }
      }
      await this.settleStream(sessionId, run, controller, flags, attempt)
    },

    /**
     * 流结束后的收尾：流意外断开而服务端仍在运行时从最后的 seq 续接（最多重试几次）；
     * 否则结束本地运行状态，并以服务端落库的消息为准。
     */
    async settleStream(
      sessionId: string,
      run: RunState,
      controller: AbortController,
      flags: StreamFlags,
      attempt = 0,
    ): Promise<void> {
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
      const ours = this.runs[sessionId] === run
      if (ours && flags.network && !controller.signal.aborted) {
        // 断网：保留本地运行状态，显示“正在重连”，恢复联网（或退避时间到）后从最后的 seq 续接
        if (await this.waitToReconnect(sessionId, run)) return this.attachRun(sessionId, run, attempt)
        if (this.runs[sessionId] !== run) return
        run.reconnecting = false
        if (this.currentSessionId === sessionId) this.error = t('storeApp.reconnectFailed')
      } else if (ours && flags.started && !controller.signal.aborted) {
        const detail = await api.getSession(sessionId).catch(() => null)
        if (detail?.session?.running && this.runs[sessionId] === run && attempt < 5) {
          await new Promise((r) => window.setTimeout(r, 300 * (attempt + 1)))
          if (this.runs[sessionId] === run) return this.attachRun(sessionId, run, attempt + 1)
        }
      }
      if (this.runs[sessionId] === run) delete this.runs[sessionId]
      await this.refreshSessions().catch(() => undefined)
      // 用服务端的消息替换临时 id 的用户消息；停止后也以落库内容为准
      if (this.currentSessionId === sessionId && (flags.started || flags.aborted)) {
        const reloaded = await api.getSession(sessionId).catch(() => null)
        if (reloaded && this.currentSessionId === sessionId && !this.runs[sessionId]) {
          this.messages = reloaded.messages
        }
      }
    },

    /** 断网后等待重连；返回 false = 不再重连（次数用完，或等待期间运行已被停止 / 删除 / 账号已切换） */
    async waitToReconnect(sessionId: string, run: RunState): Promise<boolean> {
      if (run.reconnects >= MAX_RECONNECTS) return false
      run.reconnecting = true
      this.pushNotice(run, 'reconnecting', t('storeApp.reconnecting'))
      const delay = Math.min(1000 * 2 ** run.reconnects, 15000)
      run.reconnects += 1
      await waitForNetwork(delay)
      return this.runs[sessionId] === run
    },

    /** 界面批准或拒绝一次工具调用；remember=session 时本会话内同名工具不再询问 */
    async decideTool(requestId: string, approved: boolean, remember?: 'session'): Promise<void> {
      const entry = this.streamTools.find((item) => item.requestId === requestId)
      if (entry) entry.status = approved ? 'running' : 'denied'
      try {
        await api.decideTool(requestId, approved, remember)
      } catch (error) {
        if (entry) {
          entry.status = 'error'
          entry.result = messageOf(error)
        }
      }
    },

    /* ── 多人群聊（契约 §6.10）：成员管理与实时同步 ── */

    /** 用服务端返回的最新会话替换侧栏里的那一项 */
    applyRemoteSession(session: api.Session): void {
      const index = this.sessions.findIndex((item) => item.id === session.id)
      if (index >= 0) this.sessions.splice(index, 1, session)
    },

    /** 失去访问权（被移出 / 退出 / 群被解散）：从侧栏去掉，不再请求服务端 */
    dropSession(id: string): void {
      const draft = this.drafts[draftKey(id)]
      if (draft) revokePreviews(draft.attachments)
      delete this.drafts[draftKey(id)]
      controllers.get(id)?.abort()
      delete this.runs[id]
      this.stopPolling(id)
      this.sessions = this.sessions.filter((session) => session.id !== id)
      if (this.currentSessionId === id) {
        this.currentSessionId = null
        this.messages = []
        this.editing = null
      }
    },

    /**
     * 会话事件流推来的新消息（别人发言 / Agent 回复落库）。
     * 本窗口正持有流时不插入（流结束后会整体刷新）；别人发起的提问 → 用 pending 显示“正在回复”。
     */
    applyRemoteMessage(sessionId: string, message: api.Message, meId: string | null): void {
      const session = this.sessions.find((item) => item.id === sessionId)
      const known = this.currentSessionId === sessionId && this.messages.some((m) => m.id === message.id)
      if (session && !known) {
        session.updatedAt = Math.max(session.updatedAt, message.createdAt)
        session.preview = message.content
        session.messageCount += 1
      }
      if (this.currentSessionId !== sessionId || this.runs[sessionId]?.local) return
      this.messages = mergeMessage(this.messages, message)
      // 别人发起的提问：新服务端随后会推 run（会话事件流 / 全局 session.run）→ applyRunState 接上运行流；
      // 旧服务端（会话没有 running 字段）退回 pending 轮询
      if (
        message.role === 'user' &&
        message.senderUserId &&
        message.senderUserId !== meId &&
        session?.running === undefined
      ) {
        void this.restorePending(sessionId)
      }
    },

    async inviteToGroup(id: string, userIds: string[]): Promise<void> {
      if (userIds.length === 0) return
      const { session } = await api.addParticipants(id, userIds)
      this.applyRemoteSession(session)
    },

    async removeFromGroup(id: string, userId: string): Promise<void> {
      await api.removeParticipant(id, userId)
      const fresh = (await api.getSession(id)).session
      this.applyRemoteSession(fresh)
    },

    async setGroupRole(id: string, userId: string, role: 'admin' | 'member'): Promise<void> {
      this.applyRemoteSession(await api.setParticipantRole(id, userId, role))
    },

    /** 退出群聊（群主不能退出，只能解散） */
    async leaveGroup(id: string): Promise<void> {
      await api.removeParticipant(id, 'me')
      this.dropSession(id)
    },

    /** 停止生成（契约 §6.9）：POST /api/sessions/:id/cancel；服务端随后发 done(aborted) + stopped 并结束流 */
    async stop(target?: string): Promise<void> {
      const sessionId = target ?? this.currentSessionId
      const run = sessionId ? this.runs[sessionId] : null
      if (!sessionId || !run || run.stopping) return
      run.stopping = true
      let stopped = false
      try {
        stopped = (await api.cancelRun(sessionId)).stopped
      } catch {
        stopped = false
      }
      const controller = controllers.get(sessionId)
      if (!stopped) {
        // 服务端说没有在跑（或接口失败）：直接断开本地流
        controller?.abort()
        // 断网等待重连中（没有持有流）：直接结束本地运行状态
        if (!run.local || (run.reconnecting && !controller)) {
          delete this.runs[sessionId]
          this.stopPolling(sessionId)
        }
      } else if (controller) {
        // 兜底：服务端 3 秒内没有结束流就断开
        window.setTimeout(() => controllers.get(sessionId) === controller && controller.abort(), 3000)
      } else {
        await this.restorePending(sessionId)
      }
    },
  },
})

/** 丢掉草稿里附件的本地缩略图 */
function revokePreviews(attachments: ComposerAttachment[]): void {
  for (const a of attachments) if (a.preview?.startsWith('blob:')) URL.revokeObjectURL(a.preview)
}

/** regenerate 的锚点：messageId 为助手消息时取它之前最近的用户消息；缺省取最后一条用户消息 */
export function regenerateAnchor(messages: api.Message[], messageId?: string): number {
  let from = messages.length - 1
  if (messageId) {
    from = messages.findIndex((m) => m.id === messageId)
    if (from < 0) return -1
  }
  for (let i = from; i >= 0; i--) if (messages[i].role === 'user') return i
  return -1
}
