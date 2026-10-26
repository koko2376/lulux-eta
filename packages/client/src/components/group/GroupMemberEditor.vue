<script setup lang="ts">
import { computed } from 'vue'
import type { Agent } from '../../api'
import { agentName, agentTagline, kernelReasonText } from '../../lib/kernel'
import {
  GROUP_MEMBER_MAX,
  MEMBER_ROLE_MAX,
  memberKernelId,
  newMemberDraft,
  predictMemberIds,
  splitMemberId,
  type MemberDraft,
} from '../../lib/members'
import AgentAvatar from '../AgentAvatar.vue'
import AppIcon from '../AppIcon.vue'
import MemberTag from '../MemberTag.vue'

/**
 * 群成员编辑（新建群聊与群成员面板共用）：
 * - 上面是内核列表：点一下加入 / 移出；已加入的内核右侧有“＋”，同一内核可以再加一个；
 * - 下面是已加入的成员，按发言顺序，每人可以填一个群头衔（显示在名字旁）。
 * 名字始终是内核原名，不提供改名。
 */
const props = defineProps<{ agents: Agent[]; modelValue: MemberDraft[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: MemberDraft[]] }>()

const counts = computed(() => {
  const map = new Map<string, number>()
  for (const draft of props.modelValue) {
    const base = memberKernelId(draft.agentId)
    map.set(base, (map.get(base) ?? 0) + 1)
  }
  return map
})
const full = computed(() => props.modelValue.length >= GROUP_MEMBER_MAX)
const ids = computed(() => predictMemberIds(props.modelValue))

function agentOf(id: string): Agent | undefined {
  return props.agents.find((agent) => agent.id === memberKernelId(id))
}

function toggle(agent: Agent): void {
  if (props.disabled) return
  if ((counts.value.get(agent.id) ?? 0) > 0) {
    emit('update:modelValue', props.modelValue.filter((draft) => memberKernelId(draft.agentId) !== agent.id))
  } else if (!full.value) {
    emit('update:modelValue', [...props.modelValue, newMemberDraft(agent.id)])
  }
}

function addAnother(agent: Agent): void {
  if (props.disabled || full.value || agent.available === false) return
  emit('update:modelValue', [...props.modelValue, newMemberDraft(agent.id)])
}

function remove(key: string): void {
  if (props.disabled) return
  emit('update:modelValue', props.modelValue.filter((draft) => draft.key !== key))
}

function setRole(key: string, role: string): void {
  emit(
    'update:modelValue',
    props.modelValue.map((draft) => (draft.key === key ? { ...draft, role: role.slice(0, MEMBER_ROLE_MAX) } : draft)),
  )
}

/** 同一内核多个成员时，没填头衔的显示序号 */
function numberTag(index: number): string {
  const id = ids.value[index]!
  return (counts.value.get(memberKernelId(id)) ?? 0) > 1 ? `#${splitMemberId(id).n}` : ''
}
</script>

<template>
  <div class="member-editor">
    <div class="context-agents member-editor-kernels" role="group" :aria-label="$t('groupMembers.kernels')">
      <div
        v-for="agent in agents"
        :key="agent.id"
        class="member-kernel"
        :class="{ checked: (counts.get(agent.id) ?? 0) > 0 }"
      >
        <button
          type="button"
          class="context-agent member-kernel-main"
          :class="{ checked: (counts.get(agent.id) ?? 0) > 0 }"
          :disabled="disabled || agent.available === false || (!(counts.get(agent.id) ?? 0) && full)"
          role="menuitemcheckbox"
          :aria-checked="(counts.get(agent.id) ?? 0) > 0"
          :title="agent.available === false ? kernelReasonText(agent.unavailableReason) : agentTagline(agent)"
          @click="toggle(agent)"
        >
          <AgentAvatar :agent-id="agent.id" :size="32" />
          <span class="context-agent-text">
            <strong
              >{{ agentName(agent)
              }}<span v-if="(counts.get(agent.id) ?? 0) > 1" class="member-count">×{{ counts.get(agent.id) }}</span></strong
            >
            <span>{{
              agent.available === false
                ? kernelReasonText(agent.unavailableReason) || agentTagline(agent)
                : agentTagline(agent)
            }}</span>
          </span>
          <span class="context-check">
            <AppIcon v-if="(counts.get(agent.id) ?? 0) > 0" name="check" :size="14" />
          </span>
        </button>
        <button
          v-if="(counts.get(agent.id) ?? 0) > 0"
          type="button"
          class="member-add"
          :disabled="disabled || full"
          :title="$t('groupMembers.addAnother', [agentName(agent)])"
          :aria-label="$t('groupMembers.addAnother', [agentName(agent)])"
          @click="addAnother(agent)"
        >
          <AppIcon name="plus" :size="13" />
        </button>
      </div>
    </div>

    <div v-if="modelValue.length > 0" class="member-roles" role="list" :aria-label="$t('groupMembers.roles')">
      <p class="member-roles-label">{{ $t('groupMembers.rolesHint') }}</p>
      <div v-for="(draft, index) in modelValue" :key="draft.key" class="member-role-row" role="listitem">
        <span class="member-order">{{ index + 1 }}</span>
        <AgentAvatar :agent-id="ids[index]" :size="22" />
        <span class="member-role-name"
          >{{ agentOf(draft.agentId) ? agentName(agentOf(draft.agentId)!) : draft.agentId
          }}<MemberTag :tag="draft.role.trim() || numberTag(index)" :peers="modelValue.map((d, i) => d.role.trim() || numberTag(i))"
        /></span>
        <input
          class="member-role-input"
          :value="draft.role"
          :maxlength="MEMBER_ROLE_MAX"
          :placeholder="$t('groupMembers.rolePlaceholder')"
          :aria-label="$t('groupMembers.roleAria', [index + 1])"
          :disabled="disabled"
          spellcheck="false"
          @input="setRole(draft.key, ($event.target as HTMLInputElement).value)"
        />
        <button
          type="button"
          class="member-remove"
          :disabled="disabled"
          :title="$t('groupMembers.remove')"
          :aria-label="$t('groupMembers.remove')"
          @click="remove(draft.key)"
        >
          <AppIcon name="close" :size="12" />
        </button>
      </div>
      <p v-if="full" class="member-full">{{ $t('groupMembers.full', [GROUP_MEMBER_MAX]) }}</p>
    </div>
  </div>
</template>

<style scoped>
.member-editor-kernels {
  max-height: min(300px, calc(100vh - 420px));
  min-height: 120px;
  overflow-y: auto;
}
.member-kernel {
  display: flex;
  align-items: center;
  border-radius: 12px;
}
.member-kernel.checked {
  background: var(--surface-soft);
}
.member-kernel-main {
  flex: 1;
  min-width: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.member-kernel.checked .member-kernel-main {
  background: transparent;
}
.member-kernel-main:disabled {
  cursor: default;
}
.member-count {
  margin-left: 6px;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 600;
}
.member-add {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin-right: 6px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: var(--surface-muted);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}
.member-add:hover:not(:disabled) {
  background: var(--surface-hover);
  transform: scale(1.06);
}
.member-add:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.member-roles {
  margin: 8px 6px 0;
  padding: 8px;
  border-radius: 12px;
  background: var(--surface-soft);
}
.member-roles-label {
  margin: 0 0 6px;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.member-role-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  animation: member-in 0.18s ease;
}
@keyframes member-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
.member-order {
  width: 14px;
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 11px;
  text-align: right;
}
.member-role-name {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.member-role-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.member-role-input:focus-visible {
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.member-remove {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.member-remove:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}
.member-full {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
}
</style>
