<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Agent, Session } from '../../api'
import { schedulesApi, type Schedule, type ScheduleSpecType, type Workflow } from '../../api/workflows'
import {
  MIN_INTERVAL,
  defaultScheduleForm,
  describeSpec,
  formSpec,
  formToInput,
  formatWhen,
  scheduleToForm,
  timezoneOptions,
  validateScheduleForm,
  type ScheduleForm,
  type ScheduleFormErrors,
} from '../../lib/schedule'
import { sessionDisplayName } from '../../lib/session-name'
import { errorText, toast } from '../../stores/ui'
import { t } from '../../i18n'
import UiModal from '../ui/UiModal.vue'
import UiSwitch from '../ui/UiSwitch.vue'
import KernelSelect from '../workflow/KernelSelect.vue'

/**
 * 新建 / 编辑定时任务：目标（工作流 / 提示词）+ 计划（一次 / 间隔 / 每天 / 每周 / Cron）+ 时区，
 * 右侧实时预览接下来 5 次运行（POST /api/schedules/preview，防抖 350ms）。
 */
const props = defineProps<{
  schedule?: Schedule | null
  prefill?: Partial<ScheduleForm>
  workflows: Workflow[]
  agents: Agent[]
  sessions: Session[]
}>()
const emit = defineEmits<{ close: []; saved: [schedule: Schedule] }>()

const form = reactive<ScheduleForm>(
  props.schedule ? scheduleToForm(props.schedule) : defaultScheduleForm(props.prefill ?? {}),
)
if (!props.schedule && !form.name && form.targetType === 'workflow' && form.workflowId) {
  const w = props.workflows.find((x) => x.id === form.workflowId)
  if (w) form.name = t('schedule.defaultName', [w.name])
}
const errors = ref<ScheduleFormErrors>({})
const tried = ref(false)
const saving = ref(false)
const serverError = ref('')

const SPEC_TYPES: ScheduleSpecType[] = ['once', 'interval', 'daily', 'weekly', 'cron']
/** 周一在前 */
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const dayNames = computed(() => {
  const raw = t('schedule.weekdayNames')
  return raw.includes(',') ? raw.split(',') : [...raw]
})
const timezones = computed(() => timezoneOptions(form.timezone))

function toggleDay(d: number): void {
  form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]
}

watch(
  form,
  () => {
    if (tried.value) errors.value = validateScheduleForm(form)
  },
  { deep: true },
)

/* ── 预览 ── */
const preview = ref<number[]>([])
const previewState = ref<'idle' | 'loading' | 'error' | 'invalid'>('idle')
const previewError = ref('')
let timer = 0
let ctrl: AbortController | null = null
const specKey = computed(() => JSON.stringify([formSpec(form), form.timezone]))
const description = computed(() => {
  const spec = formSpec(form)
  return spec ? describeSpec(spec, form.timezone) : ''
})

watch(
  specKey,
  () => {
    window.clearTimeout(timer)
    ctrl?.abort()
    const spec = formSpec(form)
    if (!spec || validateScheduleForm(form).timezone) {
      preview.value = []
      previewState.value = 'invalid'
      return
    }
    previewState.value = 'loading'
    timer = window.setTimeout(async () => {
      ctrl = new AbortController()
      try {
        preview.value = await schedulesApi.preview(spec, form.timezone, ctrl.signal)
        previewState.value = 'idle'
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return
        preview.value = []
        previewError.value = errorText(e)
        previewState.value = 'error'
      }
    }, 350)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  window.clearTimeout(timer)
  ctrl?.abort()
})

const kernelAgents = computed(() => props.agents.filter((a) => a.kind !== 'persona'))

async function save(): Promise<void> {
  tried.value = true
  errors.value = validateScheduleForm(form)
  if (Object.keys(errors.value).length) return
  saving.value = true
  serverError.value = ''
  try {
    const input = formToInput(form)
    const saved = props.schedule
      ? await schedulesApi.update(props.schedule.id, input, true)
      : await schedulesApi.create(input)
    toast.success(props.schedule ? t('schedule.updated') : t('schedule.created'))
    emit('saved', saved)
  } catch (e) {
    serverError.value = errorText(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiModal
    :title="schedule ? $t('schedule.editTitle') : $t('schedule.newTitle')"
    :subtitle="$t('schedule.dialogSub')"
    :width="820"
    @close="emit('close')"
  >
    <form class="sd" novalidate data-testid="schedule-dialog" @submit.prevent="save">
      <div class="sd-main">
        <label class="field">
          <span class="field-label">{{ $t('schedule.name') }}</span>
          <input
            v-model="form.name"
            class="input"
            :class="{ invalid: errors.name }"
            maxlength="80"
            :placeholder="$t('schedule.namePlaceholder')"
            data-testid="schedule-name"
          />
          <span v-if="errors.name" class="field-error">{{ errors.name }}</span>
        </label>

        <div class="field">
          <span class="field-label">{{ $t('schedule.target') }}</span>
          <div class="segmented" role="radiogroup" :aria-label="$t('schedule.target')">
            <button
              type="button"
              role="radio"
              :aria-checked="form.targetType === 'workflow'"
              :class="{ on: form.targetType === 'workflow' }"
              data-testid="target-workflow"
              @click="form.targetType = 'workflow'"
            >
              {{ $t('schedule.targetWorkflow') }}
            </button>
            <button
              type="button"
              role="radio"
              :aria-checked="form.targetType === 'prompt'"
              :class="{ on: form.targetType === 'prompt' }"
              data-testid="target-prompt"
              @click="form.targetType = 'prompt'"
            >
              {{ $t('schedule.targetPrompt') }}
            </button>
          </div>
        </div>

        <template v-if="form.targetType === 'workflow'">
          <label class="field">
            <span class="field-label">{{ $t('schedule.workflow') }}</span>
            <select
              v-model="form.workflowId"
              class="select"
              :class="{ invalid: errors.workflowId }"
              data-testid="schedule-workflow"
            >
              <option value="" disabled>{{ $t('schedule.pickWorkflow') }}</option>
              <option v-for="w in workflows" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
            <span v-if="errors.workflowId" class="field-error">{{ errors.workflowId }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('schedule.input') }}</span>
            <textarea
              v-model="form.input"
              class="textarea"
              rows="2"
              :placeholder="$t('schedule.inputPlaceholder')"
            ></textarea>
          </label>
        </template>

        <template v-else>
          <div class="field">
            <span class="field-label">{{ $t('schedule.kernel') }}</span>
            <KernelSelect v-model="form.kernelId" :agents="kernelAgents" />
            <span v-if="errors.kernelId" class="field-error">{{ errors.kernelId }}</span>
          </div>
          <label class="field">
            <span class="field-label">{{ $t('schedule.prompt') }}</span>
            <textarea
              v-model="form.prompt"
              class="textarea"
              :class="{ invalid: errors.prompt }"
              rows="3"
              :placeholder="$t('schedule.promptPlaceholder')"
              data-testid="schedule-prompt"
            ></textarea>
            <span v-if="errors.prompt" class="field-error">{{ errors.prompt }}</span>
          </label>
          <div class="field">
            <span class="field-label">{{ $t('schedule.sessionMode') }}</span>
            <div class="segmented" role="radiogroup" :aria-label="$t('schedule.sessionMode')">
              <button
                type="button"
                role="radio"
                :aria-checked="form.sessionMode === 'new'"
                :class="{ on: form.sessionMode === 'new' }"
                @click="form.sessionMode = 'new'"
              >
                {{ $t('schedule.sessionNew') }}
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="form.sessionMode === 'append'"
                :class="{ on: form.sessionMode === 'append' }"
                data-testid="session-append"
                @click="form.sessionMode = 'append'"
              >
                {{ $t('schedule.sessionAppend') }}
              </button>
            </div>
          </div>
          <label v-if="form.sessionMode === 'append'" class="field">
            <span class="field-label">{{ $t('schedule.session') }}</span>
            <select v-model="form.sessionId" class="select" :class="{ invalid: errors.sessionId }">
              <option value="" disabled>{{ $t('schedule.pickSession') }}</option>
              <option v-for="s in sessions" :key="s.id" :value="s.id">{{ sessionDisplayName(s) }}</option>
            </select>
            <span v-if="errors.sessionId" class="field-error">{{ errors.sessionId }}</span>
          </label>
        </template>

        <div class="field">
          <span class="field-label">{{ $t('schedule.when') }}</span>
          <div class="segmented sd-types" role="radiogroup" :aria-label="$t('schedule.when')">
            <button
              v-for="type in SPEC_TYPES"
              :key="type"
              type="button"
              role="radio"
              :aria-checked="form.specType === type"
              :class="{ on: form.specType === type }"
              :data-testid="`spec-${type}`"
              @click="form.specType = type"
            >
              {{ $t(`schedule.type_${type}`) }}
            </button>
          </div>
        </div>

        <div class="sd-spec">
          <label v-if="form.specType === 'once'" class="field">
            <span class="field-label">{{ $t('schedule.onceAt') }}</span>
            <input
              v-model="form.onceAt"
              type="datetime-local"
              class="input"
              :class="{ invalid: errors.onceAt }"
              data-testid="spec-once-at"
            />
            <span v-if="errors.onceAt" class="field-error">{{ errors.onceAt }}</span>
          </label>

          <label v-else-if="form.specType === 'interval'" class="field">
            <span class="field-label">{{ $t('schedule.every') }}</span>
            <span class="sd-inline">
              <input
                v-model.number="form.minutes"
                type="number"
                class="input sd-num"
                :class="{ invalid: errors.minutes }"
                :min="MIN_INTERVAL"
                step="5"
                data-testid="spec-minutes"
              />
              <span class="sd-unit">{{ $t('schedule.minutes') }}</span>
            </span>
            <span v-if="errors.minutes" class="field-error">{{ errors.minutes }}</span>
          </label>

          <template v-else-if="form.specType === 'daily' || form.specType === 'weekly'">
            <div v-if="form.specType === 'weekly'" class="field">
              <span class="field-label">{{ $t('schedule.days') }}</span>
              <span class="sd-days" role="group" :aria-label="$t('schedule.days')">
                <button
                  v-for="d in WEEK"
                  :key="d"
                  type="button"
                  class="sd-day"
                  :class="{ on: form.days.includes(d) }"
                  :aria-pressed="form.days.includes(d)"
                  :data-testid="`day-${d}`"
                  @click="toggleDay(d)"
                >
                  {{ dayNames[d] }}
                </button>
              </span>
              <span v-if="errors.days" class="field-error">{{ errors.days }}</span>
            </div>
            <label class="field">
              <span class="field-label">{{ $t('schedule.time') }}</span>
              <input
                v-model="form.time"
                type="time"
                class="input sd-time"
                :class="{ invalid: errors.time }"
                data-testid="spec-time"
              />
              <span v-if="errors.time" class="field-error">{{ errors.time }}</span>
            </label>
          </template>

          <label v-else class="field">
            <span class="field-label">{{ $t('schedule.cron') }}</span>
            <input
              v-model="form.cron"
              class="input sd-mono"
              :class="{ invalid: errors.cron }"
              spellcheck="false"
              placeholder="0 9 * * 1-5"
              data-testid="spec-cron"
            />
            <span v-if="errors.cron" class="field-error">{{ errors.cron }}</span>
            <span v-else class="field-hint">{{ $t('schedule.cronHint') }}</span>
          </label>

          <label class="field">
            <span class="field-label">{{ $t('schedule.timezone') }}</span>
            <select v-model="form.timezone" class="select" :class="{ invalid: errors.timezone }">
              <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
            </select>
            <span v-if="errors.timezone" class="field-error">{{ errors.timezone }}</span>
          </label>
        </div>

        <div class="sd-enable">
          <UiSwitch v-model="form.enabled" :label="$t('schedule.enabled')" />
          <span>{{ $t('schedule.enabledLabel') }}</span>
        </div>
      </div>

      <aside class="sd-preview" aria-live="polite" data-testid="schedule-preview">
        <div class="sd-pv-title">{{ $t('schedule.preview') }}</div>
        <div v-if="description" class="sd-pv-desc">{{ description }}</div>
        <p v-if="previewState === 'invalid'" class="sd-pv-muted">{{ $t('schedule.previewInvalid') }}</p>
        <p v-else-if="previewState === 'error'" class="sd-pv-err">{{ previewError }}</p>
        <p v-else-if="previewState === 'loading' && !preview.length" class="sd-pv-muted">
          {{ $t('schedule.previewLoading') }}
        </p>
        <p v-else-if="!preview.length" class="sd-pv-muted">{{ $t('schedule.previewNone') }}</p>
        <ol v-else class="sd-pv-list" :class="{ stale: previewState === 'loading' }">
          <li v-for="(ms, i) in preview" :key="ms" data-testid="preview-item">
            <span class="sd-pv-i">{{ i + 1 }}</span
            >{{ formatWhen(ms, form.timezone) }}
          </li>
        </ol>
        <p class="sd-pv-tz">{{ $t('schedule.previewTz', [form.timezone]) }}</p>
      </aside>
    </form>
    <template #footer>
      <span v-if="serverError" class="sd-server-err" role="alert">{{ serverError }}</span>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('schedule.cancel') }}</button>
      <button type="button" class="kbtn primary" :disabled="saving" data-testid="schedule-save" @click="save">
        {{ saving ? $t('schedule.saving') : $t('schedule.save') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.sd {
  display: grid;
  grid-template-columns: 1fr 248px;
  gap: 20px;
}
.sd-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.sd-types {
  flex-wrap: wrap;
  align-self: flex-start;
}
.segmented {
  align-self: flex-start;
}
.sd-spec {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 14px;
  align-items: start;
}
.sd-spec > .field:has(.sd-days) {
  grid-column: 1 / -1;
}
.sd-inline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sd-num {
  width: 110px;
}
.sd-unit {
  font-size: 13px;
  color: var(--text-secondary);
}
.sd-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.sd-days {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sd-day {
  min-width: 36px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
}
.sd-day.on {
  background: var(--text);
  border-color: var(--text);
  color: var(--on-strong);
  font-weight: 600;
}
.sd-enable {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-secondary);
}
.sd-preview {
  align-self: start;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface-soft);
  border: 1px solid var(--line);
}
.sd-pv-title {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
}
.sd-pv-desc {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.sd-pv-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.sd-pv-list.stale {
  opacity: 0.55;
}
.sd-pv-list li {
  display: flex;
  align-items: center;
  gap: 9px;
}
.sd-pv-i {
  width: 18px;
  height: 18px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  font-size: 10.5px;
  color: var(--text-secondary);
}
.sd-pv-muted,
.sd-pv-err {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
  line-height: 1.6;
}
.sd-pv-err {
  color: var(--danger-text);
}
.sd-pv-tz {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.sd-server-err {
  margin-right: auto;
  align-self: center;
  font-size: 12.5px;
  color: var(--danger-text);
}
@media (max-width: 760px) {
  .sd {
    grid-template-columns: 1fr;
  }
}
</style>
