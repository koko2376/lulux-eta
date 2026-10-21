import { currentActor, runAs, type Actor } from '../../context.js'
import { db } from '../../db.js'
import { messageOf } from '../../errors.js'
import type { Provider } from '../../types.js'
import { eventBus } from '../events.js'
import { completeText } from '../llm/complete.js'
import { sessionService } from '../session-service.js'
import { checkMemoryContent, normalizeMemoryText } from './guard.js'
import { MEMORY_BUDGETS, MEMORY_ENTRY_MAX, SECTION_LABEL, memoryService, type MemorySection } from './memory-service.js'
import { isAutomatedSession, isMultiHumanSession } from './session-policy.js'

/**
 * 自动提取长期记忆（契约 §6.12.4）：
 * - 对话完成后为（会话, 发言账号）排一个空闲计时器；空闲 IDLE_MS（默认 3 分钟）后，或累计 EVERY_TURNS（默认 10）轮用户消息时，
 *   用默认 Provider（会话自己的 Provider）在后台跑一次便宜的模型调用，让它对照现有记忆提出增 / 改 / 删；
 * - 只看这个账号自上次提取以来发的消息 + 助手回复；
 * - 每条提议照样经过 memoryService（安全检查过滤密钥 / 注入、预算、去重），source 记为 auto；
 *   remove 提议必须和某条现有条目整条一致、且 old_text 本身通过安全检查（转写是不可信输入，不能借它模糊删除记忆）；
 * - 不提取：账号关掉记忆或自动提取、没有 Provider；多人群聊（助手回复里混着别人的信息）；
 *   工作流 / 定时任务产生的会话（看持久化的 sessions.origin 与 workflow_run_id，加上运行中的非交互标记）；
 *   会话里有 global CLI 内核时编排层不调度；
 * - 有改动时推 `memory.updated` 事件（只推给本人）。
 */
const IDLE_MS = (): number => Math.max(0, Number(process.env.LULUX_MEMORY_IDLE_MS ?? 180_000) || 0)
const EVERY_TURNS = (): number => Math.max(1, Number(process.env.LULUX_MEMORY_EVERY_TURNS ?? 10) || 10)
const MAX_OPS = 6
const TRANSCRIPT_LIMIT = 8000

export const EXTRACT_MARKER = '【LULUX 记忆提取】'

const EXTRACT_PROMPT = `${EXTRACT_MARKER}你负责维护一位外贸从业者在 LULUX 里的长期记忆。阅读下面的“现有记忆”和“新对话”，判断有没有值得跨会话长期保存的信息。
只保存以后每次对话都用得上的：用户是谁、公司与职位、主营产品、目标市场、常用贸易条款与币种、沟通与文风偏好、明确提出的长期要求。
不要保存：一次性的任务细节、进度、某个客户或报价的具体数据（CRM 里能查到）、助手自己说的话、猜测；绝不保存密码、密钥、Token、银行卡号。
分区：profile = 用户画像（用户是谁、公司、产品、市场、风格偏好）；notes = 记忆（其他长期事实与约定）。
现有记忆里已有的不要重复添加；用户纠正了旧信息时用 replace；明确要求忘掉时用 remove。每条一句话，简短，用第三人称陈述。
只输出一个 JSON 对象，不要任何解释：
{"operations":[{"action":"add","section":"profile","content":"…"},{"action":"replace","old_text":"现有条目里的一段原文","content":"…"},{"action":"remove","old_text":"…"}]}
没有需要保存的就输出 {"operations":[]}。`

interface Operation {
  action: 'add' | 'replace' | 'remove'
  section?: MemorySection
  content?: string
  old_text?: string
}

/** 从模型输出里取出 operations（容忍 ```json 代码块、前后多余文字） */
export function parseOperations(raw: string): Operation[] {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const list = (parsed as { operations?: unknown })?.operations
  if (!Array.isArray(list)) return []
  const out: Operation[] = []
  for (const item of list.slice(0, MAX_OPS)) {
    if (!item || typeof item !== 'object') continue
    const op = item as Record<string, unknown>
    const action = op.action
    if (action !== 'add' && action !== 'replace' && action !== 'remove') continue
    const section = op.section === 'profile' || op.section === 'notes' ? op.section : undefined
    const content = typeof op.content === 'string' ? op.content : undefined
    const oldText = typeof op.old_text === 'string' ? op.old_text : typeof op.oldText === 'string' ? (op.oldText as string) : undefined
    out.push({ action, section, content, old_text: oldText })
  }
  return out
}

interface ExtractionRow {
  last_message_at: number
  user_turns: number
}

function progress(sessionId: string, ownerId: string): ExtractionRow {
  return (
    (db
      .prepare('SELECT last_message_at, user_turns FROM memory_extractions WHERE session_id = ? AND owner_id = ?')
      .get(sessionId, ownerId) as unknown as ExtractionRow | undefined) ?? { last_message_at: 0, user_turns: 0 }
  )
}

function saveProgress(sessionId: string, ownerId: string, row: ExtractionRow): void {
  try {
    db.prepare(
      `INSERT INTO memory_extractions (session_id, owner_id, last_message_at, user_turns, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, owner_id) DO UPDATE SET last_message_at = excluded.last_message_at, user_turns = excluded.user_turns,
         updated_at = excluded.updated_at`,
    ).run(sessionId, ownerId, row.last_message_at, row.user_turns, Date.now())
  } catch {
    // 会话已删除（外键）
  }
}

function eligible(sessionId: string, actor: Actor): boolean {
  if (!actor.id) return false
  const prefs = memoryService.prefs(actor)
  if (!prefs.enabled || !prefs.autoExtract) return false
  const session = sessionService.get(sessionId)
  if (!session || session.workflowRunId) return false
  if (isAutomatedSession(sessionId)) return false
  return !isMultiHumanSession(sessionId)
}

/** 自动提取的 remove：old_text 必须整条等于某条现有条目（折叠空白、忽略大小写），且自身通过安全检查 */
function exactEntryFor(oldText: string, actor: Actor, section?: MemorySection): string | null {
  const text = normalizeMemoryText(oldText)
  if (!text || !checkMemoryContent(text).ok) return null
  const key = text.replace(/\s+/g, ' ').toLowerCase()
  const hit = memoryService
    .entries(section, actor)
    .find((entry) => normalizeMemoryText(entry.content).replace(/\s+/g, ' ').toLowerCase() === key)
  return hit ? hit.id : null
}

/**
 * 定时任务追加到已有会话（sessionMode=append）：会话本身来源是 chat，运行结束后把提取进度推进到最新消息，
 * 这次运行产生的消息（自动化提示词与它抓回来的外部内容）永远不会被提取。
 */
export function skipMemoryExtractionUntilNow(sessionId: string, ownerId: string): void {
  const last = db.prepare('SELECT MAX(created_at) AS at FROM messages WHERE session_id = ?').get(sessionId) as unknown as
    | { at: number | null }
    | undefined
  const state = progress(sessionId, ownerId)
  saveProgress(sessionId, ownerId, { last_message_at: Math.max(state.last_message_at, Number(last?.at ?? 0)), user_turns: 0 })
}

const timers = new Map<string, { timer: NodeJS.Timeout; fire: () => void }>()
const running = new Set<Promise<unknown>>()

export interface ExtractionResult {
  applied: number
  operations: Operation[]
}

/** 立刻对（会话, 账号）跑一次提取；没有新消息 / 不满足条件时返回 null */
export async function runMemoryExtraction(sessionId: string, actor: Actor, provider: Provider): Promise<ExtractionResult | null> {
  return runAs(actor, async () => {
    if (!eligible(sessionId, actor)) return null
    const state = progress(sessionId, actor.id)
    const messages = sessionService
      .messages(sessionId)
      .filter((message) => message.createdAt > state.last_message_at)
      .filter((message) => (message.role === 'user' ? message.senderUserId === actor.id || message.senderUserId === null : message.role === 'assistant'))
    const users = messages.filter((message) => message.role === 'user')
    if (users.length === 0) return null
    const lastAt = messages[messages.length - 1]!.createdAt

    let transcript = messages
      .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.replace(/\s+/g, ' ').slice(0, 1500)}`)
      .join('\n')
    if (transcript.length > TRANSCRIPT_LIMIT) transcript = transcript.slice(-TRANSCRIPT_LIMIT)
    const current = memoryService.entries(undefined, actor)
    const memoryText =
      current.length > 0 ? current.map((entry) => `- [${entry.section}] ${entry.content}`).join('\n') : '（空）'
    const usage = (['profile', 'notes'] as const)
      .map((section) => {
        const { used, limit } = memoryService.usage(section, actor)
        return `${SECTION_LABEL[section]} ${used}/${limit} 字`
      })
      .join('，')
    const input = `现有记忆（${usage}；单条 ≤${MEMORY_ENTRY_MAX} 字，总预算 profile ${MEMORY_BUDGETS.profile} / notes ${MEMORY_BUDGETS.notes}）：\n${memoryText}\n\n新对话：\n${transcript}`

    const { text } = await completeText(EXTRACT_PROMPT, input, {
      provider,
      timeoutMs: 60_000,
      purpose: 'memory',
      sessionId,
      maxTokens: 600,
    })
    const operations = parseOperations(text)
    let applied = 0
    for (const op of operations) {
      try {
        if (op.action === 'add' && op.content) {
          const result = memoryService.add({ section: op.section ?? 'notes', content: op.content, source: 'auto', sessionId })
          if (!result.duplicate) applied += 1
        } else if (op.action === 'replace' && op.content && op.old_text) {
          memoryService.replace({ oldText: op.old_text, section: op.section, content: op.content, source: 'auto', sessionId })
          applied += 1
        } else if (op.action === 'remove' && op.old_text) {
          const id = exactEntryFor(op.old_text, actor, op.section)
          if (id) {
            memoryService.remove({ id })
            applied += 1
          }
        }
      } catch {
        // 不合格（含密钥 / 注入 / 超预算 / 匹配不到）的提议直接丢弃
      }
    }
    saveProgress(sessionId, actor.id, { last_message_at: lastAt, user_turns: 0 })
    if (applied > 0) {
      eventBus.publish('memory.updated', { source: 'auto', sessionId, applied }, { userId: actor.id, orgId: actor.orgId })
    }
    return { applied, operations }
  })
}

function track<T>(promise: Promise<T>): Promise<T> {
  running.add(promise)
  void promise.finally(() => running.delete(promise))
  return promise
}

/**
 * 一轮对话完成后调用（编排层）：累计轮数，到 EVERY_TURNS 立即提取，否则（重新）开始空闲计时。
 * 身份取当前发言人（群聊里是发这条消息的人）。
 */
export function scheduleMemoryExtraction(sessionId: string, provider: Provider | null, actor: Actor = currentActor()): void {
  try {
    if (!provider || !eligible(sessionId, actor)) return
    const key = `${sessionId}\u0000${actor.id}`
    const state = progress(sessionId, actor.id)
    const turns = state.user_turns + 1
    saveProgress(sessionId, actor.id, { last_message_at: state.last_message_at, user_turns: turns })
    const existing = timers.get(key)
    if (existing) clearTimeout(existing.timer)
    timers.delete(key)
    const fire = (): void => {
      timers.delete(key)
      void track(
        runMemoryExtraction(sessionId, actor, provider).catch((error) => {
          console.warn('[lulux-eta] memory extraction failed:', messageOf(error))
          return null
        }),
      )
    }
    if (turns >= EVERY_TURNS()) {
      fire()
      return
    }
    const timer = setTimeout(fire, IDLE_MS())
    timer.unref?.()
    timers.set(key, { timer, fire })
  } catch (error) {
    console.warn('[lulux-eta] memory extraction not scheduled:', messageOf(error))
  }
}

/** 测试 / 关停：取消所有计时器；flush=true 时立刻触发并等待完成 */
export async function settleMemoryExtractions(flush = false): Promise<void> {
  const pending = [...timers.values()]
  timers.clear()
  for (const item of pending) {
    clearTimeout(item.timer)
    if (flush) item.fire()
  }
  await Promise.allSettled([...running])
}

export function pendingMemoryExtractions(): number {
  return timers.size
}
