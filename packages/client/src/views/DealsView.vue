<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import * as api from '../api'
import DealFormModal from '../components/DealFormModal.vue'
import LostReasonModal from '../components/LostReasonModal.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import { useDealStage } from '../composables/useDealStage'
import { t } from '../i18n'
import { DEAL_STAGE_LABEL, formatMoneyMap } from '../lib/crm'
import { STAGE_LABEL, formatDate } from '../lib/labels'
import { formatMoney } from '../lib/quote'
import { can } from '../lib/session'
import { errorText, toast } from '../stores/ui'

/**
 * 商机：看板（按阶段分列，拖动或用“移到”下拉改阶段，输单必须填原因）与漏斗统计
 * （按金额加权，按币种分别汇总，不做汇率折算；契约 §10.3 §10.7）
 */
const route = useRoute()
const view = computed(() => (route.query.view === 'funnel' ? 'funnel' : 'board'))

const deals = ref<api.Deal[]>([])
const stats = ref<api.PipelineStats | null>(null)
const loading = ref(true)
const error = ref('')
const canWrite = computed(() => can('data:write'))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, s] = await Promise.all([api.dealsApi.list({ stage: 'all', limit: 500 }), api.pipelineApi.stats()])
    deals.value = list.items
    stats.value = s
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function refreshStats(): Promise<void> {
  try {
    stats.value = await api.pipelineApi.stats()
  } catch {
    /* 看板已更新；统计下次刷新 */
  }
}

function upsert(deal: api.Deal): void {
  const i = deals.value.findIndex((d) => d.id === deal.id)
  if (i >= 0) deals.value.splice(i, 1, deal)
  else deals.value.unshift(deal)
  void refreshStats()
}
const stage = useDealStage(upsert)

/** 侧栏搜索：按商机标题 / 客户名过滤看板（本地过滤） */
const q = ref('')
const visibleDeals = computed(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return deals.value
  return deals.value.filter(
    (d) => d.title.toLowerCase().includes(needle) || (d.customerName ?? '').toLowerCase().includes(needle),
  )
})
const columns = computed(() =>
  api.DEAL_STAGES.map((s) => {
    const items = visibleDeals.value.filter((d) => d.stage === s)
    const sum: Record<string, number> = {}
    for (const d of items) sum[d.currency] = (sum[d.currency] ?? 0) + d.amount
    return { stage: s, items, totals: formatMoneyMap(sum) }
  }),
)

/* ── 拖放 ── */
const dragging = ref<string | null>(null)
const over = ref<api.DealStage | null>(null)
function onDragStart(event: DragEvent, deal: api.Deal): void {
  if (!canWrite.value) return
  dragging.value = deal.id
  event.dataTransfer?.setData('text/plain', deal.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function endDrag(): void {
  dragging.value = null
  over.value = null
}
/** 下拉“移到…”：选择后立即复位，真正的阶段以服务端返回为准（输单要先填原因） */
function onMove(event: Event, deal: api.Deal): void {
  const el = event.target as HTMLSelectElement
  const target = el.value as api.DealStage
  el.value = deal.stage
  void stage.change(deal, target)
}
function onDrop(target: api.DealStage): void {
  const deal = deals.value.find((d) => d.id === dragging.value)
  dragging.value = null
  over.value = null
  if (deal) void stage.change(deal, target)
}

/* ── 新建 / 编辑 ── */
const creatingStage = ref<api.DealStage | null>(null)
const editing = ref<api.Deal | null>(null)
function closeForm(): void {
  creatingStage.value = null
  editing.value = null
}
function onSaved(deal: api.Deal): void {
  toast.success(creatingStage.value ? t('crm.dealCreated') : t('crm.dealSaved'))
  upsert(deal)
  creatingStage.value = null
  editing.value = null
}

/* ── 漏斗 ── */
const funnelRows = computed(() => {
  const by = stats.value?.deals?.byStage ?? []
  const max = Math.max(1, ...by.map((b) => b.count))
  return api.DEAL_STAGES.map((s) => {
    const row = by.find((b) => b.stage === s)
    return {
      stage: s,
      count: row?.count ?? 0,
      probability: row?.probability ?? 0,
      amount: formatMoneyMap(row?.amountByCurrency),
      weighted: formatMoneyMap(row?.weightedByCurrency),
      pct: ((row?.count ?? 0) / max) * 100,
    }
  })
})
/** 服务端给的是 0–100 的百分数 */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`)
</script>

<template>
  <aside class="side" :aria-label="$t('crm.deals')">
    <div class="side-head">
      <h2 class="side-title">{{ $t('crm.deals') }}</h2>
      <button v-if="canWrite" type="button" class="link" @click="creatingStage = 'prospecting'">
        {{ $t('customers.k3ke49o') }}
      </button>
    </div>
    <label class="side-search">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </svg>
      <span class="sr-only">{{ $t('dealx.search') }}</span>
      <input v-model="q" type="search" :placeholder="$t('dealx.search')" spellcheck="false" />
    </label>
    <nav class="side-body">
      <RouterLink class="nav-row" :class="{ on: view === 'board' }" :to="{ query: {} }" data-testid="deals-board-tab"
        >{{ $t('crm.board')
        }}<span class="count">{{
          deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost').length
        }}</span></RouterLink
      >
      <RouterLink
        class="nav-row"
        :class="{ on: view === 'funnel' }"
        :to="{ query: { view: 'funnel' } }"
        data-testid="deals-funnel-tab"
        >{{ $t('crm.funnel') }}</RouterLink
      >
      <div class="side-label">{{ $t('crm.stage') }}</div>
      <div v-for="col in columns" :key="col.stage" class="nav-row sub">
        <span class="sdot" :class="`st-${col.stage}`" aria-hidden="true"></span>{{ DEAL_STAGE_LABEL[col.stage]
        }}<span class="count">{{ col.items.length }}</span>
      </div>
      <div class="side-label">{{ $t('crm.related') }}</div>
      <RouterLink class="nav-row" to="/orders">{{ $t('crm.orders') }}</RouterLink>
      <RouterLink class="nav-row" to="/customers">{{ $t('crm.customers') }}</RouterLink>
    </nav>
  </aside>

  <main class="main">
    <PageTopbar :title="$t('crm.deals')" :sub="$t('crm.dealsSub')" />

    <div class="doc" :class="{ 'board-doc': view === 'board' }">
      <StateBlock v-if="loading && !stats" state="loading" />
      <StateBlock v-else-if="error" state="error" :message="error" @retry="load" />

      <template v-else-if="stats">
        <div class="head-row">
          <div>
            <h2 class="page-h">{{ view === 'funnel' ? $t('crm.funnel') : $t('crm.board') }}</h2>
            <div class="head-count">
              {{ $t('dealx.countLine', [stats.deals?.open.count ?? 0, deals.length]) }}
            </div>
          </div>
          <div class="tb-spacer"></div>
          <div class="segmented" role="tablist" :aria-label="$t('custx.viewLabel')">
            <RouterLink
              role="tab"
              :aria-selected="view === 'board'"
              :class="{ on: view === 'board' }"
              :to="{ query: {} }"
              >{{ $t('crm.board') }}</RouterLink
            >
            <RouterLink
              role="tab"
              :aria-selected="view === 'funnel'"
              :class="{ on: view === 'funnel' }"
              :to="{ query: { view: 'funnel' } }"
              >{{ $t('crm.funnel') }}</RouterLink
            >
          </div>
          <button type="button" class="btn" :disabled="loading" @click="load">{{ $t('crm.refresh') }}</button>
          <button
            v-if="canWrite"
            type="button"
            class="btn dark"
            data-testid="board-new-deal"
            @click="creatingStage = 'prospecting'"
          >
            {{ $t('crm.newDeal') }}
          </button>
        </div>
        <!-- 汇总：进行中 / 加权 / 本月预计 / 赢单率 -->
        <div class="stat-row">
          <div class="stat">
            <span class="k">{{ $t('crm.openDeals') }}</span>
            <span class="v">{{ stats.deals?.open.count ?? 0 }}</span>
            <span v-for="m in formatMoneyMap(stats.deals?.open.amountByCurrency)" :key="m" class="s money">{{
              m
            }}</span>
          </div>
          <div class="stat">
            <span class="k">{{ $t('crm.weighted') }}</span>
            <span v-if="!formatMoneyMap(stats.deals?.open.weightedByCurrency).length" class="v">—</span>
            <span
              v-for="m in formatMoneyMap(stats.deals?.open.weightedByCurrency).slice(0, 2)"
              :key="m"
              class="v money"
              data-testid="weighted-total"
              >{{ m }}</span
            >
            <span class="s">{{ $t('crm.weightedHint') }}</span>
          </div>
          <div class="stat">
            <span class="k">{{ $t('crm.closingThisMonth') }}</span>
            <span class="v">{{ stats.deals?.closingThisMonth.count ?? 0 }}</span>
            <span
              v-for="m in formatMoneyMap(stats.deals?.closingThisMonth.weightedByCurrency)"
              :key="m"
              class="s money"
              >{{ $t('crm.weightedShort', [m]) }}</span
            >
          </div>
          <div class="stat">
            <span class="k">{{ $t('crm.winRate') }}</span>
            <span class="v">{{ pct(stats.deals?.winRate) }}</span>
            <span class="s">{{ $t('crm.winRateHint') }}</span>
          </div>
        </div>

        <!-- 看板 -->
        <div v-if="view === 'board'" class="board" data-testid="deal-board">
          <section
            v-for="col in columns"
            :key="col.stage"
            class="col"
            :class="[`st-${col.stage}`, { over: over === col.stage }]"
            :data-stage="col.stage"
            :aria-label="DEAL_STAGE_LABEL[col.stage]"
            @dragover.prevent="over = col.stage"
            @dragleave="over === col.stage && (over = null)"
            @drop.prevent="onDrop(col.stage)"
          >
            <header class="col-head">
              <span class="col-dot" aria-hidden="true"></span>
              <span class="col-title">{{ DEAL_STAGE_LABEL[col.stage] }}</span>
              <span class="col-count">{{ col.items.length }}</span>
            </header>
            <div class="col-sum">
              <span v-for="m in col.totals" :key="m">{{ m }}</span>
              <span v-if="!col.totals.length">—</span>
            </div>
            <div class="cards">
              <article
                v-for="d in col.items"
                :key="d.id"
                class="card-deal"
                :class="{ dragging: dragging === d.id }"
                :draggable="canWrite"
                data-testid="board-card"
                @dragstart="onDragStart($event, d)"
                @dragend="endDrag"
              >
                <button type="button" class="card-title" :title="d.title" @click="editing = d">{{ d.title }}</button>
                <RouterLink class="card-cust" :to="`/customers/${d.customerId}`" :title="d.customerName">{{
                  d.customerName
                }}</RouterLink>
                <div class="card-money">
                  <b :title="formatMoney(d.amount, d.currency)">{{ formatMoney(d.amount, d.currency) }}</b>
                </div>
                <div class="card-meta">
                  <span :class="{ late: d.overdue }">{{
                    d.expectedClose ? formatDate(d.expectedClose) : $t('crm.noCloseDate')
                  }}</span>
                  <span class="prob">{{ d.probability }}%</span>
                </div>
                <div v-if="d.stage === 'lost' && d.lostReason" class="card-reason" :title="d.lostReason">
                  {{ d.lostReason }}
                </div>
                <div v-if="canWrite" class="card-foot">
                  <select
                    v-if="canWrite"
                    class="move"
                    :value="d.stage"
                    :aria-label="$t('crm.moveTo', [d.title])"
                    :title="$t('crm.moveShort')"
                    :disabled="stage.busy.value"
                    @change="onMove($event, d)"
                  >
                    <option v-for="s in api.DEAL_STAGES" :key="s" :value="s">{{ DEAL_STAGE_LABEL[s] }}</option>
                  </select>
                </div>
              </article>
              <button
                v-if="canWrite && col.stage !== 'won' && col.stage !== 'lost'"
                type="button"
                class="col-add"
                @click="creatingStage = col.stage"
              >
                + {{ $t('crm.addHere') }}
              </button>
              <p v-else-if="!col.items.length" class="col-empty">{{ $t('crm.colEmpty') }}</p>
            </div>
          </section>
        </div>

        <!-- 漏斗统计 -->
        <div v-else class="funnel-grid">
          <section class="panel">
            <div class="panel-head">
              <div class="txt">
                <h2 class="panel-title">{{ $t('crm.funnelByStage') }}</h2>
                <p class="panel-sub">{{ $t('crm.funnelSub') }}</p>
              </div>
            </div>
            <div class="table-scroll">
              <table class="data-table funnel-table" data-testid="funnel-table">
                <thead>
                  <tr>
                    <th>{{ $t('crm.stage') }}</th>
                    <th class="bar-col">{{ $t('crm.count') }}</th>
                    <th class="num">{{ $t('crm.probability') }}</th>
                    <th class="num">{{ $t('crm.amount') }}</th>
                    <th class="num">{{ $t('crm.weighted') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in funnelRows" :key="r.stage" :data-stage="r.stage">
                    <td>{{ DEAL_STAGE_LABEL[r.stage] }}</td>
                    <td class="bar-col">
                      <div class="fbar-wrap">
                        <span class="fbar"><i :class="`st-${r.stage}`" :style="{ width: `${r.pct}%` }"></i></span>
                        <span class="fcount">{{ r.count }}</span>
                      </div>
                    </td>
                    <td class="num">{{ r.probability }}%</td>
                    <td class="num">
                      <span v-for="m in r.amount" :key="m" class="money-line">{{ m }}</span
                      ><span v-if="!r.amount.length">—</span>
                    </td>
                    <td class="num">
                      <span v-for="m in r.weighted" :key="m" class="money-line">{{ m }}</span
                      ><span v-if="!r.weighted.length">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <div class="funnel-side">
            <section class="panel">
              <div class="panel-head">
                <div class="txt">
                  <h2 class="panel-title">{{ $t('crm.customerFunnel') }}</h2>
                </div>
              </div>
              <div class="panel-body conv">
                <div v-for="f in stats.funnel" :key="f.stage" class="conv-row">
                  <span>{{ STAGE_LABEL[f.stage as api.Stage] ?? f.stage }}</span>
                  <span class="muted">{{ $t('crm.reached', [f.reached]) }}</span>
                  <b>{{ pct(f.conversionFromPrevious) }}</b>
                </div>
              </div>
            </section>
            <section class="panel">
              <div class="panel-head">
                <div class="txt">
                  <h2 class="panel-title">{{ $t('crm.lostReasons') }}</h2>
                </div>
              </div>
              <StateBlock v-if="!stats.deals?.lostReasons.length" state="empty" :title="$t('crm.noLost')" compact />
              <ul v-else class="reasons">
                <li v-for="r in stats.deals?.lostReasons ?? []" :key="r.reason">
                  <span class="reason-text" :title="r.reason">{{ r.reason }}</span>
                  <b>{{ r.count }}</b>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </div>

    <DealFormModal
      v-if="creatingStage || editing"
      :deal="editing"
      :stage="creatingStage ?? undefined"
      @close="closeForm"
      @saved="onSaved"
    />
    <LostReasonModal
      v-if="stage.lostFor.value"
      :title="stage.lostFor.value.title"
      :busy="stage.busy.value"
      @close="stage.lostFor.value = null"
      @confirm="stage.confirmLost"
    />
  </main>
</template>

<style scoped>
.nav-row.on {
  background: var(--surface-active);
  font-weight: 600;
}
.board-doc {
  display: flex;
  flex-direction: column;
  container-type: inline-size;
}

/* 看板：6 列；容器不足 960px 时 3 列 × 2 行（见下方 @container） */
.board {
  flex: 1;
  min-height: 0;
  display: grid;
  /* 1440 宽（左栏 + 次级栏后约 1036px）要能放下 6 列：6×150 + 5×12 = 960 */
  grid-template-columns: repeat(6, minmax(150px, 1fr));
  gap: var(--space-3);
  overflow-x: auto;
  padding-bottom: var(--space-2);
}
/* 放不下 6 列时（1280 / 1024 窗口）改成 3 列 × 2 行，不再把后面几个阶段藏在没有滚动条提示的横向滚动里 */
@container (max-width: 959px) {
  .board {
    grid-template-columns: repeat(3, minmax(150px, 1fr));
  }
}
.col {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  background: var(--surface-soft);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 12px;
  transition: border-color 0.12s;
}
.col.over {
  border-color: var(--good);
  background: var(--good-soft);
}
.col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--space-1);
  font-weight: 600;
  font-size: var(--fs-sm);
}
.col-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--icon-muted);
}
/* 原版阶段绿：由浅到深；输单灰 */
:is(.col-dot, .sdot, .fbar i).st-prospecting,
.st-prospecting .col-dot {
  background: var(--stage-1);
}
:is(.col-dot, .sdot, .fbar i).st-qualified,
.st-qualified .col-dot {
  background: var(--stage-2);
}
:is(.col-dot, .sdot, .fbar i).st-proposal,
.st-proposal .col-dot {
  background: var(--stage-3);
}
:is(.col-dot, .sdot, .fbar i).st-negotiation,
.st-negotiation .col-dot {
  background: var(--stage-4);
}
:is(.col-dot, .sdot, .fbar i).st-won,
.st-won .col-dot {
  background: var(--stage-5);
}
:is(.col-dot, .sdot, .fbar i).st-lost,
.st-lost .col-dot {
  background: var(--stage-lost);
}
.sdot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--icon-muted);
}
.nav-row .count {
  margin-left: auto;
}
.nav-row.sub {
  height: 34px;
  font-size: 13px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.page-h {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.head-count {
  font-size: 12.5px;
  color: var(--text-tertiary);
  margin-top: 6px;
}
.segmented a {
  height: 28px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.segmented a.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(17, 17, 19, 0.1);
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
.col-title {
  flex: 1;
}
.col-count {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-weight: 500;
}
.col-sum {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 2px var(--space-1) var(--space-2);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  min-height: 0;
}
.card-deal {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: grab;
}
.card-deal.dragging {
  opacity: 0.5;
}
.card-title {
  all: unset;
  font-weight: 600;
  font-size: var(--fs-sm);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 点击区域 ≥24px，不改变视觉行距 */
  padding-block: 3px;
  margin-block: -3px;
}
.card-title:focus-visible {
  outline: 2px solid var(--focus);
  border-radius: 4px;
}
.card-cust {
  padding-block: 3px;
  margin-block: -3px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-cust:hover {
  text-decoration: underline;
}
.card-money {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-sm);
}
.card-money b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-money span {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}
.card-reason {
  font-size: var(--fs-xs);
  color: var(--danger-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.card-meta > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-meta .late {
  color: var(--danger-text);
}
.card-meta .prob {
  flex: none;
}
.card-foot {
  display: flex;
  margin-top: 4px;
}
.move {
  border: 0;
  background: var(--surface-muted);
  color: var(--text-secondary);
  border-radius: var(--radius-pill);
  font: inherit;
  font-size: 11.5px;
  height: 24px;
  padding: 0 22px 0 10px;
  width: 100%;
  min-width: 0;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5l3-3' fill='none' stroke='%238a8a90' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  text-overflow: ellipsis;
  cursor: pointer;
}
.move:focus-visible {
  outline: 2px solid var(--focus);
}
.col-add {
  border: 1px dashed var(--line-strong);
  background: none;
  border-radius: var(--radius-sm);
  height: 32px;
  /* 列被网格行高压缩时不跟着缩（1024 下 3×2 布局压到 22px，低于 24px 点击区域） */
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--fs-xs);
}
.col-add:hover {
  background: var(--surface);
  color: var(--text);
}
.col-empty {
  margin: var(--space-2) 0 0;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* 漏斗 */
.funnel-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr);
  gap: var(--space-4);
  align-items: start;
}
.funnel-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.funnel-table td:first-child,
.funnel-table th:first-child {
  white-space: nowrap;
}
.funnel-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bar-col {
  width: 34%;
}
.fbar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fbar {
  flex: 1;
  height: 9px;
  border-radius: 999px;
  background: var(--surface-muted);
  overflow: hidden;
}
.fbar i {
  display: block;
  height: 100%;
  background: var(--text-secondary);
  border-radius: 999px;
}
.fcount {
  width: 24px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.money-line {
  display: block;
}
.conv {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conv-row {
  display: grid;
  grid-template-columns: 1fr auto 52px;
  gap: 8px;
  font-size: var(--fs-sm);
}
.conv-row b {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.reasons {
  list-style: none;
  margin: 0;
  padding: 0 20px 12px;
}
.reasons li {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  font-size: var(--fs-sm);
}
.reasons li:first-child {
  border-top: 0;
}
.reason-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1180px) {
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .funnel-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
