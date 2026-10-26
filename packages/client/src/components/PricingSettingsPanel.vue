<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import * as api from '../api'
import { parseCsv, parseXlsx } from '../lib/import'
import { can } from '../lib/session'
import { useAppStore } from '../stores/app'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/**
 * 设置 → 报价模板 → 汇率与运价：实时汇率（欧洲央行）、手动锁汇、默认毛利率、运价表。
 * 报价单里的“按成本算价”和 Agent 的 quote_calculate 都读这里。
 */
const store = useAppStore()
const writable = computed(() => can('settings:write'))
const dataWritable = computed(() => can('data:write'))

/* ── 汇率 ── */
const SYMBOLS = ['CNY', 'EUR', 'GBP', 'JPY', 'AUD']
const fx = ref<api.FxTable | null>(null)
const fxError = ref('')
const fxLoading = ref(true)
const refreshing = ref(false)

async function loadFx(): Promise<void> {
  fxLoading.value = true
  fxError.value = ''
  try {
    fx.value = await api.getFxRates('USD', SYMBOLS)
  } catch (error) {
    fxError.value = errorText(error)
  } finally {
    fxLoading.value = false
  }
}

async function refreshFx(): Promise<void> {
  refreshing.value = true
  try {
    const res = await api.refreshFx()
    if (res.stale) toast.error(t('pricingSettings.refreshFailed'))
    else toast.success(t('pricingSettings.refreshed'))
    await loadFx()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    refreshing.value = false
  }
}

function sourceLabel(rate: api.FxRate): string {
  if (rate.source === 'locked') return t('pricingSettings.srcLocked')
  if (rate.source === 'erapi') return 'open.er-api.com'
  return t('pricingSettings.srcEcb')
}

/* ── 锁汇 ── */
interface LockRow {
  from: string
  to: string
  rate: number | null
}
function parseLocks(raw: string | undefined): LockRow[] {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, number>
    return Object.entries(parsed).map(([pair, rate]) => {
      const [from, to] = pair.split('/')
      return { from: from ?? 'USD', to: to ?? 'CNY', rate }
    })
  } catch {
    return []
  }
}
const locks = ref<LockRow[]>(parseLocks(store.settings.fxLocks))
const lockSaving = ref(false)
const margin = ref<number>(Number(store.settings.defaultMarginPct ?? '15'))

function addLock(): void {
  locks.value.push({ from: 'USD', to: 'CNY', rate: null })
}

async function saveLocks(): Promise<void> {
  const out: Record<string, number> = {}
  for (const row of locks.value) {
    const from = row.from.trim().toUpperCase()
    const to = row.to.trim().toUpperCase()
    if (!row.rate || row.rate <= 0 || from === to) {
      toast.error(t('pricingSettings.lockInvalid'))
      return
    }
    out[`${from}/${to}`] = row.rate
  }
  const pct = Number(margin.value)
  if (!Number.isInteger(pct) || pct < 0 || pct > 95) {
    toast.error(t('pricingSettings.marginInvalid'))
    return
  }
  lockSaving.value = true
  try {
    await store.saveSettings({ fxLocks: JSON.stringify(out), defaultMarginPct: String(pct) })
    toast.success(t('pricingSettings.saved'))
    await loadFx()
  } catch {
    /* 全局 toast */
  } finally {
    lockSaving.value = false
  }
}

/* ── 运价表 ── */
const rates = ref<api.FreightRate[]>([])
const ratesLoading = ref(true)
const showAdd = ref(false)
const draft = reactive({
  pol: '',
  pod: '',
  container: '40HQ' as api.Container,
  price: null as number | null,
  currency: 'USD',
  carrier: '',
  validUntil: '',
})
const adding = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function loadRates(): Promise<void> {
  ratesLoading.value = true
  try {
    rates.value = await api.listFreightRates({ includeExpired: true })
  } catch {
    /* 全局 toast */
  } finally {
    ratesLoading.value = false
  }
}

/** 有效的排前面（按目的港、价格），已过期的沉底 */
const sortedRates = computed(() =>
  [...rates.value].sort(
    (a, b) => Number(expired(a)) - Number(expired(b)) || a.pod.localeCompare(b.pod) || a.price - b.price,
  ),
)

function expired(rate: api.FreightRate): boolean {
  if (!rate.validUntil) return false
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return rate.validUntil < iso
}

async function addRate(): Promise<void> {
  if (!draft.pod.trim() || typeof draft.price !== 'number' || !Number.isFinite(draft.price) || draft.price < 0) {
    toast.error(t('pricingSettings.rateInvalid'))
    return
  }
  adding.value = true
  try {
    await api.createFreightRate({
      pol: draft.pol.trim(),
      pod: draft.pod.trim(),
      container: draft.container,
      price: draft.price,
      currency: draft.currency,
      unit: draft.container === 'LCL' ? 'cbm' : 'container',
      carrier: draft.carrier.trim(),
      validUntil: draft.validUntil,
    })
    Object.assign(draft, { pod: '', price: null, carrier: '', validUntil: '' })
    showAdd.value = false
    await loadRates()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    adding.value = false
  }
}

async function removeRate(rate: api.FreightRate): Promise<void> {
  if (
    !(await confirmDialog({
      title: t('pricingSettings.deleteTitle'),
      message: t('pricingSettings.deleteMsg', [rate.pod, rate.container]),
      danger: true,
    }))
  )
    return
  try {
    await api.deleteFreightRate(rate.id)
    rates.value = rates.value.filter((item) => item.id !== rate.id)
  } catch (error) {
    toast.error(errorText(error))
  }
}

/** 表头同义词 → 运价字段（中英文都认） */
const HEADER_MAP: Array<[RegExp, string]> = [
  [/^(pol|起运港|装货港|port of loading)$/i, 'pol'],
  [/^(pod|目的港|卸货港|port of discharge|destination)$/i, 'pod'],
  [/^(country|目的国|国家)$/i, 'podCountry'],
  [/^(container|柜型|箱型|type)$/i, 'container'],
  [/^(price|rate|运费|价格|海运费|amount)$/i, 'price'],
  [/^(currency|币种|货币)$/i, 'currency'],
  [/^(unit|单位|计费单位)$/i, 'unit'],
  [/^(carrier|船公司|承运人)$/i, 'carrier'],
  [/^(valid ?from|生效日期|开始日期)$/i, 'validFrom'],
  [/^(valid ?until|valid ?to|有效期|截止日期|到期日)$/i, 'validUntil'],
  [/^(notes?|备注)$/i, 'notes'],
]

async function importFile(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const sheet = /\.xlsx?$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text())
    const mapping = new Map<string, string>()
    for (const header of sheet.headers) {
      const hit = HEADER_MAP.find(([re]) => re.test(header.trim()))
      if (hit) mapping.set(header, hit[1])
    }
    if (![...mapping.values()].includes('pod') || ![...mapping.values()].includes('price')) {
      toast.error(t('pricingSettings.importNeedCols'))
      return
    }
    const rows = sheet.rows.slice(0, 5000).map((row) => {
      const out: Record<string, string> = {}
      for (const [header, key] of mapping) if (row[header]) out[key] = row[header]
      return out
    })
    if (!rows.length) {
      toast.error(t('pricingSettings.importEmpty'))
      return
    }
    const res = await api.importFreightRates(rows)
    if (res.skipped)
      toast.error(
        t('pricingSettings.importPartial', [
          res.created,
          res.skipped,
          res.errors[0] ? `${res.errors[0].row}: ${res.errors[0].message}` : '',
        ]),
      )
    else toast.success(t('pricingSettings.importDone', [res.created]))
    await loadRates()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

onMounted(() => {
  void loadFx()
  void loadRates()
})
</script>

<template>
  <section class="panel" data-testid="pricing-settings">
    <div class="panel-head">
      <div class="txt">
        <h2 class="panel-title">{{ $t('pricingSettings.fxTitle') }}</h2>
        <div class="panel-sub">{{ $t('pricingSettings.fxSub') }}</div>
      </div>
      <button
        v-perm="'settings:write'"
        type="button"
        class="kbtn"
        :disabled="refreshing"
        data-testid="fx-refresh"
        @click="refreshFx"
      >
        {{ refreshing ? $t('pricingSettings.refreshing') : $t('pricingSettings.refresh') }}
      </button>
    </div>
    <div class="panel-body">
      <p v-if="fxError" class="hint warn">{{ fxError }}</p>
      <ul v-else class="fx-list" :aria-busy="fxLoading">
        <li v-for="rate in fx?.rates ?? []" :key="rate.pair" class="fx-row">
          <b class="tnum">1 USD = {{ rate.rate }} {{ rate.to }}</b>
          <span class="fx-meta">
            <span class="chip" :class="{ locked: rate.source === 'locked' }">{{ sourceLabel(rate) }}</span>
            <template v-if="rate.asOf">{{ rate.asOf }}</template>
            <span v-if="rate.stale" class="warn">{{ $t('pricingSettings.stale') }}</span>
          </span>
        </li>
      </ul>

      <h3 class="sub-title">{{ $t('pricingSettings.lockTitle') }}</h3>
      <p class="hint">{{ $t('pricingSettings.lockHint') }}</p>
      <div v-for="(row, i) in locks" :key="i" class="lock-row">
        <span class="lock-label">1</span>
        <input
          v-model="row.from"
          class="input cur"
          maxlength="3"
          :aria-label="$t('pricingSettings.lockFrom')"
          :disabled="!writable"
        />
        <span class="lock-label">=</span>
        <input
          v-model.number="row.rate"
          class="input rate"
          type="number"
          min="0"
          step="any"
          :aria-label="$t('pricingSettings.lockRate')"
          :disabled="!writable"
        />
        <input
          v-model="row.to"
          class="input cur"
          maxlength="3"
          :aria-label="$t('pricingSettings.lockTo')"
          :disabled="!writable"
        />
        <button v-if="writable" type="button" class="kbtn sm ghost" @click="locks.splice(i, 1)">
          {{ $t('pricingSettings.remove') }}
        </button>
      </div>
      <div class="hstack">
        <button v-if="writable" type="button" class="kbtn sm" data-testid="fx-add-lock" @click="addLock">
          {{ $t('pricingSettings.addLock') }}
        </button>
      </div>

      <label class="field margin-field">
        <span class="field-label">{{ $t('pricingSettings.margin') }}</span>
        <input
          v-model.number="margin"
          class="input"
          type="number"
          min="0"
          max="95"
          step="1"
          :disabled="!writable"
          data-testid="fx-margin"
        />
      </label>
      <div class="hstack">
        <button
          v-perm="'settings:write'"
          type="button"
          class="kbtn primary"
          :disabled="lockSaving"
          data-testid="fx-save"
          @click="saveLocks"
        >
          {{ $t('pricingSettings.save') }}
        </button>
      </div>
    </div>
  </section>

  <section class="panel" data-testid="freight-settings">
    <div class="panel-head">
      <div class="txt">
        <h2 class="panel-title">{{ $t('pricingSettings.freightTitle') }}</h2>
        <div class="panel-sub">{{ $t('pricingSettings.freightSub') }}</div>
      </div>
      <template v-if="dataWritable">
        <input
          ref="fileInput"
          type="file"
          accept=".csv,.xlsx,.xls"
          class="sr-only"
          data-testid="freight-file"
          @change="importFile"
        />
        <button type="button" class="kbtn" @click="fileInput?.click()">{{ $t('pricingSettings.import') }}</button>
        <button type="button" class="kbtn" data-testid="freight-add" @click="showAdd = !showAdd">
          {{ $t('pricingSettings.add') }}
        </button>
      </template>
    </div>
    <div class="panel-body">
      <form v-if="showAdd" class="add-grid" data-testid="freight-form" @submit.prevent="addRate">
        <input
          v-model="draft.pol"
          class="input"
          :placeholder="$t('pricingSettings.pol')"
          :aria-label="$t('pricingSettings.pol')"
        />
        <input
          v-model="draft.pod"
          class="input"
          :placeholder="$t('pricingSettings.pod')"
          :aria-label="$t('pricingSettings.pod')"
          required
        />
        <select v-model="draft.container" class="select" :aria-label="$t('pricingSettings.container')">
          <option v-for="c in api.CONTAINERS" :key="c" :value="c">{{ c }}</option>
        </select>
        <input
          v-model.number="draft.price"
          class="input"
          type="number"
          min="0"
          step="any"
          :placeholder="draft.container === 'LCL' ? $t('pricingSettings.pricePerCbm') : $t('pricingSettings.price')"
          :aria-label="$t('pricingSettings.price')"
          required
        />
        <select v-model="draft.currency" class="select" :aria-label="$t('pricingSettings.currency')">
          <option v-for="c in api.CURRENCIES" :key="c">{{ c }}</option>
        </select>
        <input
          v-model="draft.carrier"
          class="input"
          :placeholder="$t('pricingSettings.carrier')"
          :aria-label="$t('pricingSettings.carrier')"
        />
        <input
          v-model="draft.validUntil"
          class="input"
          type="date"
          :aria-label="$t('pricingSettings.validUntil')"
          :title="$t('pricingSettings.validUntil')"
        />
        <button type="submit" class="kbtn primary" :disabled="adding">{{ $t('pricingSettings.saveRate') }}</button>
      </form>
      <p v-if="!ratesLoading && !rates.length" class="hint">{{ $t('pricingSettings.freightEmpty') }}</p>
      <div v-else-if="rates.length" class="rate-scroll" data-hscroll-ok>
        <table class="data-table rate-table">
          <thead>
            <tr>
              <th>{{ $t('pricingSettings.lane') }}</th>
              <th>{{ $t('pricingSettings.container') }}</th>
              <th class="num">{{ $t('pricingSettings.price') }}</th>
              <th>{{ $t('pricingSettings.carrierCol') }}</th>
              <th>{{ $t('pricingSettings.validUntil') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rate in sortedRates" :key="rate.id" :class="{ expired: expired(rate) }">
              <td>{{ rate.pol || '—' }} → {{ rate.pod }}</td>
              <td>{{ rate.container }}</td>
              <td class="num tnum">
                {{ rate.currency }} {{ rate.price.toLocaleString()
                }}<span v-if="rate.unit === 'cbm'" class="dim"> / cbm</span>
              </td>
              <td>{{ rate.carrier || '—' }}</td>
              <td>
                {{ rate.validUntil || $t('pricingSettings.noExpiry') }}
                <span v-if="expired(rate)" class="chip">{{ $t('pricingSettings.expired') }}</span>
              </td>
              <td class="num">
                <button
                  v-if="dataWritable"
                  type="button"
                  class="kbtn sm ghost"
                  :aria-label="$t('pricingSettings.deleteTitle')"
                  @click="removeRate(rate)"
                >
                  {{ $t('pricingSettings.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="hint">{{ $t('pricingSettings.importHint') }}</p>
    </div>
  </section>
</template>

<style scoped>
.fx-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.fx-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.fx-row:last-child {
  border-bottom: 0;
}
.fx-row b {
  font-weight: 500;
}
.fx-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
.chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--surface-muted);
  color: var(--text-secondary);
}
.chip.locked {
  background: color-mix(in srgb, var(--brand, #8b6cf0) 14%, transparent);
  color: var(--brand, #8b6cf0);
}
.sub-title {
  margin: 4px 0 4px;
  font-size: 13.5px;
  font-weight: 500;
}
.hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
.warn,
.hint.warn {
  color: var(--prs-amber, #a96512);
}
.lock-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.lock-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.input.cur {
  width: 72px;
  text-transform: uppercase;
}
.input.rate {
  width: 120px;
  text-align: right;
}
.hstack {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.margin-field {
  max-width: 220px;
  margin: 16px 0 12px;
}
.add-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
  animation: fade-in 0.2s ease;
}
@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.rate-scroll {
  overflow-x: auto;
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.rate-table {
  width: 100%;
  margin: 0;
}
.rate-table td {
  white-space: nowrap;
}
tr.expired td {
  color: var(--text-tertiary);
}
.num {
  text-align: right;
}
.tnum {
  font-variant-numeric: tabular-nums;
}
.dim {
  color: var(--text-tertiary);
}
@media (max-width: 720px) {
  .add-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
