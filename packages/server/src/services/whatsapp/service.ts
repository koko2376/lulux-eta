import { APP_VERSION, config } from '../../config.js'
import { seesAll } from '../../security/access.js'
import type { Actor } from '../../context.js'
import { AppError } from '../../errors.js'
import { auditService } from '../audit-service.js'
import { eventBus } from '../events.js'
import { logger } from '../logger.js'
import { FakeWhatsAppAdapter } from './fake-adapter.js'
import {
  DEFAULT_ACCOUNT_ID,
  acceptRisk as saveRiskAcceptance,
  chmodSession,
  clearSession,
  credentialsDir,
  ensureWhatsAppDirs,
  hasCredentials,
  readAccount,
  readRisk,
  saveAccount,
} from './credential-store.js'
import { createDefaultEngineFactory, inspectEngine } from './engine-loader.js'
import { clearProxy, proxyAgent, readProxy, saveProxy, testProxy, type WhatsAppProxyInput, type WhatsAppProxyView } from './proxy.js'
import { WhatsAppStateMachine } from './state-machine.js'
import {
  findConversation,
  getMessage,
  latestIncomingText,
  listConversations as listStoredConversations,
  conversationCounts as storedConversationCounts,
  updateConversationMeta,
  setConversationDraft,
  listMessages,
  markConversationRead,
  markMessageFailed,
  markMessageSending,
  markMessageSent,
  openConversation as openStoredConversation,
  recordIncomingMessage,
  recordOutgoingMessage,
  type WhatsAppConversationPage,
  type WhatsAppMessagePage,
} from './store.js'
import {
  TRANSLATOR_TARGET_LANGUAGES,
  detectTextLanguage,
  loadTranslator,
  resolveAutoTarget,
  type TranslatorTargetLanguage,
} from './translator.js'
import {
  WHATSAPP_RECONNECT_DELAYS,
  type WhatsAppAccountInfo,
  type WhatsAppConversation,
  type WhatsAppConversationCounts,
  type WhatsAppConversationFilter,
  type WhatsAppEngineAdapter,
  type WhatsAppEngineEvent,
  type WhatsAppEngineFactory,
  type WhatsAppLinkMode,
  type WhatsAppMessage,
  type WhatsAppStartInput,
  type WhatsAppStatus,
} from './types.js'

/**
 * 单账号 WhatsApp 关联设备服务。
 *
 * 线程/请求模型：进程内单例；desktop 只有一个本机用户，server 模式先把引擎归属锁定给
 * 第一个开始绑定的用户，其他用户收到 WHATSAPP_ACCOUNT_BUSY，避免两个会话互相顶号。
 * 目录按 `accountId` 区分（`sessions/<accountId>`），整台服务只启用 `default`。
 */
export class WhatsAppService {
  private readonly state: WhatsAppStateMachine
  private engineFactory: WhatsAppEngineFactory = createDefaultEngineFactory()
  private adapter: WhatsAppEngineAdapter | null = null
  private unlisten: (() => void) | null = null
  private ownerId: string | null = null
  private ownerOrgId: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    readonly accountId: string = DEFAULT_ACCOUNT_ID,
    owner?: { userId: string; orgId: string },
  ) {
    this.state = new WhatsAppStateMachine(this.accountId)
    // 重启后仍能识别既有绑定的归属；desktop 是否重连交给用户点击「重新连接」，server 由 resumeLinked() 自动拉起
    const stored = readAccount(this.accountId)
    if (owner) {
      this.ownerId = owner.userId
      this.ownerOrgId = owner.orgId
    } else if (stored?.ownerId) {
      this.ownerId = stored.ownerId
      this.ownerOrgId = 'local'
    }
  }

  /** 已绑定且凭据有效：用保存的凭据重新连上（server 启动时调用，电脑关机也保持在线） */
  async resume(): Promise<boolean> {
    const stored = readAccount(this.accountId)
    if (!stored?.credentialsValid || !this.ownerId || this.adapter) return false
    this.reconnectAttempts = 0
    await this.reconnectNow()
    return true
  }

  /** 代理改了之后：正在连或已连的号用新出口重连；没在线的下次连接时生效 */
  async reconnectForProxyChange(): Promise<boolean> {
    if (!this.adapter) return false
    const stored = readAccount(this.accountId)
    await this.disposeAdapter()
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    if (!stored?.credentialsValid || !this.ownerId) {
      this.state.reset()
      this.publish()
      return false
    }
    await this.reconnectNow()
    return true
  }

  /** 当前绑定者（未绑定为 null）；代理设置按它校验 */
  get boundOwnerId(): string | null {
    return this.ownerId
  }

  /** 测试注入；生产默认是运行时 Baileys（fake 模式由环境变量切换） */
  setEngineFactory(factory: WhatsAppEngineFactory): void {
    this.engineFactory = factory
  }

  private createAdapter(): WhatsAppEngineAdapter {
    const info = inspectEngine()
    const dir = info.id === 'fake' ? null : info.dir
    if (info.id === 'fake') return new FakeWhatsAppAdapter()
    if (!info.installed || !dir) {
      throw new AppError(
        503,
        info.error?.code ?? 'ENGINE_NOT_INSTALLED',
        info.error?.message ?? 'WhatsApp 引擎尚未安装',
      )
    }
    return this.engineFactory({ engineDir: dir, credentialsDir: credentialsDir(this.accountId) })
  }

  private riskFor(actor: Actor) {
    return readRisk(actor.id)
  }

  private ownerScope(): { userId: string; orgId: string } | null {
    if (!this.ownerId) return null
    return { userId: this.ownerId, orgId: this.ownerOrgId ?? 'local' }
  }

  private publish(): WhatsAppStatus | null {
    const scope = this.ownerScope()
    if (!scope) return null
    const status = this.state.snapshot(Date.now(), readRisk(scope.userId), inspectEngine())
    eventBus.publish('whatsapp.status', status, scope)
    if (status.qr) {
      eventBus.publish(
        'whatsapp.qr',
        {
          dataUrl: status.qr.dataUrl,
          issuedAt: status.qr.issuedAt,
          expiresAt: status.qr.expiresAt,
          refreshCount: status.qr.refreshCount,
          warning: status.qr.warning,
        },
        scope,
      )
    }
    if (status.pairing) {
      eventBus.publish(
        'whatsapp.pairing',
        {
          code: status.pairing.code,
          phone: status.pairing.phone,
          issuedAt: status.pairing.issuedAt,
          expiresAt: status.pairing.expiresAt,
        },
        scope,
      )
    }
    if (status.error) {
      eventBus.publish('whatsapp.error', { ...status.error }, scope)
    }
    return status
  }

  status(actor: Actor): WhatsAppStatus {
    const info = inspectEngine()
    this.state.setEngine(info)
    const risk = this.riskFor(actor)
    if (this.ownerId && this.ownerId !== actor.id) {
      // 别人绑定的账号不暴露号码 / 二维码 / 配对码；四态点仍显示引擎在忙
      const hidden = this.state.snapshot(Date.now(), risk, info)
      return {
        ...hidden,
        phase: 'unbound',
        connection: 'disconnected',
        mode: null,
        account: null,
        qr: null,
        pairing: null,
        reconnect: null,
        error: null,
      }
    }
    if (this.ownerId === actor.id && !this.ownerOrgId) this.ownerOrgId = actor.orgId
    return this.state.snapshot(Date.now(), risk, info)
  }

  acceptRisk(actor: Actor): WhatsAppStatus {
    ensureWhatsAppDirs()
    saveRiskAcceptance(actor.id, APP_VERSION)
    auditService.record({
      action: 'whatsapp.risk_accepted',
      entityType: 'whatsapp',
      entityId: this.accountId,
      summary: '确认 WhatsApp 关联设备风险',
      meta: { accountId: this.accountId, version: APP_VERSION },
      actor,
    })
    this.publish()
    return this.status(actor)
  }

  private requireRisk(actor: Actor): void {
    if (!this.riskFor(actor).accepted) {
      throw new AppError(
        403,
        'RISK_ACCEPTANCE_REQUIRED',
        '请先阅读并勾选 WhatsApp 关联设备风险确认，再开始绑定',
      )
    }
  }

  private claimOwner(actor: Actor): void {
    if (!this.ownerId) {
      this.ownerId = actor.id
      this.ownerOrgId = actor.orgId
      return
    }
    if (this.ownerId !== actor.id) {
      throw new AppError(409, 'WHATSAPP_ACCOUNT_BUSY', '这台服务已经绑定了其他用户的 WhatsApp 账号，请先由该用户解绑')
    }
  }

  private requireOwner(actor: Actor): void {
    if (!this.ownerId) {
      throw new AppError(409, 'WHATSAPP_NOT_LINKED', '当前没有 WhatsApp 绑定会话，请先开始绑定')
    }
    if (this.ownerId !== actor.id) {
      throw new AppError(409, 'WHATSAPP_ACCOUNT_BUSY', '只有绑定该 WhatsApp 账号的用户可以执行此操作')
    }
  }

  /** 读接口：没有绑定时返回空数据；别的用户绑定时仍然拒绝 */
  private assertReadable(actor: Actor): void {
    if (this.ownerId && this.ownerId !== actor.id) {
      throw new AppError(409, 'WHATSAPP_ACCOUNT_BUSY', '只有绑定该 WhatsApp 账号的用户可以读取会话')
    }
  }

  private publishConversation(conversation: WhatsAppConversation): void {
    const scope = this.ownerScope()
    if (!scope) return
    eventBus.publish('whatsapp.conversation', conversation, scope)
  }

  private publishMessage(message: WhatsAppMessage): void {
    const scope = this.ownerScope()
    if (!scope) return
    eventBus.publish('whatsapp.message', message, scope)
  }

  private requireConnected(): WhatsAppEngineAdapter {
    const snapshot = this.state.snapshot(
      Date.now(),
      this.riskFor(this.actorForOwner()),
      inspectEngine(),
    )
    if (!this.adapter || snapshot.connection !== 'connected') {
      throw new AppError(
        409,
        'WHATSAPP_NOT_CONNECTED',
        'WhatsApp 尚未连接，消息未发送；请先完成绑定或等待重连成功',
      )
    }
    return this.adapter
  }

  private requireConversation(actor: Actor, conversationId: string): WhatsAppConversation {
    this.requireOwner(actor)
    const conversation = findConversation(actor.id, conversationId)
    if (!conversation) {
      throw new AppError(404, 'WHATSAPP_CONVERSATION_NOT_FOUND', '会话不存在或不属于当前用户')
    }
    return conversation
  }

  private async deliver(
    actor: Actor,
    conversation: WhatsAppConversation,
    message: WhatsAppMessage,
  ): Promise<WhatsAppMessage> {
    const adapter = this.requireConnected()
    try {
      const result = await adapter.sendText({
        remoteJid: conversation.remoteJid,
        text: message.body,
      })
      const sent = markMessageSent(actor.id, message.id, result.id || null)
      if (sent) {
        this.publishMessage(sent)
        const updated = findConversation(actor.id, conversation.id)
        if (updated) this.publishConversation(updated)
        return sent
      }
      return message
    } catch (error) {
      const reason = errorMessage(error)
      const failed = markMessageFailed(actor.id, message.id, reason)
      if (failed) {
        this.publishMessage(failed)
        const updated = findConversation(actor.id, conversation.id)
        if (updated) this.publishConversation(updated)
      }
      if (error instanceof AppError) {
        throw new AppError(error.status, error.code, error.message, error.params, {
          ...(error.details ?? {}),
          messageId: message.id,
          conversationId: conversation.id,
        })
      }
      throw new AppError(502, 'WHATSAPP_SEND_FAILED', `消息发送失败：${reason}`, undefined, {
        messageId: message.id,
        conversationId: conversation.id,
      })
    }
  }

  private async disposeAdapter(): Promise<void> {
    const adapter = this.adapter
    const unlisten = this.unlisten
    this.adapter = null
    this.unlisten = null
    try {
      unlisten?.()
    } catch {
      // ignore
    }
    if (!adapter) return
    try {
      await adapter.stop()
    } catch (error) {
      logger.warn('whatsapp adapter stop failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private attach(adapter: WhatsAppEngineAdapter): void {
    this.unlisten = adapter.onEvent((event) => this.handleEvent(event))
  }

  async start(actor: Actor, input: WhatsAppStartInput): Promise<WhatsAppStatus> {
    this.requireRisk(actor)
    this.claimOwner(actor)
    const mode: WhatsAppLinkMode = input.mode === 'pairing' ? 'pairing' : 'qr'
    const phone = mode === 'pairing' ? normalizeWhatsAppPhone(input.phone) : undefined
    ensureWhatsAppDirs()

    const info = inspectEngine()
    if (mode === 'qr' && info.installed && !info.qrAvailable) {
      const failed = new AppError(
        503,
        'ENGINE_LOAD_FAILED',
        'WhatsApp 引擎缺少二维码渲染依赖 qrcode，请重新安装运行时引擎（见 docs/WHATSAPP-ENGINE.md）',
      )
      this.state.failed(failed.code, failed.message)
      this.publish()
      throw failed
    }

    await this.disposeAdapter()
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    this.state.begin(mode, phone ?? null)
    this.publish()

    let adapter: WhatsAppEngineAdapter
    try {
      adapter = this.createAdapter()
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(503, 'ENGINE_LOAD_FAILED', errorMessage(error))
      this.state.failed(appError.code, appError.message)
      this.publish()
      throw appError
    }

    this.adapter = adapter
    this.attach(adapter)
    try {
      await adapter.start({ mode, phone, credentialsDir: credentialsDir(this.accountId), agent: proxyAgent(this.accountId) ?? undefined })
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(502, 'ENGINE_START_FAILED', errorMessage(error))
      this.state.failed(appError.code, appError.message)
      this.publish()
      await this.disposeAdapter()
      throw appError
    }
    return this.status(actor)
  }

  async requestPairingCode(actor: Actor, rawPhone: string | undefined): Promise<WhatsAppStatus> {
    this.requireRisk(actor)
    const phone = normalizeWhatsAppPhone(rawPhone)
    // 契约 §12.2：没有绑定会话时等价于 link/start 的 pairing 模式。
    // 已有会话但适配器已释放（如进程重启后从 account.json 恢复归属）时同样重新 start。
    if (!this.ownerId || !this.adapter) {
      return this.start(actor, { mode: 'pairing', phone: `+${phone}` })
    }
    this.requireOwner(actor)
    this.state.begin('pairing', phone)
    this.publish()
    try {
      const result = await this.adapter.requestPairingCode(phone)
      this.state.pairingReceived(result.code, result.phone)
      this.publish()
      return this.status(actor)
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(502, 'PAIRING_FAILED', errorMessage(error))
      this.state.failed(appError.code, appError.message)
      this.publish()
      throw appError
    }
  }

  async refreshQr(actor: Actor): Promise<WhatsAppStatus> {
    this.requireRisk(actor)
    this.requireOwner(actor)
    const snapshot = this.state.snapshot(Date.now(), this.riskFor(actor), inspectEngine())
    if (!this.adapter || snapshot.mode !== 'qr') {
      return this.start(actor, { mode: 'qr' })
    }
    this.state.refreshQrStarting()
    this.publish()
    try {
      await this.adapter.refreshQr()
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(502, 'QR_REFRESH_FAILED', errorMessage(error))
      this.state.failed(appError.code, appError.message)
      this.publish()
      throw appError
    }
    return this.status(actor)
  }

  async stop(actor: Actor): Promise<WhatsAppStatus> {
    this.requireOwner(actor)
    const before = this.state.snapshot(Date.now(), this.riskFor(actor), inspectEngine())
    const wasConnected = before.phase === 'connected'
    await this.disposeAdapter()
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    if (wasConnected || before.account) {
      // 手动断开不删凭据：可再次连接；真正解绑走 logout
      this.state.failed('DISCONNECTED', '已断开 WhatsApp 连接。本机仍保留绑定凭据，可重新连接')
    } else {
      this.state.reset()
      if (!hasCredentials(this.accountId)) {
        this.ownerId = null
        this.ownerOrgId = null
      }
    }
    this.publish()
    return this.status(actor)
  }

  async logout(actor: Actor): Promise<WhatsAppStatus> {
    this.requireOwner(actor)
    const adapter = this.adapter
    try {
      await adapter?.logout()
    } catch (error) {
      logger.warn('whatsapp logout failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await this.disposeAdapter()
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    clearSession(this.accountId)
    const previousOwner = this.ownerId
    this.state.reset()
    this.ownerId = null
    this.ownerOrgId = null
    if (previousOwner) {
      eventBus.publish('whatsapp.status', this.state.snapshot(Date.now(), readRisk(previousOwner), inspectEngine()), {
        userId: previousOwner,
        orgId: actor.orgId,
      })
    }
    auditService.record({
      action: 'whatsapp.logout',
      entityType: 'whatsapp',
      entityId: this.accountId,
      summary: '解绑 WhatsApp（本地凭据已删除）',
      meta: { accountId: this.accountId },
      actor,
    })
    return this.status(actor)
  }

  // ---------------------------------------------------------------- 会话与消息

  listConversations(
    actor: Actor,
    options: ConversationListOptions = {},
  ): WhatsAppConversationPage {
    this.assertReadable(actor)
    if (!this.ownerId) return { items: [], total: 0, hasMore: false }
    return listStoredConversations(actor.id, options)
  }

  conversationCounts(actor: Actor): WhatsAppConversationCounts {
    this.assertReadable(actor)
    if (!this.ownerId) return { all: 0, unread: 0, pending: 0, archived: 0, tags: [] }
    return storedConversationCounts(actor.id)
  }

  /** 归档 / 置顶 / 标签 / 手动关联客户；客户是否可见由调用方（路由）先校验 */
  updateConversation(
    actor: Actor,
    conversationId: string,
    patch: { archived?: boolean; pinned?: boolean; tags?: string[]; customerId?: string | null },
  ): WhatsAppConversation {
    this.requireConversation(actor, conversationId)
    const updated = updateConversationMeta(actor.id, conversationId, patch)
    if (!updated) throw new AppError(404, 'WHATSAPP_CONVERSATION_NOT_FOUND', '会话不存在或不属于当前用户')
    this.publishConversation(updated)
    return updated
  }

  /** LULUX 起草的回复：只存到会话上，等用户在会话页采用（填入输入框）或丢弃；text 为 null 即清除 */
  setDraft(actor: Actor, conversationId: string, text: string | null): WhatsAppConversation {
    this.requireConversation(actor, conversationId)
    const value = text === null ? null : validateMessageText(text)
    const updated = setConversationDraft(actor.id, conversationId, value)
    if (!updated) throw new AppError(404, 'WHATSAPP_CONVERSATION_NOT_FOUND', '会话不存在或不属于当前用户')
    this.publishConversation(updated)
    return updated
  }

  /** 会话对应的客户：先看手动关联，再按号码匹配联系人（返回候选客户 id，由路由按权限读取） */
  conversationForProfile(actor: Actor, conversationId: string): WhatsAppConversation {
    return this.requireConversation(actor, conversationId)
  }

  openConversation(
    actor: Actor,
    input: { phone: string; displayName?: string },
  ): WhatsAppConversation {
    this.requireOwner(actor)
    const phone = normalizeConversationPhone(input.phone)
    const conversation = openStoredConversation({
      ownerId: actor.id,
      orgId: this.ownerOrgId ?? actor.orgId,
      phone: `+${phone}`,
      remoteJid: `${phone}@s.whatsapp.net`,
      displayName: input.displayName?.trim() || `+${phone}`,
    })
    this.publishConversation(conversation)
    return conversation
  }

  conversationMessages(
    actor: Actor,
    conversationId: string,
    options: { limit?: number; before?: string | null } = {},
  ): WhatsAppMessagePage {
    this.requireConversation(actor, conversationId)
    return listMessages(actor.id, conversationId, options)
  }

  async sendMessage(actor: Actor, conversationId: string, rawText: string): Promise<WhatsAppMessage> {
    const conversation = this.requireConversation(actor, conversationId)
    const text = validateMessageText(rawText)
    // 先确认连接再落库，避免未连接时留下永远停在 sending 的消息
    this.requireConnected()
    const created = recordOutgoingMessage({
      ownerId: actor.id,
      conversationId: conversation.id,
      body: text,
    })
    this.publishMessage(created.message)
    this.publishConversation(created.conversation)
    return this.deliver(actor, conversation, created.message)
  }

  async retryMessage(actor: Actor, messageId: string): Promise<WhatsAppMessage> {
    this.requireOwner(actor)
    const message = getMessage(actor.id, messageId)
    if (!message) {
      throw new AppError(404, 'WHATSAPP_MESSAGE_NOT_FOUND', '消息不存在或不属于当前用户')
    }
    if (message.direction !== 'out' || message.status !== 'failed') {
      throw new AppError(409, 'WHATSAPP_MESSAGE_NOT_RETRYABLE', '只有发送失败的消息可以重试')
    }
    const conversation = this.requireConversation(actor, message.conversationId)
    this.requireConnected()
    const sending = markMessageSending(actor.id, message.id)
    if (sending) this.publishMessage(sending)
    return this.deliver(actor, conversation, sending ?? message)
  }

  markRead(actor: Actor, conversationId: string): WhatsAppConversation {
    const conversation = this.requireConversation(actor, conversationId)
    const updated = markConversationRead(actor.id, conversation.id)
    if (!updated) {
      throw new AppError(404, 'WHATSAPP_CONVERSATION_NOT_FOUND', '会话不存在或不属于当前用户')
    }
    this.publishConversation(updated)
    return updated
  }

  async translateInput(
    actor: Actor,
    input: {
      text: string
      targetLang?: string
      sourceLang?: string
      conversationId?: string | null
    },
  ): Promise<{
    provider: string
    kind: string
    text: string
    sourceLang: string
    targetLang: string
    requestedTarget: string
  }> {
    const text = String(input.text ?? '').trim()
    if (!text) throw new AppError(400, 'TRANSLATION_INVALID_TEXT', '要翻译的文本不能为空')
    if (text.length > 5_000) {
      throw new AppError(400, 'TRANSLATION_INVALID_TEXT', '要翻译的文本过长（最多 5000 字符）')
    }
    const requestedTarget = input.targetLang?.trim() || 'en'
    if (!(TRANSLATOR_TARGET_LANGUAGES as readonly string[]).includes(requestedTarget)) {
      throw new AppError(400, 'TRANSLATION_INVALID_TARGET', `不支持的目标语言：${requestedTarget}`)
    }
    let conversationText: string | null = null
    if (input.conversationId) {
      const conversation = this.requireConversation(actor, input.conversationId)
      conversationText = latestIncomingText(actor.id, conversation.id)
    }
    const targetLang: string =
      requestedTarget === 'auto'
        ? resolveAutoTarget(conversationText ?? text)
        : (requestedTarget as TranslatorTargetLanguage)
    const requestedSource = input.sourceLang?.trim() || 'auto'
    const detected = detectTextLanguage(text)
    const sourceLang = requestedSource === 'auto' ? (detected === 'unknown' ? 'auto' : detected) : requestedSource
    const provider = await loadTranslator()
    try {
      const result = await provider.translate({ text, sourceLang, targetLang })
      return {
        provider: provider.id,
        kind: provider.kind,
        text: result.text,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        requestedTarget,
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(502, 'TRANSLATION_FAILED', `翻译失败：${errorMessage(error)}`)
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private handleEvent(event: WhatsAppEngineEvent): void {
    switch (event.type) {
      case 'connecting':
        this.state.connecting()
        this.publish()
        break
      case 'qr':
        this.state.qrReceived(event.dataUrl)
        this.publish()
        break
      case 'pairing':
        this.state.pairingReceived(event.code, event.phone)
        this.publish()
        break
      case 'open': {
        const account: WhatsAppAccountInfo = event.account
        this.reconnectAttempts = 0
        this.clearReconnectTimer()
        this.state.connected(account)
        if (this.ownerId) {
          saveAccount(this.accountId, this.ownerId, account)
          chmodSession(this.accountId)
          auditService.record({
            action: 'whatsapp.linked',
            entityType: 'whatsapp',
            entityId: this.accountId,
            summary: 'WhatsApp 关联设备绑定成功',
            meta: { accountId: this.accountId, phoneTail: account.phone.slice(-4) },
            actor: { id: this.ownerId, name: '', email: '', role: 'member', orgId: this.ownerOrgId ?? 'local', teamIds: [], sessionId: null },
          })
        }
        this.publish()
        break
      }
      case 'message': {
        if (!this.ownerId) break
        try {
          const result = recordIncomingMessage({
            ...event.message,
            ownerId: this.ownerId,
            orgId: this.ownerOrgId ?? 'local',
          })
          this.publishConversation(result.conversation)
          if (!result.duplicate) this.publishMessage(result.message)
        } catch (error) {
          logger.warn('whatsapp incoming message persist failed', { message: errorMessage(error) })
        }
        break
      }
      case 'close':
        this.handleClose(event)
        break
      case 'error':
        this.state.failed(event.code, event.message)
        this.publish()
        break
    }
  }

  private handleClose(event: Extract<WhatsAppEngineEvent, { type: 'close' }>): void {
    if (event.loggedOut) {
      clearSession(this.accountId)
      this.state.loggedOut('AUTH_LOGGED_OUT', '已在手机上退出这台设备，本地凭据已作废，请重新扫码或使用配对码绑定')
      this.publish()
      this.recordAuthEvent('whatsapp.logged_out', 'WhatsApp 已在手机端被登出')
      void this.disposeAdapter()
      return
    }
    if (event.replaced) {
      clearSession(this.accountId)
      this.state.loggedOut('AUTH_REPLACED', '该号码在别处重新绑定了设备，本设备已断开，请重新绑定')
      this.publish()
      this.recordAuthEvent('whatsapp.replaced', 'WhatsApp 关联设备被其他设备顶替')
      void this.disposeAdapter()
      return
    }
    const snapshot = this.state.snapshot(Date.now(), this.riskFor(this.actorForOwner()), inspectEngine())
    if (snapshot.phase === 'unbound' || snapshot.phase === 'reauth' || snapshot.phase === 'failed') return
    this.scheduleReconnect(event.reason || '连接中断')
  }

  private actorForOwner(): Actor {
    return {
      id: this.ownerId ?? 'local',
      name: '',
      email: '',
      role: 'member',
      orgId: this.ownerOrgId ?? 'local',
      teamIds: [],
      sessionId: null,
    }
  }

  private recordAuthEvent(action: string, summary: string): void {
    if (!this.ownerId) return
    auditService.record({
      action,
      entityType: 'whatsapp',
      entityId: this.accountId,
      summary,
      meta: { accountId: this.accountId },
      actor: this.actorForOwner(),
    })
  }

  private scheduleReconnect(reason: string): void {
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > WHATSAPP_RECONNECT_DELAYS.length) {
      this.state.failed('RECONNECT_EXHAUSTED', `连续 ${WHATSAPP_RECONNECT_DELAYS.length} 次重连失败：${reason}`)
      this.publish()
      void this.disposeAdapter()
      return
    }
    const delay = WHATSAPP_RECONNECT_DELAYS[this.reconnectAttempts - 1]!
    const nextAt = Date.now() + delay
    this.state.reconnecting({
      attempt: this.reconnectAttempts,
      maxAttempts: WHATSAPP_RECONNECT_DELAYS.length,
      nextAt,
    })
    this.publish()
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnectNow()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private async reconnectNow(): Promise<void> {
    const snapshot = this.state.snapshot(Date.now(), readRisk(this.ownerId ?? ''), inspectEngine())
    const mode: WhatsAppLinkMode = snapshot.mode ?? 'qr'
    const phone = snapshot.pairing?.phone
    await this.disposeAdapter()
    let adapter: WhatsAppEngineAdapter
    try {
      adapter = this.createAdapter()
    } catch (error) {
      this.reconnectAttempts += 1
      if (this.reconnectAttempts > WHATSAPP_RECONNECT_DELAYS.length) {
        this.state.failed('RECONNECT_EXHAUSTED', `连续重连失败：${errorMessage(error)}`)
        this.publish()
      } else {
        const delay = WHATSAPP_RECONNECT_DELAYS[this.reconnectAttempts - 1]!
        this.state.reconnecting({ attempt: this.reconnectAttempts, maxAttempts: WHATSAPP_RECONNECT_DELAYS.length, nextAt: Date.now() + delay })
        this.publish()
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          void this.reconnectNow()
        }, delay)
        this.reconnectTimer.unref?.()
      }
      return
    }
    this.adapter = adapter
    this.attach(adapter)
    try {
      await adapter.start({ mode, phone, credentialsDir: credentialsDir(this.accountId), agent: proxyAgent(this.accountId) ?? undefined })
    } catch (error) {
      this.scheduleReconnect(errorMessage(error))
    }
  }
}

/**
 * 联系人里手填的电话 → 不带 + 的 E.164 数字；只认带国家码的写法（+ 或 00 开头），
 * 认不出返回 null（不猜国家码，免得把别人的号码关联到客户上）。
 */
export function contactPhoneDigits(raw: string): string | null {
  const v = String(raw ?? '').trim().replace(/[\s\-().]/g, '')
  const m = /^(?:\+|00)([1-9]\d{7,14})$/.exec(v)
  return m ? m[1]! : null
}

export interface ConversationListOptions {
  limit?: number
  offset?: number
  filter?: WhatsAppConversationFilter
  tag?: string
  q?: string
  sort?: 'recent' | 'unread'
}

export function normalizeWhatsAppPhone(raw: string | undefined): string {
  const value = String(raw ?? '').trim().replace(/[\s-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new AppError(
      400,
      'PAIRING_INVALID_PHONE',
      '手机号格式不正确：请输入带国家码的 E.164 号码（如 +8613800138000）',
    )
  }
  return value.slice(1)
}

export function normalizeConversationPhone(raw: string): string {
  const value = String(raw ?? '').trim().replace(/[\s-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new AppError(
      400,
      'WHATSAPP_INVALID_PHONE',
      '手机号格式不正确：请输入带国家码的 E.164 号码（如 +8613800138000）',
    )
  }
  return value.slice(1)
}

function validateMessageText(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new AppError(400, 'WHATSAPP_MESSAGE_EMPTY', '消息内容不能为空')
  if (text.length > 4_096) {
    throw new AppError(400, 'WHATSAPP_MESSAGE_TOO_LONG', '消息内容过长（最多 4096 字符）')
  }
  return text
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


/**
 * 单机个人号：整台服务只关联一个 WhatsApp 账号（`default`）。
 * desktop 只有本机用户；server 模式归属锁定给第一个开始绑定的成员，其他成员收到 WHATSAPP_ACCOUNT_BUSY。
 * 出口代理：本机模式由本机用户设置；server 模式由已绑定的成员（未绑定时任何有写权限的成员）或老板 / 管理员设置。
 */
export class WhatsAppAccount {
  private service: WhatsAppService | null = null
  private factory: WhatsAppEngineFactory | null = null

  private get instance(): WhatsAppService {
    if (!this.service) {
      this.service = new WhatsAppService(DEFAULT_ACCOUNT_ID)
      if (this.factory) this.service.setEngineFactory(this.factory)
    }
    return this.service
  }

  setEngineFactory(factory: WhatsAppEngineFactory): void {
    this.factory = factory
    this.service?.setEngineFactory(factory)
  }

  /** server 启动：凭据有效时自动重新连上（电脑关机也保持在线）；desktop 由用户点「重新连接」 */
  async resumeLinked(): Promise<boolean> {
    if (config.mode !== 'server') return false
    try {
      return await this.instance.resume()
    } catch (error) {
      logger.warn('whatsapp.resume_failed', { error: errorMessage(error) })
      return false
    }
  }

  status(actor: Actor): WhatsAppStatus { return this.instance.status(actor) }
  acceptRisk(actor: Actor) { return this.instance.acceptRisk(actor) }
  start(actor: Actor, input: WhatsAppStartInput) { return this.instance.start(actor, input) }
  requestPairingCode(actor: Actor, phone: string | undefined) { return this.instance.requestPairingCode(actor, phone) }
  refreshQr(actor: Actor) { return this.instance.refreshQr(actor) }
  stop(actor: Actor) { return this.instance.stop(actor) }
  logout(actor: Actor) { return this.instance.logout(actor) }
  listConversations(actor: Actor, options: ConversationListOptions = {}) { return this.instance.listConversations(actor, options) }
  conversationCounts(actor: Actor) { return this.instance.conversationCounts(actor) }
  updateConversation(actor: Actor, id: string, patch: Parameters<WhatsAppService['updateConversation']>[2]) { return this.instance.updateConversation(actor, id, patch) }
  conversationForProfile(actor: Actor, id: string) { return this.instance.conversationForProfile(actor, id) }
  openConversation(actor: Actor, input: { phone: string; displayName?: string }) { return this.instance.openConversation(actor, input) }
  conversationMessages(actor: Actor, id: string, options: { limit?: number; before?: string | null } = {}) { return this.instance.conversationMessages(actor, id, options) }
  sendMessage(actor: Actor, id: string, text: string) { return this.instance.sendMessage(actor, id, text) }
  retryMessage(actor: Actor, id: string) { return this.instance.retryMessage(actor, id) }
  markRead(actor: Actor, id: string) { return this.instance.markRead(actor, id) }
  setDraft(actor: Actor, id: string, text: string | null) { return this.instance.setDraft(actor, id, text) }
  translateInput(...args: Parameters<WhatsAppService['translateInput']>) { return this.instance.translateInput(...args) }

  // ------------------------------------------------ 出口代理

  private requireProxyEditor(actor: Actor): WhatsAppService {
    const service = this.instance
    if (config.mode !== 'server') return service
    const owner = service.boundOwnerId
    if (owner && owner !== actor.id && !seesAll(actor)) {
      throw new AppError(409, 'WHATSAPP_ACCOUNT_BUSY', '只有绑定该 WhatsApp 账号的用户可以执行此操作')
    }
    return service
  }

  getProxy(actor: Actor): { proxy: WhatsAppProxyView | null } {
    return { proxy: readProxy(this.requireProxyEditor(actor).accountId) }
  }

  async setProxy(actor: Actor, input: WhatsAppProxyInput | null): Promise<{ proxy: WhatsAppProxyView | null; reconnected: boolean }> {
    const service = this.requireProxyEditor(actor)
    const proxy = input ? saveProxy(service.accountId, input) : (clearProxy(service.accountId), null)
    auditService.record({
      action: 'whatsapp.proxy_update',
      entityType: 'whatsapp',
      entityId: service.accountId,
      summary: proxy ? `设置 WhatsApp 代理 ${proxy.protocol}://${proxy.host}:${proxy.port}` : '清除 WhatsApp 代理',
      meta: { accountId: service.accountId },
      actor,
    })
    const reconnected = await service.reconnectForProxyChange()
    return { proxy, reconnected }
  }

  testProxy(actor: Actor, input?: WhatsAppProxyInput) {
    return testProxy(this.requireProxyEditor(actor).accountId, input)
  }
}

export const whatsappService = new WhatsAppAccount()
