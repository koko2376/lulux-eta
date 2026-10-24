<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Session } from '../api'
import { exportSessionMarkdown } from '../lib/export-session'
import { isGroupSession } from '../lib/session-name'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/ui'
import AgentAvatar from './AgentAvatar.vue'
import AppIcon from './AppIcon.vue'
import SupervisorPicker from './SupervisorPicker.vue'
import GroupPeople from './group/GroupPeople.vue'
import GroupMemberEditor from './group/GroupMemberEditor.vue'
import { type MemberDraft } from '../lib/members'
import { canManageGroup, isGroupOwner } from '../lib/group-members'
import { auth } from '../lib/session'
import { viewportCss } from '../lib/ui-zoom'
import { t } from '../i18n'

const MENU_WIDTH = 308
const ROW_HEIGHT = 58

const props = defineProps<{
  session: Session
  x: number
  y: number
}>()

const emit = defineEmits<{ close: []; remove: [id: string] }>()

const store = useAppStore()
const selected = ref<string[]>([...props.session.agentIds])
const busy = ref(false)
const error = ref('')
const renaming = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
const groupDraft = ref(props.session.groupName ?? '')

/** 多人群聊：群主 / 群管理员才能改设置；普通成员只能看、退出（契约 §6.10） */
const manageable = computed(() => canManageGroup(props.session))
const owner = computed(() => isGroupOwner(props.session))
const locked = computed(() => store.isRunning(props.session.id) || !manageable.value)
/** 群里的同事：团队服务器模式的群聊 */
const showPeople = computed(() => isGroup.value && auth.mode === 'server')
/** 群聊看会话类型（kind）：单聊只能换内核（单选），群聊才能增删成员（多选）。单聊不会变成群聊 */
const isGroup = computed(() => isGroupSession(props.session))

/** 群成员草稿：已有成员用实例 id（保存时保持身份），新加的用内核 id（服务端分配序号） */
function draftsOf(session: Session): MemberDraft[] {
  return session.agentIds.map((id) => ({
    agentId: id,
    role: session.memberProfiles?.[id]?.role ?? '',
    instructions: session.memberProfiles?.[id]?.instructions ?? '',
    key: id,
  }))
}
const drafts = ref<MemberDraft[]>(draftsOf(props.session))
const dirty = ref(false)
let saveTimer: number | null = null

watch(
  () => [props.session.agentIds, props.session.memberProfiles] as const,
  () => {
    selected.value = [...props.session.agentIds]
    // 正在编辑（有未保存的改动）时不覆盖输入
    if (!dirty.value && !busy.value) drafts.value = draftsOf(props.session)
  },
)

/** 群成员改动：头衔输入防抖保存，增删成员立刻保存 */
function onDrafts(next: MemberDraft[]): void {
  if (locked.value) return
  if (next.length === 0) return
  const structural = next.length !== drafts.value.length || next.some((draft, i) => draft.key !== drafts.value[i]?.key)
  drafts.value = next
  dirty.value = true
  error.value = ''
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void saveDrafts(), structural ? 0 : 600)
}

async function saveDrafts(): Promise<void> {
  saveTimer = null
  if (!dirty.value) return
  if (busy.value) {
    saveTimer = window.setTimeout(() => void saveDrafts(), 200)
    return
  }
  busy.value = true
  dirty.value = false
  const snapshot = drafts.value
  try {
    await store.setSessionMembers(
      props.session.id,
      snapshot.map((draft) => ({
        agentId: draft.agentId,
        role: draft.role.trim() || null,
        instructions: draft.instructions || null,
      })),
    )
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    busy.value = false
    // 保存期间没有新改动：按服务端返回的成员刷新（新成员拿到实例 id）
    const latest = store.sessions.find((item) => item.id === props.session.id)
    if (!dirty.value && latest) drafts.value = draftsOf(latest)
  }
}

watch(
  () => props.session.groupName,
  (name) => {
    groupDraft.value = name ?? ''
  },
)

const position = computed(() => {
  const people = showPeople.value ? 80 + (props.session.participants?.length ?? 1) * 36 : 0
  // props.x / y 已经是 CSS 像素；innerWidth / innerHeight 是视觉像素，夹取时同样换算
  const viewport = viewportCss()
  const height = Math.min(
    viewport.height - 20,
    108 + (isGroup.value ? 80 : 0) + store.agents.length * ROW_HEIGHT + 72 + people,
  )
  const left = Math.max(10, Math.min(props.x, viewport.width - MENU_WIDTH - 10))
  const top = Math.max(10, Math.min(props.y, viewport.height - height - 10))
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${MENU_WIDTH}px`,
    maxHeight: 'calc(100vh - 20px)',
    overflowY: 'auto' as const,
  }
})

async function toggle(agentId: string): Promise<void> {
  if (busy.value || locked.value) return

  let next: string[]
  if (isGroup.value) {
    next = selected.value.includes(agentId)
      ? selected.value.filter((id) => id !== agentId)
      : [...selected.value, agentId]
    // 群聊至少保留一个成员，否则会话没有可用的发言者
    if (next.length === 0) return
  } else {
    // 单聊：换成另一个内核，仍是单聊
    if (selected.value[0] === agentId) return
    next = [agentId]
  }

  const previous = selected.value
  selected.value = next
  busy.value = true
  error.value = ''

  try {
    await store.setSessionAgents(props.session.id, next)
  } catch (value) {
    selected.value = previous
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    busy.value = false
  }
}

async function startRename(): Promise<void> {
  if (busy.value || locked.value) return
  titleDraft.value = props.session.title
  error.value = ''
  renaming.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return
  renaming.value = false
  const next = titleDraft.value.trim()
  if (!next || next === props.session.title) return

  busy.value = true
  error.value = ''
  try {
    await store.renameSession(props.session.id, next)
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    busy.value = false
  }
}

function cancelRename(): void {
  renaming.value = false
  titleDraft.value = ''
}

async function commitGroupName(): Promise<void> {
  if (!isGroup.value || busy.value || locked.value) return
  const next = groupDraft.value.trim()
  if (next === (props.session.groupName ?? '')) return

  busy.value = true
  error.value = ''
  try {
    await store.renameGroup(props.session.id, next)
  } catch (value) {
    groupDraft.value = props.session.groupName ?? ''
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    busy.value = false
  }
}

/** 回车提交后主动失焦，让输入框滚回开头，避免长名字只露出尾部 */
async function commitGroupNameAndBlur(event: KeyboardEvent): Promise<void> {
  const input = event.target as HTMLInputElement | null
  await commitGroupName()
  input?.blur()
}

function cancelGroupName(event: KeyboardEvent): void {
  groupDraft.value = props.session.groupName ?? ''
  ;(event.target as HTMLInputElement | null)?.blur()
}

function removeSession(): void {
  // 先关菜单再交给父组件弹确认框，避免确认框与菜单叠在一起
  const id = props.session.id
  emit('close')
  emit('remove', id)
}

async function exportMarkdown(): Promise<void> {
  try {
    await exportSessionMarkdown(props.session)
    toast.success(t('sessionContextMenu.k1vvdqsc'))
    emit('close')
  } catch {
    /* 全局 toast 已提示 */
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  // 关闭面板时把还没保存的群头衔存掉
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    void saveDrafts()
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="context-backdrop" @mousedown.self="emit('close')" @contextmenu.prevent>
      <section
        class="context-menu"
        :style="position"
        role="menu"
        :aria-label="$t('sessionContextMenu.khz7jfo', [session.title])"
        @mousedown.stop
      >
        <header class="context-head">
          <template v-if="renaming">
            <input
              ref="titleInput"
              v-model="titleDraft"
              class="context-title-input"
              maxlength="80"
              spellcheck="false"
              :aria-label="$t('sessionContextMenu.k119expy')"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <span class="context-title">{{ session.title }}</span>
            <span v-if="isGroup" class="context-tag">{{ $t('sessionContextMenu.k16q82zq', [selected.length]) }}</span>
            <button
              type="button"
              class="context-rename"
              :title="$t('sessionContextMenu.k8044if')"
              :aria-label="$t('sessionContextMenu.k8044if')"
              :disabled="busy || locked"
              @click="startRename"
            >
              <AppIcon name="edit" :size="13" />
            </button>
          </template>
        </header>
        <p class="context-hint">
          {{ isGroup ? $t('sessionContextMenu.k1apspv7') : $t('sessionContextMenu.singleHint') }}
        </p>

        <label v-if="isGroup" class="context-group">
          <span class="context-group-label">{{ $t('sessionContextMenu.k1uvbgy6') }}</span>
          <input
            v-model="groupDraft"
            class="context-group-input"
            maxlength="40"
            spellcheck="false"
            :placeholder="$t('sessionContextMenu.kg13pbq')"
            :disabled="busy || locked"
            @click.stop
            @keydown.enter.prevent="commitGroupNameAndBlur"
            @keydown.esc.prevent="cancelGroupName"
            @blur="commitGroupName"
          />
        </label>

        <SupervisorPicker v-if="isGroup" :session="session" @error="(message) => (error = message)" />

        <GroupMemberEditor
          v-if="isGroup"
          :agents="store.agents"
          :model-value="drafts"
          :disabled="locked"
          @update:model-value="onDrafts"
        />

        <div v-else class="context-agents" role="group">
          <button
            v-for="agent in store.agents"
            :key="agent.id"
            type="button"
            class="context-agent"
            :class="{ checked: selected.includes(agent.id) }"
            :disabled="busy || locked"
            :role="isGroup ? 'menuitemcheckbox' : 'menuitemradio'"
            :aria-checked="selected.includes(agent.id)"
            @click="toggle(agent.id)"
          >
            <AgentAvatar :agent-id="agent.id" :size="34" />
            <span class="context-agent-text">
              <strong>{{ agent.name }}</strong>
              <span :title="agent.description">{{ agent.description }}</span>
            </span>
            <span class="context-check">
              <AppIcon v-if="selected.includes(agent.id)" name="check" :size="14" />
            </span>
          </button>
        </div>

        <GroupPeople
          v-if="showPeople"
          :session="session"
          @error="(message) => (error = message)"
          @left="emit('close')"
        />

        <p v-if="!manageable" class="context-note">{{ $t('groupPeople.managedHint') }}</p>
        <p v-else-if="locked" class="context-note">{{ $t('sessionContextMenu.kjq1fux') }}</p>
        <p v-else-if="error" class="context-note danger">{{ error }}</p>
        <p v-else class="context-note">
          {{ isGroup ? $t('sessionContextMenu.k1mfqs5v') : $t('sessionContextMenu.singleNote') }}
        </p>

        <footer class="context-foot">
          <button
            v-if="owner"
            type="button"
            class="context-remove"
            :title="store.isRunning(session.id) ? $t('sessionContextMenu.ks7q5j3') : undefined"
            @click="removeSession"
          >
            <AppIcon name="trash" :size="14" />
            <span>{{ $t('sessionContextMenu.k75suew') }}</span>
          </button>
          <button type="button" class="context-export" @click="exportMarkdown">
            <AppIcon name="download" :size="14" />
            <span>{{ $t('sessionContextMenu.kczj22j') }}</span>
          </button>
          <button type="button" class="context-done" @click="emit('close')">
            {{ $t('sessionContextMenu.ke6ugyy') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
