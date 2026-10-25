<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import InitialBadge from '../components/ui/InitialBadge.vue'
import ProspectImportModal from '../components/ProspectImportModal.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import UiPager from '../components/ui/UiPager.vue'
import { askLulux } from '../lib/ask-lulux'
import { formatDate, relativeTime } from '../lib/labels'
import { can } from '../lib/session'
import { confirmDialog, errorText, toast } from '../stores/ui'
import { t } from '../i18n'

/**
 * 客户 → 线索：Agent（或导入）找到的潜在客户。按评分排序，区分“有海关证据”和“仅官网发现”，
 * 右侧抽屉看证据与评分理由，可标记已联系 / 忽略、转为客户、删除（进回收站）。
 * 数据全部来自 /api/prospects；找客户本身交给 Agent（find_uk_importers / save_prospects 等工具）。
 */
type Evidence = 'customs' | 'web' | ''
const router = useRouter()
const PAGE_SIZE = 20

const q = ref('')
const status = ref<api.ProspectStatus | ''>('')
const evidence = ref<Evidence>('')
const flag = ref<api.ProspectFlag | ''>('')
const sort = ref<'score' | 'updated' | 'lastImport'>('score')
const page = ref(1)
const items = ref<api.Prospect[]>([])
const total = ref(0)
const counts = ref<api.ProspectCounts | null>(null)
const loading = ref(true)
const loadError = ref('')
const canWrite = computed(() => can('data:write'))
let seq = 0

const STATUS_LABEL = computed<Record<api.ProspectStatus, string>>(() => ({
  new: t('prosp.stNew'),
  contacted: t('prosp.stContacted'),
  converted: t('prosp.stConverted'),
  ignored: t('prosp.stIgnored'),
}))
const FLAG_LABEL = computed<Record<api.ProspectFlag, string>>(() => ({
  forwarder: t('prosp.flagForwarder'),
  sanctions_hit: t('prosp.flagSanctions'),
  customer_exists: t('prosp.flagCustomer'),
  stale: t('prosp.flagStale'),
  name_conflict: t('prosp.flagNameConflict'),
  website_down: t('prosp.flagWebsiteDown'),
}))
const KIND_LABEL = computed<Record<api.EvidenceKind, string>>(() => ({
  customs: t('prosp.kCustoms'),
  bill_of_lading: t('prosp.kBol'),
  website: t('prosp.kWebsite'),
  search: t('prosp.kSearch'),
  directory: t('prosp.kDirectory'),
  import: t('prosp.kImport'),
  manual: t('prosp.kManual'),
}))

const filtered = computed(() => !!(q.value.trim() || status.value || evidence.value || flag.value))

async function load(): Promise<void> {
  const mine = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.listProspects({
      q: q.value,
      status: status.value,
      flag: flag.value,
      hasCustomsEvidence: evidence.value === '' ? undefined : evidence.value === 'customs',
      sort: sort.value,
      limit: PAGE_SIZE,
      offset: (page.value - 1) * PAGE_SIZE,
    })
    if (mine !== seq) return
    items.value = res.items
    total.value = res.total
    if (!res.items.length && page.value > 1 && res.total > 0) page.value = Math.max(1, Math.ceil(res.total / PAGE_SIZE))
  } catch (error) {
    if (mine === seq) loadError.value = errorText(error)
  } finally {
    if (mine === seq) loading.value = false
  }
}

async function loadCounts(): Promise<void> {
  counts.value = await api.getProspectCounts().catch(() => counts.value)
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    page.value = 1
    void load()
  }, 250)
})
watch([status, evidence, flag, sort], () => {
  page.value = 1
  void load()
})
watch(page, () => void load())
onMounted(() => {
  void load()
  void loadCounts()
})

function clearFilters(): void {
  q.value = ''
  status.value = ''
  evidence.value = ''
  flag.value = ''
}

function lastImport(p: api.Prospect): string {
  return p.lastImportAt ? formatDate(p.lastImportAt).slice(0, 7) : '—'
}

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/* ── 详情抽屉 ── */
const current = ref<api.Prospect | null>(null)
const busy = ref(false)
function open(p: api.Prospect): void {
  current.value = p
}
function close(): void {
  current.value = null
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && current.value) close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function replace(next: api.Prospect): void {
  items.value = items.value.map((item) => (item.id === next.id ? next : item))
  if (current.value?.id === next.id) current.value = next
}

async function setStatus(p: api.Prospect, next: 'new' | 'contacted' | 'ignored'): Promise<void> {
  busy.value = true
  try {
    replace(await api.setProspectStatus(p.id, next))
    toast.success(t('prosp.statusDone', [STATUS_LABEL.value[next]]))
    void loadCounts()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}

async function convert(p: api.Prospect, force = false): Promise<void> {
  busy.value = true
  try {
    const res = await api.convertProspect(p.id, force)
    if (!res.converted) {
      const names = res.matches.map((m) => (m.owner ? `${m.company} (${m.owner})` : m.company)).join(', ')
      const ok = await confirmDialog({
        title: t('prosp.dupTitle'),
        message: t('prosp.dupMessage', [names]),
        confirmText: t('prosp.dupConfirm'),
      })
      busy.value = false
      if (ok) await convert(p, true)
      return
    }
    replace(res.prospect)
    toast.success(t('prosp.converted', [res.customer.company]))
    void loadCounts()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}

async function remove(p: api.Prospect): Promise<void> {
  const ok = await confirmDialog({
    title: t('prosp.delTitle'),
    message: t('prosp.delMessage', [p.company]),
    confirmText: t('prosp.delConfirm'),
    danger: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await api.deleteProspect(p.id)
    toast.success(t('prosp.deleted'))
    close()
    void load()
    void loadCounts()
  } catch (error) {
    toast.error(errorText(error))
  } finally {
    busy.value = false
  }
}

const importing = ref(false)
function onImported(): void {
  void load()
  void loadCounts()
}

function askAgent(): void {
  void askLulux(router, { prompt: t('prosp.askPrompt') })
}
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('prosp.title')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('prosp.title') }}</h2>
      </div>
      <label class="side-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <span class="sr-only">{{ $t('prosp.search') }}</span>
        <input
          v-model="q"
          type="search"
          :placeholder="$t('prosp.search')"
          spellcheck="false"
          data-testid="prospects-search"
        />
      </label>
      <nav class="side-body">
        <button type="button" class="nav-row" :class="{ on: !filtered }" @click="clearFilters">
          {{ $t('prosp.all') }}<span v-if="counts" class="count">{{ counts.total }}</span>
        </button>
        <div class="side-label">{{ $t('prosp.status') }}</div>
        <button
          v-for="s in api.PROSPECT_STATUSES"
          :key="s"
          type="button"
          class="nav-row sub"
          :class="{ on: status === s }"
          :aria-pressed="status === s"
          @click="status = status === s ? '' : s"
        >
          {{ STATUS_LABEL[s] }}<span class="count">{{ counts?.byStatus[s] ?? 0 }}</span>
        </button>
        <div class="side-label">{{ $t('prosp.evidence') }}</div>
        <button
          type="button"
          class="nav-row sub"
          :class="{ on: evidence === 'customs' }"
          :aria-pressed="evidence === 'customs'"
          data-testid="filter-customs"
          @click="evidence = evidence === 'customs' ? '' : 'customs'"
        >
          {{ $t('prosp.evCustoms') }}<span v-if="counts?.customs !== undefined" class="count">{{ counts.customs }}</span>
        </button>
        <button
          type="button"
          class="nav-row sub"
          :class="{ on: evidence === 'web' }"
          :aria-pressed="evidence === 'web'"
          @click="evidence = evidence === 'web' ? '' : 'web'"
        >
          {{ $t('prosp.evWeb') }}<span v-if="counts?.web !== undefined" class="count">{{ counts.web }}</span>
        </button>
        <div class="side-label">{{ $t('prosp.flags') }}</div>
        <button
          v-for="f in ['sanctions_hit', 'forwarder', 'customer_exists'] as api.ProspectFlag[]"
          :key="f"
          type="button"
          class="nav-row sub"
          :class="{ on: flag === f }"
          :aria-pressed="flag === f"
          @click="flag = flag === f ? '' : f"
        >
          {{ FLAG_LABEL[f]
          }}<span v-if="counts" class="count">{{ counts.byFlag?.[f] ?? (f === 'customer_exists' ? counts.customerExists : 0) }}</span>
        </button>
        <div class="side-label">{{ $t('crm.related') }}</div>
        <RouterLink class="nav-row" to="/customers">{{ $t('crm.customers') }}</RouterLink>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('prosp.title')" :sub="$t('prosp.sub')" />

    <div class="doc">
      <div class="head-row">
        <div>
          <h2 class="page-h">{{ $t('prosp.title') }}</h2>
          <div class="head-count">{{ $t('prosp.countLine', [total]) }}</div>
        </div>
        <div class="tb-spacer"></div>
        <label class="sort">
          <span class="sr-only">{{ $t('prosp.sort') }}</span>
          <select v-model="sort" class="select sm" :aria-label="$t('prosp.sort')">
            <option value="score">{{ $t('prosp.sortScore') }}</option>
            <option value="lastImport">{{ $t('prosp.sortImport') }}</option>
            <option value="updated">{{ $t('prosp.sortUpdated') }}</option>
          </select>
        </label>
        <button type="button" class="btn" :disabled="loading" @click="load">{{ $t('crm.refresh') }}</button>
        <button v-if="canWrite" type="button" class="btn" data-testid="prospects-import" @click="importing = true">
          {{ $t('prosp.import') }}
        </button>
        <button type="button" class="btn dark" data-testid="prospects-ask" @click="askAgent">
          {{ $t('prosp.ask') }}
        </button>
      </div>
      <p class="scope-note">{{ $t('prosp.scopeNote') }}</p>

      <StateBlock v-if="loading && !items.length" state="loading" />
      <StateBlock v-else-if="loadError" state="error" :message="loadError" @retry="load" />
      <div v-else-if="!items.length" class="empty" data-testid="prospects-empty">
        <template v-if="filtered">
          <p>{{ $t('prosp.emptyFiltered') }}</p>
          <button type="button" class="link" @click="clearFilters">{{ $t('prosp.clear') }}</button>
        </template>
        <template v-else>
          <p class="empty-title">{{ $t('prosp.emptyTitle') }}</p>
          <p class="empty-sub">{{ $t('prosp.emptySub') }}</p>
          <button type="button" class="btn dark" @click="askAgent">{{ $t('prosp.ask') }}</button>
        </template>
      </div>

      <div v-else class="table-wrap" :class="{ 'is-loading': loading }">
        <div class="table-scroll-x">
          <table class="ptable data-table" data-testid="prospects-table">
            <colgroup>
              <col />
              <col style="width: 72px" />
              <col style="width: 118px" />
              <col style="width: 112px" />
              <col style="width: 96px" />
              <col style="width: 92px" />
              <col style="width: 150px" />
            </colgroup>
            <thead>
              <tr>
                <th>{{ $t('prosp.company') }}</th>
                <th>{{ $t('prosp.country') }}</th>
                <th>{{ $t('prosp.evidence') }}</th>
                <th>{{ $t('prosp.score') }}</th>
                <th>{{ $t('prosp.lastImport') }}</th>
                <th>{{ $t('prosp.status') }}</th>
                <th>{{ $t('prosp.flags') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in items"
                :key="p.id"
                class="row-link"
                :class="{ on: current?.id === p.id }"
                tabindex="0"
                @click="open(p)"
                @keydown.enter.self="open(p)"
              >
                <td>
                  <div class="cust">
                    <InitialBadge :name="p.company" :size="28" />
                    <div class="cust-txt">
                      <div class="cust-name" :title="p.company">{{ p.company }}</div>
                      <div class="cust-mail" :title="p.website || p.address">
                        {{ p.website ? host(p.website) : p.address || p.products || '—' }}
                      </div>
                    </div>
                  </div>
                </td>
                <td class="dim">{{ p.country || '—' }}</td>
                <td>
                  <span v-if="api.hasCustomsEvidence(p)" class="ev ev-customs">{{ $t('prosp.evCustomsShort') }}</span>
                  <span
                    v-else-if="p.evidence.length && p.evidence.every((e) => e.kind === 'import')"
                    class="ev ev-web"
                    >{{ $t('prosp.kImport') }}</span
                  >
                  <span v-else class="ev ev-web">{{ $t('prosp.evWebShort') }}</span>
                </td>
                <td>
                  <div
                    class="score"
                    :title="p.scoreReasons.map((r) => `${r.label} ${r.points > 0 ? '+' : ''}${r.points}`).join('\n')"
                  >
                    <span class="score-n tnum">{{ p.score }}</span>
                    <span class="score-bar" aria-hidden="true"><i :style="{ width: `${p.score}%` }"></i></span>
                  </div>
                </td>
                <td class="dim tnum">{{ lastImport(p) }}</td>
                <td>
                  <span class="st-pill" :class="`st-${p.status}`">{{ STATUS_LABEL[p.status] }}</span>
                </td>
                <td>
                  <div class="flags">
                    <span v-for="f in p.flags" :key="f" class="flag" :class="`f-${f}`">{{ FLAG_LABEL[f] }}</span>
                    <span v-if="!p.flags.length" class="dim">—</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <UiPager v-model:page="page" class="pager-in" :page-size="PAGE_SIZE" :total="total" />
      </div>
    </div>
  </main>

  <ProspectImportModal v-if="importing" @close="importing = false" @done="onImported" />
  <Transition name="fade">
    <div v-if="current" class="drawer-mask" aria-hidden="true" @click="close"></div>
  </Transition>
  <Transition name="drawer">
    <aside v-if="current" class="drawer" role="dialog" :aria-label="current.company" data-testid="prospect-drawer">
      <header class="dr-head">
        <InitialBadge :name="current.company" :size="36" />
        <div class="dr-title">
          <h3 :title="current.company">{{ current.company }}</h3>
          <div class="dr-sub">
            <span class="st-pill" :class="`st-${current.status}`">{{ STATUS_LABEL[current.status] }}</span>
            <span v-if="current.country">{{ current.country }}</span>
            <span>{{ $t('prosp.updated', [relativeTime(current.updatedAt)]) }}</span>
          </div>
        </div>
        <button type="button" class="dr-close" :aria-label="$t('prosp.close')" @click="close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <div class="dr-body">
        <div v-if="current.flags.includes('sanctions_hit')" class="warn" role="note">
          {{ $t('prosp.sanctionsWarn') }}
        </div>
        <div v-if="current.flags.includes('forwarder')" class="note" role="note">{{ $t('prosp.forwarderNote') }}</div>

        <section class="sec">
          <h4>{{ $t('prosp.scoreTitle', [current.score]) }}</h4>
          <ul v-if="current.scoreReasons.length" class="reasons">
            <li v-for="r in current.scoreReasons" :key="r.key">
              <span>{{ r.label }}</span
              ><b :class="{ neg: r.points < 0 }">{{ r.points > 0 ? '+' : '' }}{{ r.points }}</b>
            </li>
          </ul>
          <p v-else class="dim">{{ $t('prosp.noReasons') }}</p>
        </section>

        <section class="sec">
          <h4>{{ $t('prosp.evidenceTitle', [current.evidence.length]) }}</h4>
          <ol class="evidence">
            <li v-for="(e, i) in current.evidence" :key="i">
              <div class="ev-line">
                <span class="ev" :class="api.CUSTOMS_EVIDENCE.includes(e.kind) ? 'ev-customs' : 'ev-web'">{{
                  KIND_LABEL[e.kind] ?? e.kind
                }}</span>
                <span class="ev-src">{{ e.source }}</span>
                <span class="ev-time">{{ formatDate(e.observedAt) }}</span>
              </div>
              <a v-if="e.url" class="ev-title" :href="e.url" target="_blank" rel="noopener noreferrer">{{
                e.title || host(e.url)
              }}</a>
              <div v-else class="ev-title">{{ e.title || '—' }}</div>
              <p v-if="e.snippet" class="ev-snip">{{ e.snippet }}</p>
            </li>
          </ol>
        </section>

        <section class="sec">
          <h4>{{ $t('prosp.info') }}</h4>
          <dl class="kv">
            <template v-if="current.website">
              <dt>{{ $t('prosp.website') }}</dt>
              <dd>
                <a :href="current.website" target="_blank" rel="noopener noreferrer">{{ host(current.website) }}</a>
              </dd>
            </template>
            <template v-if="current.address">
              <dt>{{ $t('prosp.address') }}</dt>
              <dd>{{ current.address }}</dd>
            </template>
            <template v-if="current.products">
              <dt>{{ $t('prosp.products') }}</dt>
              <dd>{{ current.products }}</dd>
            </template>
            <template v-if="current.hsCodes.length">
              <dt>HS</dt>
              <dd class="tnum">{{ current.hsCodes.join(', ') }}</dd>
            </template>
            <template v-if="current.emails.length">
              <dt>{{ $t('prosp.emails') }}</dt>
              <dd>{{ current.emails.join(', ') }}</dd>
            </template>
            <template v-if="current.phones.length">
              <dt>{{ $t('prosp.phones') }}</dt>
              <dd>{{ current.phones.join(', ') }}</dd>
            </template>
            <template v-if="current.lastImportAt">
              <dt>{{ $t('prosp.lastImport') }}</dt>
              <dd>
                {{ lastImport(current)
                }}<span v-if="current.shipments" class="dim">{{ $t('prosp.monthsLine', [current.shipments]) }}</span>
              </dd>
            </template>
            <dt>{{ $t('prosp.owner') }}</dt>
            <dd>{{ current.ownerName || '—' }}</dd>
          </dl>
          <p v-if="current.notes" class="notes">{{ current.notes }}</p>
        </section>
      </div>

      <footer v-if="canWrite" class="dr-foot">
        <RouterLink v-if="current.customerId" class="btn dark" :to="`/customers/${current.customerId}`">{{
          $t('prosp.openCustomer')
        }}</RouterLink>
        <button
          v-else
          type="button"
          class="btn dark"
          :disabled="busy"
          data-testid="prospect-convert"
          @click="convert(current)"
        >
          {{ $t('prosp.convert') }}
        </button>
        <button
          v-if="current.status === 'new' || current.status === 'ignored'"
          type="button"
          class="btn"
          :disabled="busy"
          @click="setStatus(current, 'contacted')"
        >
          {{ $t('prosp.markContacted') }}
        </button>
        <button
          v-if="current.status !== 'ignored' && current.status !== 'converted'"
          type="button"
          class="btn"
          :disabled="busy"
          @click="setStatus(current, 'ignored')"
        >
          {{ $t('prosp.ignore') }}
        </button>
        <div class="tb-spacer"></div>
        <button
          v-perm="['data:write', 'customer:delete']"
          type="button"
          class="btn ghost-danger"
          :disabled="busy"
          @click="remove(current)"
        >
          {{ $t('prosp.delete') }}
        </button>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
/* 状态色：浅色 / 深色两套（深色下提亮保证对比度）；只定义 --prs-* 变量，不影响其他页面 */
:global(:root) {
  --prs-green: #00854a;
  --prs-blue: #0b6dd3;
  --prs-amber: #aa6300;
  --prs-red: #cd2834;
}
:global(:root[data-theme='dark']) {
  --prs-green: #00ba69;
  --prs-blue: #4d9bff;
  --prs-amber: #e28600;
  --prs-red: #ff6463;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.page-h {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.head-count {
  min-height: 18px;
  font-size: 12.5px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.tb-spacer {
  flex: 1;
}
.btn.dark {
  border-color: var(--bubble-user);
  background: var(--bubble-user);
  color: var(--on-strong);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.ghost-danger {
  color: var(--danger, #d64545);
}
.scope-note {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
.nav-row .count {
  margin-left: auto;
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
.empty {
  padding: 56px 16px;
  text-align: center;
  color: var(--text-secondary);
}
.empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.empty-sub {
  margin: 0 auto 18px;
  max-width: 460px;
  font-size: 13px;
  line-height: 1.6;
}
.cust {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.cust-txt {
  min-width: 0;
}
.cust-name {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cust-mail {
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dim {
  color: var(--text-tertiary);
}
.tnum {
  font-variant-numeric: tabular-nums;
}
.ev {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  white-space: nowrap;
}
.ev-customs {
  background: color-mix(in srgb, #14c16f 9%, transparent);
  color: var(--prs-green);
}
.ev-web {
  background: var(--surface-active);
  color: var(--text-secondary);
}
.score {
  display: flex;
  align-items: center;
  gap: 8px;
}
.score-n {
  width: 22px;
  text-align: right;
  font-weight: 600;
}
.score-bar {
  flex: 1;
  min-width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-active);
  overflow: hidden;
}
.score-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--text-secondary);
  transition: width 0.3s ease;
}
.st-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--surface-active);
  color: var(--text-secondary);
  white-space: nowrap;
}
.st-new {
  background: color-mix(in srgb, #1e86fc 9%, transparent);
  color: var(--prs-blue);
}
.st-contacted {
  background: color-mix(in srgb, #f59312 9%, transparent);
  color: var(--prs-amber);
}
.st-converted {
  background: color-mix(in srgb, #14c16f 9%, transparent);
  color: var(--prs-green);
}
.flags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.flag {
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 20px;
  background: var(--surface-active);
  color: var(--text-secondary);
  white-space: nowrap;
}
.f-sanctions_hit {
  background: color-mix(in srgb, #fb2b3e 9%, transparent);
  color: var(--prs-red);
}

/* 抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 39;
  background: rgba(0, 0, 0, 0.12);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  width: min(440px, 92vw);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-left: 1px solid var(--line);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.08);
}
.drawer-enter-active,
.drawer-leave-active {
  transition:
    transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.22s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(24px);
  opacity: 0;
}
.dr-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--line);
}
.dr-title {
  flex: 1;
  min-width: 0;
}
.dr-title h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dr-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.dr-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: grid;
  place-items: center;
}
.dr-close:hover {
  background: var(--surface-active);
}
.dr-close svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.dr-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 20px;
}
.warn,
.note {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.55;
}
.warn {
  background: color-mix(in srgb, #fb2b3e 9%, transparent);
  color: var(--prs-red);
}
.note {
  background: var(--surface-active);
  color: var(--text-secondary);
}
.sec {
  margin-top: 16px;
}
.sec h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.reasons {
  margin: 0;
  padding: 0;
  list-style: none;
}
.reasons li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px dashed var(--line);
}
.reasons b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.reasons b.neg {
  color: var(--danger, #d64545);
}
.evidence {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.evidence li {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.ev-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}
.ev-time {
  margin-left: auto;
}
.ev-title {
  display: block;
  font-size: 13px;
  color: var(--link, #1264b6);
  word-break: break-word;
}
div.ev-title {
  color: var(--text);
}
.ev-snip {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}
.kv {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: 13px;
}
.kv dt {
  color: var(--text-tertiary);
}
.kv dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}
.kv dd .dim {
  margin-left: 6px;
}
.notes {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-active);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.dr-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
}
@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active,
  .drawer-leave-active,
  .score-bar i {
    transition: none;
  }
}
</style>
