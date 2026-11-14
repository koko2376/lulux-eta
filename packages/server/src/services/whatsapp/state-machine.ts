import {
  WHATSAPP_MAX_QR_REFRESHES,
  WHATSAPP_PAIRING_TTL_MS,
  WHATSAPP_QR_TTL_MS,
  type WhatsAppAccountInfo,
  type WhatsAppConnection,
  type WhatsAppErrorInfo,
  type WhatsAppLinkMode,
  type WhatsAppPairing,
  type WhatsAppPhase,
  type WhatsAppQr,
  type WhatsAppReconnectInfo,
  type WhatsAppStatus,
  type WhatsAppEngineInfo,
} from './types.js'

/** 状态机只保存内部阶段与数据；对外快照按需求归并为四态连接。 */
export class WhatsAppStateMachine {
  constructor(private readonly accountId = 'default') {}

  private phase: WhatsAppPhase = 'unbound'
  private mode: WhatsAppLinkMode | null = null
  private account: WhatsAppAccountInfo | null = null
  private qr: WhatsAppQr | null = null
  private pairing: WhatsAppPairing | null = null
  private error: WhatsAppErrorInfo | null = null
  private reconnect: WhatsAppReconnectInfo | null = null
  private qrRefreshCount = 0
  private updatedAt = Date.now()
  private engine: WhatsAppEngineInfo = {
    id: 'baileys',
    installed: false,
    version: null,
    dir: null,
    qrAvailable: false,
    error: null,
  }

  setEngine(engine: WhatsAppEngineInfo): void {
    this.engine = engine
    this.updatedAt = Date.now()
  }

  begin(mode: WhatsAppLinkMode, phone: string | null, now = Date.now()): void {
    this.phase = mode === 'qr' ? 'waiting_qr' : 'waiting_pairing'
    this.mode = mode
    this.qr = null
    this.pairing = null
    this.error = null
    this.reconnect = null
    this.qrRefreshCount = 0
    if (mode === 'pairing' && phone) {
      // 手机号在拿到配对码前也可展示；码由 pairing event 填入
      this.pairing = { code: '', phone, issuedAt: now, expiresAt: now + WHATSAPP_PAIRING_TTL_MS, expired: false }
    }
    this.updatedAt = now
  }

  qrReceived(dataUrl: string, now = Date.now()): void {
    if (this.mode !== 'qr') return
    this.qrRefreshCount += 1
    this.qr = {
      dataUrl,
      issuedAt: now,
      expiresAt: now + WHATSAPP_QR_TTL_MS,
      refreshCount: this.qrRefreshCount,
      warning: this.qrRefreshCount >= WHATSAPP_MAX_QR_REFRESHES,
      expired: false,
    }
    this.phase = 'waiting_qr'
    this.error = null
    this.reconnect = null
    this.updatedAt = now
  }

  /** 手动换一张二维码：保留连续刷新计数，用于第 6 次后提示检查手机网络 */
  refreshQrStarting(now = Date.now()): void {
    if (this.mode !== 'qr') return
    this.phase = 'waiting_qr'
    this.qr = null
    this.pairing = null
    this.error = null
    this.reconnect = null
    this.updatedAt = now
  }

  pairingReceived(code: string, phone: string, now = Date.now()): void {
    if (this.mode !== 'pairing') return
    this.pairing = {
      code,
      phone,
      issuedAt: now,
      expiresAt: now + WHATSAPP_PAIRING_TTL_MS,
      expired: false,
    }
    this.phase = 'waiting_pairing'
    this.error = null
    this.updatedAt = now
  }

  connecting(now = Date.now()): void {
    // 等二维码 / 等配对码阶段不因底层 "connecting" 事件丢掉当前面板
    if (this.phase === 'waiting_qr' || this.phase === 'waiting_pairing') return
    if (this.phase === 'unbound' || this.phase === 'reauth') return
    this.phase = 'connecting'
    this.updatedAt = now
  }

  connected(account: WhatsAppAccountInfo, now = Date.now()): void {
    this.phase = 'connected'
    this.account = { ...account, lastLoginAt: now, lastActivityAt: now }
    this.qr = null
    this.pairing = null
    this.error = null
    this.reconnect = null
    this.qrRefreshCount = 0
    this.updatedAt = now
  }

  reconnecting(info: WhatsAppReconnectInfo, now = Date.now()): void {
    this.phase = 'reconnecting'
    this.reconnect = info
    this.qr = null
    this.pairing = null
    this.updatedAt = now
  }

  failed(code: string, message: string, now = Date.now()): void {
    this.phase = 'failed'
    this.error = { code, message }
    this.reconnect = null
    this.qr = null
    this.pairing = null
    this.updatedAt = now
  }

  loggedOut(code = 'AUTH_LOGGED_OUT', message = '已在手机上退出这台设备，请重新扫码或使用配对码绑定', now = Date.now()): void {
    this.phase = 'reauth'
    this.error = { code, message }
    this.qr = null
    this.pairing = null
    this.reconnect = null
    this.mode = null
    this.updatedAt = now
  }

  touch(now = Date.now()): void {
    if (this.account && this.phase === 'connected') this.account.lastActivityAt = now
    this.updatedAt = now
  }

  reset(now = Date.now()): void {
    this.phase = 'unbound'
    this.mode = null
    this.account = null
    this.qr = null
    this.pairing = null
    this.error = null
    this.reconnect = null
    this.qrRefreshCount = 0
    this.updatedAt = now
  }

  connection(_now = Date.now()): WhatsAppConnection {
    if (this.phase === 'connected') return 'connected'
    if (this.phase === 'reauth') return 'reauth'
    if (
      this.phase === 'waiting_qr' ||
      this.phase === 'waiting_pairing' ||
      this.phase === 'connecting' ||
      this.phase === 'reconnecting'
    ) {
      return 'connecting'
    }
    return 'disconnected'
  }

  snapshot(now = Date.now(), risk: WhatsAppStatus['risk'], engineOverride?: WhatsAppEngineInfo): WhatsAppStatus {
    if (engineOverride) this.engine = engineOverride
    let phase = this.phase
    let error = this.error
    let qr = this.qr
    let pairing = this.pairing

    if (qr && qr.expiresAt <= now) {
      qr = { ...qr, expired: true }
      // 二维码过期不等于失败：保留等待面板，界面显示「已过期 · 刷新后重新扫码」
    }
    if (pairing && pairing.expiresAt <= now) {
      pairing = { ...pairing, expired: true }
      phase = 'failed'
      error = { code: 'PAIRING_CODE_EXPIRED', message: '配对码已过期或校验失败，请重新生成' }
    }

    return {
      accountId: this.accountId,
      phase,
      connection: phase === 'connected' ? 'connected' : phase === 'reauth' ? 'reauth' : phase === 'unbound' || phase === 'failed' ? 'disconnected' : 'connecting',
      mode: this.mode,
      engine: this.engine,
      account: this.account ? { ...this.account } : null,
      qr,
      pairing,
      reconnect: this.reconnect,
      error,
      risk,
      limits: { linkedDevices: 4, phoneOfflineDays: 14, deviceIdleDays: 30 },
      updatedAt: this.updatedAt,
    }
  }
}
