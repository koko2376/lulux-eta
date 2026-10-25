<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import UiModal from './ui/UiModal.vue'
import StateBlock from './ui/StateBlock.vue'
import { t } from '../i18n'
import { downloadBlob } from '../lib/download'
import { errorText, toast } from '../stores/ui'

/**
 * 出货单证：编辑单证资料（发票号、收货人、唛头、港口、每行英文品名 / HS / 件数 / 毛净重 / 体积），
 * 实时显示缺项，资料齐了再下载商业发票、装箱单、原产地证申请草稿。发货人默认取报价模板，收起在“更多”里。
 */
const props = defineProps<{ orderId: string; canWrite: boolean }>()
const emit = defineEmits<{ close: [] }>()

const bundle = ref<api.DocBundle | null>(null)
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const downloading = ref<api.DocKind | ''>('')
const showShipper = ref(false)

type Form = Omit<api.DocInfo, 'updatedAt'>
const form = reactive<Form>({
  invoiceNo: '',
  invoiceDate: '',
  shipper: { name: '', address: '', contact: '' },
  consignee: { name: '', address: '', contact: '' },
  notifyParty: '',
  marks: '',
  origin: '',
  portOfLoading: '',
  portOfDischarge: '',
  vessel: '',
  packageUnit: '',
  lines: [],
})
let snapshot = ''

function fill(b: api.DocBundle): void {
  bundle.value = b
  const { updatedAt: _u, ...info } = b.info
  Object.assign(form, JSON.parse(JSON.stringify(info)))
  snapshot = JSON.stringify(form)
}
const dirty = computed(() => JSON.stringify(form) !== snapshot)

onMounted(async () => {
  try {
    fill(await api.getOrderDocs(props.orderId))
  } catch (e) {
    loadError.value = errorText(e)
  } finally {
    loading.value = false
  }
})

const lineView = (index: number) => bundle.value?.lines.find((l) => l.itemIndex === index)

/* 缺项按当前表单即时重算（与服务端规则一致），保存后以服务端为准 */
const issues = computed<api.DocIssue[]>(() => {
  if (!bundle.value) return []
  const out: api.DocIssue[] = []
  const push = (level: api.DocIssue['level'], field: string, code: string, params: Array<string | number> = []) =>
    out.push({ level, field, code, params, message: '' })
  if (!form.invoiceNo.trim()) push('error', 'invoiceNo', 'invoiceNo')
  if (!form.shipper.name.trim()) push('error', 'shipper.name', 'shipper')
  if (!form.consignee.name.trim()) push('error', 'consignee.name', 'consignee')
  if (form.consignee.address.trim().length < 12) push('warning', 'consignee.address', 'consigneeAddress')
  if (!form.portOfLoading.trim()) push('warning', 'portOfLoading', 'pol')
  if (!form.portOfDischarge.trim()) push('warning', 'portOfDischarge', 'pod')
  if (!form.origin.trim()) push('error', 'origin', 'origin')
  if (!form.vessel.trim()) push('warning', 'vessel', 'vessel')
  form.lines.forEach((line, i) => {
    const no = i + 1
    const digits = line.hsCode.replace(/\D/g, '')
    if (!digits) push('error', `lines.${i}.hsCode`, 'hsMissing', [no])
    else if (digits.length < 6) push('error', `lines.${i}.hsCode`, 'hsShort', [no])
    else if (digits.length !== 8 && digits.length !== 10)
      push('warning', `lines.${i}.hsCode`, 'hsDigits', [no, digits.length])
    if (!line.description.trim()) push('error', `lines.${i}.description`, 'description', [no])
    if (!(line.cartons > 0)) push('error', `lines.${i}.cartons`, 'cartons', [no])
    if (!(line.netKg > 0)) push('error', `lines.${i}.netKg`, 'netKg', [no])
    if (!(line.grossKg > 0)) push('error', `lines.${i}.grossKg`, 'grossKg', [no])
    if (line.grossKg > 0 && line.netKg > line.grossKg) push('error', `lines.${i}.grossKg`, 'grossLtNet', [no])
    if (!(line.cbm > 0)) push('warning', `lines.${i}.cbm`, 'cbm', [no])
    if (line.cartons > 0 && line.grossKg / line.cartons > 60) push('warning', `lines.${i}.grossKg`, 'heavyCarton', [no])
  })
  if (bundle.value.issues.some((i) => i.code === 'amountMismatch')) push('warning', 'amount', 'amountMismatch')
  return out
})
const errors = computed(() => issues.value.filter((i) => i.level === 'error'))
const warnings = computed(() => issues.value.filter((i) => i.level === 'warning'))
const bad = (field: string) => issues.value.some((i) => i.field === field && i.level === 'error')
const issueText = (i: api.DocIssue) => t(`docs.iss_${i.code}`, i.params)

const totals = computed(() =>
  form.lines.reduce(
    (acc, l) => ({
      cartons: acc.cartons + (Number(l.cartons) || 0),
      netKg: acc.netKg + (Number(l.netKg) || 0),
      grossKg: acc.grossKg + (Number(l.grossKg) || 0),
      cbm: acc.cbm + (Number(l.cbm) || 0),
    }),
    { cartons: 0, netKg: 0, grossKg: 0, cbm: 0 },
  ),
)
const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })

async function save(silent = false): Promise<boolean> {
  saving.value = true
  try {
    const { lines, ...rest } = form
    fill(
      await api.updateOrderDocs(props.orderId, {
        ...rest,
        lines: lines.map((l) => ({
          ...l,
          cartons: Math.max(0, Math.round(Number(l.cartons) || 0)),
          netKg: Number(l.netKg) || 0,
          grossKg: Number(l.grossKg) || 0,
          cbm: Number(l.cbm) || 0,
        })),
      }),
    )
    if (!silent) toast.success(t('docs.saved'))
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  } finally {
    saving.value = false
  }
}

async function download(kind: api.DocKind): Promise<void> {
  if (errors.value.length) return
  downloading.value = kind
  try {
    if (dirty.value && props.canWrite && !(await save(true))) return
    const blob = await api.orderDocPdf(props.orderId, kind)
    const prefix = { ci: 'CI', pl: 'PL', co: 'CO-draft' }[kind]
    downloadBlob(blob, `${prefix}-${form.invoiceNo.replace(/[\\/:*?"<>|\s]+/g, '_')}.pdf`)
  } catch (e) {
    toast.error(errorText(e))
  } finally {
    downloading.value = ''
  }
}

/* HS 建议 */
const hsFor = ref<number | null>(null)
const hsLoading = ref(false)
const hsResult = ref<{ candidates: api.HsCandidate[]; note: string; tariffError: string | null } | null>(null)
let hsSeq = 0
async function suggest(i: number): Promise<void> {
  if (hsFor.value === i) {
    hsFor.value = null
    return
  }
  hsFor.value = i
  hsResult.value = null
  hsLoading.value = true
  const seq = ++hsSeq
  try {
    const line = form.lines[i]!
    const result = await api.suggestHs(line.description || lineView(line.itemIndex)?.name || '')
    // 期间点了别的行：旧结果作废
    if (seq === hsSeq) hsResult.value = result
  } catch (e) {
    if (seq !== hsSeq) return
    toast.error(errorText(e))
    hsFor.value = null
  } finally {
    if (seq === hsSeq) hsLoading.value = false
  }
}
function pick(i: number, c: api.HsCandidate): void {
  form.lines[i]!.hsCode = c.code
  hsFor.value = null
}
const SOURCE = computed(() => ({
  product: t('docs.srcProduct'),
  history: t('docs.srcHistory'),
  uk_tariff: t('docs.srcTariff'),
}))
</script>

<template>
  <UiModal
    :title="$t('docs.title')"
    :subtitle="bundle ? $t('docs.sub', [bundle.orderNumber, bundle.incoterm, bundle.currency]) : ''"
    :width="980"
    @close="emit('close')"
  >
    <StateBlock v-if="loading" state="loading" />
    <StateBlock v-else-if="loadError" state="error" :message="loadError" />
    <div v-else-if="bundle" class="docs" data-testid="docs-modal">
      <div
        v-if="errors.length || warnings.length"
        class="issues"
        :class="{ err: errors.length }"
        role="status"
        data-testid="docs-issues"
      >
        <b>{{ errors.length ? $t('docs.notReady', [errors.length]) : $t('docs.readyWarn', [warnings.length]) }}</b>
        <span class="iss"
          >{{ [...errors, ...warnings].slice(0, 5).map(issueText).join('；')
          }}<template v-if="errors.length + warnings.length > 5"> …</template></span
        >
      </div>
      <div v-else class="issues ok" data-testid="docs-ready">
        <b>{{ $t('docs.ready') }}</b>
      </div>

      <div class="grid4">
        <label class="field">
          <span class="field-label">{{ $t('docs.invoiceNo') }}</span>
          <input
            v-model="form.invoiceNo"
            class="input"
            :class="{ invalid: bad('invoiceNo') }"
            maxlength="60"
            :disabled="!canWrite"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('docs.invoiceDate') }}</span>
          <input v-model="form.invoiceDate" type="date" class="input" :disabled="!canWrite" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('docs.origin') }}</span>
          <input
            v-model="form.origin"
            class="input"
            :class="{ invalid: bad('origin') }"
            maxlength="100"
            :disabled="!canWrite"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('docs.packageUnit') }}</span>
          <input v-model="form.packageUnit" class="input" maxlength="20" :disabled="!canWrite" />
        </label>
      </div>

      <div class="grid2">
        <fieldset class="box">
          <legend>{{ $t('docs.consignee') }}</legend>
          <input
            v-model="form.consignee.name"
            class="input"
            :class="{ invalid: bad('consignee.name') }"
            :placeholder="$t('docs.companyPh')"
            maxlength="300"
            :disabled="!canWrite"
          />
          <textarea
            v-model="form.consignee.address"
            class="textarea"
            rows="2"
            :placeholder="$t('docs.addressPh')"
            maxlength="1000"
            :disabled="!canWrite"
            data-testid="consignee-address"
          ></textarea>
          <input
            v-model="form.consignee.contact"
            class="input"
            :placeholder="$t('docs.contactPh')"
            maxlength="300"
            :disabled="!canWrite"
          />
          <label class="field">
            <span class="field-label">{{ $t('docs.notify') }}</span>
            <input v-model="form.notifyParty" class="input" maxlength="1000" :disabled="!canWrite" />
          </label>
        </fieldset>
        <fieldset class="box">
          <legend>{{ $t('docs.shipping') }}</legend>
          <div class="grid2 tight">
            <label class="field">
              <span class="field-label">{{ $t('docs.pol') }}</span>
              <input v-model="form.portOfLoading" class="input" maxlength="200" :disabled="!canWrite" />
            </label>
            <label class="field">
              <span class="field-label">{{ $t('docs.pod') }}</span>
              <input v-model="form.portOfDischarge" class="input" maxlength="200" :disabled="!canWrite" />
            </label>
          </div>
          <label class="field">
            <span class="field-label">{{ $t('docs.vessel') }}</span>
            <input v-model="form.vessel" class="input" maxlength="200" :disabled="!canWrite" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('docs.marks') }}</span>
            <textarea
              v-model="form.marks"
              class="textarea mono"
              rows="2"
              maxlength="1000"
              :disabled="!canWrite"
            ></textarea>
          </label>
        </fieldset>
      </div>

      <button type="button" class="more" :aria-expanded="showShipper" @click="showShipper = !showShipper">
        <svg viewBox="0 0 24 24" :class="{ open: showShipper }" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        {{ $t('docs.shipper') }}<span class="dim"> · {{ form.shipper.name || $t('docs.shipperEmpty') }}</span>
      </button>
      <div v-if="showShipper" class="grid3 shipper">
        <input
          v-model="form.shipper.name"
          class="input"
          :class="{ invalid: bad('shipper.name') }"
          :placeholder="$t('docs.companyPh')"
          maxlength="300"
          :disabled="!canWrite"
        />
        <input
          v-model="form.shipper.address"
          class="input"
          :placeholder="$t('docs.addressPh')"
          maxlength="1000"
          :disabled="!canWrite"
        />
        <input
          v-model="form.shipper.contact"
          class="input"
          :placeholder="$t('docs.contactPh')"
          maxlength="300"
          :disabled="!canWrite"
        />
      </div>

      <div class="table-scroll-x">
        <table class="data-table lines" data-testid="docs-lines">
          <colgroup>
            <col style="width: 140px" />
            <col />
            <col style="width: 178px" />
            <col style="width: 76px" />
            <col style="width: 96px" />
            <col style="width: 96px" />
            <col style="width: 90px" />
          </colgroup>
          <thead>
            <tr>
              <th>{{ $t('docs.product') }}</th>
              <th>{{ $t('docs.description') }}</th>
              <th>{{ $t('docs.hs') }}</th>
              <th class="num">{{ $t('docs.cartons') }}</th>
              <th class="num">{{ $t('docs.netKg') }}</th>
              <th class="num">{{ $t('docs.grossKg') }}</th>
              <th class="num">{{ $t('docs.cbm') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(line, i) in form.lines" :key="line.itemIndex">
              <tr>
                <td>
                  <div class="prod ell" :title="lineView(line.itemIndex)?.name">
                    {{ lineView(line.itemIndex)?.name }}
                  </div>
                  <div class="dim">
                    {{ lineView(line.itemIndex)?.qty.toLocaleString('en-US') }} {{ lineView(line.itemIndex)?.unit }}
                  </div>
                </td>
                <td>
                  <input
                    v-model="line.description"
                    class="input sm"
                    :class="{ invalid: bad(`lines.${i}.description`) }"
                    maxlength="500"
                    :disabled="!canWrite"
                  />
                </td>
                <td>
                  <div class="hs">
                    <input
                      v-model="line.hsCode"
                      class="input sm mono"
                      :class="{ invalid: bad(`lines.${i}.hsCode`) }"
                      maxlength="20"
                      inputmode="numeric"
                      :disabled="!canWrite"
                      :data-testid="`hs-${i}`"
                    />
                    <button
                      v-if="canWrite"
                      type="button"
                      class="hs-btn"
                      :aria-expanded="hsFor === i"
                      :title="$t('docs.suggest')"
                      :data-testid="`hs-suggest-${i}`"
                      @click="suggest(i)"
                    >
                      {{ $t('docs.suggestShort') }}
                    </button>
                  </div>
                </td>
                <td>
                  <input
                    v-model.number="line.cartons"
                    type="number"
                    min="0"
                    class="input sm num"
                    :class="{ invalid: bad(`lines.${i}.cartons`) }"
                    :disabled="!canWrite"
                  />
                </td>
                <td>
                  <input
                    v-model.number="line.netKg"
                    type="number"
                    min="0"
                    step="0.01"
                    class="input sm num"
                    :class="{ invalid: bad(`lines.${i}.netKg`) }"
                    :disabled="!canWrite"
                  />
                </td>
                <td>
                  <input
                    v-model.number="line.grossKg"
                    type="number"
                    min="0"
                    step="0.01"
                    class="input sm num"
                    :class="{ invalid: bad(`lines.${i}.grossKg`) }"
                    :disabled="!canWrite"
                  />
                </td>
                <td>
                  <input
                    v-model.number="line.cbm"
                    type="number"
                    min="0"
                    step="0.001"
                    class="input sm num"
                    :disabled="!canWrite"
                  />
                </td>
              </tr>
              <tr v-if="hsFor === i" class="hs-row">
                <td colspan="7">
                  <div class="hs-panel" data-testid="hs-panel">
                    <StateBlock v-if="hsLoading" state="loading" compact />
                    <template v-else-if="hsResult">
                      <p v-if="!hsResult.candidates.length" class="dim">{{ $t('docs.noSuggest') }}</p>
                      <button
                        v-for="c in hsResult.candidates"
                        :key="c.source + c.code"
                        type="button"
                        class="cand"
                        @click="pick(i, c)"
                      >
                        <span class="code mono">{{ c.code }}</span>
                        <span class="src" :class="c.source">{{ SOURCE[c.source] }}</span>
                        <span class="desc ell" :title="`${c.description} — ${c.detail}`">{{ c.description }}</span>
                      </button>
                      <p class="note">{{ $t('docs.hsNote') }}</p>
                    </template>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" class="tot-l">{{ $t('docs.total') }}</td>
              <td class="num tnum">{{ fmt(totals.cartons, 0) }}</td>
              <td class="num tnum">{{ fmt(totals.netKg) }}</td>
              <td class="num tnum">{{ fmt(totals.grossKg) }}</td>
              <td class="num tnum">{{ fmt(totals.cbm, 3) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="field-hint">{{ $t('docs.hint') }}</p>
    </div>
    <template #footer>
      <div class="foot">
        <button
          v-if="canWrite"
          type="button"
          class="btn"
          :disabled="saving || !dirty"
          data-testid="docs-save"
          @click="save()"
        >
          {{ saving ? $t('docs.saving') : $t('docs.save') }}
        </button>
        <span class="sp"></span>
        <button
          v-for="k in api.DOC_KINDS"
          :key="k"
          type="button"
          class="btn"
          :class="{ dark: k === 'ci' }"
          :disabled="!!errors.length || !!downloading"
          :title="errors.length ? $t('docs.fixFirst') : ''"
          :data-testid="`docs-dl-${k}`"
          @click="download(k)"
        >
          {{ downloading === k ? $t('docs.generating') : $t(`docs.dl_${k}`) }}
        </button>
      </div>
    </template>
  </UiModal>
</template>

<style scoped>
.docs {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.issues {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  background: rgba(240, 180, 103, 0.14);
  color: var(--docs-amber);
}
.issues.err {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.issues.ok {
  background: var(--good-soft);
  color: var(--good);
}
.issues b {
  flex: none;
  font-weight: 600;
}
.iss {
  min-width: 0;
}
.grid4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.grid2.tight {
  gap: 8px;
}
.box {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.box legend {
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
}
.more {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.more svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  transition: transform 0.2s ease;
}
.more svg.open {
  transform: rotate(90deg);
}
.dim {
  color: var(--text-tertiary);
  font-size: 12px;
}
.shipper {
  animation: in 0.2s ease;
}
@keyframes in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.lines td {
  vertical-align: middle;
}
.input.sm {
  height: 30px;
  font-size: 12.5px;
  padding: 0 8px;
}
.input.num {
  text-align: right;
  padding: 0 6px;
  -moz-appearance: textfield;
}
.input.num::-webkit-outer-spin-button,
.input.num::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.hs .input {
  min-width: 0;
  flex: 1;
  letter-spacing: 0;
}
.num {
  text-align: right;
}
.prod {
  font-weight: 500;
  font-size: 13px;
}
.ell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hs {
  display: flex;
  gap: 4px;
}
.hs-btn {
  flex: none;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.hs-btn[aria-expanded='true'] {
  background: var(--text);
  color: var(--on-strong);
  border-color: var(--text);
}
.hs-row td {
  padding-top: 0;
}
.hs-panel {
  padding: 10px;
  border-radius: 10px;
  background: var(--surface-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: in 0.2s ease;
}
.cand {
  display: grid;
  grid-template-columns: 96px 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
}
.cand:hover {
  background: var(--surface-hover);
}
.src {
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-self: start;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.src.product,
.src.history {
  background: var(--good-soft);
  color: var(--good);
}
.note {
  margin: 4px 8px 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
.tot-l {
  font-weight: 600;
}
tfoot td {
  font-weight: 600;
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.sp {
  flex: 1;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
:global(:root) {
  --docs-amber: #a96512;
}
:global(:root[data-theme='dark']) {
  --docs-amber: #f0b467;
}
</style>
