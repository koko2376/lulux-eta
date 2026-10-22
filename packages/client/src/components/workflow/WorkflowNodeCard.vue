<script setup lang="ts">
import { computed } from 'vue'
import type { Agent, Provider } from '../../api'
import type { JoinStrategy, RunStatus, WorkflowNode } from '../../api/workflows'
import { decodeModel, encodeModel, statusLabel } from '../../lib/workflow'
import UiSwitch from '../ui/UiSwitch.vue'
import KernelSelect from './KernelSelect.vue'

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
      <span class="wf-head-label">{{ $t('workflow.agentNode') }}</span>
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

      <KernelSelect
        :model-value="node.kernelId"
        :agents="agents"
        :disabled="readonly"
        @update:model-value="setKernel"
      />

      <select
        v-if="isBuiltin"
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
        :placeholder="$t('workflow.promptPlaceholder')"
        :aria-label="$t('workflow.prompt')"
        data-testid="node-prompt"
        @change="emit('update', { prompt: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
    </div>
  </div>
</template>

<style scoped>
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
