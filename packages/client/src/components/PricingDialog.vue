<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import * as api from '../api'
import { formatMoney } from '../lib/quote'
import { errorText } from '../stores/ui'
import { useAppStore } from '../stores/app'
import { t } from '../i18n'
import UiModal from './ui/UiModal.vue'

/**
 * 报价单编辑器 → 按成本算价：填每行采购成本，选术语和毛利率，算出 EXW / FOB / CFR / CIF / DDP 价格，
 * 一键把单价填回报价单。和 Agent 的 quote_calculate 用同一个后端计算。
 */
const props = defineProps<{ items: api.QuoteItem[]; currency: string; incoterm: string; port: string }>()
const emit = defineEmits<{ close: []; apply: [payload: { unitPrices: number[]; incoterm: api.PricingIncoterm }] }>()
const store = useAppStore()

interface Row {
  name: string
  qty: number
  unit: string
  productId: string | null
  cost: number | null
  costCurrency: string
  cbm: number | null
}

const rows = ref<Row[]>(
  props.items.map((item) => ({
    name: item.name,
    qty: Number(item.qty) || 0,
    unit: item.unit || 'pcs',
    productId: item.productId ?? null,
    cost: null,
    costCurrency: 'CNY',
    cbm: null,
  })),
)

const form = reactive({
  incoterm: ((api.PRICING_INCOTERMS as string[]).includes(props.incoterm) ? props.incoterm : 'FOB') as api.PricingIncoterm,
  marginPct: Number(store.settings.defaultMarginPct ?? '15') || 15,
  exportFee: null as number | null,
  freightMode: 'manual' as 'manual' | 'table',
  freightAmount: null as number | null,
  freightCurrency: 'USD',
  freightPer: 'shipment' as 'shipment' | 'cbm',
  pol: '',
  pod: '',
  container: '' as '' | api.Container,
  insurancePct: null as number | null,
  dutyPct: null as number | null,
  vatPct: null as number | null,
  destinationFee: null as number | null,
  rebatePct: null as number | null,
})
const showMore = ref(false)
const needsFreight = computed(() => ['CFR', 'CIF', 'DDP'].includes(form.incoterm))
const isDdp = computed(() => form.incoterm === 'DDP')

const result = ref<api.PricingResult | null>(null)
const error = ref('')
const running = ref(false)
const shownLadder = computed(() => api.PRICING_INCOTERMS.slice(0, api.PRICING_INCOTERMS.indexOf(result.value?.incoterm ?? 'EXW') + 1))

watch(
  () => [rows.value, { ...form }],
  () => {
    result.value = null
  },
  { deep: true },
)

const canRun = computed(() => rows.value.length > 0 && rows.value.every((row) => row.qty > 0 && row.cost !== null && row.cost >= 0 && row.name.trim()))

function num(value: number | null | string): number | undefined {
  if (value === null || value === '' || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function buildRequest(): api.PricingRequest {
  const costs: NonNullable<api.PricingRequest['costs']> = {}
  const exportFee = num(form.exportFee)
  if (exportFee !== undefined) costs.exportPerShipment = exportFee
  if (needsFreight.value) {
    if (form.freightMode === 'manual') {
      const amount = num(form.freightAmount)
      if (amount !== undefined) costs.freight = { amount, currency: form.freightCurrency, per: form.freightPer }
    }
    if (form.pol.trim()) costs.pol = form.pol.trim()
    if (form.pod.trim()) costs.pod = form.pod.trim()
  }
  if (form.container) costs.container = form.container
  const insurance = num(form.insurancePct)
  if (insurance !== undefined) costs.insuranceRatePct = insurance
  if (isDdp.value) {
    const duty = num(form.dutyPct)
    const vat = num(form.vatPct)
    const dest = num(form.destinationFee)
    if (duty !== undefined) costs.dutyPct = duty
    if (vat !== undefined) costs.vatPct = vat
    if (dest !== undefined) costs.destinationPerShipment = dest
  }
  const rebate = num(form.rebatePct)
  if (rebate !== undefined) costs.exportRebatePct = rebate
  return {
    items: rows.value.map((row) => ({
      name: row.name.trim(),
      qty: row.qty,
      unit: row.unit,
      unitCost: row.cost ?? 0,
      costCurrency: row.costCurrency,
      ...(num(row.cbm) !== undefined ? { cbmPerUnit: num(row.cbm) } : {}),
    })),
    quoteCurrency: props.currency,
    incoterm: form.incoterm,
    pricing: { marginPct: num(form.marginPct) ?? 0 },
    costs,
  }
}

async function run(): Promise<void> {
  if (!canRun.value || running.value) return
  running.value = true
  error.value = ''
  try {
    result.value = await api.calculatePricing(buildRequest())
  } catch (err) {
    result.value = null
    error.value = errorText(err)
  } finally {
    running.value = false
  }
}

function apply(): void {
  if (!result.value) return
  emit('apply', { unitPrices: result.value.items.map((item) => item.unitPrice), incoterm: result.value.incoterm })
}

const money = (value: number) => formatMoney(value, props.currency)
function fxLabel(fx: api.FxRate): string {
  const source = fx.source === 'locked' || fx.source === 'manual' ? t('pricing.fxLocked') : fx.asOf ? t('pricing.fxAsOf', [fx.asOf]) : ''
  return `${fx.pair} ${fx.rate}${source ? ` · ${source}` : ''}`
}
</script>

<template>
  <UiModal :title="$t('pricing.title')" :subtitle="$t('pricing.sub', [currency])" :width="880" dismissible @close="emit('close')">
    <form id="pricing-form" class="pd" data-testid="pricing-dialog" @submit.prevent="run">
      <div class="pd-scroll" data-hscroll-ok>
        <table class="data-table pd-items">
          <thead>
            <tr>
              <th>{{ $t('pricing.item') }}</th>
              <th class="c-n">{{ $t('pricing.qty') }}</th>
              <th class="c-cost">{{ $t('pricing.cost') }}</th>
              <th class="c-cur">{{ $t('pricing.costCurrency') }}</th>
              <th class="c-n">{{ $t('pricing.cbm') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in rows" :key="i">
              <td class="name">{{ row.name || '—' }}</td>
              <td class="num dim">{{ row.qty }} {{ row.unit }}</td>
              <td>
                <input
                  v-model.number="row.cost"
                  class="input num-in"
                  type="number"
                  min="0"
                  step="any"
                  :aria-label="$t('pricing.costOf', [i + 1])"
                  :data-testid="`pricing-cost-${i}`"
                />
              </td>
              <td>
                <select v-model="row.costCurrency" class="select" :aria-label="$t('pricing.costCurrencyOf', [i + 1])">
                  <option v-for="c in api.CURRENCIES" :key="c">{{ c }}</option>
                </select>
              </td>
              <td>
                <input v-model.number="row.cbm" class="input num-in" type="number" min="0" step="any" :placeholder="$t('pricing.optional')" :aria-label="$t('pricing.cbmOf', [i + 1])" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pd-grid">
        <label class="field">
          <span class="field-label">{{ $t('pricing.incoterm') }}</span>
          <select v-model="form.incoterm" class="select" data-testid="pricing-incoterm">
            <option v-for="it in api.PRICING_INCOTERMS" :key="it" :value="it">{{ it }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ $t('pricing.margin') }}</span>
          <input v-model.number="form.marginPct" class="input" type="number" min="0" max="95" step="any" data-testid="pricing-margin" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('pricing.exportFee') }}</span>
          <input v-model.number="form.exportFee" class="input" type="number" min="0" step="any" :placeholder="$t('pricing.exportFeeHint')" />
        </label>
      </div>

      <div v-if="needsFreight" class="pd-freight">
        <div class="seg" role="radiogroup" :aria-label="$t('pricing.freight')">
          <button type="button" class="seg-btn" :class="{ on: form.freightMode === 'manual' }" :aria-pressed="form.freightMode === 'manual'" @click="form.freightMode = 'manual'">
            {{ $t('pricing.freightManual') }}
          </button>
          <button type="button" class="seg-btn" :class="{ on: form.freightMode === 'table' }" :aria-pressed="form.freightMode === 'table'" @click="form.freightMode = 'table'">
            {{ $t('pricing.freightTable') }}
          </button>
        </div>
        <div class="pd-grid">
          <template v-if="form.freightMode === 'manual'">
            <label class="field">
              <span class="field-label">{{ $t('pricing.freightAmount') }}</span>
              <input v-model.number="form.freightAmount" class="input" type="number" min="0" step="any" data-testid="pricing-freight" />
            </label>
            <label class="field">
              <span class="field-label">{{ $t('pricing.freightCurrency') }}</span>
              <select v-model="form.freightCurrency" class="select">
                <option v-for="c in api.CURRENCIES" :key="c">{{ c }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">{{ $t('pricing.freightPer') }}</span>
              <select v-model="form.freightPer" class="select">
                <option value="shipment">{{ $t('pricing.perShipment') }}</option>
                <option value="cbm">{{ $t('pricing.perCbm') }}</option>
              </select>
            </label>
          </template>
          <template v-else>
            <label class="field">
              <span class="field-label">{{ $t('pricing.pol') }}</span>
              <input v-model="form.pol" class="input" placeholder="Ningbo" />
            </label>
            <label class="field">
              <span class="field-label">{{ $t('pricing.pod') }}</span>
              <input v-model="form.pod" class="input" placeholder="Felixstowe" data-testid="pricing-pod" />
            </label>
            <label class="field">
              <span class="field-label">{{ $t('pricing.container') }}</span>
              <select v-model="form.container" class="select">
                <option value="">{{ $t('pricing.containerAuto') }}</option>
                <option v-for="c in api.CONTAINERS" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </template>
        </div>
      </div>

      <button type="button" class="more" :aria-expanded="showMore" @click="showMore = !showMore">
        {{ showMore ? $t('pricing.lessOptions') : $t('pricing.moreOptions') }}
      </button>
      <div v-if="showMore" class="pd-grid">
        <label class="field">
          <span class="field-label">{{ $t('pricing.rebate') }}</span>
          <input v-model.number="form.rebatePct" class="input" type="number" min="0" max="17" step="any" placeholder="13" />
        </label>
        <label class="field">
          <span class="field-label">{{ $t('pricing.insurance') }}</span>
          <input v-model.number="form.insurancePct" class="input" type="number" min="0" max="10" step="any" :placeholder="store.settings.defaultInsuranceRatePct || '0.11'" />
        </label>
        <template v-if="isDdp">
          <label class="field">
            <span class="field-label">{{ $t('pricing.duty') }}</span>
            <input v-model.number="form.dutyPct" class="input" type="number" min="0" step="any" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('pricing.vat') }}</span>
            <input v-model.number="form.vatPct" class="input" type="number" min="0" step="any" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('pricing.destination', [currency]) }}</span>
            <input v-model.number="form.destinationFee" class="input" type="number" min="0" step="any" />
          </label>
        </template>
      </div>

      <p v-if="error" class="pd-error" role="alert">{{ error }}</p>

      <div v-if="result" class="pd-result" data-testid="pricing-result">
        <div class="pd-scroll" data-hscroll-ok>
          <table class="data-table pd-out">
            <thead>
              <tr>
                <th>{{ $t('pricing.item') }}</th>
                <th v-for="lv in shownLadder" :key="lv" class="num" :class="{ hl: lv === result.incoterm }">{{ lv }}</th>
                <th class="num">{{ $t('pricing.marginCol') }}</th>
                <th class="num">{{ $t('pricing.amount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, i) in result.items" :key="i">
                <td class="name">{{ item.name }}</td>
                <td v-for="lv in shownLadder" :key="lv" class="num" :class="{ hl: lv === result.incoterm }">{{ money(item.ladder[lv] ?? 0) }}</td>
                <td class="num" :class="{ warn: item.marginPct < 5 }">{{ item.marginPct }}%</td>
                <td class="num">{{ money(item.amount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pd-sum">
          <span>{{ $t('pricing.totalRevenue') }} <b class="tnum">{{ money(result.totals.revenue) }}</b></span>
          <span>{{ $t('pricing.totalProfit') }} <b class="tnum">{{ money(result.totals.profit) }}</b> ({{ result.totals.marginPct }}%)</span>
          <span v-if="result.container">{{ $t('pricing.containerUsed', [result.container.count, result.container.type, result.container.cbmUsed, result.container.fillPct]) }}</span>
        </div>
        <div v-if="result.fx.length" class="pd-fx">{{ $t('pricing.fxUsed') }}{{ result.fx.map(fxLabel).join(' · ') }}</div>
        <ul v-if="result.warnings.length" class="pd-warn">
          <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="pd-note">{{ $t('pricing.privacyNote') }}</p>
      </div>
    </form>
    <template #footer>
      <button type="button" class="kbtn" @click="emit('close')">{{ $t('crm.cancel') }}</button>
      <button type="submit" form="pricing-form" class="kbtn" :disabled="!canRun || running" data-testid="pricing-run">
        {{ running ? $t('pricing.running') : $t('pricing.run') }}
      </button>
      <button type="button" class="kbtn primary" :disabled="!result" data-testid="pricing-apply" @click="apply">{{ $t('pricing.apply') }}</button>
    </template>
  </UiModal>
</template>

<style scoped>
.pd {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pd-scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.pd-items,
.pd-out {
  width: 100%;
  margin: 0;
}
.pd-items td,
.pd-out td {
  vertical-align: middle;
}
.name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-n {
  width: 110px;
}
.c-cost {
  width: 130px;
}
.c-cur {
  width: 96px;
}
.num-in {
  text-align: right;
}
.num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dim {
  color: var(--text-tertiary);
}
.pd-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.pd-freight {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.seg {
  display: inline-flex;
  align-self: flex-start;
  padding: 3px;
  border-radius: 999px;
  background: var(--surface-muted);
}
.seg-btn {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  padding: 5px 14px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}
.seg-btn.on {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 0 0 1px var(--line-strong), 0 1px 3px rgba(0, 0, 0, 0.12);
}
.more {
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12.5px;
  color: var(--info-text);
  cursor: pointer;
}
.pd-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--danger, #d64545);
  background: color-mix(in srgb, var(--danger, #d64545) 8%, transparent);
}
.pd-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: pd-in 0.22s ease;
}
@keyframes pd-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.hl {
  font-weight: 600;
  color: var(--text);
  background: color-mix(in srgb, var(--info-text) 9%, transparent);
}
.warn {
  color: var(--prs-amber, #a96512);
}
.pd-sum {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  font-size: 13px;
  color: var(--text-secondary);
}
.pd-sum b {
  color: var(--text);
}
.pd-fx,
.pd-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.pd-warn {
  margin: 0;
  padding: 10px 12px 10px 28px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--prs-amber, #a96512);
  background: color-mix(in srgb, var(--prs-amber, #a96512) 9%, transparent);
}
.tnum {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 720px) {
  .pd-grid {
    grid-template-columns: 1fr;
  }
}
</style>
