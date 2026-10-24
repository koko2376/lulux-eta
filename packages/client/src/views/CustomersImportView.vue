<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import PermNote from '../components/ui/PermNote.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { STAGE_LABEL } from '../lib/labels'
import * as api from '../api'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import {
  IMPORT_FIELDS,
  MAX_ROWS,
  buildPreview,
  guessMapping,
  parseCsv,
  parseXlsx,
  readText,
  rowsForImport,
  type ParsedSheet,
} from '../lib/import'
import { errorText, toast } from '../stores/ui'
import { t } from '../i18n'

const MAX_BYTES = 10 * 1024 * 1024
const step = ref<1 | 2 | 3>(1)
const fileName = ref('')
const parsing = ref(false)
const parseError = ref('')
const sheet = ref<ParsedSheet>({ headers: [], rows: [] })
const mapping = ref<Partial<Record<api.ImportField, string>>>({})
const dedupeBy = ref<api.ImportRequest['dedupeBy']>('email')
const onDuplicate = ref<api.ImportRequest['onDuplicate']>('skip')
const importing = ref(false)
const result = ref<api.ImportResult | null>(null)
const dragging = ref(false)
const input = ref<HTMLInputElement | null>(null)

async function handleFile(file: File | undefined): Promise<void> {
  if (!file) return
  parseError.value = ''
  if (file.size > MAX_BYTES) return void (parseError.value = t('customersImport.ktezp46'))
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!['csv', 'txt', 'xlsx', 'xls'].includes(ext ?? '')) return void (parseError.value = t('customersImport.k1rynq0k'))
  parsing.value = true
  try {
    const parsed =
      ext === 'xlsx' || ext === 'xls' ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await readText(file))
    if (!parsed.headers.length || !parsed.rows.length) throw new Error(t('customersImport.k1cc7727'))
    if (parsed.rows.length > MAX_ROWS) throw new Error(t('customersImport.k1066siv', [MAX_ROWS, parsed.rows.length]))
    sheet.value = parsed
    fileName.value = file.name
    mapping.value = guessMapping(parsed.headers)
    dedupeBy.value = mapping.value.contactEmail ? 'email' : mapping.value.website ? 'website' : 'company'
    result.value = null
    step.value = 2
  } catch (error) {
    parseError.value = errorText(error)
  } finally {
    parsing.value = false
  }
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement
  void handleFile(target.files?.[0])
  target.value = ''
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  void handleFile(event.dataTransfer?.files?.[0])
}

const preview = computed(() => buildPreview(sheet.value.rows, mapping.value, dedupeBy.value))
const sample = (col?: string) =>
  col
    ? sheet.value.rows
        .slice(0, 3)
        .map((r) => r[col])
        .filter(Boolean)
        .join(' / ')
    : ''
const dedupeAvailable = computed(() => ({
  email: Boolean(mapping.value.contactEmail),
  company: Boolean(mapping.value.company),
  website: Boolean(mapping.value.website),
}))
watch(dedupeAvailable, (a) => {
  if (!a[dedupeBy.value]) dedupeBy.value = a.email ? 'email' : a.website ? 'website' : 'company'
})

const toImport = computed(() => rowsForImport(sheet.value.rows, preview.value, mapping.value, onDuplicate.value))

async function runImport(): Promise<void> {
  if (!mapping.value.company) return void toast.error(t('customersImport.k1ybiuig'))
  if (!toImport.value.length) return void toast.error(t('customersImport.ki9mi09'))
  importing.value = true
  try {
    result.value = await api.importCustomers({
      rows: toImport.value,
      mapping: mapping.value,
      dedupeBy: dedupeBy.value,
      onDuplicate: onDuplicate.value,
    })
    step.value = 3
  } finally {
    importing.value = false
  }
}

function reset(): void {
  step.value = 1
  sheet.value = { headers: [], rows: [] }
  mapping.value = {}
  result.value = null
  fileName.value = ''
}
/* 侧栏（客户侧栏）：搜索 → 客户列表、按阶段计数 */
const router = useRouter()
const sideQ = ref('')
function sideSearch(): void {
  const q = sideQ.value.trim()
  void router.push(q ? { path: '/customers', query: { q } } : '/customers')
}
const stageCounts = ref<Partial<Record<api.Stage, number>>>({})
const allTotal = ref<number | null>(null)
onMounted(async () => {
  try {
    const s = await api.getWorkbenchSummary()
    stageCounts.value = s.customers.byStage
    allTotal.value = s.customers.total
  } catch {
    allTotal.value = null
  }
})
const stepDesc = computed(() => [
  fileName.value ? t('importx.fileRows', [fileName.value, sheet.value.rows.length]) : t('importx.d1'),
  step.value > 2 ? t('importx.d2done') : t('importx.d2'),
  result.value ? t('importx.d3done') : t('importx.d3'),
])

const STATUS_TEXT = {
  new: t('customersImport.k1ncjoxn'),
  'duplicate-in-file': t('customersImport.kd7aazb'),
  invalid: t('customersImport.k1thf9y6'),
} as const
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('customers.k1v5iwp2')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('customers.k1v5iwp2') }}</h2>
        <RouterLink v-perm:hide="'data:write'" class="link" to="/customers?new=1">{{
          $t('customers.k3ke49o')
        }}</RouterLink>
      </div>
      <form class="side-search" role="search" @submit.prevent="sideSearch">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <input
          v-model="sideQ"
          type="search"
          :placeholder="$t('customers.kf31amz')"
          :aria-label="$t('wbx.sideSearchAria')"
          spellcheck="false"
        />
      </form>
      <nav class="side-body">
        <RouterLink class="nav-row" to="/customers"
          >{{ $t('customers.k1jk3qup') }}<span v-if="allTotal !== null" class="count">{{ allTotal }}</span></RouterLink
        >
        <div class="side-label">{{ $t('customers.kl9iz6y') }}</div>
        <RouterLink
          v-for="st in api.STAGES"
          :key="st"
          class="nav-row sub"
          :to="{ path: '/customers', query: { stage: st } }"
          >{{ STAGE_LABEL[st] }}<span class="count">{{ stageCounts[st] ?? 0 }}</span></RouterLink
        >
        <div class="side-label">{{ $t('workbench.kw66xb5') }}</div>
        <RouterLink class="nav-row on" to="/customers/import">{{ $t('customersImport.kmozngi') }}</RouterLink>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('customersImport.kmozngi')" :sub="$t('customersImport.k1bqjcvc')" />
    <div class="doc">
      <div class="doc-inner">
        <RouterLink class="back" to="/customers">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
          {{ $t('customersImport.kf87lgq') }}
        </RouterLink>
        <PermNote perm="data:write" />
        <ol class="steps" :aria-label="$t('customersImport.k15qg489')">
          <template
            v-for="(label, i) in [
              $t('customersImport.k1w8ditv'),
              $t('customersImport.k129dqlw'),
              $t('customersImport.kxh424y'),
            ]"
            :key="i"
          >
            <li v-if="i > 0" class="step-line" aria-hidden="true"></li>
            <li
              class="step"
              :class="{ on: step === i + 1 && !(i === 2 && result), done: step > i + 1 || (i === 2 && !!result) }"
              :aria-current="step === i + 1 ? 'step' : undefined"
            >
              <span class="n">
                <svg v-if="step > i + 1 || (i === 2 && result)" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6 12.5 4 4 8-8.5" />
                </svg>
                <template v-else>{{ i + 1 }}</template>
              </span>
              <span>
                <span class="t">{{ label.replace(/^\d+[.、]?\s*/, '') }}</span>
                <span class="d">{{ stepDesc[i] }}</span>
              </span>
            </li>
          </template>
        </ol>

        <section v-if="step === 1" class="panel">
          <div
            class="drop"
            :class="{ over: dragging }"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <StateBlock v-if="parsing" state="loading" :title="$t('customersImport.k14du0ky')" compact />
            <template v-else>
              <p class="drop-t">{{ $t('customersImport.kx3kboy') }}</p>
              <p class="drop-d">{{ $t('customersImport.k7u0bcj', [MAX_ROWS]) }}</p>
              <button type="button" class="kbtn primary" @click="input?.click()">
                {{ $t('customersImport.kg76lpm') }}
              </button>
              <input
                ref="input"
                type="file"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
                accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                @change="onPick"
              />
            </template>
            <p v-if="parseError" class="field-error" role="alert">{{ parseError }}</p>
          </div>
        </section>

        <template v-else-if="step === 2">
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('customersImport.k1jyh20f') }}</h2>
                <div class="panel-sub">
                  {{ $t('customersImport.klq1dpa', [fileName, sheet.rows.length, sheet.headers.length]) }}
                </div>
              </div>
              <button type="button" class="kbtn" @click="reset">{{ $t('customersImport.kof6bvk') }}</button>
            </div>
            <div class="map-grid">
              <label v-for="f in IMPORT_FIELDS" :key="f.key" class="field">
                <span class="field-label">{{ f.label }}<b v-if="f.required" class="req"> *</b></span>
                <select v-model="mapping[f.key]" class="select">
                  <option :value="undefined">{{ $t('customersImport.k9cjn4d') }}</option>
                  <option v-for="h in sheet.headers" :key="h" :value="h">{{ h }}</option>
                </select>
                <span class="field-hint sample" :title="sample(mapping[f.key])">{{
                  sample(mapping[f.key]) || ' '
                }}</span>
              </label>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('customersImport.kdqbey8') }}</h2>
                <div class="panel-sub">{{ $t('customersImport.k1r198dc') }}</div>
              </div>
            </div>
            <div class="panel-body form-grid">
              <label class="field">
                <span class="field-label">{{ $t('customersImport.kct1doy') }}</span>
                <select v-model="dedupeBy" class="select">
                  <option value="email" :disabled="!dedupeAvailable.email">{{ $t('customersImport.kg7ejoe') }}</option>
                  <option value="company" :disabled="!dedupeAvailable.company">
                    {{ $t('customersImport.k159zy9b') }}
                  </option>
                  <option value="website" :disabled="!dedupeAvailable.website">
                    {{ $t('customersImport.k1cw9m93') }}
                  </option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">{{ $t('customersImport.kc6pp9p') }}</span>
                <select v-model="onDuplicate" class="select">
                  <option value="skip">{{ $t('customersImport.k1lh9cmg') }}</option>
                  <option value="merge">{{ $t('customersImport.k1bwczjv') }}</option>
                </select>
              </label>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('customersImport.k1ppb1qm') }}</h2>
                <div class="panel-sub">
                  {{ $t('customersImport.k1ncjoxn') }} <b>{{ preview.valid }}</b> {{ $t('customersImport.k4yluap') }}
                  <b>{{ preview.duplicatesInFile }}</b> {{ $t('customersImport.k1uqpbjc') }}
                  <b :class="{ bad: preview.invalid }">{{ preview.invalid }}</b> {{ $t('customersImport.kbp803e') }}
                </div>
              </div>
              <button
                v-perm="['data:write', 'customer:import']"
                type="button"
                class="kbtn primary"
                :disabled="importing || !mapping.company || !toImport.length"
                @click="runImport"
              >
                {{ importing ? $t('customersImport.k1povjjz') : $t('customersImport.k1one6je', [toImport.length]) }}
              </button>
            </div>
            <p v-if="!mapping.company" class="note warn map-warn">{{ $t('customersImport.k1d39f6r') }}</p>
            <div class="preview-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>{{ $t('customersImport.kbp803e') }}</th>
                    <th>{{ $t('customersImport.krfzxye') }}</th>
                    <th>{{ $t('customersImport.kpxyqnh') }}</th>
                    <th>{{ $t('customersImport.k1vrnrvy') }}</th>
                    <th>{{ $t('customersImport.kanlbru') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in preview.rows.slice(0, 100)" :key="r.index">
                    <td class="num dim">{{ r.index + 2 }}</td>
                    <td>
                      <span
                        :class="r.status === 'new' ? 'badge-on' : r.status === 'invalid' ? 'badge-bad' : 'badge-off'"
                        >{{ STATUS_TEXT[r.status] }}</span
                      >
                    </td>
                    <td>{{ r.company || '—' }}</td>
                    <td class="dim code">{{ r.key || '—' }}</td>
                    <td class="dim">{{ r.reason || '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="preview.rows.length > 100" class="more">
              {{ $t('customersImport.kx0c32r', [preview.rows.length]) }}
            </p>
          </section>
        </template>

        <section v-else-if="result" class="panel">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('customersImport.kwoar18') }}</h2>
              <div class="panel-sub">{{ fileName }}</div>
            </div>
          </div>
          <div class="result">
            <div>
              <span>{{ $t('customersImport.k3ke49o') }}</span
              ><b>{{ result.created }}</b>
            </div>
            <div>
              <span>{{ $t('customersImport.k1rqpifk') }}</span
              ><b>{{ result.merged }}</b>
            </div>
            <div>
              <span>{{ $t('customersImport.kds2843') }}</span
              ><b>{{ result.skipped }}</b>
            </div>
            <div>
              <span>{{ $t('customersImport.kh9nt60') }}</span
              ><b :class="{ bad: result.errors.length }">{{ result.errors.length }}</b>
            </div>
          </div>
          <div v-if="result.errors.length" class="panel-body">
            <h3 class="err-h">{{ $t('customersImport.k1c3lzm') }}</h3>
            <ul class="errs">
              <li v-for="e in result.errors.slice(0, 50)" :key="e.row">
                {{ $t('customersImport.k9b17x2', [e.row, e.message]) }}
              </li>
            </ul>
          </div>
          <div class="panel-body hstack">
            <RouterLink class="kbtn primary" to="/customers">{{ $t('customersImport.kv1w26x') }}</RouterLink>
            <button type="button" class="kbtn" @click="reset">{{ $t('customersImport.kri746r') }}</button>
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 14px;
}
.back:hover {
  color: var(--text);
}
.back svg {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nav-row .count {
  margin-left: auto;
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
/* 步骤条（圆形序号 + 标题 + 说明，中间细线） */
.steps {
  display: flex;
  align-items: center;
  list-style: none;
  padding: 0;
  margin: 0 0 18px;
}
.step {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.step .n {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--surface-muted);
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 600;
}
.step .n svg {
  width: 12px;
  height: 12px;
  stroke: var(--on-strong);
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.step.done .n {
  background: var(--good);
}
.step.on .n {
  background: var(--text);
  color: var(--on-strong);
}
.step .t {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.step .d {
  display: block;
  font-size: 11.5px;
  color: var(--text-tertiary);
  margin-top: 1px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-line {
  flex: 1;
  height: 1px;
  min-width: 24px;
  background: var(--line-strong);
  margin: 0 16px;
}
.drop {
  margin: 16px;
  padding: 44px 20px;
  border: 1.5px dashed var(--line-strong);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.drop.over {
  border-color: var(--good);
  background: var(--good-soft);
}
.drop-t {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.drop-d {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.map-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 14px;
  padding: 16px 20px;
}
.req {
  color: var(--danger);
}
.sample {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-height: 18px;
}
.map-warn {
  margin: 12px 20px 0;
}
.preview-scroll {
  max-height: 420px;
  overflow: auto;
}
.more {
  margin: 0;
  padding: 10px 20px 14px;
  font-size: 12px;
  color: var(--text-secondary);
}
.bad {
  color: var(--danger);
}
.result {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}
.result div {
  padding: 18px 20px;
  border-left: 1px solid var(--surface-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.result div:first-child {
  border-left: 0;
}
.result span {
  font-size: 12px;
  color: var(--text-secondary);
}
.result b {
  font-size: 26px;
  font-weight: 600;
}
.err-h {
  margin: 0 0 8px;
  font-size: 13px;
}
.errs {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.8;
}
</style>
