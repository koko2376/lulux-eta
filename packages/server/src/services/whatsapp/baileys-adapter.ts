import { AppError } from '../../errors.js'
import { logger } from '../logger.js'
import { dirname } from 'node:path'
import { chmodTree } from './credential-store.js'
import { loadBaileysModules, type BaileysModules } from './engine-loader.js'
import { JidResolver, mapContacts, mapHistorySet, mapRawMessage, timestampOf } from './message-mapper.js'
import {
  WA_HISTORY_DAYS,
  type WhatsAppEngineAdapter,
  type WhatsAppEngineListener,
  type WhatsAppOutgoingMessage,
  type WhatsAppSendResult,
  type WhatsAppStartOptions,
} from './types.js'

/**
 * Baileys 运行时适配器（不进 bundle、不是 npm 依赖）。
 *
 * 关键行为：
 * - `connection.update` 的 qr → 用引擎目录里的 qrcode 渲染成 data URL，只经 SSE 下发；
 * - `requestPairingCode` → 8 位码只回给当前请求与 SSE，不写日志、不落盘；
 * - `creds.update` → saveCreds 后把会话目录文件权限收紧到 0600；
 * - `DisconnectReason` 原样上报，由服务层映射四态（401 不重连、440 不重连）。
 *
 * passkey 二次确认（调研 §2.3 / §4.4）在 2026-11 的 Baileys 发布版仍可能卡住；
 * 适配器不伪造连接成功，只如实把 close / error 交给状态机。
 *
 * 历史同步：以桌面端身份请求完整历史（syncFullHistory + 桌面设备标识），
 * `messaging-history.set` 按批交给服务层，只保留近 WA_HISTORY_DAYS 天的一对一聊天。
 */

/** 完整历史同步要求以桌面端身份关联 */
function desktopBrowser(modules: BaileysModules): [string, string, string] {
  const preset = modules.Browsers?.macOS?.('Desktop')
  return Array.isArray(preset) && preset.length === 3 ? preset : ['Mac OS', 'Desktop', '14.4.1']
}
export class BaileysAdapter implements WhatsAppEngineAdapter {
  readonly id = 'baileys'
  private readonly listeners = new Set<WhatsAppEngineListener>()
  private modules: BaileysModules | null = null
  private socket: any = null
  private mode: WhatsAppStartOptions['mode'] = 'qr'
  private credentialsDir = ''
  private stopped = false
  private connected = false
  private generation = 0

  constructor(private readonly engineDir: string) {}

  onEvent(listener: WhatsAppEngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Parameters<WhatsAppEngineListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        logger.warn('whatsapp engine listener failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async load(): Promise<BaileysModules> {
    if (!this.modules) this.modules = await loadBaileysModules(this.engineDir)
    return this.modules
  }

  async start(options: WhatsAppStartOptions): Promise<void> {
    this.stopped = false
    this.mode = options.mode
    this.credentialsDir = options.credentialsDir
    const generation = ++this.generation
    const modules = await this.load()

    // 已有凭据时 Baileys 会直接重连；没有凭据时等待 qr 事件
    const { state, saveCreds } = await modules.useMultiFileAuthState(options.credentialsDir)
    if (this.stopped || generation !== this.generation) return

    const socket = modules.makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: desktopBrowser(modules),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      ...(options.agent ? { agent: options.agent, fetchAgent: options.agent } : {}),
    })
    this.socket = socket

    socket.ev.on('creds.update', () => {
      void saveCreds()
        .then(() => chmodTree(dirname(options.credentialsDir)))
        .catch((error: unknown) => {
          logger.warn('whatsapp credentials save failed', {
            message: error instanceof Error ? error.message : String(error),
          })
        })
    })

    socket.ev.on('connection.update', (update: any) => {
      if (this.stopped || generation !== this.generation) return
      const { connection, qr, lastDisconnect, isNewLogin } = update ?? {}

      if (qr) {
        if (this.mode !== 'qr') return
        void modules
          .toDataUrl(String(qr), { errorCorrectionLevel: 'M', margin: 2, width: 512 })
          .then((dataUrl) => {
            if (this.stopped || generation !== this.generation) return
            this.emit({ type: 'qr', dataUrl })
          })
          .catch((error: unknown) => {
            this.emit({
              type: 'error',
              code: 'ENGINE_QR_RENDER_FAILED',
              message: `二维码渲染失败：${error instanceof Error ? error.message : String(error)}`,
            })
          })
      }

      if (connection === 'connecting') {
        this.emit({ type: 'connecting' })
      }

      if (connection === 'open') {
        this.connected = true
        const user = socket.user ?? {}
        const jid = String(user.id ?? '')
        const phone = jid.split(':')[0]?.split('@')[0] ?? ''
        const now = Date.now()
        this.emit({
          type: 'open',
          account: {
            phone: phone ? `+${phone}` : '',
            deviceName: String(user.name ?? 'WhatsApp 关联设备'),
            platform: user.platform ? String(user.platform) : null,
            linkedAt: now,
            lastLoginAt: now,
            lastActivityAt: now,
          },
        })
        logger.info('whatsapp engine connected', { isNewLogin: Boolean(isNewLogin) })
      }

      if (connection === 'close') {
        this.connected = false
        const error = lastDisconnect?.error
        const statusCode = Number(error?.output?.statusCode ?? error?.statusCode ?? 0) || null
        const reason = String(error?.message ?? 'connection closed')
        this.emit({
          type: 'close',
          statusCode,
          reason,
          loggedOut: statusCode === 401,
          replaced: statusCode === 440,
        })
      }
    })

    const resolver = new JidResolver()
    const cutoff = (): number => Date.now() - WA_HISTORY_DAYS * 86_400_000

    // 实时消息：通知类与补发类 upsert 都处理（含自己从手机发出的），跳过群聊、广播与协议消息。
    // 去重交给存储层按引擎消息 id 处理（重连补历史不会重复计数）。
    socket.ev.on('messages.upsert', (payload: any) => {
      if (this.stopped || generation !== this.generation) return
      if (payload?.type && payload.type !== 'notify' && payload.type !== 'append') return
      for (const raw of payload?.messages ?? []) {
        const message = mapRawMessage(raw, resolver)
        if (!message) continue
        // 补发类（离线期间的消息）同样只要近 90 天
        if (payload?.type === 'append' && message.timestamp < cutoff()) continue
        this.emit({ type: 'message', message })
      }
    })

    // 历史同步：绑定后手机分批推送会话、联系人与消息
    socket.ev.on('messaging-history.set', (data: any) => {
      if (this.stopped || generation !== this.generation) return
      try {
        const batch = mapHistorySet(data, cutoff(), resolver)
        this.emit({ type: 'history', batch })
      } catch (error) {
        logger.warn('whatsapp history batch failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })

    const onContacts = (contacts: unknown): void => {
      if (this.stopped || generation !== this.generation) return
      const mapped = mapContacts(contacts, resolver)
      if (mapped.length) this.emit({ type: 'contacts', contacts: mapped })
    }
    socket.ev.on('contacts.upsert', onContacts)
    socket.ev.on('contacts.update', onContacts)

    // 配对码模式：没有既有凭据时立刻向 WhatsApp 申请 8 位码；失败原样抛给服务层，
    // 不允许静默退回二维码。已有凭据时直接重连，不申请新码。
    if (options.mode === 'pairing' && options.phone && !state.creds?.registered) {
      try {
        await this.requestPairingCode(options.phone)
      } catch (error) {
        this.emit({
          type: 'error',
          code: error instanceof AppError ? error.code : 'PAIRING_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
  }

  async sendText(message: WhatsAppOutgoingMessage): Promise<WhatsAppSendResult> {
    if (!this.socket || !this.connected) {
      // 未连接必须显式失败；服务层据此把消息标记为 failed 并允许重试
      throw new AppError(409, 'WHATSAPP_NOT_CONNECTED', 'WhatsApp 尚未连接，消息未发送')
    }
    const text = message.text.trim()
    if (!text) throw new AppError(400, 'WHATSAPP_MESSAGE_EMPTY', '消息内容不能为空')
    const remoteJid = message.remoteJid.includes('@')
      ? message.remoteJid
      : `${message.remoteJid.replace(/\D/g, '')}@s.whatsapp.net`
    try {
      const result = await this.socket.sendMessage(remoteJid, { text })
      return {
        id: String(result?.key?.id ?? ''),
        timestamp: timestampOf(result?.messageTimestamp),
      }
    } catch (error) {
      const status = Number((error as any)?.output?.statusCode ?? (error as any)?.statusCode ?? 0)
      const detail = error instanceof Error ? error.message : String(error)
      throw new AppError(
        502,
        'WHATSAPP_SEND_FAILED',
        `WhatsApp 消息发送失败：${detail}`,
        undefined,
        status ? { statusCode: status } : undefined,
      )
    }
  }

  async requestPairingCode(phone: string): Promise<{ code: string; phone: string }> {
    if (!this.socket) {
      throw new AppError(502, 'PAIRING_FAILED', 'WhatsApp 引擎尚未建立连接，无法生成配对码')
    }
    try {
      const raw = await this.socket.requestPairingCode(phone)
      const code = String(raw ?? '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
      if (code.length !== 8) {
        throw new AppError(502, 'PAIRING_CODE_INVALID', 'WhatsApp 返回的配对码格式不正确，请重试')
      }
      this.emit({ type: 'pairing', code, phone })
      return { code, phone }
    } catch (error) {
      if (error instanceof AppError) throw error
      const status = Number(
        (error as any)?.output?.statusCode ?? (error as any)?.statusCode ?? 0,
      )
      const message = error instanceof Error ? error.message : String(error)
      throw new AppError(
        502,
        status === 401 ? 'PAIRING_REJECTED' : 'PAIRING_FAILED',
        `配对码生成失败：${message}`,
      )
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.connected = false
    this.generation += 1
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.end?.(undefined)
    } catch {
      // 已经断开
    }
  }

  async logout(): Promise<void> {
    this.stopped = true
    this.connected = false
    this.generation += 1
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      await socket.logout?.()
    } finally {
      try {
        socket.end?.(undefined)
      } catch {
        // 已经断开
      }
    }
  }

  async refreshQr(): Promise<void> {
    const credentialsDir = this.credentialsDir
    await this.stop()
    await this.start({ mode: 'qr', credentialsDir })
  }
}
