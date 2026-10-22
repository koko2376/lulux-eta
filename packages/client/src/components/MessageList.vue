<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Message, Runtime, ToolTraceEntry } from '../api'
import * as api from '../api'
import { stripAttachmentNote } from '../lib/attachments'
import { stripRefContexts } from '../lib/composer-context'
import { copyText } from '../lib/clipboard'
import { runtimeLabel } from '../lib/kernel'
import { formatMessageUsage } from '../lib/usage'
import { regenerateAnchor, useAppStore } from '../stores/app'
import { toast } from '../stores/ui'
import { isMultiHuman, messageSender } from '../lib/group-members'
import { auth } from '../lib/session'
import AgentAvatar from './AgentAvatar.vue'
import GroupAvatar from './GroupAvatar.vue'
import HumanAvatar from './group/HumanAvatar.vue'
import AppIcon from './AppIcon.vue'
import MessageContent from './MessageContent.vue'
import MessageImages from './MessageImages.vue'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolTrace from './ToolTrace.vue'
import { t } from '../i18n'

const store = useAppStore()
const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)

/** 群聊看会话类型（kind），不看成员数 */
const isGroup = computed(() => store.isGroupChat)

/**
 * 气泡文字：带图片的用户消息不再重复显示“附件已上传…”说明（缩略图已经在上面）；
 * 输入框“+”引用的客户 / 邮件等资料块折叠成一行名称。
 */
function bubbleText(message: Message): string {
  if (message.role !== 'user') return message.content
  const text = message.attachments?.length
    ? stripAttachmentNote(
        message.content,
        message.attachments.map((a) => a.path),
      )
    : message.content
  return stripRefContexts(text)
}

const streamingAgent = computed(() => store.agents.find((agent) => agent.id === store.streamingAgentId) ?? null)

/** start.speakers：群聊里本轮将由谁、按什么顺序回答（契约 §6.8-6） */
const speakersText = computed(() => {
  const ids = store.currentRun?.speakers ?? []
  if (!isGroup.value || ids.length < 2) return ''
  return t('messageList.kzyb0op', [ids.map((id) => agentName(id)).join(' → ')])
})

/* ── 多人群聊（契约 §6.10）：用户消息显示是谁发的；别人的消息靠左、带头像和名字 ── */
const meId = computed(() => auth.me?.user.id ?? null)
function humanOf(message: Message): { userId: string; name: string } | null {
  return messageSender(message, store.currentSession)
}
function fromOther(message: Message): boolean {
  const sender = humanOf(message)
  return Boolean(sender && sender.userId !== meId.value)
}
/** 编辑重发 / 重新生成会截掉之后的消息：多人群聊里只能针对自己的消息，且之后没有别人发言 */
function canBranchFrom(message: Message): boolean {
  if (!isMultiHuman(store.currentSession)) return true
  const index = regenerateAnchor(store.messages, message.id)
  if (index < 0) return message.role === 'assistant'
  const anchor = store.messages[index]
  if (fromOther(anchor)) return false
  return !store.messages.slice(index + 1).some((m) => fromOther(m))
}

function senderId(message: Message): string {
  return message.senderAgentId ?? store.currentSession?.agentIds[0] ?? ''
}

function agentName(id: string | null | undefined): string {
  return store.agents.find((agent) => agent.id === id)?.name ?? 'Agent'
}

/** 消息头显示实际运行者：Provider 的模型名或内核版本 */
function runtimeText(runtime: Runtime | null | undefined): string {
  return runtimeLabel(runtime, store.agents)
}

const FINISH_FLAG: Record<string, { text: string; warn?: boolean; title: string }> = {
  aborted: { text: t('messageList.kwpc5ea'), title: t('messageList.k13rrqwk') },
  length: { text: t('messageList.kq46k5z'), warn: true, title: t('messageList.k4pfs02') },
  tool_limit: { text: t('messageList.k1bkdw2m'), warn: true, title: t('messageList.k1sv19v2') },
  error: { text: t('messageList.kiz4j02'), warn: true, title: t('messageList.kpntbqg') },
  interrupted: { text: t('runs.interrupted'), warn: true, title: t('runs.interruptedTitle') },
  streaming: { text: t('runs.streaming'), title: t('runs.streamingTitle') },
}

const lastAssistantId = computed(() => {
  for (let i = store.messages.length - 1; i >= 0; i--) {
    if (store.messages[i].role === 'assistant') return store.messages[i].id
  }
  return null
})

const busy = computed(() => store.streaming)

/* ── 思考中（Grok 式）：第一个正文 token / 工具调用之前，取代旧的三个点 ── */
const thinkingLive = computed(() => {
  const run = store.currentRun
  return Boolean(run) && run!.thinkEndedAt === null && !store.streamText && store.streamTools.length === 0
})
const showThinking = computed(() => Boolean(store.streamReasoning) || thinkingLive.value)
const streamThinkMs = computed(() => {
  const run = store.currentRun
  if (!run || run.thinkStartedAt === null || run.thinkEndedAt === null) return null
  return run.thinkEndedAt - run.thinkStartedAt
})
/** 工具都执行完、正文还没来：模型在继续想 */
const waitingAfterTools = computed(
  () =>
    !store.streamText &&
    store.streamTools.length > 0 &&
    store.streamTools.every((entry) => entry.status !== 'pending' && entry.status !== 'running'),
)
const isTemp = (message: Message) => message.id.startsWith('tmp_')

/* ── 群聊主管 ── */
const DISPATCH_TOOL = 'dispatch_members'
const streamSupervisorRole = computed(() => {
  const role = store.currentRun?.role
  return role === 'plan' || role === 'summary' ? role : null
})
/** 主管的派发调用不作为普通工具卡片显示，改成一行“已分派给 …” */
function visibleTrace(trace: ToolTraceEntry[] | undefined): ToolTraceEntry[] {
  return (trace ?? []).filter((entry) => entry.name !== DISPATCH_TOOL)
}
const streamToolsVisible = computed(() => store.streamTools.filter((entry) => entry.name !== DISPATCH_TOOL))
function dispatchOf(message: Message): { names: string; instructions: string } | null {
  if (message.supervisorRole !== 'plan') return null
  const entry = message.toolTrace?.find((item) => item.name === DISPATCH_TOOL && item.ok)
  if (!entry) return null
  try {
    const args = JSON.parse(entry.arguments || '{}') as { members?: unknown; instructions?: unknown }
    const ids = Array.isArray(args.members) ? args.members.filter((id): id is string => typeof id === 'string') : []
    const known = ids.filter((id) => id !== message.senderAgentId && store.agents.some((agent) => agent.id === id))
    if (known.length === 0) return null
    return {
      names: known.map((id) => agentName(id)).join(t('fmt.listSep')),
      instructions: typeof args.instructions === 'string' ? args.instructions : '',
    }
  } catch {
    return null
  }
}

async function copyMessage(message: Message): Promise<void> {
  const ok = await copyText(message.content)
  if (ok) toast.success(t('messageList.k1r4hxti'))
  else toast.error(t('messageList.kzq8b2z'))
}

async function copyMarkdown(message: Message): Promise<void> {
  try {
    const markdown = await api.messageMarkdown(message.sessionId, message.id, true)
    if (await copyText(markdown)) toast.success(t('messageList.k1v6gx6j'))
    else toast.error(t('messageList.k1vd0uty'))
  } catch {
    /* 错误已由全局 toast 显示 */
  }
}

/** 历史消息里的工具调用只展示最终状态 */
function traceStatus(entry: ToolTraceEntry): 'done' | 'error' | 'denied' {
  if (!entry.approved) return 'denied'
  return entry.ok ? 'done' : 'error'
}

interface DayGroup {
  key: number
  label: string
  messages: Message[]
}

const groups = computed<DayGroup[]>(() => {
  const result: DayGroup[] = []
  for (const message of store.messages) {
    const date = new Date(message.createdAt)
    const key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const last = result[result.length - 1]
    if (last && last.key === key) {
      last.messages.push(message)
    } else {
      result.push({ key, label: dayLabel(date), messages: [message] })
    }
  }
  return result
})

function dayLabel(date: Date): string {
  const now = new Date()
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)

  if (days <= 0) return t('messageList.k6msvk2')
  if (days === 1) return t('messageList.kowoka8')
  if (date.getFullYear() === now.getFullYear()) {
    return t('messageList.k1xdmaps', [date.getMonth() + 1, date.getDate()])
  }
  return t('messageList.krwbhie', [date.getFullYear(), date.getMonth() + 1, date.getDate()])
}

function onScroll(): void {
  const element = scroller.value
  if (!element) return
  pinned.value = element.scrollHeight - element.scrollTop - element.clientHeight < 120
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element) element.scrollTop = element.scrollHeight
}

watch(
  () => [
    store.messages.length,
    store.streamText,
    store.streamReasoning,
    store.streamTools.length,
    store.streamNotices.length,
  ],
  async () => {
    if (!pinned.value) return
    await scrollToBottom()
  },
)

watch(
  () => store.currentSessionId,
  async () => {
    pinned.value = true
    await scrollToBottom()
  },
)
</script>

<template>
  <div ref="scroller" class="message-list" @scroll.passive="onScroll">
    <div v-if="store.messages.length === 0 && !store.streaming" class="chat-empty">
      <GroupAvatar v-if="isGroup && store.currentSession" :session="store.currentSession" :size="52" />
      <AgentAvatar v-else :agent-id="store.currentAgents[0]?.id" :size="52" />
      <h2>{{ $t('messageList.k1h8emk2') }}</h2>
      <p>
        {{ isGroup ? $t('messageList.k1g3vh6t') : $t('messageList.k1j9ht09') }}
      </p>
    </div>

    <template v-for="group in groups" :key="group.key">
      <div class="day-divider">{{ group.label }}</div>
      <article
        v-for="message in group.messages"
        :key="message.id"
        class="message"
        :class="[
          message.role,
          {
            last: message.id === lastAssistantId && !busy,
            'from-other': fromOther(message),
            'mine-in-group': Boolean(humanOf(message)) && !fromOther(message),
          },
        ]"
        :data-message-id="message.id"
        :data-sender-user-id="humanOf(message)?.userId"
      >
        <HumanAvatar
          v-if="fromOther(message)"
          class="message-human-avatar"
          :user-id="humanOf(message)!.userId"
          :name="humanOf(message)!.name"
          :size="28"
        />
        <span
          v-if="isGroup && message.role === 'assistant'"
          class="message-avatar message-avatar-wrap"
          :title="message.supervisorRole ? $t('supervisor.badgeTitle') : undefined"
        >
          <AgentAvatar :agent-id="senderId(message)" :size="28" />
          <i v-if="message.supervisorRole" class="supervisor-dot" aria-hidden="true">★</i>
        </span>
        <div class="message-body">
          <span v-if="fromOther(message)" class="message-sender" data-testid="message-sender">{{
            humanOf(message)!.name
          }}</span>
          <span v-if="isGroup && message.role === 'assistant'" class="message-sender">
            {{ agentName(senderId(message))
            }}<span v-if="message.supervisorRole" class="supervisor-tag" :title="$t('supervisor.badgeTitle')">{{
              message.supervisorRole === 'plan' ? $t('supervisor.planTag') : $t('supervisor.summaryTag')
            }}</span>
          </span>
          <span v-if="message.role === 'assistant' && message.runtime" class="message-runtime">{{
            runtimeText(message.runtime)
          }}</span>
          <ReasoningBlock
            v-if="message.reasoning"
            :text="message.reasoning"
            :duration-ms="store.thinkDurations[message.id] ?? null"
          />
          <div v-if="dispatchOf(message)" class="dispatch-note">
            <strong>{{ $t('supervisor.dispatched', [dispatchOf(message)!.names]) }}</strong>
            <span v-if="dispatchOf(message)!.instructions">{{
              $t('supervisor.instructions', [dispatchOf(message)!.instructions])
            }}</span>
          </div>
          <div v-if="visibleTrace(message.toolTrace).length" class="tool-trace-list">
            <ToolTrace
              v-for="entry in visibleTrace(message.toolTrace)"
              :key="entry.id"
              :name="entry.name"
              :server="entry.server"
              :args="entry.arguments"
              :status="traceStatus(entry)"
              :result="entry.result"
              :duration-ms="entry.durationMs"
            />
          </div>
          <MessageImages
            v-if="message.attachments?.length"
            :session-id="message.sessionId"
            :attachments="message.attachments"
          />
          <div v-if="bubbleText(message)" class="bubble">
            <MessageContent :content="bubbleText(message)" :markdown="message.role === 'assistant'" />
          </div>
          <div v-if="store.messageNotices[message.id]?.length" class="run-notices">
            <span v-for="n in store.messageNotices[message.id]" :key="n.id" class="run-notice" :class="n.kind">{{
              n.text
            }}</span>
          </div>
          <div v-if="!isTemp(message)" class="message-meta">
            <span
              v-if="message.finishReason && FINISH_FLAG[message.finishReason]"
              class="message-flag"
              :class="{ warn: FINISH_FLAG[message.finishReason].warn }"
              :title="FINISH_FLAG[message.finishReason].title"
              >{{ FINISH_FLAG[message.finishReason].text }}</span
            >
            <span
              v-if="message.usage"
              class="message-usage"
              :title="
                $t('messageList.k12ncr7y', [
                  message.usage.calls,
                  message.usage.estimated ? $t('messageList.k53ofph') : '',
                ])
              "
              >{{ formatMessageUsage(message.usage) }}</span
            >
            <span class="message-actions">
              <button
                v-if="message.content"
                type="button"
                class="msg-action"
                :title="$t('messageList.klvqx34')"
                :aria-label="$t('messageList.klvqx34')"
                @click="copyMessage(message)"
              >
                <AppIcon name="copy" :size="15" />
              </button>
              <button
                v-if="message.role === 'assistant'"
                type="button"
                class="msg-action"
                :title="$t('messageList.kbtqkye')"
                :aria-label="$t('messageList.kj1hzdw')"
                @click="copyMarkdown(message)"
              >
                <AppIcon name="code" :size="15" />
              </button>
              <button
                v-if="message.role === 'assistant' && canBranchFrom(message)"
                type="button"
                class="msg-action"
                :title="$t('messageList.k2nc85u')"
                :aria-label="$t('messageList.kcsggvk')"
                :disabled="busy"
                @click="store.regenerate(message.id)"
              >
                <AppIcon name="refresh" :size="15" />
              </button>
              <button
                v-if="message.role === 'user' && canBranchFrom(message)"
                type="button"
                class="msg-action"
                :title="$t('messageList.k1ig85tf')"
                :aria-label="$t('messageList.k1ig85tf')"
                :disabled="busy"
                @click="store.startEdit(message.id)"
              >
                <AppIcon name="edit" :size="15" />
              </button>
            </span>
          </div>
        </div>
      </article>
    </template>

    <article v-if="store.streaming" class="message assistant streaming">
      <span v-if="isGroup" class="message-avatar message-avatar-wrap">
        <AgentAvatar :agent-id="store.streamingAgentId ?? store.currentAgents[0]?.id" :size="28" />
        <i v-if="streamSupervisorRole" class="supervisor-dot" aria-hidden="true">★</i>
      </span>
      <div class="message-body">
        <span v-if="isGroup" class="message-sender">
          {{ streamingAgent?.name || store.currentAgents[0]?.name || 'Agent'
          }}<span v-if="streamSupervisorRole" class="supervisor-tag" :title="$t('supervisor.badgeTitle')">{{
            streamSupervisorRole === 'plan' ? $t('supervisor.planTag') : $t('supervisor.summaryTag')
          }}</span>
        </span>
        <span v-if="store.streamRuntime" class="message-runtime">{{ runtimeText(store.streamRuntime) }}</span>
        <span v-if="speakersText" class="run-speakers">{{ speakersText }}</span>
        <ReasoningBlock
          v-if="showThinking"
          :text="store.streamReasoning"
          :live="thinkingLive"
          :started-at="store.currentRun?.thinkStartedAt ?? null"
          :duration-ms="streamThinkMs"
        />
        <div v-if="streamToolsVisible.length" class="tool-trace-list">
          <ToolTrace
            v-for="entry in streamToolsVisible"
            :key="entry.requestId"
            :name="entry.name"
            :server="entry.server"
            :args="entry.arguments"
            :status="entry.status"
            :result="entry.result"
            :duration-ms="entry.durationMs"
            :risk="entry.risk"
            :approval-kind="entry.approvalKind"
            :detail="entry.detail"
            :can-remember="entry.canRemember"
            :interactive="entry.status === 'pending'"
            @decide="(approved, remember) => store.decideTool(entry.requestId, approved, remember)"
          />
        </div>
        <div v-if="store.streamText" class="bubble">
          <MessageContent :content="store.streamText" markdown streaming /><span class="caret" />
        </div>
        <ReasoningBlock v-else-if="waitingAfterTools" class="thinking-followup" text="" live />
        <div v-if="store.streamNotices.length" class="run-notices" role="status">
          <span v-for="n in store.streamNotices" :key="n.id" class="run-notice" :class="n.kind">{{ n.text }}</span>
        </div>
        <div v-if="store.currentRun?.stopping" class="run-notices" role="status">
          <span class="run-notice">{{ $t('messageList.k1aar5xf') }}</span>
        </div>
      </div>
    </article>
  </div>
</template>
