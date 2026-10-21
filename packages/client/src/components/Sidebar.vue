<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getSession, type Session } from '../api'
import { plainPreview, toolPreview } from '../lib/preview'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { isGroupSession, sessionDisplayName } from '../lib/session-name'
import { canManageGroup, isMultiHuman } from '../lib/group-members'
import { onTitleBarDoubleClick } from '../lib/window'
import { isUnread, syncSeen } from '../lib/unread'
import AgentAvatar from './AgentAvatar.vue'
import GroupAvatar from './GroupAvatar.vue'
import AppIcon from './AppIcon.vue'
import NotificationBell from './NotificationBell.vue'
import KernelMenu from './KernelMenu.vue'
import NewGroupDialog from './NewGroupDialog.vue'
import SessionContextMenu from './SessionContextMenu.vue'
import { intlLocale, t } from '../i18n'

const store = useAppStore()
const router = useRouter()
const route = useRoute()
const query = ref('')

const menu = ref<{ id: string; x: number; y: number } | null>(null)
const menuSession = computed<Session | null>(() => {
  if (!menu.value) return null
  return store.sessions.find((session) => session.id === menu.value?.id) ?? null
})

const removing = ref(false)
const renamingId = ref<string | null>(null)
const renamingGroup = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

function setTitleInput(element: unknown): void {
  titleInput.value = element instanceof HTMLInputElement ? element : null
}

const onChatPage = computed(() => route.name === 'agent')

const filteredSessions = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return store.sessions
  return store.sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(keyword) ||
      (session.groupName ?? '').toLowerCase().includes(keyword) ||
      session.preview.toLowerCase().includes(keyword),
  )
})

/* 未读小圆点：正在看的会话（在对话页时）随时标记已读 */
const viewingId = computed(() => (onChatPage.value ? store.currentSessionId : null))
watch(
  () => [store.sessions.map((s) => `${s.id}:${s.updatedAt}`).join('|'), viewingId.value] as const,
  () => {
    if (store.sessions.length || store.ready) syncSeen(store.sessions, viewingId.value)
  },
  { immediate: true },
)
function unread(session: Session): boolean {
  return !store.isRunning(session.id) && isUnread(session, viewingId.value)
}

/** 最后一条没有正文的会话（例如只有超时的工具审批）：按需读一次消息，显示工具摘要；按 updatedAt 缓存 */
const toolSummaries = reactive<Record<string, { at: number; text: string }>>({})
watch(
  () => store.sessions.filter((s) => !s.preview.trim() && s.messageCount > 0).map((s) => [s.id, s.updatedAt] as const),
  (list) => {
    for (const [id, at] of list) {
      if (toolSummaries[id]?.at === at) continue
      toolSummaries[id] = { at, text: toolSummaries[id]?.text ?? '' }
      getSession(id)
        .then(({ messages }) => {
          if (toolSummaries[id]?.at === at) toolSummaries[id] = { at, text: toolPreview(messages) }
        })
        .catch(() => undefined)
    }
  },
  { immediate: true },
)

function previewOf(preview: string, messageCount: number, sessionId = ''): string {
  const text = plainPreview(preview)
  if (text) return text
  if (messageCount === 0) return t('sidebar.kc822rg')
  return toolSummaries[sessionId]?.text || t('sidebar.k1sqw1fn')
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const startOfDay = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)

  if (days <= 0) {
    return date.toLocaleTimeString(intlLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  if (days === 1) return t('sidebar.kowoka8')
  if (days < 7) {
    return (
      [
        t('sidebar.k1i6b768'),
        t('sidebar.kxmcyqv'),
        t('sidebar.k13oiivx'),
        t('sidebar.kacadf7'),
        t('sidebar.k6x665a'),
        t('sidebar.kinxp1v'),
        t('sidebar.k1ut0tcq'),
      ][date.getDay()] ?? ''
    )
  }
  return date.toLocaleDateString(intlLocale(), { month: 'numeric', day: 'numeric' })
}

const kernelMenu = ref<{ x: number; y: number } | null>(null)

function openKernelMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  kernelMenu.value = { x: rect.right - 252, y: rect.bottom + 6 }
}

/** 新建群聊：从“+”菜单进入，在同一位置弹出；群聊总是一个全新的会话 */
const groupDialog = ref<{ x: number; y: number } | null>(null)

function openNewGroup(): void {
  groupDialog.value = kernelMenu.value ? { x: kernelMenu.value.x, y: kernelMenu.value.y } : { x: 80, y: 60 }
  kernelMenu.value = null
}

async function groupCreated(): Promise<void> {
  groupDialog.value = null
  if (!onChatPage.value) await router.push({ name: 'agent' })
}

async function newChat(agentId: string): Promise<void> {
  kernelMenu.value = null
  await store.newSession(agentId)
  if (!onChatPage.value) await router.push({ name: 'agent' })
}

async function openSession(id: string): Promise<void> {
  if (id === store.currentSessionId && onChatPage.value) return
  // 生成中也可以切换：流在后台继续，切回来时恢复显示（契约 §6.8-3）
  if (!onChatPage.value) await router.push({ name: 'agent' })
  await store.selectSession(id)
}

function openMenu(event: MouseEvent, session: Session): void {
  if (renamingId.value) return
  menu.value = { id: session.id, x: event.clientX, y: event.clientY }
}

async function startRename(session: Session): Promise<void> {
  // 多人群聊里只有群主 / 管理员能改名（契约 §6.10）
  if (store.isRunning(session.id) || !canManageGroup(session)) return
  // 列表里显示的是群名（有群名时），双击改的就是这个显示名
  renamingGroup.value = isGroupSession(session) && Boolean(session.groupName)
  renamingId.value = session.id
  titleDraft.value = sessionDisplayName(session)
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

async function commitRename(session: Session): Promise<void> {
  if (renamingId.value !== session.id) return
  const editingGroup = renamingGroup.value
  renamingId.value = null
  renamingGroup.value = false
  const next = titleDraft.value.trim()
  const previous = editingGroup ? (session.groupName ?? '') : session.title
  if (!next || next === previous) return
  try {
    if (editingGroup) await store.renameGroup(session.id, next)
    else await store.renameSession(session.id, next)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

function cancelRename(): void {
  renamingId.value = null
  renamingGroup.value = false
  titleDraft.value = ''
}

async function removeSession(id: string): Promise<void> {
  // 先关掉右键菜单，再弹应用内确认框（不用原生 confirm：Electron 下会阻塞并丢失输入焦点，且会叠在菜单上）
  menu.value = null
  if (removing.value) return
  const session = store.sessions.find((s) => s.id === id)
  if (!session) return
  const running = store.isRunning(id)
  const ok = await confirmDialog({
    title: t('sidebar.k75suew'),
    message: t('sidebar.k1cm9yk6', [sessionDisplayName(session)]) + (running ? t('sidebar.k3l150t') : ''),
    confirmText: t('sidebar.kfcqesv'),
    danger: true,
  })
  if (!ok) return
  const wasCurrent = store.currentSessionId === id
  const index = filteredSessions.value.findIndex((s) => s.id === id)
  removing.value = true
  try {
    await store.removeSession(id)
    toast.success(t('sidebar.kzzpudo'))
    if (wasCurrent && onChatPage.value) {
      // 选中相邻的会话（优先下一条），没有则留空
      const rest = filteredSessions.value.length ? filteredSessions.value : store.sessions
      const next = rest[Math.min(Math.max(index, 0), rest.length - 1)]
      if (next) await store.selectSession(next.id)
    }
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-top" @dblclick="onTitleBarDoubleClick">
      <span class="sidebar-title">{{ $t('sidebar.title') }}</span>
      <span class="sidebar-tools">
        <!-- 通知铃放在二级栏头部：对话标题栏留给会话名（原版标题栏只有内核 + 产物/浏览器/详情） -->
        <NotificationBell />
        <button
          type="button"
          class="icon-button"
          :title="$t('sidebar.kh3mzlw')"
          :aria-label="$t('sidebar.kh3mzlw')"
          @click="openKernelMenu"
        >
          <AppIcon name="plus" :size="18" />
        </button>
      </span>
    </div>

    <label class="sidebar-search">
      <AppIcon name="search" :size="16" class="search-icon" />
      <input v-model="query" type="text" :placeholder="$t('sidebar.k1unt8qo')" spellcheck="false" />
    </label>

    <nav class="session-list" :aria-label="$t('sidebar.k1ewr0ny')">
      <div
        v-for="session in filteredSessions"
        :key="session.id"
        class="session-item"
        :class="{ active: onChatPage && session.id === store.currentSessionId }"
        role="button"
        tabindex="0"
        @click="openSession(session.id)"
        @keydown.enter.prevent="openSession(session.id)"
        @keydown.space.prevent="openSession(session.id)"
        @contextmenu.prevent="openMenu($event, session)"
        @dblclick.stop="startRename(session)"
      >
        <GroupAvatar v-if="isGroupSession(session)" :session="session" :size="34" />
        <AgentAvatar v-else :agent-id="session.agentIds[0]" :size="34" />
        <span class="session-body">
          <span class="session-line">
            <input
              v-if="renamingId === session.id"
              :ref="setTitleInput"
              v-model="titleDraft"
              class="session-title-input"
              maxlength="80"
              spellcheck="false"
              :aria-label="$t('sidebar.k119expy')"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent.stop="commitRename(session)"
              @keydown.esc.prevent.stop="cancelRename"
              @blur="commitRename(session)"
            />
            <span v-else class="session-title" :title="sessionDisplayName(session)">{{
              sessionDisplayName(session)
            }}</span>
            <span
              v-if="isMultiHuman(session)"
              class="session-people"
              data-testid="session-people"
              :title="$t('groupPeople.online', [session.participants?.length ?? 0])"
              :aria-label="$t('groupPeople.online', [session.participants?.length ?? 0])"
              ><AppIcon name="users" :size="12" />{{ session.participants?.length }}</span
            >
            <span class="session-time">{{ formatTime(session.updatedAt) }}</span>
          </span>
          <span class="session-line">
            <span
              class="session-preview"
              :class="{ running: store.isRunning(session.id), unread: unread(session) }"
              :title="
                store.isRunning(session.id) ? undefined : previewOf(session.preview, session.messageCount, session.id)
              "
            >
              {{
                store.isRunning(session.id)
                  ? $t('sidebar.kg9b6i8')
                  : previewOf(session.preview, session.messageCount, session.id)
              }}
            </span>
            <span v-if="unread(session)" class="session-unread" role="img" :aria-label="$t('sidebar.unread')" />
          </span>
        </span>
      </div>

      <p v-if="filteredSessions.length === 0" class="list-empty">
        {{ query ? $t('sidebar.k1rccczv') : $t('sidebar.kq59qbj') }}
      </p>
    </nav>

    <SessionContextMenu
      v-if="menuSession"
      :key="menuSession.id"
      :session="menuSession"
      :x="menu?.x ?? 0"
      :y="menu?.y ?? 0"
      @close="menu = null"
      @remove="removeSession"
    />

    <KernelMenu
      v-if="kernelMenu"
      :x="kernelMenu.x"
      :y="kernelMenu.y"
      :agents="store.agents"
      :current-id="store.currentSession?.agentIds[0] ?? null"
      allow-group
      @select="newChat"
      @new-group="openNewGroup"
      @close="kernelMenu = null"
    />

    <NewGroupDialog
      v-if="groupDialog"
      :x="groupDialog.x"
      :y="groupDialog.y"
      @created="groupCreated"
      @close="groupDialog = null"
    />
  </aside>
</template>
