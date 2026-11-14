import type {
  WhatsAppAccountInfo,
  WhatsAppEngineAdapter,
  WhatsAppEngineListener,
  WhatsAppIncomingMessage,
  WhatsAppOutgoingMessage,
  WhatsAppSendResult,
  WhatsAppStartOptions,
} from './types.js'

/**
 * 可注入的假引擎：只用于单测与浏览器验证。
 *
 * 通过环境变量驱动（绝不用于生产）：
 * - `LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS`：二维码出现后多少毫秒模拟手机确认 → connected；
 * - `LULUX_WHATSAPP_FAKE_DISCONNECT_AFTER_MS`：连接后多少毫秒模拟 401 被登出 → reauth；
 * - `LULUX_WHATSAPP_FAKE_INBOUND_AFTER_MS`：连接后多少毫秒模拟一条客户入站消息（只发一次）；
 * - `LULUX_WHATSAPP_FAKE_REPLY_AFTER_MS`：发出文本后多少毫秒模拟对方回复（默认 120ms，发 0 立即）；
 * - `LULUX_WHATSAPP_FAKE_SEND_FAIL_TIMES`：前 N 次发送模拟失败（验证失败态与重试）；
 * - `LULUX_WHATSAPP_FAKE_QR_FIXTURES=1`：使用真实可扫描的 QR 图片（默认就是）。
 *
 * 二维码图片为预生成的 PNG data URL（内容指向 example.invalid，不可用于真实绑定），
 * 每轮刷新切换一张，便于验证「刷新后图片与到期时间都变化」。
 */
const QR_FIXTURES = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAN4AAADeAQAAAAB6HIMaAAACIElEQVR4nO1YMYrkMBCslgwO5R/4KdLPhvmZDPeRecCBFA7I9FGtGbPB7V50bAfbgRFWUm5XV5Ukik/rDJ/vAT+b+EcToI3PqDpSVa0ARpr9zsNj+7KqAsf6KLJBtcZHiar8iuAQLUQK+u3c60BGLwuALnwGj2itjtjy2o5zy7gq4IsK37r5FHluQKrPvboA9LfSRt7Glm24ctQaWzbe+pyyQ0QArI8SG9BvVFoR2Vz2dlbL2jISdWyk1zt/vSUTpt5GE1uygoJmChy8oQ0E1jB6OTe2V6TMWUMvPpkwAbOZXHDo1AbNX2/pvGPSFfmlCZQFkMPBH1rVkUhaYn7TWJu9Dw7RVkorl/z7M9UQvM9U0xlm1oZBOyvaYP5rgxb8oU0a9f7cX6l8SfXcOHSrxwyGyYRpuEyJxt5JYH9MwGVklhb4hoEhEbxHtC1bjKkcNDs+mPCaCwd/aHVq1xQEigOtzanzgmgn1EQmGDHelhH8oW1sJr3AjIwyy8b65G0A8rnrgmNtuLSL2ru71Fur52Z21m9I9wHCdqq3bYqtmVcy7aWOZZfOi/fZgb5gkca01xb+0AZ0EZHF4vfJ24+7bOBlgsecgMvF5pl3hrGXBQePaAHamSGkU1z+6w/ttXmwpY+y9PL6BI/nsuXD+jiZG4+MKqkt6vD+dmEnGWuVGvu7/BqQ1LRL/O6f/dX9bcuDKXEegXnL5JK38nOTj//V2z945ZgB/R092QAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAN4AAADeAQAAAAB6HIMaAAACAklEQVR4nO1YwWnEMBAcWQY/JUgB10hA7iAlHSkpHciluIO854HMhtl17peEPBL2ET2EkTiYG2ZmV5sUn65j+vwO+L/ENyRAhXtWHaWrdgCjON9tRKSvqSqwLfuaKlR73tesyn8xBUSLlFbcrselDzTc1hnALXGfIqL1pft1ke2oLQqgry63Gdu9AqXfL/1Hv/zDS6hQt1kazVU0a8/STLcxXballAAs+5p3CphJm1KqIbn1Zdx6jo1ynsXjlkrwvEWhXKkKBpol8BQPrVKrxFzIMIsCBUz1RkQrzIFsXhuAf6gZLSbaQT6tNKAxExgLQAmKVp1JtPEhYx7G5FZNBkJbub8sHEh1RLTswVoWghxw2B2WY/HQTowCfb1XAgYwl35UZMESsQeDK8ELruUDk8EFHI/bs09wWzm9sfO2ub8GGLyk2vIhaIKpnv7yHGCBoBKCVgdbzm02PVgCW0RM8dBKM39xP2OWxMbU7Qzg/iQJyMBR37K8LFKHHcacJ5hQG585tyvK6yDsqHkrHrZnCTNJ2DAhYuWdWGQN21H57E2VPKuYRKbAsxoQs41r6LigeSv+5oW3uKwRxm1YtDAyrQNn6/Wov4HRksxH98iWJqLL5sfXeNqeLxzfNfRUZNaA81ucuv14QlqOkeSgfYJwt8kSU9emo3ykh9Rt+p/k47e4fQdS+bTHB+JzCgAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAN4AAADeAQAAAAB6HIMaAAACC0lEQVR4nO1YQY7cIBCsBqQ5grQP2KfAz1Z5Un6ApXwkD4gEx5GwOqrG49smpyh9WA7INpdSubq6GlF8us7w+RnwdYi/kAAd3KP2lbtqB7Dy5rsud/RBR1XVqErYBlhHtVeHaAMAkYbZzve+UDFbAjCFe/CI1tbx+PnxGMdZKu4V8IcV/sNhup/OglW+I/fzbSSnaHHp1nagRu3RtW4PESHLs8UBzA/yLCLFJbd7vZxh5b7y9c0ft1SC+a1GM9uNeX/xhzZcrWHKWaqOKtKehcaL2VwqobO4rLIWsMttNwh/3BLtQl2ZmC9PoC0A2SXagZU7tZrJ7ZaxDgrYI1ozW0Ya+/s71VDJHlNNAOvLWlruT2k6YP3XCi145BZG7KISqFtQGNSGP25ZZWYI3C00Ur1bwB7RvizLYONK45ngPaI1kGa2VmtbA6hOHUwZDNgXLINZg6ASnOp2sL52ntk2y50m7BMtWFNXxDWbteTgUreBDTerlIMDWqEMHob/+e7Sb8c1KezZwWbeqxf743aj3bbAvsBX+lh12Xnxmh3YFyzSMOXuB39omRNEJOW+ZjsLVL/JKzb41O0dw7YhGL1u8229ZodRYSPk3X8do7VB0uorsjv4rLJ0Py0czzcFjooueSR1eH+bSC+Qsp4J8Vf7sSB56JTo9GYJHNKtyqiBnW2yutStfN3k419x+xs+l71AmSXp5wAAAABJRU5ErkJggg==',
]
const PAIRING_CODES = ['4K7QM2X9', '8P2N5R6T', '9W3X7Y2Z']
const FAKE_CUSTOMER = {
  remoteJid: '8613800138001@s.whatsapp.net',
  phone: '+8613800138001',
  displayName: '测试客户',
}

function envMs(name: string): number | null {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : null
}

function phoneOf(jid: string): string {
  const user = jid.split('@')[0] ?? ''
  return user ? `+${user.replace(/\D/g, '')}` : ''
}

export class FakeWhatsAppAdapter implements WhatsAppEngineAdapter {
  readonly id = 'fake'
  private readonly listeners = new Set<WhatsAppEngineListener>()
  private timers = new Set<NodeJS.Timeout>()
  private qrRound = 0
  private pairingRound = 0
  private outboundRound = 0
  private sendFailures = envMs('LULUX_WHATSAPP_FAKE_SEND_FAIL_TIMES') ?? 0
  private stopped = false
  private connected = false
  private greeted = false

  onEvent(listener: WhatsAppEngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Parameters<WhatsAppEngineListener>[0]): void {
    for (const listener of this.listeners) listener(event)
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped) fn()
    }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }

  async start(options: WhatsAppStartOptions): Promise<void> {
    this.stopped = false
    this.emit({ type: 'connecting' })
    this.later(() => {
      if (options.mode === 'qr') {
        const dataUrl = QR_FIXTURES[this.qrRound % QR_FIXTURES.length]!
        this.qrRound += 1
        this.emit({ type: 'qr', dataUrl })
        const scanAfter = envMs('LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS')
        if (scanAfter !== null) this.later(() => this.open(), scanAfter)
      } else {
        const code = PAIRING_CODES[this.pairingRound % PAIRING_CODES.length]!
        this.pairingRound += 1
        this.emit({ type: 'pairing', code, phone: options.phone ?? '' })
        const scanAfter = envMs('LULUX_WHATSAPP_FAKE_SCAN_AFTER_MS')
        if (scanAfter !== null) this.later(() => this.open(), scanAfter)
      }
    }, 15)
  }

  private open(): void {
    if (this.connected) return
    this.connected = true
    const now = Date.now()
    const account: WhatsAppAccountInfo = {
      phone: '+8613800138000',
      deviceName: 'LULUX ETA 测试设备',
      platform: 'Chrome',
      linkedAt: now,
      lastLoginAt: now,
      lastActivityAt: now,
    }
    this.emit({ type: 'open', account })
    const inboundAfter = envMs('LULUX_WHATSAPP_FAKE_INBOUND_AFTER_MS')
    if (inboundAfter !== null && !this.greeted) {
      this.greeted = true
      this.later(() => {
        this.emit({
          type: 'message',
          message: {
            id: `fake-in-greeting-${Date.now()}`,
            remoteJid: FAKE_CUSTOMER.remoteJid,
            phone: FAKE_CUSTOMER.phone,
            displayName: FAKE_CUSTOMER.displayName,
            text: '你好，我想咨询一下产品报价。',
            timestamp: Date.now(),
          },
        })
      }, inboundAfter)
    }
    const disconnectAfter = envMs('LULUX_WHATSAPP_FAKE_DISCONNECT_AFTER_MS')
    if (disconnectAfter !== null) {
      this.later(() => {
        this.connected = false
        this.emit({
          type: 'close',
          statusCode: 401,
          reason: 'Connection Failure: logged out (fake)',
          loggedOut: true,
          replaced: false,
        })
      }, disconnectAfter)
    }
  }

  async sendText(message: WhatsAppOutgoingMessage): Promise<WhatsAppSendResult> {
    if (!this.connected) {
      // 显式失败：引擎未连接时绝不假装发送成功
      throw new Error('WhatsApp 引擎未连接，消息未发送')
    }
    const text = message.text.trim()
    if (!text) throw new Error('消息内容不能为空')
    if (this.sendFailures > 0) {
      this.sendFailures -= 1
      throw new Error('假引擎：模拟发送失败')
    }
    this.outboundRound += 1
    const id = `fake-out-${Date.now()}-${this.outboundRound}`
    const timestamp = Date.now()
    const replyAfter = envMs('LULUX_WHATSAPP_FAKE_REPLY_AFTER_MS') ?? 120
    this.later(() => {
      if (!this.connected) return
      const incoming: WhatsAppIncomingMessage = {
        id: `fake-in-reply-${id}`,
        remoteJid: message.remoteJid,
        phone: phoneOf(message.remoteJid),
        displayName: FAKE_CUSTOMER.displayName,
        text: `收到：${text}`,
        timestamp: Date.now(),
      }
      this.emit({ type: 'message', message: incoming })
    }, replyAfter)
    return { id, timestamp }
  }

  async requestPairingCode(phone: string): Promise<{ code: string; phone: string }> {
    const code = PAIRING_CODES[this.pairingRound % PAIRING_CODES.length]!
    this.pairingRound += 1
    this.emit({ type: 'pairing', code, phone })
    return { code, phone }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.connected = false
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  async logout(): Promise<void> {
    await this.stop()
  }

  async refreshQr(): Promise<void> {
    const dataUrl = QR_FIXTURES[this.qrRound % QR_FIXTURES.length]!
    this.qrRound += 1
    this.later(() => this.emit({ type: 'qr', dataUrl }), 15)
  }
}
