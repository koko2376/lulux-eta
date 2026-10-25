import { messageOf } from '../../errors.js'
import type { Provider } from '../../types.js'
import { eventBus } from '../events.js'
import { sessionAudience } from '../session-hub.js'
import { completeText } from '../llm/complete.js'
import { NEW_SESSION_TITLE, provisionalTitle, sessionService } from '../session-service.js'
import { settingsService } from '../settings-service.js'

const TITLE_PROMPT =
  '根据下面的对话开头，为这次会话起一个简短的中文标题（不超过 16 个字，概括主题，例如“德国客户阀门报价”）。' +
  '只输出标题本身，不要引号、句号或任何解释。'

export function cleanTitle(raw: string): string {
  const firstLine = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  const cleaned = firstLine
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/^[#*\s"'“”‘’「」《》]+|[\s"'“”‘’「」《》。.!！?？]+$/g, '')
    .trim()
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
}

/**
 * 首轮回复后（会话里恰好一条用户消息）用模型生成标题；用户改过标题则不动。
 * 后台执行，不阻塞对话流；结果经 /api/events 推送 `session.title`。返回 Promise 便于测试等待。
 */
export function maybeGenerateTitle(sessionId: string, provider: Provider | null): Promise<string | null> | null {
  if (!provider || settingsService.get('autoTitle') === '0') return null
  const messages = sessionService.messages(sessionId)
  const users = messages.filter((m) => m.role === 'user')
  const firstReply = messages.find((m) => m.role === 'assistant' && m.content.trim())
  if (users.length !== 1 || !firstReply) return null
  const session = sessionService.get(sessionId)
  if (!session || session.workflowRunId) return null
  const expected = session.title
  if (expected !== NEW_SESSION_TITLE && expected !== provisionalTitle(users[0]!.content)) return null

  const transcript = `用户：${users[0]!.content.slice(0, 1200)}\n\n助手：${firstReply.content.slice(0, 800)}`
  return completeText(TITLE_PROMPT, transcript, { provider, timeoutMs: 30_000, purpose: 'title', sessionId, maxTokens: 64 })
    .then(({ text }) => {
      const title = cleanTitle(text)
      if (!title) return null
      if (!sessionService.setGeneratedTitle(sessionId, expected, title)) return null
      // 只推给会话成员（负责人 + 群聊真人成员），admin 也收不到别人的会话标题
      const audience = sessionAudience(sessionId)
      if (audience) eventBus.publish('session.title', { sessionId, title }, { userIds: audience.userIds, orgId: audience.orgId })
      return title
    })
    .catch((error) => {
      console.warn('[lulux-eta] auto title failed:', messageOf(error))
      return null
    })
}
