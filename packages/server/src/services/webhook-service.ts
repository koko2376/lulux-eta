import { config } from '../config.js'
import { fetchWithProxy } from './http-client.js'
import { settingsService } from './settings-service.js'

export interface ChatCompletedEvent {
  sessionId: string
  sessionTitle: string
  group: boolean
  providerName: string
  model: string
  agentId: string
  agentName: string
  messageId: string
  content: string
}

export interface WebhookResult {
  ok: boolean
  status: number
}

export function normalizeWebhookUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Webhook 地址格式不正确，示例：https://example.com/hook')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook 地址只支持 http:// 或 https://')
  }
  return url.toString()
}

function savedUrl(): string {
  try {
    return normalizeWebhookUrl(settingsService.get('webhookUrl') ?? '')
  } catch {
    return ''
  }
}

function enabled(): boolean {
  return settingsService.get('webhookEnabled') === '1'
}

function previewOf(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

async function post(
  target: string,
  payload: Record<string, unknown>,
): Promise<WebhookResult> {
  const response = await fetchWithProxy(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `LULUX-ETA/${config.version}`,
      'X-LULUX-Event': String(payload.event ?? ''),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  })
  return { ok: response.ok, status: response.status }
}

/** 通知发送失败不影响对话本身，只记录日志。 */
export const webhookService = {
  notifyChatCompleted(event: ChatCompletedEvent): void {
    if (!enabled()) return
    const target = savedUrl()
    if (!target) return

    const payload = {
      app: 'LULUX ETA',
      event: 'chat.completed',
      sentAt: new Date().toISOString(),
      session: {
        id: event.sessionId,
        title: event.sessionTitle,
        group: event.group,
      },
      provider: { name: event.providerName, model: event.model },
      agent: { id: event.agentId, name: event.agentName },
      message: {
        id: event.messageId,
        preview: previewOf(event.content),
        characters: event.content.length,
      },
    }

    void post(target, payload).catch((error) => {
      console.warn('[lulux-eta] webhook 发送失败', error)
    })
  },

  async test(rawUrl?: string): Promise<WebhookResult> {
    const target = normalizeWebhookUrl(rawUrl ?? settingsService.get('webhookUrl') ?? '')
    if (!target) throw new Error('请先填写 Webhook 地址')

    return post(target, {
      app: 'LULUX ETA',
      event: 'test',
      sentAt: new Date().toISOString(),
      message: '这是一条来自 LULUX ETA 的测试通知，收到即表示配置成功。',
    })
  },
}
