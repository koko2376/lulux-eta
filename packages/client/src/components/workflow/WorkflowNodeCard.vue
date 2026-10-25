<script setup lang="ts">
import { computed } from 'vue'
import type { Agent, Provider } from '../../api'
import type { JoinStrategy, RunStatus, WorkflowNode } from '../../api/workflows'
import { decodeModel, encodeModel, statusLabel } from '../../lib/workflow'
import UiSwitch from '../ui/UiSwitch.vue'
import KernelSelect from './KernelSelect.vue'
import AgentAvatar from '../AgentAvatar.vue'
import MemberTag from '../MemberTag.vue'
import { agentName } from '../../lib/kernel'
import { GROUP_MEMBER_MAX, MEMBER_ROLE_MAX, memberKernelId, predictMemberIds, splitMemberId, withMemberTag } from '../../lib/members'

/**
 * 工作流节点卡片（画布里的一张卡）：名称、内核、模型（只有 LULUX 内核有）、汇合策略、允许写操作、提示词，
 * 运行中右上角显示节点状态。可交互的控件都带 nodrag（拖动卡片只从空白处 / 标题栏拖），文本框带 nowheel。
 * 连接点（Handle）由画布包一层加上，卡片本身不依赖 Vue Flow，方便单测。
 */
const props = defineProps<{
  node: WorkflowNode
  agents: Agent[]
  providers: Array<Pick<Provider, 'id' | 'name' | 'model' | 'models'>>
  status?: RunStatus | null
  selected?: boolean
  readonly?: boolean
  /** 有上游连线时才显示汇合策略 */
  hasUpstream?: boolean
}>()
const emit = defineEmits<{
  update: [patch: Partial<WorkflowNode>]
  remove: []
}>()

const isBuiltin = computed(() => props.node.kernelId === 'builtin')
const isGroup = computed(() => props.node.kind === 'group')
const members = computed(() => props.node.members ?? [])
/** 保存后成员 id 由服务端按同一规则分配；这里预测出来给主管下拉与序号用 */
const memberIds = computed(() => predictMemberIds(members.value))
const kernelChoices = computed(() => [
  ...props.agents.filter((agent) => agent.kind !== 'kernel'),
  ...props.agents.filter((agent) => agent.kind === 'kernel'),
])

function memberName(id: string): string {
  const agent = props.agents.find((item) => item.id === memberKernelId(id))
  return agent ? agentName(agent) : id
}
function memberNumberTag(index: number): string {
  const id = memberIds.value[index]!
  const base = memberKernelId(id)
  return memberIds.value.filter((other) => memberKernelId(other) === base).length > 1 ? `#${splitMemberId(id).n}` : ''
}
function supervisorLabel(index: number): string {
  const member = members.value[index]!
  return withMemberTag(memberName(member.agentId), member.role || memberNumberTag(index))
}
function setKind(kind: 'agent' | 'group'): void {
  if (kind === (props.node.kind ?? 'agent')) return
  if (kind === 'group') {
    // 默认带两个成员：当前内核 + LULUX（用户再改）
    const first = props.node.kernelId || 'builtin'
    const seed = members.value.length
      ? members.value
      : [
          { agentId: first, role: '', instructions: '', model: null },
          { agentId: 'builtin', role: '', instructions: '', model: null },
        ]
    emit('update', { kind: 'group', members: seed, supervisorId: props.node.supervisorId ?? 'builtin' })
  } else emit('update', { kind: 'agent' })
}
function addMember(e: Event): void {
  const select = e.target as HTMLSelectElement
  const agentId = select.value
  select.value = ''
  if (!agentId || members.value.length >= GROUP_MEMBER_MAX) return
  emit('update', { members: [...members.value, { agentId, role: '', instructions: '', model: null }] })
}
function removeMember(index: number): void {
  const next = members.value.filter((_, i) => i !== index)
  const removedId = memberIds.value[index]
  emit('update', {
    members: next,
    ...(removedId && props.node.supervisorId === removedId ? { supervisorId: 'builtin' } : {}),
  })
}
function setRole(index: number, e: Event): void {
  const role = (e.target as HTMLInputElement).value.trim().slice(0, MEMBER_ROLE_MAX)
  if (role === (members.value[index]?.role ?? '')) return
  emit('update', { members: members.value.map((m, i) => (i === index ? { ...m, role } : m)) })
}
const modelValue = computed(() => encodeModel(props.node.providerId, props.node.model))

function setKernel(id: string): void {
  // 换成命令行内核时清掉模型覆盖（只有 LULUX 内核用 Provider / 模型）
  emit('update', id === 'builtin' ? { kernelId: id } : { kernelId: id, providerId: null, model: null })
}
function setModel(e: Event): void {
  emit('update', decodeModel((e.target as HTMLSelectElement).value))
}
function setJoin(e: Event): void {
  emit('update', { joinStrategy: (e.target as HTMLSelectElement).value as JoinStrategy })
}
function setName(e: Event): void {
  const name = (e.target as HTMLInputElement).value.trim()
  if (name && name !== props.node.name) emit('update', { name })
  else (e.target as HTMLInputElement).value = props.node.name
}
</script>

<template>
  <div
    class="wf-node"
    :class="[status ? `st-${status}` : '', { selected }]"
    :data-node-id="node.id"
    data-testid="workflow-node"
  >
    <header class="wf-node-head">
      <span class="wf-dot" aria-hidden="true"></span>
      <span class="wf-head-label">{{ isGroup ? $t('workflow.groupNode') : $t('workflow.agentNode') }}</span>
      <span v-if="status" class="wf-badge" :class="`st-${status}`" data-testid="node-status">
        <span v-if="status === 'running'" class="wf-spin" aria-hidden="true"></span>{{ statusLabel(status) }}
      </span>
      <button
        v-if="!readonly"
        type="button"
        class="wf-x nodrag"
        :aria-label="$t('workflow.removeNode')"
        :title="$t('workflow.removeNode')"
        @click="emit('remove')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
      </button>
    </header>

    <div class="wf-body">
      <input
        class="wf-name nodrag"
        :value="node.name"
        :readonly="readonly"
        maxlength="40"
        :aria-label="$t('workflow.nodeNameLabel')"
        spellcheck="false"
        @change="setName"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />

      <div class="wf-kind nodrag" role="radiogroup" :aria-label="$t('workflow.nodeKind')">
        <button
          type="button"
          role="radio"
          :aria-checked="!isGroup"
          :class="{ on: !isGroup }"
          :disabled="readonly"
          @click="setKind('agent')"
        >
          {{ $t('workflow.kindAgent') }}
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="isGroup"
          :class="{ on: isGroup }"
          :disabled="readonly"
          data-testid="kind-group"
          @click="setKind('group')"
        >
          {{ $t('workflow.kindGroup') }}
        </button>
      </div>

      <template v-if="isGroup">
        <div class="wf-members nodrag nowheel" data-testid="group-members">
          <div v-for="(member, index) in members" :key="`${index}-${member.agentId}`" class="wf-member">
            <AgentAvatar :agent-id="memberIds[index]" :size="20" />
            <span class="wf-member-name"
              >{{ memberName(member.agentId) }}<MemberTag :tag="member.role || memberNumberTag(index)" :peers="members.map((m, i) => m.role || memberNumberTag(i))"
            /></span>
            <input
              class="wf-member-role"
              :value="member.role"
              :readonly="readonly"
              :maxlength="MEMBER_ROLE_MAX"
              :placeholder="$t('groupMembers.rolePlaceholder')"
              :aria-label="$t('groupMembers.roleAria', [index + 1])"
              spellcheck="false"
              @change="setRole(index, $event)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
            <button
              v-if="!readonly && members.length > 1"
              type="button"
              class="wf-member-x"
              :aria-label="$t('groupMembers.remove')"
              :title="$t('groupMembers.remove')"
              @click="removeMember(index)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
            </button>
          </div>
          <select
            v-if="!readonly && members.length < GROUP_MEMBER_MAX"
            class="select sm wf-select"
            value=""
            :aria-label="$t('workflow.addMember')"
            data-testid="add-member"
            @change="addMember"
          >
            <option value="">{{ $t('workflow.addMember') }}</option>
            <option v-for="agent in kernelChoices" :key="agent.id" :value="agent.id" :disabled="agent.available === false">
              {{ agentName(agent) }}
            </option>
          </select>
        </div>
        <label class="wf-row">
          <span class="wf-label">{{ $t('supervisor.label') }}</span>
          <select
            class="select sm wf-select nodrag"
            :value="node.supervisorId ?? 'builtin'"
            :disabled="readonly"
            data-testid="group-supervisor"
            @change="emit('update', { supervisorId: ($event.target as HTMLSelectElement).value })"
          >
            <option value="builtin">{{ $t('supervisor.builtin') }}</option>
            <template v-for="(member, index) in members" :key="`s-${index}`">
              <option v-if="memberIds[index] !== 'builtin'" :value="memberIds[index]">
                {{ supervisorLabel(index) }}
              </option>
            </template>
            <option value="none">{{ $t('supervisor.none') }}</option>
          </select>
        </label>
      </template>

      <KernelSelect
        v-if="!isGroup"
        :model-value="node.kernelId"
        :agents="agents"
        :disabled="readonly"
        @update:model-value="setKernel"
      />

      <select
        v-if="isBuiltin && !isGroup"
        class="select sm wf-select nodrag"
        :value="modelValue"
        :disabled="readonly"
        :aria-label="$t('workflow.model')"
        data-testid="model-select"
        @change="setModel"
      >
        <option value="">{{ $t('workflow.modelDefault') }}</option>
        <optgroup v-for="p in providers" :key="p.id" :label="p.name">
          <option v-for="m in p.models.length ? p.models : [p.model]" :key="m" :value="encodeModel(p.id, m)">
            {{ m }}
          </option>
        </optgroup>
        <option
          v-if="modelValue && !providers.some((p) => encodeModel(p.id, node.model) === modelValue)"
          :value="modelValue"
        >
          {{ node.model || node.providerId }}
        </option>
      </select>

      <label v-if="hasUpstream" class="wf-row">
        <span class="wf-label">{{ $t('workflow.join') }}</span>
        <select
          class="select sm wf-select nodrag"
          :value="node.joinStrategy"
          :disabled="readonly"
          :title="$t('workflow.joinHint')"
          data-testid="join-select"
          @change="setJoin"
        >
          <option value="all">{{ $t('workflow.joinAll') }}</option>
          <option value="any">{{ $t('workflow.joinAny') }}</option>
        </select>
      </label>
      <p v-else class="wf-note" data-testid="root-note">{{ $t('workflow.rootNote') }}</p>

      <div class="wf-row">
        <span class="wf-label" :title="$t('workflow.allowWriteHint')">{{ $t('workflow.allowWrite') }}</span>
        <UiSwitch
          class="nodrag"
          :model-value="node.allowWrite"
          :disabled="readonly"
          :label="$t('workflow.allowWrite')"
          @update:model-value="emit('update', { allowWrite: $event })"
        />
      </div>

      <textarea
        class="wf-prompt nodrag nowheel"
        :value="node.prompt"
        :readonly="readonly"
        rows="4"
        :placeholder="isGroup ? $t('workflow.groupPromptPlaceholder') : $t('workflow.promptPlaceholder')"
        :aria-label="$t('workflow.prompt')"
        data-testid="node-prompt"
        @change="emit('update', { prompt: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
.wf-kind {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--surface-muted);
}
.wf-kind button {
  flex: 1;
  height: 24px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.wf-kind button.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.wf-kind button:disabled {
  cursor: default;
}
.wf-members {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 210px;
  overflow-y: auto;
}
.wf-member {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
}
.wf-member-name {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 52%;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.wf-member-role {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: var(--surface-muted);
  color: var(--text);
  font: inherit;
  font-size: 11.5px;
  outline: none;
}
.wf-member-role:focus {
  box-shadow: 0 0 0 2px var(--focus-ring);
}
.wf-member-x {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.wf-member-x:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.wf-member-x svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.wf-node {
  width: 248px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: var(--shadow-1);
  font-size: 12.5px;
  color: var(--text);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.wf-node.selected {
  border-color: var(--text);
  box-shadow: var(--shadow-2);
}
.wf-node.st-running {
  border-color: var(--info-text);
  box-shadow: 0 0 0 3px var(--info-soft);
}
.wf-node.st-succeeded {
  border-color: var(--good-line);
}
.wf-node.st-failed {
  border-color: var(--danger-line);
}
.wf-node.st-skipped,
.wf-node.st-cancelled {
  opacity: 0.7;
}
.wf-node-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--line);
  cursor: grab;
}
.wf-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--kpi-dot);
  flex: none;
}
.st-running .wf-dot {
  background: var(--info-text);
}
.st-succeeded .wf-dot {
  background: var(--good);
}
.st-failed .wf-dot {
  background: var(--danger);
}
.wf-head-label {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  font-weight: 500;
}
.wf-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--surface-muted);
  color: var(--text-secondary);
  white-space: nowrap;
}
.wf-badge.st-running,
.wf-badge.st-queued {
  background: var(--info-soft);
  color: var(--info-text);
}
.wf-badge.st-succeeded {
  background: var(--good-soft);
  color: var(--good);
}
.wf-badge.st-failed {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.wf-spin {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  animation: wf-spin 0.8s linear infinite;
}
@keyframes wf-spin {
  to {
    transform: rotate(360deg);
  }
}
.wf-x {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--icon-muted);
  opacity: 0;
}
.wf-node:hover .wf-x,
.wf-node.selected .wf-x,
.wf-x:focus-visible {
  opacity: 1;
}
.wf-x:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.wf-x svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.wf-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px 12px;
}
.wf-name {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  outline: none;
}
.wf-name:focus,
.wf-prompt:focus {
  border-color: var(--focus);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.wf-select {
  width: 100%;
}
.wf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}
.wf-row .wf-select {
  flex: 1;
  width: auto;
}
.wf-label {
  flex: none;
  font-size: 12px;
  color: var(--text-secondary);
}
.wf-row:has(.switch) .wf-label {
  flex: 1;
}
.wf-note {
  margin: 0;
  min-height: 30px;
  display: flex;
  align-items: center;
  font-size: 11px;
  color: var(--text-tertiary);
}
.wf-prompt {
  width: 100%;
  min-height: 78px;
  max-height: 220px;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.55;
  resize: vertical;
  outline: none;
}
.wf-prompt::placeholder {
  color: var(--icon-muted);
}
</style>
