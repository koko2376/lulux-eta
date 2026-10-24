<script setup lang="ts">
import { findMemberAgent, memberTag, withMemberTag } from '../lib/members'
import { computed, ref } from 'vue'
import type { Session } from '../api'
import { canManageGroup } from '../lib/group-members'
import { useAppStore } from '../stores/app'
import { t } from '../i18n'

/**
 * 群聊主管选择：LULUX（默认）/ 任一成员内核 / 无主管。
 * 用在会话右键的成员面板与会话详情里；生成中不可改。
 */
const props = defineProps<{ session: Session; compact?: boolean }>()
const emit = defineEmits<{ error: [message: string] }>()

const store = useAppStore()
const busy = ref(false)

const value = computed(() => props.session.supervisorId ?? 'builtin')
const options = computed(() => {
  const members = props.session.agentIds
    .filter((id) => id !== 'builtin')
    .map((id) => ({ id, name: withMemberTag(findMemberAgent(store.agents, id)?.name ?? id, memberTag(props.session, id)) }))
  return [{ id: 'builtin', name: t('supervisor.builtin') }, ...members, { id: 'none', name: t('supervisor.none') }]
})
/** 生成中，或多人群聊里不是群主 / 管理员 */
const locked = computed(() => store.isRunning(props.session.id) || !canManageGroup(props.session))

async function onChange(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value
  if (next === value.value || busy.value) return
  busy.value = true
  try {
    await store.setSupervisor(props.session.id, next)
  } catch (error) {
    ;(event.target as HTMLSelectElement).value = value.value
    emit('error', error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <label class="supervisor-picker" :class="{ compact }" :title="$t('supervisor.hint')">
    <span class="supervisor-picker-label">{{ $t('supervisor.label') }}</span>
    <select
      class="supervisor-select"
      :value="value"
      :disabled="busy || locked"
      :aria-label="$t('supervisor.pickerAria')"
      @click.stop
      @change="onChange"
    >
      <option v-for="option in options" :key="option.id" :value="option.id">{{ option.name }}</option>
    </select>
  </label>
</template>

<style scoped>
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
</style>
