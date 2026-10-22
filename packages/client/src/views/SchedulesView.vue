<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { schedulesApi, workflowsApi, type Schedule, type ScheduleRun, type Workflow } from '../api/workflows'
import ScheduleDialog from '../components/schedule/ScheduleDialog.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import SessionPeekModal from '../components/workflow/SessionPeekModal.vue'
import { describeSpec, formatWhen } from '../lib/schedule'
import { can } from '../lib/session'
import { formatDateTime, formatDuration, isActive, statusLabel } from '../lib/workflow'
import { useAppStore } from '../stores/app'
import { onAutomationEvent } from '../stores/automation-events'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/**
 * 定时任务：列表（名称、目标、白话计划、下次运行、上次状态、启用开关、立即运行），新建 / 编辑对话框，每个任务的运行记录。
 */
const router = useRouter()
const store = useAppStore()
/** 新建 / 修改 / 删除定时任务需要 workflow:manage；立即运行只需要 data:write */
const canWrite = computed(() => can('data:write') && can('workflow:manage'))
const canRun = computed(() => can('data:write'))

const schedules = ref<Schedule[]>([])
const workflows = ref<Workflow[]>([])
const loading = ref(true)
const error = ref('')
type Filter = 'all' | 'enabled' | 'disabled' | 'workflow' | 'prompt'
const filter = ref<Filter>('all')
const q = ref('')

const counts = computed(() => ({
  all: schedules.value.length,
  enabled: schedules.value.filter((s) => s.enabled).length,
  disabled: schedules.value.filter((s) => !s.enabled).length,
  workflow: schedules.value.filter((s) => s.target.type === 'workflow').length,
  prompt: schedules.value.filter((s) => s.target.type === 'prompt').length,
}))
const visible = computed(() => {
  const k = q.value.trim().toLowerCase()
  return schedules.value.filter((s) => {
    if (filter.value === 'enabled' && !s.enabled) return false
    if (filter.value === 'disabled' && s.enabled) return false
    if ((filter.value === 'workflow' || filter.value === 'prompt') && s.target.type !== filter.value) return false
    return !k || s.name.toLowerCase().includes(k) || targetText(s).toLowerCase().includes(k)
  })
})

function targetText(s: Schedule): string {
  if (s.target.type === 'workflow') {
    const id = s.target.workflowId
    return workflows.value.find((w) => w.id === id)?.name ?? t('schedule.missingWorkflow')
  }
  const kid = s.target.kernelId
  const kernel = kid === 'builtin' ? t('workflow.kernelLulux') : (store.agents.find((a) => a.id === kid)?.name ?? kid)
  return `${kernel} · ${s.target.prompt}`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, wfs] = await Promise.all([schedulesApi.list(true), workflowsApi.list(true).catch(() => [])])
    schedules.value = list
    workflows.value = wfs
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}

function upsert(s: Schedule): void {
  const i = schedules.value.findIndex((x) => x.id === s.id)
  if (i >= 0) schedules.value[i] = s
  else schedules.value = [s, ...schedules.value]
}

const toggling = ref<Record<string, boolean>>({})
async function toggle(s: Schedule, enabled: boolean): Promise<void> {
  toggling.value = { ...toggling.value, [s.id]: true }
  const prev = s.enabled
  s.enabled = enabled
  try {
    upsert(await schedulesApi.update(s.id, { enabled }))
  } catch {
    s.enabled = prev
  } finally {
    toggling.value = { ...toggling.value, [s.id]: false }
  }
}

const runningNow = ref<Record<string, boolean>>({})
async function runNow(s: Schedule): Promise<void> {
  runningNow.value = { ...runningNow.value, [s.id]: true }
  try {
    const run = await schedulesApi.runNow(s.id)
    s.lastStatus = run.status
    s.lastRunAt = run.startedAt
    toast.success(t('schedule.runStarted', [s.name]))
    if (historyFor.value?.id === s.id) history.value = [run, ...history.value.filter((r) => r.id !== run.id)]
  } catch {
    /* toast */
  } finally {
    runningNow.value = { ...runningNow.value, [s.id]: false }
  }
}

async function remove(s: Schedule): Promise<void> {
  const ok = await confirmDialog({
    title: t('schedule.deleteTitle'),
    message: t('schedule.deleteMessage', [s.name]),
    confirmText: t('schedule.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await schedulesApi.remove(s.id)
    schedules.value = schedules.value.filter((x) => x.id !== s.id)
    toast.success(t('schedule.deleted'))
  } catch {
    /* toast */
  }
}

/* ── 对话框 ── */
const editing = ref<Schedule | null>(null)
const creating = ref(false)
function openCreate(): void {
  editing.value = null
  creating.value = true
}
function openEdit(s: Schedule): void {
  creating.value = false
  editing.value = s
}
function closeDialog(): void {
  creating.value = false
  editing.value = null
}
function onSaved(s: Schedule): void {
  upsert(s)
  closeDialog()
}

/* ── 运行记录 ── */
const historyFor = ref<Schedule | null>(null)
const history = ref<ScheduleRun[]>([])
const historyLoading = ref(false)
const historyError = ref('')
async function openHistory(s: Schedule): Promise<void> {
  historyFor.value = s
  history.value = []
  await loadHistory()
}
async function loadHistory(): Promise<void> {
  const s = historyFor.value
  if (!s) return
  historyLoading.value = true
  historyError.value = ''
  try {
    history.value = await schedulesApi.runs(s.id, 20)
  } catch (e) {
    historyError.value = errorText(e)
  } finally {
    historyLoading.value = false
  }
}
const peek = ref<{ sessionId: string; title: string } | null>(null)
function openRun(run: ScheduleRun): void {
  const s = historyFor.value
  if (!s) return
  if (run.workflowRunId && s.target.type === 'workflow') {
    historyFor.value = null
    void router.push(`/workflows/${s.target.workflowId}`)
  } else if (run.sessionId) {
    peek.value = { sessionId: run.sessionId, title: s.name }
  }
}

let off: (() => void) | null = null
onMounted(async () => {
  await Promise.all([
    load(),
    store.agents.length ? Promise.resolve() : store.refreshAgents().catch(() => undefined),
    store.sessions.length ? Promise.resolve() : store.refreshSessions().catch(() => undefined),
  ])
  off = onAutomationEvent((ev) => {
    if (ev.type !== 'schedule.run') return
    const s = schedules.value.find((x) => x.id === ev.scheduleId)
    if (!s) return
    s.lastStatus = ev.status
    if (isActive(ev.status)) s.lastRunAt = Date.now()
    else void schedulesApi.get(s.id, true).then(upsert, () => undefined)
    if (historyFor.value?.id === s.id) void loadHistory()
  })
})
onBeforeUnmount(() => off?.())

const FILTERS: Filter[] = ['all', 'enabled', 'disabled', 'workflow', 'prompt']

const menuFor = ref<string | null>(null)
function pick(fn: () => unknown): void {
  menuFor.value = null
  void fn()
}
function closeMenu(): void {
  menuFor.value = null
}
onMounted(() => document.addEventListener('click', closeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeMenu))
</script>

<template>
  <aside class="side" :aria-label="$t('schedule.title')">
    <div class="side-head">
      <h2 class="side-title">{{ $t('schedule.title') }}</h2>
      <button v-if="canWrite" type="button" class="link" data-testid="schedule-new-side" @click="openCreate">
        {{ $t('schedule.new') }}
      </button>
    </div>
    <label class="side-search">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <span class="sr-only">{{ $t('schedule.search') }}</span>
      <input v-model="q" type="search" :placeholder="$t('schedule.search')" spellcheck="false" />
    </label>
    <nav class="side-body">
      <template v-for="f in FILTERS" :key="f">
        <div v-if="f === 'workflow'" class="side-label">{{ $t('schedule.byTarget') }}</div>
        <button type="button" class="nav-row" :class="{ on: filter === f }" @click="filter = f">
          {{ $t(`schedule.filter_${f}`) }}<span class="count">{{ counts[f] }}</span>
        </button>
      </template>
      <div class="side-label">{{ $t('schedule.related') }}</div>
      <RouterLink class="nav-row" to="/workflows">{{ $t('workflow.title') }}</RouterLink>
    </nav>
  </aside>

  <main class="main">
    <PageTopbar :title="$t('schedule.title')" :sub="$t('schedule.sub')" :search="false">
      <button v-if="canWrite" type="button" class="btn sd-new" data-testid="schedule-new" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>{{ $t('schedule.new') }}
      </button>
    </PageTopbar>

    <div class="doc">
      <StateBlock v-if="loading && !schedules.length" state="loading" />
      <StateBlock v-else-if="error" state="error" :message="error" @retry="load" />
      <StateBlock
        v-else-if="!schedules.length"
        state="empty"
        :title="$t('schedule.emptyTitle')"
        :message="$t('schedule.emptyMessage')"
      >
        <button v-if="canWrite" type="button" class="kbtn primary" @click="openCreate">{{ $t('schedule.new') }}</button>
      </StateBlock>

      <div v-else class="panel sc-panel">
        <table class="data-table sc-table" data-testid="schedule-table">
          <thead>
            <tr>
              <th>{{ $t('schedule.colName') }}</th>
              <th>{{ $t('schedule.colTarget') }}</th>
              <th>{{ $t('schedule.colSchedule') }}</th>
              <th>{{ $t('schedule.colNext') }}</th>
              <th>{{ $t('schedule.colLast') }}</th>
              <th class="c-center">{{ $t('schedule.colEnabled') }}</th>
              <th class="c-actions">
                <span class="sr-only">{{ $t('schedule.colActions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!visible.length">
              <td colspan="7" class="sc-none">{{ $t('schedule.noMatch') }}</td>
            </tr>
            <tr v-for="s in visible" :key="s.id" :class="{ off: !s.enabled }" data-testid="schedule-row">
              <td>
                <button type="button" class="sc-name" :disabled="!canWrite" :title="s.name" @click="openEdit(s)">
                  {{ s.name }}
                </button>
              </td>
              <td class="sc-target">
                <span class="tag">{{
                  s.target.type === 'workflow' ? $t('schedule.targetWorkflow') : $t('schedule.targetPrompt')
                }}</span>
                <span class="sc-target-text" :title="targetText(s)">{{ targetText(s) }}</span>
              </td>
              <td class="sc-spec">
                <span>{{ describeSpec(s.spec, s.timezone) }}</span>
                <span class="sc-tz">{{ s.timezone }}</span>
              </td>
              <td class="sc-next">{{ s.enabled ? formatWhen(s.nextRunAt, s.timezone) : '—' }}</td>
              <td>
                <span
                  v-if="s.lastStatus"
                  class="sc-pill"
                  :class="`st-${s.lastStatus}`"
                  :title="s.lastError ?? undefined"
                  >{{ statusLabel(s.lastStatus) }}</span
                >
                <span v-else class="sc-muted">{{ $t('schedule.neverRun') }}</span>
                <span v-if="s.lastRunAt" class="sc-last">{{ formatWhen(s.lastRunAt, s.timezone) }}</span>
              </td>
              <td class="c-center">
                <UiSwitch
                  :model-value="s.enabled"
                  :disabled="!canWrite || toggling[s.id]"
                  :label="$t('schedule.enableFor', [s.name])"
                  @update:model-value="toggle(s, $event)"
                />
              </td>
              <td class="c-actions">
                <button
                  v-if="canRun"
                  type="button"
                  class="kbtn sm"
                  :disabled="runningNow[s.id]"
                  data-testid="schedule-run-now"
                  @click="runNow(s)"
                >
                  {{ $t('schedule.runNow') }}
                </button>
                <button
                  type="button"
                  class="sc-more"
                  :aria-label="$t('schedule.moreFor', [s.name])"
                  :aria-expanded="menuFor === s.id"
                  data-testid="schedule-more"
                  @click.stop="menuFor = menuFor === s.id ? null : s.id"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="6" cy="12" r="1.4" />
                    <circle cx="12" cy="12" r="1.4" />
                    <circle cx="18" cy="12" r="1.4" />
                  </svg>
                </button>
                <div v-if="menuFor === s.id" class="sc-menu" role="menu" @click.stop>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="schedule-history"
                    @click="pick(() => openHistory(s))"
                  >
                    {{ $t('schedule.history') }}
                  </button>
                  <button v-if="canWrite" type="button" role="menuitem" @click="pick(() => openEdit(s))">
                    {{ $t('schedule.edit') }}
                  </button>
                  <button
                    v-if="canWrite"
                    type="button"
                    role="menuitem"
                    class="danger"
                    data-testid="schedule-delete"
                    @click="pick(() => remove(s))"
                  >
                    {{ $t('schedule.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <ScheduleDialog
    v-if="creating || editing"
    :schedule="editing"
    :workflows="workflows"
    :agents="store.agents"
    :sessions="store.sessions"
    @close="closeDialog"
    @saved="onSaved"
  />

  <UiModal
    v-if="historyFor"
    :title="$t('schedule.historyTitle', [historyFor.name])"
    :subtitle="describeSpec(historyFor.spec, historyFor.timezone)"
    :width="600"
    @close="historyFor = null"
  >
    <StateBlock v-if="historyLoading && !history.length" state="loading" compact />
    <StateBlock v-else-if="historyError" state="error" :message="historyError" compact @retry="loadHistory" />
    <p v-else-if="!history.length" class="sc-muted sc-hist-empty">{{ $t('schedule.noRuns') }}</p>
    <ul v-else class="sc-hist" data-testid="schedule-runs">
      <li v-for="run in history" :key="run.id">
        <span class="sc-pill" :class="`st-${run.status}`">{{ statusLabel(run.status) }}</span>
        <span class="sc-hist-time">{{ formatDateTime(run.startedAt) }}</span>
        <span class="sc-hist-dur">{{ formatDuration(run.startedAt, run.finishedAt) }}</span>
        <span v-if="run.missed" class="sc-missed" :title="$t('schedule.missedHint')">{{ $t('schedule.missed') }}</span>
        <span class="tb-spacer"></span>
        <button v-if="run.workflowRunId || run.sessionId" type="button" class="link sc-open" @click="openRun(run)">
          {{ run.workflowRunId ? $t('schedule.openWorkflowRun') : $t('schedule.openSession') }}
        </button>
        <p v-if="run.error" class="sc-hist-err">{{ run.error }}</p>
      </li>
    </ul>
  </UiModal>
  <SessionPeekModal v-if="peek" :session-id="peek.sessionId" :title="peek.title" @close="peek = null" />
</template>

<style scoped>
.sd-new svg {
  width: 15px;
  height: 15px;
}
.sc-panel {
  overflow: visible;
}
.sc-missed {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--surface-muted);
}
.sc-table td {
  vertical-align: middle;
}
.sc-table tr.off td:not(.c-center):not(.c-actions) {
  color: var(--text-tertiary);
}
.sc-name {
  display: block;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  text-align: left;
}
.sc-name:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.sc-name:disabled {
  cursor: default;
}
tr.off .sc-name {
  color: var(--text-secondary);
}
.sc-target {
  max-width: 240px;
  white-space: nowrap;
}
.sc-target .tag {
  margin-right: 6px;
}
.sc-target-text {
  display: inline-block;
  max-width: 150px;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.sc-spec {
  min-width: 150px;
}
.sc-last {
  white-space: nowrap;
}
.sc-spec span:first-child {
  display: block;
  font-weight: 500;
}
.sc-tz,
.sc-last {
  display: block;
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
.sc-next {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sc-pill {
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
.sc-pill.st-running,
.sc-pill.st-queued {
  background: var(--info-soft);
  color: var(--info-text);
}
.sc-pill.st-succeeded {
  background: var(--good-soft);
  color: var(--good);
}
.sc-pill.st-failed {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.sc-muted {
  font-size: 12px;
  color: var(--text-tertiary);
}
.c-center {
  text-align: center;
}
.c-actions {
  text-align: right;
  white-space: nowrap;
}
.c-actions {
  position: relative;
}
.sc-more {
  width: 28px;
  height: 28px;
  margin-left: 4px;
  display: inline-grid;
  place-items: center;
  vertical-align: middle;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--icon-muted);
}
.sc-more:hover,
.sc-more[aria-expanded='true'] {
  background: var(--surface-hover);
  color: var(--text);
}
.sc-more svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}
.sc-menu {
  position: absolute;
  right: 12px;
  top: calc(100% - 6px);
  z-index: 20;
  min-width: 120px;
  padding: 5px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
}
.sc-menu button {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.sc-menu button:hover {
  background: var(--surface-hover);
}
.sc-menu button.danger {
  color: var(--danger-text);
}
.sc-none {
  text-align: center;
  padding: 28px 12px !important;
  color: var(--text-tertiary);
}
.sc-hist {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sc-hist li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 2px;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
.sc-hist li:first-child {
  border-top: 0;
}
.sc-hist-time {
  font-variant-numeric: tabular-nums;
}
.sc-hist-dur {
  font-size: 12px;
  color: var(--text-tertiary);
}
.sc-hist-err {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--danger-text);
}
.sc-hist-empty {
  text-align: center;
  margin: 24px 0;
}
.sc-open {
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
