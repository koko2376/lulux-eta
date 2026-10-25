<script setup lang="ts">
import { findMemberAgent, memberTag, withMemberTag } from '../lib/members'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import { exportSessionMarkdown } from '../lib/export-session'
import { agentName as kernelAgentName, agentTagline } from '../lib/kernel'
import { sessionDisplayName } from '../lib/session-name'
import { formatCostMap, formatTokens } from '../lib/usage'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/ui'
import AgentAvatar from './AgentAvatar.vue'
import AppIcon from './AppIcon.vue'
import SupervisorPicker from './SupervisorPicker.vue'
import GroupPeople from './group/GroupPeople.vue'
import { auth } from '../lib/session'
import { intlLocale, t } from '../i18n'

const emit = defineEmits<{ close: [] }>()

const store = useAppStore()
const router = useRouter()
const copied = ref(false)

const session = computed(() => store.currentSession)

const provider = computed(() => {
  const id = session.value?.providerId
  return (id ? store.providers.find((item) => item.id === id) : undefined) ?? store.defaultProvider
})
/** 会话选的模型（契约 §6.13）优先，否则 Provider 的默认模型 */
const modelName = computed(() => {
  const chosen = session.value?.model
  return chosen && provider.value?.models.includes(chosen) ? chosen : (provider.value?.model ?? '')
})

/* 本会话的模型用量（契约 §6.7 /api/usage?sessionId=）——替换原来的装饰占位图 */
const usage = ref<api.UsageTotals | null>(null)
async function loadUsage(): Promise<void> {
  const id = session.value?.id
  usage.value = null
  if (!id) return
  const res = await api.getUsage({ sessionId: id }).catch(() => null)
  if (res && session.value?.id === id) usage.value = res.totals
}
watch(() => [session.value?.id, store.streaming], loadUsage, { immediate: true })

async function exportMarkdown(): Promise<void> {
  if (!session.value) return
  try {
    await exportSessionMarkdown(session.value)
    toast.success(t('detailPanel.k1vvdqsc'))
  } catch {
    /* 全局 toast 已提示 */
  }
}

const createdAt = computed(() => (session.value ? formatDateTime(session.value.createdAt) : '—'))

const agents = computed(() => store.currentAgents)
/** 群聊看会话类型（kind），不看成员数 */
const isGroup = computed(() => store.isGroupChat)
/** 单聊：标题是会话所用内核的名称（LULUX / Claude Code …），下面一行是内核说明；群聊：成员数 + 名单 */
const agentHeading = computed(() => {
  if (isGroup.value) return t('detailPanel.k1nw4ap4', [agents.value.length])
  const agent = agents.value[0]
  return agent ? kernelAgentName(agent) : t('detailPanel.kernel')
})
const agentSummary = computed(() => {
  if (!isGroup.value && agents.value[0]) return agentTagline(agents.value[0])
  return (
    agents.value
      .map((agent) => withMemberTag(kernelAgentName(agent), memberTag(session.value, agent.id)))
      .join(t('fmt.listSep')) || t('detailPanel.kn9wygg')
  )
})

function agentName(id: string | null | undefined): string | undefined {
  const name = findMemberAgent(store.agents, id)?.name
  return name && id ? withMemberTag(name, memberTag(session.value, id)) : name
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(intlLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

async function copyTranscript(): Promise<void> {
  const current = session.value
  if (!current) return

  const lines = [`# ${sessionDisplayName(current)}`, '']
  if (provider.value) {
    lines.push(`${provider.value.name} · ${modelName.value}`, '')
  }
  for (const message of store.messages) {
    const speaker =
      message.role === 'user'
        ? t('detailPanel.knwxime')
        : (agentName(message.senderAgentId ?? current.agentIds[0]) ?? 'LULUX ETA')
    lines.push(`**${speaker}**`, '', message.content, '')
  }

  try {
    await navigator.clipboard.writeText(lines.join('\n').trim())
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copied.value = false
  }
}

async function newChat(): Promise<void> {
  if (store.streaming) return
  await store.newSession()
}

function openSettings(): void {
  void router.push({ name: 'settings-kernels' })
}
</script>

<template>
  <aside class="detail-panel">
    <header class="detail-header">
      <button
        type="button"
        class="icon-button"
        :title="$t('detailPanel.k5x13zv')"
        :aria-label="$t('detailPanel.k5x13zv')"
        @click="emit('close')"
      >
        <AppIcon name="chevron-left" :size="18" />
      </button>

      <div class="detail-actions">
        <button
          type="button"
          class="icon-button"
          :title="copied ? $t('detailPanel.k1r4hxti') : $t('detailPanel.k1joy366')"
          :disabled="!session"
          @click="copyTranscript"
        >
          <AppIcon :name="copied ? 'check' : 'upload'" :size="17" />
        </button>
        <button
          type="button"
          class="icon-button"
          :title="$t('detailPanel.kyxspmz')"
          :aria-label="$t('detailPanel.kyxspmz')"
          @click="openSettings"
        >
          <AppIcon name="settings" :size="17" />
        </button>
        <button
          type="button"
          class="icon-button"
          :title="$t('detailPanel.kw0cv9y')"
          :aria-label="$t('detailPanel.kw0cv9y')"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="17" />
        </button>
      </div>
    </header>

    <div class="detail-body">
      <template v-if="session">
        <div class="session-hero">
          <div class="hero-visual">
            <div class="hero-shot" aria-hidden="true">
              <div class="shot-bar">
                <i></i><i></i><i></i>
                <span></span>
              </div>
              <div class="shot-body">
                <div class="shot-side"><i></i><i></i><i></i><i></i></div>
                <div class="shot-main">
                  <div class="shot-blocks"><i></i><i></i><i></i><i></i><i></i><i></i></div>
                </div>
              </div>
            </div>
          </div>
          <strong>{{ sessionDisplayName(session) }}</strong>
        </div>

        <h3 class="detail-label">{{ $t('detailPanel.kjrd9ed') }}</h3>
        <ul class="routine-list">
          <li class="routine">
            <span class="routine-icon"><AppIcon name="clock" :size="17" /></span>
            <span class="routine-text">
              <strong>{{ $t('detailPanel.k10vdyr3') }}</strong>
              <span>{{ createdAt }}</span>
            </span>
          </li>
          <li class="routine">
            <span class="routine-icon"><AppIcon name="message" :size="17" /></span>
            <span class="routine-text">
              <strong>{{ $t('detailPanel.kdzyyoj') }}</strong>
              <span>{{ $t('detailPanel.k6zodwa', [session.messageCount]) }}</span>
            </span>
          </li>
          <li class="routine">
            <span class="routine-icon"><AppIcon name="spark" :size="17" /></span>
            <span class="routine-text">
              <strong>{{ agentHeading }}</strong>
              <span>{{ agentSummary }}</span>
            </span>
          </li>
          <li v-if="isGroup" class="routine">
            <span class="routine-icon"><AppIcon name="edit" :size="17" /></span>
            <span class="routine-text">
              <strong>{{ $t('detailPanel.k1uvbgy6') }}</strong>
              <span>{{ session.groupName || $t('detailPanel.kg13pbq') }}</span>
            </span>
          </li>
          <li v-if="isGroup" class="routine supervisor-routine">
            <span class="routine-icon"><AppIcon name="shield" :size="17" /></span>
            <span class="routine-text">
              <strong>{{ $t('supervisor.label') }}</strong>
              <SupervisorPicker :session="session" compact class="detail-supervisor" />
              <span class="supervisor-hint">{{ $t('supervisor.hint') }}</span>
            </span>
          </li>
          <!-- 多人群聊：群里的同事（团队服务器模式，契约 §6.10） -->
          <li v-if="isGroup && auth.mode === 'server'" class="routine people-routine">
            <span class="routine-icon"><AppIcon name="users" :size="17" /></span>
            <span class="routine-text">
              <GroupPeople :session="session" class="detail-people" @error="(message) => toast.error(message)" />
            </span>
          </li>
          <li class="routine">
            <span class="routine-icon"><AppIcon name="plug" :size="17" /></span>
            <span class="routine-text">
              <strong>Provider</strong>
              <span>{{ provider ? `${provider.name} · ${modelName}` : $t('detailPanel.krkdc45') }}</span>
            </span>
          </li>
          <!-- 本会话模型用量（契约 §6.7）：作为一行信息放在会话信息里，不占示意图的位置 -->
          <li v-if="usage && usage.calls > 0" class="routine" :aria-label="$t('detailPanel.k1b26cba')">
            <span class="routine-icon"><AppIcon name="info" :size="17" /></span>
            <span class="routine-text" :title="$t('detailPanel.k1qhzpqa', [usage.inputTokens, usage.outputTokens])">
              <strong>{{ $t('agx.usageTitle') }}</strong>
              <span>{{
                $t('agx.usageLine', [
                  usage.calls,
                  formatTokens(usage.inputTokens + usage.outputTokens),
                  formatCostMap(usage.cost),
                ])
              }}</span>
            </span>
          </li>
        </ul>

        <h3 class="detail-label">{{ $t('detailPanel.kdhjp26') }}</h3>
        <ul class="routine-list">
          <li>
            <button type="button" class="routine action" :disabled="store.streaming" @click="newChat">
              <span class="routine-icon"><AppIcon name="plus" :size="17" /></span>
              <span class="routine-text">
                <strong>{{ $t('detailPanel.kh3mzlw') }}</strong>
                <span>{{ $t('detailPanel.k1su0xed') }}</span>
              </span>
            </button>
          </li>
          <li>
            <button type="button" class="routine action" @click="exportMarkdown">
              <span class="routine-icon"><AppIcon name="download" :size="17" /></span>
              <span class="routine-text">
                <strong>{{ $t('detailPanel.kczj22j') }}</strong>
                <span>{{ $t('detailPanel.k1orq3nc') }}</span>
              </span>
            </button>
          </li>
          <li>
            <button type="button" class="routine action" @click="openSettings">
              <span class="routine-icon"><AppIcon name="settings" :size="17" /></span>
              <span class="routine-text">
                <strong>{{ $t('detailPanel.kyxspmz') }}</strong>
                <span>{{ $t('detailPanel.k1ydu1ze', [store.providers.length, store.mcpServers.length]) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </template>

      <div v-else class="detail-empty">
        <AgentAvatar :size="64" />
        <strong>{{ $t('detailPanel.kr74626') }}</strong>
        <p>{{ $t('detailPanel.kjk3sj4') }}</p>
      </div>
    </div>
  </aside>
</template>
