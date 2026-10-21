<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { agentName, agentTagline, kernelReasonText } from '../lib/kernel'
import { useAppStore } from '../stores/app'
import AgentAvatar from './AgentAvatar.vue'
import AppIcon from './AppIcon.vue'
import ColleaguePicker from './group/ColleaguePicker.vue'
import { auth } from '../lib/session'
import { t } from '../i18n'

/**
 * 新建群聊：与原版（0f0d587）会话右键里的成员面板同一套样式——群聊名称、勾选内核、按勾选顺序发言。
 * 群聊总是一个全新的会话（空历史），不会把已有的单聊变成群聊。
 */
const MENU_WIDTH = 308
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
const selected = ref<string[]>(
  kernels.value.some((agent) => agent.id === BUILTIN_ID && agent.available !== false) ? [BUILTIN_ID] : [],
)
const supervisorId = ref(BUILTIN_ID)
const busy = ref(false)
const error = ref('')

const supervisorOptions = computed(() => [
  { id: BUILTIN_ID, name: t('supervisor.builtin') },
  ...selected.value
    .filter((id) => id !== BUILTIN_ID)
    .map((id) => ({ id, name: store.agents.find((agent) => agent.id === id)?.name ?? id })),
  { id: 'none', name: t('supervisor.none') },
])
/** 至少两个内核；邀请了同事时一个内核也能建群（多人群聊，契约 §6.10） */
const enough = computed(() => selected.value.length >= 2 || (selected.value.length >= 1 && userIds.value.length > 0))
const canCreate = computed(() => enough.value && !busy.value)

function toggle(agentId: string): void {
  if (busy.value) return
  selected.value = selected.value.includes(agentId)
    ? selected.value.filter((id) => id !== agentId)
    : [...selected.value, agentId]
  if (!supervisorOptions.value.some((option) => option.id === supervisorId.value)) supervisorId.value = BUILTIN_ID
  error.value = ''
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await store.newGroup({
      agentIds: selected.value,
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
  left.value = Math.max(10, Math.min(props.x, window.innerWidth - MENU_WIDTH - 10))
  top.value = Math.max(10, Math.min(props.y, window.innerHeight - height - 10))
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
          <span v-if="selected.length > 0" class="context-tag">{{
            $t('sessionContextMenu.k16q82zq', [selected.length])
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

        <div class="context-agents new-group-agents" role="group" :aria-label="$t('newGroup.members')">
          <button
            v-for="agent in kernels"
            :key="agent.id"
            type="button"
            class="context-agent"
            :class="{ checked: selected.includes(agent.id) }"
            :disabled="busy || agent.available === false"
            role="menuitemcheckbox"
            :aria-checked="selected.includes(agent.id)"
            :title="agent.available === false ? kernelReasonText(agent.unavailableReason) : agentTagline(agent)"
            @click="toggle(agent.id)"
          >
            <AgentAvatar :agent-id="agent.id" :size="34" />
            <span class="context-agent-text">
              <strong>{{ agentName(agent) }}</strong>
              <span>{{
                agent.available === false
                  ? kernelReasonText(agent.unavailableReason) || agentTagline(agent)
                  : agentTagline(agent)
              }}</span>
            </span>
            <span class="context-check">
              <AppIcon v-if="selected.includes(agent.id)" name="check" :size="14" />
            </span>
          </button>
        </div>

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
.new-group-agents {
  max-height: min(460px, calc(100vh - 300px));
  overflow-y: auto;
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
