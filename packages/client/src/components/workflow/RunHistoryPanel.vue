<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WorkflowNode, WorkflowRun } from '../../api/workflows'
import { formatDateTime, formatDuration, isActive, statusLabel } from '../../lib/workflow'
import MessageContent from '../MessageContent.vue'
import StateBlock from '../ui/StateBlock.vue'

/**
 * 右侧「运行历史」：运行列表 → 某次运行的各节点状态与输出；节点有隐藏会话时可以打开查看。
 */
const props = defineProps<{
  runs: WorkflowRun[]
  nodes: WorkflowNode[]
  selectedId: string | null
  loading?: boolean
  error?: string
}>()
const emit = defineEmits<{
  select: [runId: string | null]
  refresh: []
  close: []
  cancel: [runId: string]
  'open-session': [sessionId: string, title: string]
}>()

const selected = computed(() => props.runs.find((r) => r.id === props.selectedId) ?? null)
const expanded = ref<Record<string, boolean>>({})

/** 节点按画布里的顺序列出；运行记录里有、画布里已删掉的节点排在后面 */
const rows = computed(() => {
  const run = selected.value
  if (!run) return []
  const byId = new Map(run.nodes.map((n) => [n.nodeId, n]))
  const out = props.nodes.map((node) => ({ id: node.id, name: node.name, rn: byId.get(node.id) ?? null }))
  for (const rn of run.nodes)
    if (!props.nodes.some((n) => n.id === rn.nodeId)) out.push({ id: rn.nodeId, name: rn.nodeId, rn })
  return out
})

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}
const isOpen = (id: string, status: string | undefined): boolean =>
  expanded.value[id] ?? (status === 'running' || status === 'failed')
</script>

<template>
  <aside class="rh" :aria-label="$t('workflow.history')" data-testid="run-history">
    <header class="rh-head">
      <button
        v-if="selected"
        type="button"
        class="rh-icon"
        :aria-label="$t('workflow.backToRuns')"
        :title="$t('workflow.backToRuns')"
        @click="emit('select', null)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
      </button>
      <h2 class="rh-title">{{ selected ? $t('workflow.runDetail') : $t('workflow.history') }}</h2>
      <button
        type="button"
        class="rh-icon"
        :aria-label="$t('workflow.refresh')"
        :title="$t('workflow.refresh')"
        @click="emit('refresh')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
          <path d="M19.5 4.5v4h-4" />
        </svg>
      </button>
      <button
        type="button"
        class="rh-icon"
        :aria-label="$t('workflow.closePanel')"
        :title="$t('workflow.closePanel')"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11" /></svg>
      </button>
    </header>

    <div class="rh-body">
      <template v-if="!selected">
        <StateBlock v-if="loading && !runs.length" state="loading" compact />
        <StateBlock v-else-if="error" state="error" :message="error" compact @retry="emit('refresh')" />
        <p v-else-if="!runs.length" class="rh-empty">{{ $t('workflow.noRuns') }}</p>
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="rh-run"
          data-testid="run-row"
          @click="emit('select', run.id)"
        >
          <span class="rh-run-top">
            <span class="wf-pill" :class="`st-${run.status}`">{{ statusLabel(run.status) }}</span>
            <span class="rh-trigger">{{
              run.trigger === 'schedule' ? $t('workflow.triggerSchedule') : $t('workflow.triggerManual')
            }}</span>
            <span class="rh-dur">{{ formatDuration(run.startedAt, run.finishedAt) }}</span>
          </span>
          <span class="rh-run-time">{{ formatDateTime(run.startedAt) }}</span>
          <span class="rh-run-nodes">
            <span
              v-for="n in run.nodes"
              :key="n.nodeId"
              class="rh-seg"
              :class="`st-${n.status}`"
              :title="`${nodes.find((x) => x.id === n.nodeId)?.name ?? n.nodeId} · ${statusLabel(n.status)}`"
            ></span>
          </span>
        </button>
      </template>

      <template v-else>
        <div class="rh-summary">
          <div class="rh-sum-row">
            <span class="wf-pill" :class="`st-${selected.status}`">{{ statusLabel(selected.status) }}</span>
            <span class="rh-trigger">{{
              selected.trigger === 'schedule' ? $t('workflow.triggerSchedule') : $t('workflow.triggerManual')
            }}</span>
            <span class="tb-spacer"></span>
            <button
              v-if="isActive(selected.status)"
              type="button"
              class="kbtn sm danger"
              data-testid="cancel-run"
              @click="emit('cancel', selected.id)"
            >
              {{ $t('workflow.cancelRun') }}
            </button>
          </div>
          <dl class="rh-meta">
            <dt>{{ $t('workflow.startedAt') }}</dt>
            <dd>{{ formatDateTime(selected.startedAt) }}</dd>
            <dt>{{ $t('workflow.duration') }}</dt>
            <dd>{{ formatDuration(selected.startedAt, selected.finishedAt) }}</dd>
            <template v-if="selected.input">
              <dt>{{ $t('workflow.runInput') }}</dt>
              <dd class="rh-input">{{ selected.input }}</dd>
            </template>
          </dl>
          <p v-if="selected.error" class="rh-error">{{ selected.error }}</p>
        </div>

        <div v-for="row in rows" :key="row.id" class="rh-node" data-testid="run-node">
          <button
            type="button"
            class="rh-node-head"
            :aria-expanded="isOpen(row.id, row.rn?.status)"
            @click="toggle(row.id)"
          >
            <span class="rh-dot" :class="`st-${row.rn?.status ?? 'none'}`" aria-hidden="true"></span>
            <span class="rh-node-name">{{ row.name }}</span>
            <span class="rh-node-st">{{ row.rn ? statusLabel(row.rn.status) : $t('workflow.notRun') }}</span>
            <span v-if="row.rn?.startedAt" class="rh-dur">{{
              formatDuration(row.rn.startedAt, row.rn.finishedAt)
            }}</span>
          </button>
          <div v-if="row.rn && isOpen(row.id, row.rn.status)" class="rh-node-body">
            <p v-if="row.rn.error" class="rh-error">{{ row.rn.error }}</p>
            <div v-if="row.rn.output" class="rh-output"><MessageContent :content="row.rn.output" markdown /></div>
            <p v-else-if="!row.rn.error" class="rh-muted">
              {{ row.rn.status === 'skipped' ? $t('workflow.skippedHint') : $t('workflow.noOutput') }}
            </p>
            <button
              v-if="row.rn.sessionId"
              type="button"
              class="link rh-open"
              data-testid="open-session"
              @click="emit('open-session', row.rn.sessionId, row.name)"
            >
              {{ $t('workflow.openSession') }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.rh {
  width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--surface);
}
.rh-head {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--line);
}
.rh-title {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.rh-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text-secondary);
}
.rh-icon:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.rh-icon svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rh-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.rh-empty {
  margin: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}
.rh-run {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  margin-bottom: 8px;
}
.rh-run:hover {
  background: var(--surface-soft);
}
.rh-run-top,
.rh-sum-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rh-trigger {
  font-size: 12px;
  color: var(--text-secondary);
}
.rh-dur {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.rh-run-time {
  font-size: 12px;
  color: var(--text-tertiary);
}
.rh-run-nodes {
  display: flex;
  gap: 3px;
}
.rh-seg {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-active);
}
.rh-seg.st-running,
.rh-seg.st-queued {
  background: var(--info-text);
}
.rh-seg.st-succeeded {
  background: var(--good);
}
.rh-seg.st-failed {
  background: var(--danger);
}
.wf-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.wf-pill.st-running,
.wf-pill.st-queued {
  background: var(--info-soft);
  color: var(--info-text);
}
.wf-pill.st-succeeded {
  background: var(--good-soft);
  color: var(--good);
}
.wf-pill.st-failed {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.rh-summary {
  padding: 6px 6px 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 8px;
}
.rh-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 5px 12px;
  margin: 10px 0 0;
  font-size: 12px;
}
.rh-meta dt {
  color: var(--text-tertiary);
}
.rh-meta dd {
  margin: 0;
  color: var(--text);
}
.rh-input {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 80px;
  overflow: auto;
}
.rh-error {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--danger-soft);
  color: var(--danger-text);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.rh-node {
  border-radius: 10px;
}
.rh-node + .rh-node {
  margin-top: 2px;
}
.rh-node-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.rh-node-head:hover {
  background: var(--surface-hover);
}
.rh-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--kpi-dot);
}
.rh-dot.st-running,
.rh-dot.st-queued {
  background: var(--info-text);
}
.rh-dot.st-succeeded {
  background: var(--good);
}
.rh-dot.st-failed {
  background: var(--danger);
}
.rh-node-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rh-node-st {
  font-size: 12px;
  color: var(--text-secondary);
}
.rh-node-head .rh-dur {
  margin-left: 0;
  min-width: 44px;
  text-align: right;
}
.rh-node-body {
  padding: 2px 8px 10px 24px;
}
.rh-output {
  max-height: 240px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-soft);
  font-size: 12.5px;
  line-height: 1.6;
}
.rh-muted {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.rh-open {
  margin-top: 6px;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
