<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { agentSidebar, toggleSidebar } from '../lib/agent-sidebar'
import AgentAvatar from './AgentAvatar.vue'
import GroupAvatar from './GroupAvatar.vue'
import AppIcon from './AppIcon.vue'
import ArtifactPanel from './ArtifactPanel.vue'
import ContextBindingModal from './ContextBindingModal.vue'
import BrowserPanel from './BrowserPanel.vue'
import Composer from './Composer.vue'
import DetailPanel from './DetailPanel.vue'
import KernelMenu from './KernelMenu.vue'
import MessageList from './MessageList.vue'
import { isGroupSession, sessionDisplayName } from '../lib/session-name'
import { loadPanel, savePanel, type PanelId } from '../lib/panel-state'
import { onTitleBarDoubleClick } from '../lib/window'
import * as api from '../api'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/ui'
import { t } from '../i18n'

const store = useAppStore()
// 原版：会话详情默认停靠在右侧（1360 / 1440 都停靠）。只有更窄（<1280px）时改成浮层：默认收起，
// 打开时有遮罩，点遮罩 / Esc 关闭。
const NARROW_QUERY = '(max-width: 1279px)'
const narrowMq = window.matchMedia?.(NARROW_QUERY)
const narrow = ref(narrowMq?.matches ?? window.innerWidth < 1280)
const activePanel = ref<PanelId | null>(narrow.value ? null : loadPanel(store.currentSessionId))
// 宽屏：面板的展开 / 收起按会话记住（lib/panel-state.ts）；切换会话时恢复该会话的状态
let restoringPanel = false
watch(
  () => store.currentSessionId,
  (id) => {
    if (narrow.value) return
    restoringPanel = true
    activePanel.value = loadPanel(id)
    void nextTick(() => (restoringPanel = false))
  },
)
watch(activePanel, (panel) => {
  if (narrow.value || restoringPanel) return
  savePanel(store.currentSessionId, panel)
})
const panelOverlay = computed(() => narrow.value && activePanel.value !== null)
function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}
function onPanelEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !panelOverlay.value) return
  // 有对话框 / 菜单打开时 Esc 交给它们
  if (document.querySelector('[role="dialog"], [role="menu"]')) return
  activePanel.value = null
}
onMounted(() => {
  narrowMq?.addEventListener?.('change', onNarrowChange)
  window.addEventListener('keydown', onPanelEsc)
})
onBeforeUnmount(() => {
  narrowMq?.removeEventListener?.('change', onNarrowChange)
  window.removeEventListener('keydown', onPanelEsc)
})
const renaming = ref(false)
const renamingGroup = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const subtitle = computed(() => {
  const names = store.currentAgents.map((agent) => agent.name).join(t('fmt.listSep'))
  if (!store.isGroupChat) return names
  const groupName = store.currentSession?.groupName
  return groupName ? `${groupName} · ${names}` : t('chat.k16q82zq', [names])
})

async function startRename(): Promise<void> {
  const session = store.currentSession
  if (!session || store.streaming) return
  // 标题栏显示的是群名（有群名时），双击改的就是这个显示名
  renamingGroup.value = isGroupSession(session) && Boolean(session.groupName)
  titleDraft.value = sessionDisplayName(session)
  renaming.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return
  const editingGroup = renamingGroup.value
  renaming.value = false
  renamingGroup.value = false
  const session = store.currentSession
  const next = titleDraft.value.trim()
  const previous = editingGroup ? (session?.groupName ?? '') : (session?.title ?? '')
  if (!session || !next || next === previous) return

  try {
    if (editingGroup) await store.renameGroup(session.id, next)
    else await store.renameSession(session.id, next)
  } catch (value) {
    store.error = value instanceof Error ? value.message : String(value)
  }
}

function cancelRename(): void {
  renaming.value = false
  renamingGroup.value = false
  titleDraft.value = ''
}

// create_artifact 产物：自动打开产物面板（面板负责定位）
watch(
  () => store.artifactFocus,
  (focus) => {
    if (focus && focus.sessionId === store.currentSessionId) activePanel.value = 'artifacts'
  },
)

function togglePanel(panel: PanelId): void {
  activePanel.value = activePanel.value === panel ? null : panel
}

/* ── 会话业务上下文：当前客户 / 报价（契约 §6.4） ─────────── */

const bindingOpen = ref(false)
watch(
  () => [store.context.customerId, store.context.quoteId] as const,
  async ([customerId, quoteId]) => {
    const [customer, quote] = await Promise.all([
      customerId ? api.getCustomer(customerId).catch(() => null) : null,
      quoteId ? api.getQuote(quoteId).catch(() => null) : null,
    ])
    if (store.context.customerId !== customerId || store.context.quoteId !== quoteId) return
    store.contextNames = { customer: customer?.company ?? '', quote: quote?.number ?? '' }
  },
  { immediate: true },
)

const contextLabel = computed(() => {
  const { customer, quote } = store.contextNames
  if (!store.context.customerId && !store.context.quoteId) return ''
  return [customer, quote].filter(Boolean).join(' · ') || t('chat.k1durj32')
})
/** 插头旁的小名称：只放客户（没有客户时放报价单号），完整内容在提示里 */
const contextShort = computed(() => (contextLabel.value ? store.contextNames.customer || store.contextNames.quote : ''))

async function saveContext(next: api.SessionContext): Promise<void> {
  bindingOpen.value = false
  try {
    await store.setContext(next)
    toast.success(next.customerId || next.quoteId ? t('chat.k92044r') : t('chat.kamf9xb'))
  } catch {
    /* 全局 toast 已提示 */
  }
}

/* ── 内核选择：LULUX 是产品，内核是独立的 Agent ─────────── */

const kernelMenu = ref<{ x: number; y: number } | null>(null)

const primaryAgent = computed(() => store.currentAgents[0] ?? null)

function openKernelMenu(event: MouseEvent): void {
  if (!store.currentSession || store.streaming) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  kernelMenu.value = { x: rect.left, y: rect.bottom + 6 }
}

async function chooseKernel(agentId: string): Promise<void> {
  kernelMenu.value = null
  const session = store.currentSession
  if (!session || session.agentIds[0] === agentId) return
  try {
    // 单聊：换成另一个内核，仍是单聊（不会变成群聊）；群聊：把它提到第一位，其他成员保持不变
    const next = isGroupSession(session) ? [agentId, ...session.agentIds.filter((id) => id !== agentId)] : [agentId]
    await store.setSessionAgents(session.id, next)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}
/** 快捷键提示：macOS ⌘B，其他 Ctrl+B */
const sidebarShortcut =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
    ? '⌘B'
    : 'Ctrl+B'
</script>

<template>
  <section class="chat-view">
    <header class="chat-header" @dblclick="onTitleBarDoubleClick">
      <button
        type="button"
        class="icon-button sidebar-toggle"
        data-testid="sidebar-toggle"
        :aria-pressed="!agentSidebar.collapsed"
        :aria-label="agentSidebar.collapsed ? $t('chat.sidebarShow') : $t('chat.sidebarHide')"
        :title="`${agentSidebar.collapsed ? $t('chat.sidebarShow') : $t('chat.sidebarHide')} (${sidebarShortcut})`"
        @click="toggleSidebar"
        @dblclick.stop
      >
        <AppIcon name="sidebar" :size="18" />
      </button>
      <GroupAvatar
        v-if="store.currentSession && store.isGroupChat"
        :session="store.currentSession"
        :size="26"
        class="chat-head-avatar"
      />
      <AgentAvatar
        v-else-if="store.currentSession"
        :agent-id="store.currentAgents[0]?.id"
        :size="26"
        class="chat-head-avatar"
      />
      <img v-else class="chat-head-fallback" src="/icon.png" alt="" />

      <div class="chat-heading">
        <input
          v-if="renaming"
          ref="titleInput"
          v-model="titleDraft"
          class="chat-title-input"
          maxlength="80"
          spellcheck="false"
          :aria-label="$t('chat.k119expy')"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <h1
          v-else
          :title="$t('chat.k1c4od4w', [store.currentSession ? sessionDisplayName(store.currentSession) : 'LULUX ETA'])"
          @dblclick.stop="startRename"
        >
          {{ store.currentSession ? sessionDisplayName(store.currentSession) : 'LULUX ETA' }}
        </h1>
        <p v-if="store.currentAgents.length > 0" class="chat-subtitle" :title="subtitle">
          {{ subtitle }}
        </p>
      </div>

      <button
        v-if="primaryAgent"
        type="button"
        class="kernel-chip"
        :disabled="store.streaming"
        :title="$t('chat.k1s9c5r4')"
        :aria-label="$t('chat.k1s9c5r4')"
        @click="openKernelMenu"
      >
        <span class="kernel-chip-name">{{ primaryAgent.name }}</span>
        <AppIcon name="chevron-down" :size="14" />
      </button>

      <!-- 会话绑定（固定上下文）：插头图标，已绑定时带小圆点和客户名；悬停 / 聚焦显示完整说明 -->
      <span v-if="store.currentSession && primaryAgent?.kind !== 'kernel'" class="context-bind">
        <button
          type="button"
          class="context-chip"
          :class="{ bound: Boolean(contextLabel), named: Boolean(contextShort) }"
          :aria-label="contextLabel ? $t('chat.k1vy0ahp', [contextLabel]) : $t('chat.kt6tuei')"
          aria-describedby="context-bind-tip"
          data-testid="context-bind"
          @click="bindingOpen = true"
        >
          <AppIcon name="plug" :size="15" />
          <i v-if="contextLabel" class="context-chip-dot" aria-hidden="true"></i>
          <span v-if="contextShort" class="context-chip-name">{{ contextShort }}</span>
        </button>
        <span id="context-bind-tip" role="tooltip" class="context-tip" data-testid="context-bind-tip">
          <template v-if="contextLabel">
            <b>{{ $t('chat.pinnedTitle') }}</b>
            <span v-if="store.contextNames.customer">{{
              $t('chat.pinnedCustomer', [store.contextNames.customer])
            }}</span>
            <span v-if="store.contextNames.quote">{{ $t('chat.pinnedQuote', [store.contextNames.quote]) }}</span>
            <span class="context-tip-hint">{{ $t('chat.pinnedHint') }}</span>
          </template>
          <template v-else>
            <b>{{ $t('chat.kt6tuei') }}</b>
            <span class="context-tip-hint">{{ $t('chat.k1nzhmrn') }}</span>
          </template>
        </span>
      </span>

      <div class="chat-actions">
        <span v-if="store.streaming" class="status-pill">{{ $t('chat.kocj52r') }}</span>
        <button
          type="button"
          class="icon-button"
          :class="{ active: activePanel === 'artifacts' }"
          :title="$t('chat.k4dl4ov')"
          :aria-label="$t('chat.k4dl4ov')"
          @click="togglePanel('artifacts')"
        >
          <AppIcon name="code" :size="18" />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: activePanel === 'browser' }"
          :title="$t('chat.k11yttjx')"
          :aria-label="$t('chat.k11yttjx')"
          @click="togglePanel('browser')"
        >
          <AppIcon name="globe" :size="18" />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: activePanel === 'detail' }"
          :title="$t('chat.kndt8to')"
          :aria-label="$t('chat.kndt8to')"
          @click="togglePanel('detail')"
        >
          <AppIcon name="monitor" :size="18" />
        </button>
      </div>
    </header>

    <p v-if="store.error" class="error-banner">
      <AppIcon name="alert" :size="16" />
      <span>{{ store.error }}</span>
    </p>

    <MessageList />
    <Composer />
  </section>

  <KernelMenu
    v-if="kernelMenu"
    :x="kernelMenu.x"
    :y="kernelMenu.y"
    :agents="store.agents"
    :current-id="primaryAgent?.id ?? null"
    @select="chooseKernel"
    @close="kernelMenu = null"
  />

  <ContextBindingModal
    v-if="bindingOpen"
    :customer-id="store.context.customerId"
    :quote-id="store.context.quoteId"
    @close="bindingOpen = false"
    @save="saveContext"
  />

  <div v-if="panelOverlay" class="panel-backdrop" aria-hidden="true" @click="activePanel = null" />
  <DetailPanel v-if="activePanel === 'detail'" @close="activePanel = null" />
  <ArtifactPanel v-else-if="activePanel === 'artifacts'" @close="activePanel = null" />
  <BrowserPanel v-else-if="activePanel === 'browser'" @close="activePanel = null" />
</template>
