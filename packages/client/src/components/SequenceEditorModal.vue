<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import * as api from '../api'
import UiModal from './ui/UiModal.vue'
import UiSwitch from './ui/UiSwitch.vue'
import { t } from '../i18n'
import { errorText, toast } from '../stores/ui'

/**
 * 新建 / 编辑开发信序列：名称、发信邮箱、步骤（隔几天、主题、正文，可用变量）；
 * 高级项默认收起：发送时段（对方当地时间）、跳过周末、同公司回信也停、附退订说明、每日上限、自动发送。
 */
const props = defineProps<{ sequence?: api.Sequence | null; accounts: api.EmailAccount[] }>()
const emit = defineEmits<{ close: []; saved: [sequence: api.Sequence] }>()

const editing = computed(() => Boolean(props.sequence))
/* 模板变量含花括号和竖线，不能放进 i18n 文案（vue-i18n 会当插值 / 复数解析），作为参数传入 */
const VARS = '{{firstName|there}}  {{name}}  {{company}}  {{country}}  {{senderName}}'
const DEFAULT_BODY_1 = 'Hi {{firstName|there}},\n\n\n\nBest regards,\n{{senderName}}'
const DEFAULT_BODY_2 = 'Hi {{firstName|there}},\n\nJust following up on my last email.\n\nBest regards,\n{{senderName}}'
const s = props.sequence
const form = reactive<api.SequenceInput>({
  name: s?.name ?? '',
  accountId: s?.accountId ?? props.accounts[0]?.id,
  steps: s?.steps.map((step) => ({ ...step })) ?? [
    { delayDays: 0, subject: '', body: DEFAULT_BODY_1 },
    { delayDays: 3, subject: '', body: DEFAULT_BODY_2 },
  ],
  windowStart: s?.windowStart ?? 9,
  windowEnd: s?.windowEnd ?? 17,
  skipWeekends: s?.skipWeekends ?? true,
  stopOnCompanyReply: s?.stopOnCompanyReply ?? true,
  includeOptout: s?.includeOptout ?? true,
  autoSend: s?.autoSend ?? false,
  dailyLimit: s?.dailyLimit ?? 50,
})
const advanced = ref(false)
const switches = computed(() => [
  { key: 'skipWeekends' as const, label: t('seq.skipWeekends') },
  { key: 'stopOnCompanyReply' as const, label: t('seq.stopCompany') },
  { key: 'includeOptout' as const, label: t('seq.optout') },
  { key: 'autoSend' as const, label: t('seq.autoSend') },
])
const saving = ref(false)
const error = ref('')

function addStep(): void {
  const last = form.steps[form.steps.length - 1]
  form.steps.push({
    delayDays: 4,
    subject: last?.subject ? `Re: ${last.subject.replace(/^re:\s*/i, '')}` : '',
    body: '',
  })
}
function removeStep(index: number): void {
  form.steps.splice(index, 1)
}

const invalid = computed(() => {
  if (!form.name.trim()) return t('seq.errName')
  if (!form.accountId) return t('seq.errAccount')
  if (form.steps.some((step) => !step.subject.trim() || !step.body.trim())) return t('seq.errStep')
  const ws = form.windowStart as unknown,
    we = form.windowEnd as unknown
  if (
    !Number.isInteger(ws) ||
    !Number.isInteger(we) ||
    (ws as number) < 0 ||
    (we as number) > 24 ||
    (ws as number) >= (we as number)
  )
    return t('seq.errWindow')
  const limit = form.dailyLimit as unknown
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) return t('seq.errLimit')
  return ''
})

async function save(): Promise<void> {
  if (invalid.value) {
    error.value = invalid.value
    return
  }
  saving.value = true
  error.value = ''
  try {
    const body = {
      ...form,
      name: form.name.trim(),
      steps: form.steps.map((step) => ({
        delayDays: Number(step.delayDays) || 0,
        subject: step.subject.trim(),
        body: step.body.trim(),
      })),
    }
    const saved = props.sequence ? await api.updateSequence(props.sequence.id, body) : await api.createSequence(body)
    toast.success(editing.value ? t('seq.saved') : t('seq.created'))
    emit('saved', saved)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiModal
    :title="editing ? $t('seq.editTitle') : $t('seq.newTitle')"
    :subtitle="$t('seq.editorSub')"
    :width="680"
    @close="emit('close')"
  >
    <div class="ed" data-testid="sequence-editor">
      <div class="row2">
        <label class="field">
          <span class="field-label">{{ $t('seq.name') }}</span>
          <input
            v-model="form.name"
            class="input"
            :placeholder="$t('seq.namePh')"
            maxlength="120"
            data-testid="seq-name"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('seq.from') }}</span>
          <select v-model="form.accountId" class="select">
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.email }}</option>
          </select>
        </label>
      </div>

      <div class="steps">
        <div v-for="(step, i) in form.steps" :key="i" class="step" data-testid="seq-step">
          <div class="step-head">
            <span class="step-no">{{ i + 1 }}</span>
            <span class="step-when">
              <template v-if="i === 0">{{ $t('seq.firstWhen') }}</template>
              <template v-else>{{ $t('seq.afterPrev') }}</template>
              <input
                v-model.number="step.delayDays"
                type="number"
                min="0"
                max="90"
                class="input days"
                :aria-label="$t('seq.days')"
              />
              {{ $t('seq.daysUnit') }}
            </span>
            <span class="sp"></span>
            <button v-if="form.steps.length > 1" type="button" class="link danger" @click="removeStep(i)">
              {{ $t('seq.removeStep') }}
            </button>
          </div>
          <input v-model="step.subject" class="input" :placeholder="$t('seq.subjectPh')" maxlength="500" />
          <textarea
            v-model="step.body"
            class="textarea body"
            rows="5"
            :placeholder="$t('seq.bodyPh')"
            maxlength="20000"
          ></textarea>
        </div>
        <button
          v-if="form.steps.length < 10"
          type="button"
          class="add-step"
          data-testid="seq-add-step"
          @click="addStep"
        >
          + {{ $t('seq.addStep') }}
        </button>
        <p class="field-hint">{{ $t('seq.varsHint', [VARS]) }}</p>
      </div>

      <button type="button" class="adv-toggle" :aria-expanded="advanced" @click="advanced = !advanced">
        <svg viewBox="0 0 24 24" :class="{ open: advanced }" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        {{ $t('seq.advanced') }}
      </button>
      <div v-if="advanced" class="adv">
        <div class="row2">
          <label class="field">
            <span class="field-label">{{ $t('seq.window') }}</span>
            <span class="win">
              <input
                v-model.number="form.windowStart"
                type="number"
                min="0"
                max="23"
                class="input"
                :aria-label="$t('seq.windowStart')"
              />
              <span>–</span>
              <input
                v-model.number="form.windowEnd"
                type="number"
                min="1"
                max="24"
                class="input"
                :aria-label="$t('seq.windowEnd')"
              />
              <span class="dim">{{ $t('seq.localTime') }}</span>
            </span>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('seq.dailyLimit') }}</span>
            <input v-model.number="form.dailyLimit" type="number" min="1" max="500" class="input" />
          </label>
        </div>
        <div v-for="sw in switches" :key="sw.key" class="sw-row">
          <span>{{ sw.label }}</span>
          <UiSwitch
            v-model="form[sw.key]"
            :label="sw.label"
            :data-testid="sw.key === 'autoSend' ? 'seq-autosend' : undefined"
          />
        </div>
        <p v-if="form.autoSend" class="warn">{{ $t('seq.autoSendWarn') }}</p>
      </div>

      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">{{ $t('seq.cancel') }}</button>
      <button type="button" class="btn dark" :disabled="saving" data-testid="seq-save" @click="save">
        {{ saving ? $t('seq.saving') : $t('seq.save') }}
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.ed {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.step-no {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: var(--text);
  color: var(--on-strong);
  flex: none;
}
.step-when {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.days {
  width: 64px;
  height: 28px;
  text-align: center;
}
.sp {
  flex: 1;
}
.body {
  min-height: 110px;
}
.add-step {
  height: 36px;
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s ease;
}
.add-step:hover {
  background: var(--surface-hover);
}
.adv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}
.adv-toggle svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  transition: transform 0.2s ease;
}
.adv-toggle svg.open {
  transform: rotate(90deg);
}
.adv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: adv-in 0.2s ease;
}
@keyframes adv-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.win {
  display: flex;
  align-items: center;
  gap: 6px;
}
.win .input {
  width: 64px;
  text-align: center;
}
.dim {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
.sw-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.warn {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--danger-text);
  background: var(--danger-soft);
}
.link.danger {
  border: 0;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--danger-text);
  cursor: pointer;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.55;
}
</style>
