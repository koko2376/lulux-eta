<script setup lang="ts">
import FieldError from '../components/ui/FieldError.vue'
import { useFieldErrors } from '../composables/useFieldErrors'
import PermNote from '../components/ui/PermNote.vue'
import { onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiModal from '../components/ui/UiModal.vue'
import UiSwitch from '../components/ui/UiSwitch.vue'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const FIELDS = {
  subject: t('settingsRules.k1sg85hw'),
  body: t('settingsRules.k18moclf'),
  from: t('settingsRules.kfosvh5'),
  domain: t('settingsRules.kw5ern2'),
} as const
const OPS = {
  contains: t('settingsRules.k1wz3dpz'),
  not_contains: t('settingsRules.k10a93pr'),
  regex: t('settingsRules.k1dswb1z'),
} as const
const ACTIONS = {
  inquiry: t('settingsRules.k1mf77ly'),
  spam: t('settingsRules.k1qon1jy'),
  review: t('settingsRules.kckz245'),
} as const

const rules = ref<api.InquiryRule[]>([])
const loading = ref(true)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    rules.value = (await api.listInquiryRules()).sort((a, b) => b.priority - a.priority)
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function toggle(rule: api.InquiryRule, enabled: boolean): Promise<void> {
  const updated = await api.updateInquiryRule(rule.id, { enabled })
  Object.assign(rule, updated ?? { enabled })
}

async function remove(rule: api.InquiryRule): Promise<void> {
  if (
    !(await confirmDialog({
      title: t('settingsRules.kgqhut0', [rule.name]),
      message: t('settingsRules.k1g0urjj'),
      confirmText: t('settingsRules.kfcqesv'),
      danger: true,
    }))
  )
    return
  await api.deleteInquiryRule(rule.id)
  toast.success(t('settingsRules.k1xqwrmq'))
  await load()
}

/* ── 表单 ── */
const showForm = ref(false)
const editing = ref<api.InquiryRule | null>(null)
const saving = ref(false)
const formError = ref('')
const blankCondition = (): api.InquiryCondition => ({ field: 'subject', op: 'contains', value: '' })
const form = reactive({
  name: '',
  enabled: true,
  action: 'inquiry' as api.InquiryRule['action'],
  priority: 10,
  conditions: [blankCondition()],
})

function openCreate(): void {
  editing.value = null
  Object.assign(form, { name: '', enabled: true, action: 'inquiry', priority: 10, conditions: [blankCondition()] })
  formError.value = ''
  showForm.value = true
}
function openEdit(rule: api.InquiryRule): void {
  editing.value = rule
  Object.assign(form, {
    name: rule.name,
    enabled: rule.enabled,
    action: rule.action,
    priority: rule.priority,
    conditions: rule.conditions.map((c) => ({ ...c })),
  })
  formError.value = ''
  showForm.value = true
}

const fe = useFieldErrors<'name'>('rule-form')
async function save(): Promise<void> {
  formError.value = ''
  fe.clear()
  if (!fe.require({ name: form.name }, () => t('settingsRules.kv34je0'))) return
  const conditions = form.conditions.filter((c) => c.value.trim())
  if (!conditions.length) return void (formError.value = t('settingsRules.k18cob28'))
  for (const c of conditions) {
    if (c.op === 'regex') {
      try {
        new RegExp(c.value)
      } catch {
        return void (formError.value = t('settingsRules.k9c9jqb', [c.value]))
      }
    }
  }
  const input = {
    name: form.name.trim(),
    enabled: form.enabled,
    action: form.action,
    priority: Number(form.priority) || 0,
    conditions,
  }
  saving.value = true
  try {
    if (editing.value) await api.updateInquiryRule(editing.value.id, input)
    else await api.createInquiryRule(input)
    showForm.value = false
    toast.success(t('settingsRules.k1o1q888'))
    await load()
  } catch (error) {
    formError.value = errorText(error)
  } finally {
    saving.value = false
  }
}

/* ── 测试器 ── */
const sample = reactive({ subject: '', body: '', from: '' })
const testing = ref(false)
const verdict = ref<{ verdict: string; matchedRuleId: string | null } | null>(null)
async function runTest(): Promise<void> {
  testing.value = true
  verdict.value = null
  try {
    verdict.value = await api.testInquiryRules({ ...sample })
  } finally {
    testing.value = false
  }
}
const ruleName = (id: string | null) => rules.value.find((r) => r.id === id)?.name ?? null
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsRules.k123t65u')" :sub="$t('settingsRules.ktl390p')">
      <button v-perm="'settings:write'" type="button" class="kbtn primary" @click="openCreate">
        {{ $t('settingsRules.k1t68tt5') }}
      </button>
    </PageTopbar>
    <div class="doc">
      <div class="doc-inner">
        <PermNote perm="settings:write" :text="$t('settingsRules.k101cq6')" />
        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsRules.k1twygko') }}</h2>
              <div class="panel-sub">{{ $t('settingsRules.kpwd9hn') }}</div>
            </div>
          </div>
          <StateBlock v-if="loading" state="loading" compact />
          <StateBlock v-else-if="loadError" state="error" :message="loadError" compact @retry="load" />
          <StateBlock
            v-else-if="!rules.length"
            state="empty"
            :title="$t('settingsRules.k1q3u8zi')"
            :message="$t('settingsRules.k6apz6w')"
            compact
          >
            <button v-perm="'settings:write'" type="button" class="kbtn primary" @click="openCreate">
              {{ $t('settingsRules.k1t68tt5') }}
            </button>
          </StateBlock>
          <div v-else>
            <div v-for="rule in rules" :key="rule.id" class="row-item">
              <div class="grow">
                <div class="t">
                  {{ rule.name }}
                  <span
                    :class="rule.action === 'spam' ? 'badge-bad' : rule.action === 'inquiry' ? 'badge-on' : 'badge-off'"
                    >{{ ACTIONS[rule.action] }}</span
                  >
                  <span class="badge-off">{{ $t('settingsRules.k1yo35nx', [rule.priority]) }}</span>
                </div>
                <div class="d">
                  <span v-for="(c, i) in rule.conditions" :key="i">
                    <template v-if="i > 0"> {{ $t('settingsRules.k33lpn1') }} </template
                    >{{ $t('settingsRules.condPrefix', [FIELDS[c.field], OPS[c.op].toLowerCase()])
                    }}<span class="code">{{ c.value }}</span
                    >{{ $t('settingsRules.condSuffix') }}
                  </span>
                </div>
              </div>
              <UiSwitch
                :model-value="rule.enabled"
                :label="$t('settingsRules.k15osxgw', [rule.name])"
                :disabled="!can('settings:write')"
                @update:model-value="toggle(rule, $event)"
              />
              <div class="panel-actions">
                <button v-perm="'settings:write'" type="button" class="kbtn sm" @click="openEdit(rule)">
                  {{ $t('settingsRules.k1alsnuo') }}
                </button>
                <button v-perm="'settings:write'" type="button" class="kbtn sm danger" @click="remove(rule)">
                  {{ $t('settingsRules.kfcqesv') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsRules.k10l5vy0') }}</h2>
              <div class="panel-sub">{{ $t('settingsRules.k1pq8ksk') }}</div>
            </div>
          </div>
          <form class="panel-body form-grid" @submit.prevent="runTest">
            <label class="field"
              ><span class="field-label">{{ $t('settingsRules.kfosvh5') }}</span
              ><input v-model="sample.from" class="input" placeholder="buyer@example.com"
            /></label>
            <label class="field span-2"
              ><span class="field-label">{{ $t('settingsRules.k1sg85hw') }}</span
              ><input v-model="sample.subject" class="input" placeholder="Request for quotation"
            /></label>
            <label class="field span-all"
              ><span class="field-label">{{ $t('settingsRules.k18moclf') }}</span
              ><textarea v-model="sample.body" class="textarea" rows="4"></textarea>
            </label>
            <div class="hstack span-all">
              <button
                type="submit"
                class="kbtn primary"
                :disabled="testing || (!sample.subject && !sample.body && !sample.from)"
              >
                {{ testing ? $t('settingsRules.k4hwuey') : $t('settingsRules.kflgp2p') }}
              </button>
              <span v-if="verdict" class="verdict" role="status">
                {{ $t('settingsRules.k1fjedn6')
                }}<b>{{ ACTIONS[verdict.verdict as keyof typeof ACTIONS] ?? verdict.verdict }}</b>
                <template v-if="ruleName(verdict.matchedRuleId)">{{
                  $t('settingsRules.kku6oik', [ruleName(verdict.matchedRuleId)])
                }}</template>
                <template v-else>{{ $t('settingsRules.k18hjz2q') }}</template>
              </span>
            </div>
          </form>
        </section>
      </div>
    </div>

    <UiModal
      v-if="showForm"
      :title="editing ? $t('settingsRules.k5eio81') : $t('settingsRules.k1t68tt5')"
      :width="640"
      @close="showForm = false"
    >
      <form id="rule-form" class="stack" novalidate @submit.prevent="save">
        <div class="form-grid">
          <label class="field span-2"
            ><span class="field-label">{{ $t('settingsRules.k7qqgy7') }}</span
            ><input
              v-model="form.name"
              class="input"
              :class="{ invalid: fe.errors.name }"
              data-field="name"
              maxlength="60"
              required
              @input="fe.clear('name')" />
            <FieldError :msg="fe.errors.name"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('settingsRules.kylb4a9') }}</span
            ><input v-model.number="form.priority" class="input" type="number" min="0" max="999"
          /></label>
          <label class="field"
            ><span class="field-label">{{ $t('settingsRules.kexkomt') }}</span>
            <select v-model="form.action" class="select">
              <option v-for="(label, key) in ACTIONS" :key="key" :value="key">{{ label }}</option>
            </select>
          </label>
        </div>
        <fieldset class="conds">
          <legend class="field-label">{{ $t('settingsRules.k1qr40x7') }}</legend>
          <div v-for="(c, i) in form.conditions" :key="i" class="cond">
            <select v-model="c.field" class="select" :aria-label="$t('settingsRules.kl3obau', [i + 1])">
              <option v-for="(label, key) in FIELDS" :key="key" :value="key">{{ label }}</option>
            </select>
            <select v-model="c.op" class="select" :aria-label="$t('settingsRules.kz3yha1', [i + 1])">
              <option v-for="(label, key) in OPS" :key="key" :value="key">{{ label }}</option>
            </select>
            <input
              v-model="c.value"
              class="input"
              :aria-label="$t('settingsRules.kdvlu4w', [i + 1])"
              :placeholder="$t('settingsRules.k1y3r839')"
            />
            <button
              type="button"
              class="kbtn sm ghost"
              :disabled="form.conditions.length === 1"
              :aria-label="$t('settingsRules.k4isuif', [i + 1])"
              @click="form.conditions.splice(i, 1)"
            >
              {{ $t('settingsRules.kfcqesv') }}
            </button>
          </div>
          <button type="button" class="kbtn sm" @click="form.conditions.push(blankCondition())">
            {{ $t('settingsRules.k1llkw3u') }}
          </button>
        </fieldset>
        <label class="check"><input v-model="form.enabled" type="checkbox" /> {{ $t('settingsRules.k1n2qbel') }}</label>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <button type="button" class="kbtn" @click="showForm = false">{{ $t('settingsRules.kldkknc') }}</button>
        <button type="submit" form="rule-form" class="kbtn primary" :disabled="saving">
          {{ saving ? $t('settingsRules.ksdjf4x') : $t('settingsRules.k1xlvxln') }}
        </button>
      </template>
    </UiModal>
  </main>
</template>

<style scoped>
.verdict {
  font-size: 13px;
}
.conds {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.cond {
  display: grid;
  grid-template-columns: 110px 110px 1fr auto;
  gap: 8px;
  width: 100%;
}
</style>
