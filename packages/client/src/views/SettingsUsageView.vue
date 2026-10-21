<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as api from '../api'
import SettingsSidebar from '../components/SettingsSidebar.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiPager from '../components/ui/UiPager.vue'
import { auth, can, currentRole, currentUser } from '../lib/session'
import { formatCost, formatCostMap, formatTokens, pricingToRows, rowsToPricing, type PricingRow } from '../lib/usage'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'
import { intlLocale, t } from '../i18n'

/** 设置 → 用量：/api/usage 按天 / 模型汇总 + 明细（契约 §6.7），以及 modelPricing 单价编辑（§6.1） */
const store = useAppStore()

const RANGES = [
  { key: '7d', label: t('settingsUsage.k1vb6v12'), days: 7 },
  { key: '30d', label: t('settingsUsage.k69nkb'), days: 30 },
  { key: '90d', label: t('settingsUsage.k41tfxn'), days: 90 },
] as const
const range = ref<(typeof RANGES)[number]['key']>('30d')
const groupBy = ref<'day' | 'model' | 'provider' | 'purpose' | 'member'>('day')
const scopeAll = ref(false)
const canSeeAll = computed(
  () => auth.mode === 'server' && (currentRole.value === 'owner' || currentRole.value === 'admin'),
)
/** 按成员分组只给所有者 / 管理员（成员只能看到自己的用量，分组没有意义） */
const groupOptions = computed(() => [
  { key: 'day', label: 'settingsUsage.groupDay' } as const,
  { key: 'model', label: 'settingsUsage.groupModel' } as const,
  { key: 'provider', label: 'settingsUsage.groupProvider' } as const,
  { key: 'purpose', label: 'settingsUsage.groupPurpose' } as const,
  ...(canSeeAll.value ? [{ key: 'member', label: 'settingsUsage.groupMember' } as const] : []),
])
/** 按成员看时总是全组织口径 */
const effectiveAll = computed(() => scopeAll.value || groupBy.value === 'member')

const summary = ref<api.UsageSummary | null>(null)
const records = ref<api.UsageRecord[]>([])
const total = ref(0)
const page = ref(1)
const PAGE_SIZE = 20
const loading = ref(true)
const error = ref('')

const PURPOSE: Record<string, string> = {
  chat: t('settingsUsage.k8awmn'),
  continuation: t('settingsUsage.k19kd2hj'),
  compaction: t('settingsUsage.k1jmhjn5'),
  title: t('settingsUsage.k1pvbu2q'),
  completion: t('settingsUsage.kzlyc0u'),
  memory: t('settingsUsage.memoryPurpose'),
}

function filter(): api.UsageFilter {
  const days = RANGES.find((r) => r.key === range.value)?.days ?? 30
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  return { from: start.getTime(), scope: effectiveAll.value && canSeeAll.value ? 'all' : undefined }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const f = filter()
    const [s, r] = await Promise.all([api.getUsage(f, groupBy.value), api.getUsageRecords(f, page.value, PAGE_SIZE)])
    summary.value = s
    records.value = r.items
    total.value = r.total
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(async () => {
  void load()
  loadPricing()
  // 直接打开本页时 store 里可能还没有设置
  await store.refreshSettings().catch(() => undefined)
  loadPricing()
})
watch([range, groupBy, scopeAll], () => {
  page.value = 1
  void load()
})
watch(page, load)

const groupLabel = (g: { key: string; label: string }) => {
  if (groupBy.value === 'purpose') return PURPOSE[g.key] ?? g.label
  if (groupBy.value === 'member' && g.key && g.key === currentUser.value?.id)
    return t('settingsUsage.memberMe', [g.label || g.key])
  return g.label || g.key || '—'
}
const sessionTitle = (id: string | null) =>
  id ? (store.sessions.find((s) => s.id === id)?.title ?? t('settingsUsage.k5xj46r')) : '—'
const time = (ms: number) =>
  new Date(ms).toLocaleString(intlLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
const maxTokens = computed(() =>
  Math.max(1, ...(summary.value?.groups ?? []).map((g) => g.inputTokens + g.outputTokens)),
)

/* ── 按成员限流（团队服务器） ── */
const showLimits = computed(() => auth.mode === 'server' && can('settings:write'))
const limits = ref({ concurrent: '', perMinute: '' })
const limitsSaving = ref(false)
const limitsError = ref('')
function loadLimits(): void {
  limits.value = {
    concurrent: store.settings.chatMaxConcurrentRunsPerUser ?? '3',
    perMinute: store.settings.chatRunsPerMinutePerUser ?? '20',
  }
}
watch(() => [store.settings.chatMaxConcurrentRunsPerUser, store.settings.chatRunsPerMinutePerUser], loadLimits, {
  immediate: true,
})
function parseLimit(raw: string, max: number): number | null {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return value >= 0 && value <= max ? value : null
}
async function saveLimits(): Promise<void> {
  limitsError.value = ''
  const concurrent = parseLimit(limits.value.concurrent, 50)
  const perMinute = parseLimit(limits.value.perMinute, 600)
  if (concurrent === null || perMinute === null) {
    limitsError.value = t('settingsUsage.limitInvalid')
    return
  }
  limitsSaving.value = true
  try {
    await store.saveSettings({
      chatMaxConcurrentRunsPerUser: String(concurrent),
      chatRunsPerMinutePerUser: String(perMinute),
    })
    toast.success(t('settingsUsage.limitSaved'))
  } catch {
    /* 全局 toast 已提示 */
  } finally {
    limitsSaving.value = false
  }
}

/* ── 单价 ── */
const pricingMode = ref<'table' | 'json'>('table')
const rows = ref<PricingRow[]>([])
const pricingJson = ref('')
const pricingError = ref('')
const pricingSaving = ref(false)
const writable = computed(() => can('settings:write'))

function loadPricing(): void {
  pricingJson.value = store.settings.modelPricing ?? ''
  try {
    rows.value = pricingToRows(pricingJson.value)
    pricingError.value = ''
  } catch (e) {
    rows.value = []
    pricingMode.value = 'json'
    pricingError.value = t('settingsUsage.kcilr4v', [errorText(e)])
  }
}
watch(() => store.settings.modelPricing, loadPricing)

function addRow(): void {
  const model = store.defaultProvider?.model ?? ''
  rows.value.push({
    key: rows.value.some((r) => r.key === model) ? '' : model,
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
    currency: 'CNY',
  })
}

function switchMode(mode: 'table' | 'json'): void {
  pricingError.value = ''
  if (mode === 'json') {
    const res = rowsToPricing(rows.value)
    if ('error' in res) {
      pricingError.value = res.error
      return
    }
    pricingJson.value = res.json ? JSON.stringify(JSON.parse(res.json), null, 2) : ''
  } else {
    try {
      rows.value = pricingToRows(pricingJson.value)
    } catch (e) {
      pricingError.value = t('settingsUsage.kxit2hu', [errorText(e)])
      return
    }
  }
  pricingMode.value = mode
}

async function savePricing(): Promise<void> {
  pricingError.value = ''
  let json = ''
  if (pricingMode.value === 'table') {
    const res = rowsToPricing(rows.value)
    if ('error' in res) {
      pricingError.value = res.error
      return
    }
    json = res.json
  } else {
    try {
      json = pricingJson.value.trim() ? JSON.stringify(JSON.parse(pricingJson.value)) : ''
      pricingToRows(json)
    } catch (e) {
      pricingError.value = t('settingsUsage.kxit2hu', [errorText(e)])
      return
    }
  }
  pricingSaving.value = true
  try {
    await store.saveSettings({ modelPricing: json })
    loadPricing()
    toast.success(t('settingsUsage.k19a8n48'))
  } catch {
    /* 全局 toast 已提示（结构不对 400） */
  } finally {
    pricingSaving.value = false
  }
}
</script>

<template>
  <SettingsSidebar />
  <main class="main">
    <PageTopbar :title="$t('settingsUsage.k1ldluuk')" :sub="$t('settingsUsage.k1owdxgh')" />
    <div class="doc">
      <div class="doc-inner">
        <div class="usage-toolbar">
          <div class="segmented" role="tablist" :aria-label="$t('settingsUsage.kc6luko')">
            <button
              v-for="r in RANGES"
              :key="r.key"
              type="button"
              role="tab"
              :aria-selected="range === r.key"
              :class="{ on: range === r.key }"
              @click="range = r.key"
            >
              {{ r.label }}
            </button>
          </div>
          <div class="segmented" role="tablist" :aria-label="$t('settingsUsage.k117h4r2')">
            <button
              v-for="g in groupOptions"
              :key="g.key"
              type="button"
              role="tab"
              :aria-selected="groupBy === g.key"
              :class="{ on: groupBy === g.key }"
              @click="groupBy = g.key"
            >
              {{ $t(g.label) }}
            </button>
          </div>
          <label v-if="canSeeAll" class="usage-scope">
            <input
              :checked="effectiveAll"
              type="checkbox"
              :disabled="groupBy === 'member'"
              @change="scopeAll = ($event.target as HTMLInputElement).checked"
            />
            <span>{{ $t('settingsUsage.kelshww') }}</span>
          </label>
        </div>

        <StateBlock v-if="loading && !summary" state="loading" />
        <StateBlock v-else-if="error" state="error" :message="error" @retry="load" />
        <template v-else-if="summary">
          <div class="usage-stats">
            <div class="usage-stat">
              <span>{{ $t('settingsUsage.k1gnyq12') }}</span>
              <b>{{ summary.totals.calls.toLocaleString('en-US') }}</b>
            </div>
            <div class="usage-stat">
              <span>{{ $t('settingsUsage.k1fa8v68') }}</span>
              <b>{{ formatTokens(summary.totals.inputTokens) }}</b>
              <small v-if="summary.totals.cacheReadTokens">{{
                $t('settingsUsage.kkn5220', [formatTokens(summary.totals.cacheReadTokens)])
              }}</small>
            </div>
            <div class="usage-stat">
              <span>{{ $t('settingsUsage.kcdlepu') }}</span>
              <b>{{ formatTokens(summary.totals.outputTokens) }}</b>
              <small v-if="summary.totals.reasoningTokens">{{
                $t('settingsUsage.k1gnvk4o', [formatTokens(summary.totals.reasoningTokens)])
              }}</small>
            </div>
            <div class="usage-stat">
              <span>{{ $t('settingsUsage.k44mahd') }}</span>
              <b :title="formatCostMap(summary.totals.cost)">{{ formatCostMap(summary.totals.cost) }}</b>
              <small v-if="summary.totals.unpricedCalls">{{
                $t('settingsUsage.kawpwh7', [summary.totals.unpricedCalls])
              }}</small>
            </div>
          </div>
          <p v-if="summary.totals.estimatedCalls" class="field-hint">
            {{ $t('settingsUsage.kq03e1u', [summary.totals.estimatedCalls]) }}
          </p>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsUsage.kfkszxd') }}</h2>
              </div>
            </div>
            <StateBlock v-if="!summary.groups.length" state="empty" :title="$t('settingsUsage.kgml1h3')" compact />
            <div v-else class="table-scroll flat">
              <table class="data-table" :aria-label="$t('settingsUsage.k1x7ghzd')">
                <thead>
                  <tr>
                    <th>
                      {{
                        {
                          day: $t('settingsUsage.k1erw2wf'),
                          model: $t('settingsUsage.k16g5qd9'),
                          provider: 'Provider',
                          purpose: $t('settingsUsage.kyhhalu'),
                          member: $t('settingsUsage.colMember'),
                        }[groupBy]
                      }}
                    </th>
                    <th class="num">{{ $t('settingsUsage.k1ddspi3') }}</th>
                    <th class="num">{{ $t('settingsUsage.k1sikn5s') }}</th>
                    <th class="num">{{ $t('settingsUsage.k1ptvani') }}</th>
                    <th class="bar-col" aria-hidden="true"></th>
                    <th class="num">{{ $t('settingsUsage.k168f2am') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="g in summary.groups" :key="g.key">
                    <td class="cell-ellipsis" :title="groupLabel(g)">{{ groupLabel(g) }}</td>
                    <td class="num">{{ g.calls }}</td>
                    <td class="num">{{ formatTokens(g.inputTokens) }}</td>
                    <td class="num">{{ formatTokens(g.outputTokens) }}</td>
                    <td class="bar-col">
                      <i class="bar" :style="{ width: `${((g.inputTokens + g.outputTokens) / maxTokens) * 100}%` }" />
                    </td>
                    <td class="num">{{ formatCostMap(g.cost) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('settingsUsage.k19qdqtc') }}</h2>
                <div class="panel-sub">{{ $t('settingsUsage.keex8k3') }}</div>
              </div>
            </div>
            <StateBlock v-if="!records.length" state="empty" :title="$t('settingsUsage.k15o664c')" compact />
            <template v-else>
              <div class="table-scroll flat">
                <table class="data-table" :aria-label="$t('settingsUsage.ktwerc3')">
                  <thead>
                    <tr>
                      <th>{{ $t('settingsUsage.k127i5b7') }}</th>
                      <th>{{ $t('settingsUsage.k16g5qd9') }}</th>
                      <th>{{ $t('settingsUsage.kyhhalu') }}</th>
                      <th>{{ $t('settingsUsage.k10gw4cu') }}</th>
                      <th class="num">{{ $t('settingsUsage.k1sikn5s') }}</th>
                      <th class="num">{{ $t('settingsUsage.k1ptvani') }}</th>
                      <th class="num">{{ $t('settingsUsage.k168f2am') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in records" :key="r.id">
                      <td class="dim nowrap">{{ time(r.createdAt) }}</td>
                      <td class="cell-ellipsis" :title="`${r.providerName ?? ''} / ${r.model}`">
                        {{ r.model
                        }}<span v-if="r.estimated" class="est" :title="$t('settingsUsage.k124fteu')">{{
                          $t('settingsUsage.k1g5ba1i')
                        }}</span>
                      </td>
                      <td class="nowrap">{{ PURPOSE[r.purpose] ?? r.purpose }}</td>
                      <td class="cell-ellipsis" :title="sessionTitle(r.sessionId)">{{ sessionTitle(r.sessionId) }}</td>
                      <td class="num">{{ formatTokens(r.inputTokens) }}</td>
                      <td class="num">{{ formatTokens(r.outputTokens) }}</td>
                      <td class="num">{{ r.cost === null ? '—' : formatCost(r.cost, r.currency) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <UiPager v-model:page="page" :total="total" :page-size="PAGE_SIZE" />
            </template>
          </section>
        </template>

        <section v-if="showLimits" class="panel" data-testid="chat-rate-limits">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsUsage.limitTitle') }}</h2>
              <div class="panel-sub">{{ $t('settingsUsage.limitSub') }}</div>
            </div>
          </div>
          <div class="panel-body form-grid">
            <label class="field">
              <span class="field-label">{{ $t('settingsUsage.limitConcurrent') }}</span>
              <input
                v-model="limits.concurrent"
                class="input"
                type="number"
                min="0"
                max="50"
                name="chatMaxConcurrentRunsPerUser"
              />
              <span class="field-hint">{{ $t('settingsUsage.limitConcurrentHint') }}</span>
            </label>
            <label class="field">
              <span class="field-label">{{ $t('settingsUsage.limitPerMinute') }}</span>
              <input
                v-model="limits.perMinute"
                class="input"
                type="number"
                min="0"
                max="600"
                name="chatRunsPerMinutePerUser"
              />
              <span class="field-hint">{{ $t('settingsUsage.limitPerMinuteHint') }}</span>
            </label>
          </div>
          <div class="panel-body">
            <p v-if="limitsError" class="field-error" role="alert">{{ limitsError }}</p>
            <button type="button" class="kbtn primary" :disabled="limitsSaving" @click="saveLimits">
              {{ $t('settingsUsage.limitSave') }}
            </button>
          </div>
        </section>

        <section class="panel" data-testid="model-pricing">
          <div class="panel-head">
            <div class="txt">
              <h2 class="panel-title">{{ $t('settingsUsage.k70dp7') }}</h2>
              <div class="panel-sub">
                {{ $t('settingsUsage.km816t6') }}
              </div>
            </div>
            <div class="segmented" role="tablist" :aria-label="$t('settingsUsage.kv1d995')">
              <button
                type="button"
                role="tab"
                :aria-selected="pricingMode === 'table'"
                :class="{ on: pricingMode === 'table' }"
                @click="switchMode('table')"
              >
                {{ $t('settingsUsage.k5ts43m') }}
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="pricingMode === 'json'"
                :class="{ on: pricingMode === 'json' }"
                @click="switchMode('json')"
              >
                JSON
              </button>
            </div>
          </div>
          <div class="panel-body stack">
            <template v-if="pricingMode === 'table'">
              <div v-if="rows.length" class="table-scroll flat">
                <table class="data-table price-table" :aria-label="$t('settingsUsage.k70dp7')">
                  <thead>
                    <tr>
                      <th>{{ $t('settingsUsage.k16g5qd9') }}</th>
                      <th>{{ $t('settingsUsage.k1sikn5s') }}</th>
                      <th>{{ $t('settingsUsage.k1ptvani') }}</th>
                      <th>{{ $t('settingsUsage.kfilv6j') }}</th>
                      <th>{{ $t('settingsUsage.ku9ejmn') }}</th>
                      <th>{{ $t('settingsUsage.k1an5azl') }}</th>
                      <th>
                        <span class="sr-only">{{ $t('settingsUsage.k1voemgk') }}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, i) in rows" :key="i">
                      <td>
                        <input
                          v-model="row.key"
                          class="input code"
                          :aria-label="$t('settingsUsage.kq6ww37')"
                          placeholder="deepseek-chat"
                          :disabled="!writable"
                        />
                      </td>
                      <td>
                        <input
                          v-model="row.input"
                          class="input num-input"
                          :aria-label="$t('settingsUsage.k18enod5')"
                          inputmode="decimal"
                          :disabled="!writable"
                        />
                      </td>
                      <td>
                        <input
                          v-model="row.output"
                          class="input num-input"
                          :aria-label="$t('settingsUsage.k1j3zez0')"
                          inputmode="decimal"
                          :disabled="!writable"
                        />
                      </td>
                      <td>
                        <input
                          v-model="row.cacheRead"
                          class="input num-input"
                          :aria-label="$t('settingsUsage.kj0q4nt')"
                          inputmode="decimal"
                          :placeholder="$t('settingsUsage.kn9xdm8')"
                          :disabled="!writable"
                        />
                      </td>
                      <td>
                        <input
                          v-model="row.cacheWrite"
                          class="input num-input"
                          :aria-label="$t('settingsUsage.k1laztju')"
                          inputmode="decimal"
                          :placeholder="$t('settingsUsage.kn9xdm8')"
                          :disabled="!writable"
                        />
                      </td>
                      <td>
                        <select
                          v-model="row.currency"
                          class="select"
                          :aria-label="$t('settingsUsage.k1an5azl')"
                          :disabled="!writable"
                        >
                          <option v-for="c in ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD']" :key="c" :value="c">
                            {{ c }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          class="kbtn sm ghost"
                          :aria-label="$t('settingsUsage.k1b4ruiu', [row.key || $t('settingsUsage.k1f2vqve')])"
                          :disabled="!writable"
                          @click="rows.splice(i, 1)"
                        >
                          {{ $t('settingsUsage.kfcqesv') }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="muted empty-line">{{ $t('settingsUsage.kg2pwxb') }}</p>
            </template>
            <textarea
              v-else
              v-model="pricingJson"
              class="textarea code"
              rows="8"
              spellcheck="false"
              :aria-label="$t('settingsUsage.klmscqx')"
              placeholder='{"deepseek-chat": {"input": 2, "output": 8, "cacheRead": 0.5, "currency": "CNY"}}'
              :disabled="!writable"
            />
            <p v-if="pricingError" class="field-error" role="alert">{{ pricingError }}</p>
            <div class="hstack">
              <button
                v-if="pricingMode === 'table'"
                v-perm="'settings:write'"
                type="button"
                class="kbtn"
                @click="addRow"
              >
                {{ $t('settingsUsage.kn2pujl') }}
              </button>
              <button
                v-perm="'settings:write'"
                type="button"
                class="kbtn primary"
                :disabled="pricingSaving"
                @click="savePricing"
              >
                {{ pricingSaving ? $t('settingsUsage.ksdjf4x') : $t('settingsUsage.k1nmarqh') }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.usage-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-bottom: 14px;
}
.usage-scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.usage-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 10px;
}
.usage-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.usage-stat span {
  font-size: 12px;
  color: var(--text-secondary);
}
.usage-stat b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.usage-stat small {
  font-size: 11.5px;
  color: var(--text-secondary);
}
.table-scroll.flat {
  border: 0;
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}
.cell-ellipsis {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nowrap {
  white-space: nowrap;
}
.bar-col {
  width: 22%;
  min-width: 80px;
}
.bar {
  display: block;
  height: 6px;
  min-width: 2px;
  border-radius: 999px;
  background: #8aa9e8;
}
.est {
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-muted);
  color: var(--text-secondary);
  font-size: 11px;
}
.price-table td {
  padding-top: 6px;
  padding-bottom: 6px;
}
.price-table .input,
.price-table .select {
  min-width: 90px;
}
.price-table td:first-child .input {
  min-width: 180px;
}
.num-input {
  text-align: right;
}
.empty-line {
  margin: 0;
  font-size: 13px;
}
</style>
