<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import AppIcon from './AppIcon.vue'
import ColleaguePicker from './group/ColleaguePicker.vue'
import GroupMemberEditor from './group/GroupMemberEditor.vue'
import { auth } from '../lib/session'
import { t } from '../i18n'
import { viewportCss } from '../lib/ui-zoom'
import { agentName } from '../lib/kernel'
import { newMemberDraft, predictMemberIds, splitMemberId, withMemberTag, type MemberDraft } from '../lib/members'

/**
 * 新建群聊：群聊名称、选内核（同一内核可以加多个）、给成员填群头衔、选主管。
 * 群聊总是一个全新的会话（空历史），不会把已有的单聊变成群聊。
 */
const MENU_WIDTH = 340
const BUILTIN_ID = 'builtin'

const props = defineProps<{ x: number; y: number }>()
const emit = defineEmits<{ close: []; created: [id: string] }>()

const store = useAppStore()
const panel = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const groupName = ref('')
const left = ref(props.x)
const top = ref(props.y)

/** 内核顺序同内核选择器：LULUX 在最前，然后是各命令行内核 */
const kernels = computed(() => [
  ...store.agents.filter((agent) => agent.kind !== 'kernel'),
  ...store.agents.filter((agent) => agent.kind === 'kernel'),
])
/** 一起邀请的同事（团队服务器模式；组织里只有自己时选择器不显示） */
const userIds = ref<string[]>([])
const serverMode = computed(() => auth.mode === 'server')
const members = ref<MemberDraft[]>(
  kernels.value.some((agent) => agent.id === BUILTIN_ID && agent.available !== false) ? [newMemberDraft(BUILTIN_ID)] : [],
)
const supervisorId = ref(BUILTIN_ID)
const busy = ref(false)
const error = ref('')

/** 成员保存后的 id（服务端同一规则分配）：主管下拉里用 */
const memberIds = computed(() => predictMemberIds(members.value))
const supervisorOptions = computed(() => [
  { id: BUILTIN_ID, name: t('supervisor.builtin') },
  ...members.value
    .map((draft, index) => ({ draft, id: memberIds.value[index]! }))
    .filter(({ id }) => id !== BUILTIN_ID)
    .map(({ draft, id }) => {
      const agent = store.agents.find((item) => item.id === splitMemberId(id).base)
      const name = agent ? agentName(agent) : id
      const n = splitMemberId(id).n
      return { id, name: withMemberTag(name, draft.role.trim() || (n > 1 ? `#${n}` : '')) }
    }),
  { id: 'none', name: t('supervisor.none') },
])
/** 至少两个成员（同一内核两个也行）；邀请了同事时一个成员也能建群（多人群聊，契约 §6.10） */
const enough = computed(() => members.value.length >= 2 || (members.value.length >= 1 && userIds.value.length > 0))
const canCreate = computed(() => enough.value && !busy.value)

function onMembers(next: MemberDraft[]): void {
  members.value = next
  if (!supervisorOptions.value.some((option) => option.id === supervisorId.value)) supervisorId.value = BUILTIN_ID
  error.value = ''
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await store.newGroup({
      agentIds: memberIds.value,
      members: members.value.map((draft) => ({ agentId: draft.agentId, role: draft.role.trim() || null })),
      groupName: groupName.value,
      supervisorId: supervisorId.value === BUILTIN_ID ? undefined : supervisorId.value,
      userIds: userIds.value,
    })
    emit('created', session.id)
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value)
  } finally {
    busy.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await nextTick()
  const height = panel.value?.offsetHeight ?? 420
  // props.x / y 已经是 CSS 像素；innerWidth / innerHeight 是视觉像素，夹取时同样换算
  const viewport = viewportCss()
  left.value = Math.max(10, Math.min(props.x, viewport.width - MENU_WIDTH - 10))
  top.value = Math.max(10, Math.min(props.y, viewport.height - height - 10))
  nameInput.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="context-backdrop" @mousedown.self="emit('close')" @contextmenu.prevent>
      <section
        ref="panel"
        class="context-menu new-group"
        role="dialog"
        :aria-label="$t('newGroup.title')"
        :style="{ left: `${left}px`, top: `${top}px`, width: `${MENU_WIDTH}px`, maxHeight: 'calc(100vh - 20px)' }"
        @mousedown.stop
      >
        <header class="context-head">
          <AppIcon name="users" :size="15" class="new-group-icon" />
          <span class="context-title">{{ $t('newGroup.title') }}</span>
          <span v-if="members.length > 0" class="context-tag">{{
            $t('sessionContextMenu.k16q82zq', [members.length])
          }}</span>
        </header>
        <p class="context-hint">{{ $t('newGroup.hint') }}</p>

        <label class="context-group">
          <span class="context-group-label">{{ $t('sessionContextMenu.k1uvbgy6') }}</span>
          <input
            ref="nameInput"
            v-model="groupName"
            class="context-group-input"
            maxlength="40"
            spellcheck="false"
            :placeholder="$t('sessionContextMenu.kg13pbq')"
            :disabled="busy"
            @keydown.enter.prevent="create"
          />
        </label>

        <GroupMemberEditor :agents="kernels" :model-value="members" :disabled="busy" @update:model-value="onMembers" />

        <label class="supervisor-picker new-group-supervisor" :title="$t('supervisor.hint')">
          <span class="supervisor-picker-label">{{ $t('supervisor.label') }}</span>
          <select
            v-model="supervisorId"
            class="supervisor-select"
            :aria-label="$t('supervisor.pickerAria')"
            :disabled="busy"
          >
            <option v-for="option in supervisorOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
        </label>

        <ColleaguePicker v-if="serverMode" v-model="userIds" :disabled="busy" />

        <p v-if="error" class="context-note danger">{{ error }}</p>
        <p v-else class="context-note">{{ enough ? $t('newGroup.fresh') : $t('newGroup.needTwo') }}</p>

        <footer class="context-foot">
          <button type="button" class="context-export" @click="emit('close')">{{ $t('newGroup.cancel') }}</button>
          <button type="button" class="context-done" :disabled="!canCreate" @click="create">
            {{ $t('newGroup.create') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.new-group {
  overflow-y: auto;
}
.new-group-icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}
.supervisor-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 6px 8px;
}
.supervisor-picker.compact {
  margin: 0;
}
.supervisor-picker-label {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.supervisor-select {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 26px 0 8px;
  border: 0;
  border-radius: 7px;
  background-color: var(--surface-muted);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5l3-3' fill='none' stroke='%238a8a90' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 12px 12px;
  -webkit-appearance: none;
  appearance: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
  cursor: pointer;
  text-overflow: ellipsis;
}
.supervisor-select:focus-visible {
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.supervisor-select:disabled {
  cursor: default;
  opacity: 0.6;
}
.new-group-supervisor {
  margin: 8px 6px 0;
}
.context-done:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
