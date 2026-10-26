<script setup lang="ts">
import SideSlot from '../components/shell/SideSlot.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api'
import logoUrl from '../assets/lulux-neutral.png'
import FollowUpModal from '../components/FollowUpModal.vue'
import InitialBadge from '../components/ui/InitialBadge.vue'
import PageTopbar from '../components/ui/PageTopbar.vue'
import StateBlock from '../components/ui/StateBlock.vue'
import { intlLocale, t } from '../i18n'
import { askLulux } from '../lib/ask-lulux'
import { formatMoneyMap } from '../lib/crm'
import { dueLabel } from '../lib/due'
import { ACTIVITY_LABEL, STAGE_LABEL, relativeTime } from '../lib/labels'
import { chartModel, CHART } from '../lib/mini-chart'
import { formatMoney } from '../lib/quote'
import { recentCustomers } from '../lib/recent-customers'
import { currentUser } from '../lib/session'
import { useAppStore } from '../stores/app'
import { errorText, toast } from '../stores/ui'

/**
 * 工作台：问候 + 一句话摘要、今天 / 近 7 天 / 近 30 天、4 张 KPI、邮件与询盘折线、客户阶段条；
 * 右栏 LULUX 今日摘要、今日待跟进、邮箱、应收。全部来自 /api/workbench/summary 等真实接口，没有数据时显示空状态。
 */
const router = useRouter()
const store = useAppStore()

type View = 'overview' | 'todo' | 'stale' | 'activity'
const view = ref<View>('overview')
const range = ref<api.WorkbenchRange>('today')
const summary = ref<api.WorkbenchSummary | null>(null)
const loading = ref(true)
const loadError = ref('')
const loadedAt = ref<Date | null>(null)
const tz = -new Date().getTimezoneOffset()

/** 应收 / 逾期（契约 §10.8 /api/receivables）；旧服务端或没有权限时不显示这张卡 */
const receivables = ref<{ items: api.Order[]; summary: api.ReceivablesSummary } | null>(null)
async function loadReceivables(): Promise<void> {
  try {
    const r = await api.request<{ items: api.Order[]; total: number; summary: api.ReceivablesSummary }>(
      '/api/receivables',
      { query: { limit: 5 }, silent: true },
    )
    receivables.value = { items: r.items, summary: r.summary }
  } catch {
    receivables.value = null
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    summary.value = await api.getWorkbenchSummary({ range: range.value, tz })
    loadedAt.value = new Date()
  } catch (error) {
    loadError.value = errorText(error)
  } finally {
    loading.value = false
  }
}
function refresh(): void {
  void loadReceivables()
  void load()
  if (view.value === 'todo') void loadTasks()
}
onMounted(() => {
  refresh()
  if (!store.providers.length) void store.refreshProviders().catch(() => undefined)
})
watch(range, () => void load())

const ov = computed(() => summary.value?.overview ?? null)
const hasMailbox = computed(() => (ov.value?.mail.accounts.length ?? 0) > 0)

/* ── 页头 ── */
const today = computed(() => {
  const d = new Date()
  const date = d.toLocaleDateString(intlLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
  const wd = d.toLocaleDateString(intlLocale(), { weekday: 'short' })
  return `${date} · ${wd}`
})
const greeting = computed(() => {
  const h = new Date().getHours()
  const name = currentUser.value?.name?.trim()
  const hello = h < 12 ? t('wbx.morning') : h < 18 ? t('wbx.afternoon') : t('wbx.evening')
  return name ? t('wbx.greetName', [hello, name]) : hello
})
const rangeText = computed(() =>
  range.value === 'today' ? t('wbx.rToday') : range.value === '7d' ? t('wbx.r7d') : t('wbx.r30d'),
)
/** KPI 标签里的范围：今日 / 近 7 天 / 近 30 天 */
const rangeShort = computed(() =>
  range.value === 'today' ? t('wbx.kToday') : range.value === '7d' ? t('wbx.k7d') : t('wbx.k30d'),
)
const summaryLine = computed(() => {
  const o = ov.value
  if (!o) return ''
  const a = hasMailbox.value ? t('wbx.lineInq', [rangeText.value, o.mail.current.inquiry]) : t('wbx.lineNoMail')
  const b =
    o.stale.count > 0
      ? t('wbx.lineStale', [o.stale.count])
      : summary.value && summary.value.customers.total === 0
        ? t('wbx.lineNoCustomers')
        : t('wbx.lineNoStale')
  return t('wbx.lineJoin', [a, b])
})

/* ── KPI ── */
function delta(cur: number, prev: number): { text: string; cls: string } | null {
  const d = cur - prev
  if (d > 0) return { text: `+${d}`, cls: '' }
  if (d < 0) return { text: `−${-d}`, cls: 'flat' }
  return null
}
const kpis = computed(() => {
  const o = ov.value
  const s = summary.value
  if (!o || !s) return []
  const mailDelta = hasMailbox.value ? delta(o.mail.current.total, o.mail.previous.total) : null
  const inqDelta = hasMailbox.value ? delta(o.mail.current.inquiry, o.mail.previous.inquiry) : null
  return [
    {
      key: 'mail',
      label: t('wbx.kMail', [rangeShort.value]),
      value: hasMailbox.value ? o.mail.current.total : '—',
      unit: hasMailbox.value ? t('wbx.uMail') : '',
      delta: mailDelta,
      foot: hasMailbox.value ? t('wbx.fMail', [o.mail.current.inquiry]) : t('wbx.fNoMail'),
      to: hasMailbox.value ? '/mailbox' : '/settings/mailbox',
    },
    {
      key: 'inq',
      label: t('wbx.kInq', [rangeShort.value]),
      value: hasMailbox.value ? o.mail.current.inquiry : '—',
      unit: hasMailbox.value ? t('wbx.uMail') : '',
      delta: inqDelta,
      foot: hasMailbox.value ? t('wbx.fInq', [o.mail.inquiryCountries, o.mail.inquiryNewCustomers]) : t('wbx.fNoMail'),
      to: hasMailbox.value ? { path: '/mailbox', query: { verdict: 'inquiry' } } : '/settings/mailbox',
    },
    {
      key: 'follow',
      label: t('wbx.kFollow'),
      value: o.followUps.due,
      unit: t('wbx.uCust'),
      delta: o.followUps.overdue > 0 ? { text: t('wbx.dOverdue', [o.followUps.overdue]), cls: 'down' } : null,
      foot: t('wbx.fFollow', [rangeText.value, o.followUps.done]),
      to: '',
    },
    {
      key: 'new',
      label: t('wbx.kNew', [rangeShort.value]),
      value: o.newCustomers.current,
      unit: t('wbx.uCust'),
      delta: delta(o.newCustomers.current, o.newCustomers.previous),
      foot: t('wbx.fNew', [o.newCustomers.week, s.customers.byStage.quoted ?? 0]),
      to: '/customers',
    },
  ]
})
/** 「**粗体**」标记 → 片段（文本节点渲染，不用 v-html） */
function boldParts(text: string): Array<{ b: boolean; s: string }> {
  return text.split('**').map((s, i) => ({ b: i % 2 === 1, s }))
}
function onKpi(to: string | { path: string; query?: Record<string, string> }): void {
  if (to) void router.push(to)
  else view.value = 'todo'
}

/* ── 折线图 ── */
const chart = computed(() => (ov.value ? chartModel(ov.value.mail.daily) : null))
const chartTotal = computed(() => ov.value?.mail.daily.reduce((n, d) => n + d.total, 0) ?? 0)

/* ── 阶段条 ── */
const stageRows = computed(() => {
  const s = summary.value
  if (!s) return []
  const keys = api.STAGES.filter((k) => k !== 'lost' || (s.customers.byStage.lost ?? 0) > 0)
  const max = Math.max(1, ...keys.map((k) => s.customers.byStage[k] ?? 0))
  return keys.map((k) => ({
    key: k,
    label: STAGE_LABEL[k],
    count: s.customers.byStage[k] ?? 0,
    pct: ((s.customers.byStage[k] ?? 0) / max) * 100,
  }))
})

/* ── LULUX 今日摘要（确定性：按真实计数拼句子） ── */
const aiText = computed(() => {
  const o = ov.value
  if (!o) return ''
  const parts: string[] = []
  if (hasMailbox.value && o.mail.current.inquiry > 0) {
    parts.push(
      o.mail.inquiryNewCustomers > 0
        ? t('wbx.aiInqNew', [rangeText.value, o.mail.current.inquiry, o.mail.inquiryNewCustomers])
        : t('wbx.aiInq', [rangeText.value, o.mail.current.inquiry]),
    )
  }
  if (o.mail.unreadInquiries > 0) parts.push(t('wbx.aiUnread', [o.mail.unreadInquiries]))
  const firstOver = o.followUps.items.find((i) => i.overdue)
  if (o.followUps.overdue > 0 && firstOver) {
    parts.push(t('wbx.aiOverdue', [o.followUps.overdue, firstOver.title, firstOver.company || t('wbx.noCustomer')]))
  }
  if (o.stale.count > 0) {
    const names = o.stale.items
      .slice(0, 2)
      .map((i) => i.company)
      .join(t('wbx.listSep'))
    parts.push(t('wbx.aiStale', [o.stale.count, names]))
  }
  if (!parts.length) parts.push(hasMailbox.value ? t('wbx.aiCalm') : t('wbx.aiCalmNoMail'))
  return parts.join('')
})
const aiTime = computed(() =>
  loadedAt.value ? loadedAt.value.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) : '',
)
const replyCount = computed(() => ov.value?.mail.unreadInquiries ?? 0)
const canSummarize = computed(() => store.providers.length > 0)
const showFollow = ref(false)
function aiSummarize(): void {
  const o = ov.value
  if (!o) return
  const prompt = t('wbx.aiPrompt', [rangeText.value, aiText.value.replaceAll('**', '')])
  void askLulux(router, { prompt })
}

/* ── 今日待跟进 ── */
const dueInfo = (dueAt: number | null) => dueLabel(dueAt)
function metaLine(i: { country: string | null; stage: api.Stage | null }): string {
  return [i.country, i.stage ? STAGE_LABEL[i.stage] : ''].filter(Boolean).join(' · ')
}

/* ── 全部待办（侧栏「今日待办」） ── */
const tasks = ref<api.Task[]>([])
const tasksLoading = ref(false)
async function loadTasks(): Promise<void> {
  tasksLoading.value = true
  try {
    tasks.value = (await api.tasksApi.list({ status: 'open', limit: 100 }, true)).items
  } catch {
    tasks.value = []
  } finally {
    tasksLoading.value = false
  }
}
watch(view, (v) => {
  if (v === 'todo') void loadTasks()
})
async function markDone(task: { id: string }): Promise<void> {
  try {
    await api.tasksApi.update(task.id, { status: 'done' })
    tasks.value = tasks.value.filter((x) => x.id !== task.id)
    toast.success(t('wbx.doneOk'))
    void load()
  } catch (error) {
    toast.error(errorText(error))
  }
}

/* ── 侧栏搜索：回车 → 客户列表按关键字筛选 ── */
const sideQ = ref('')
function sideSearch(): void {
  const q = sideQ.value.trim()
  if (q) void router.push({ path: '/customers', query: { q } })
}

/* ── 邮箱卡 ── */
const mailAccount = computed(() => ov.value?.mail.accounts[0] ?? null)
const syncedAt = computed(() => {
  const at = Math.max(0, ...(ov.value?.mail.accounts.map((a) => a.lastSyncAt ?? 0) ?? [0]))
  return at ? new Date(at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''
})
</script>

<template>
  <SideSlot>
    <aside class="side" :aria-label="$t('workbench.k10rnjfv')">
      <div class="side-head">
        <h2 class="side-title">{{ $t('workbench.k10rnjfv') }}</h2>
        <button type="button" class="link" :disabled="loading" @click="refresh">{{ $t('workbench.kfk0ip6') }}</button>
      </div>
      <form class="side-search" role="search" @submit.prevent="sideSearch">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
        <input
          v-model="sideQ"
          type="search"
          :placeholder="$t('wbx.sideSearch')"
          :aria-label="$t('wbx.sideSearchAria')"
          spellcheck="false"
        />
      </form>
      <nav class="side-body">
        <button type="button" class="nav-row" :class="{ on: view === 'overview' }" @click="view = 'overview'">
          {{ $t('wbx.navOverview') }}
        </button>
        <button type="button" class="nav-row" :class="{ on: view === 'todo' }" @click="view = 'todo'">
          {{ $t('wbx.navTodo') }}<span v-if="ov?.followUps.openTotal" class="count">{{ ov.followUps.openTotal }}</span>
        </button>
        <button type="button" class="nav-row" :class="{ on: view === 'stale' }" @click="view = 'stale'">
          {{ $t('wbx.navStale') }}<span v-if="ov?.stale.count" class="count">{{ ov.stale.count }}</span>
        </button>
        <button type="button" class="nav-row" :class="{ on: view === 'activity' }" @click="view = 'activity'">
          {{ $t('wbx.navActivity') }}
        </button>

        <div class="side-label">{{ $t('workbench.kw66xb5') }}</div>
        <RouterLink class="nav-row" :to="{ path: '/mailbox', query: { verdict: 'inquiry' } }">{{
          $t('wbx.qFromMail')
        }}</RouterLink>
        <RouterLink class="nav-row" to="/customers/import">{{ $t('workbench.k5ajcq1') }}</RouterLink>
        <RouterLink class="nav-row" to="/quotation/new">{{ $t('workbench.k1o6w1ye') }}</RouterLink>

        <template v-if="recentCustomers.length">
          <div class="side-label">{{ $t('wbx.recentViewed') }}</div>
          <RouterLink v-for="c in recentCustomers.slice(0, 5)" :key="c.id" class="nav-row" :to="`/customers/${c.id}`">
            <InitialBadge :name="c.company" :size="28" />
            <span class="nav-ellipsis">{{ c.company }}</span>
          </RouterLink>
        </template>
        <template v-else-if="summary?.recentSessions.length">
          <div class="side-label">{{ $t('workbench.k1iyb428') }}</div>
          <RouterLink
            v-for="s in summary.recentSessions.slice(0, 5)"
            :key="s.id"
            class="nav-row"
            :to="{ path: '/agent', query: { session: s.id } }"
            :title="s.title"
            ><span class="nav-ellipsis">{{ s.title }}</span></RouterLink
          >
        </template>
      </nav>
    </aside>
  </SideSlot>

  <main class="main">
    <PageTopbar :title="$t('workbench.k10rnjfv')" :sub="today" />
    <div class="doc">
      <StateBlock v-if="loading && !summary" state="loading" />
      <StateBlock
        v-else-if="loadError && !summary"
        state="error"
        :title="$t('workbench.k1sfzbyb')"
        :message="loadError"
        @retry="load"
      />
      <template v-else-if="summary">
        <!-- 侧栏：今日待办（全部未完成跟进） -->
        <section v-if="view === 'todo'" class="card list-card">
          <div class="card-head">
            <div>
              <div class="card-title">{{ $t('wbx.navTodo') }}</div>
              <div class="card-sub">{{ $t('wbx.todoSub') }}</div>
            </div>
            <button type="button" class="link" @click="showFollow = true">{{ $t('wbx.aiFollow') }}</button>
          </div>
          <StateBlock v-if="tasksLoading && !tasks.length" state="loading" compact />
          <StateBlock
            v-else-if="!tasks.length"
            state="empty"
            :title="$t('wbx.todoEmpty')"
            :message="$t('wbx.todoEmptyHint')"
            compact
          />
          <div v-else class="todo-list">
            <div v-for="task in tasks" :key="task.id" class="trow">
              <InitialBadge :name="task.customerName || task.title" />
              <div class="trow-main">
                <RouterLink v-if="task.customerId" class="trow-name" :to="`/customers/${task.customerId}`">{{
                  task.customerName
                }}</RouterLink>
                <div v-else class="trow-name">{{ task.title }}</div>
                <div class="trow-meta">{{ task.customerId ? task.title : $t('wbx.noCustomer') }}</div>
              </div>
              <div class="trow-when">
                <b :class="dueInfo(task.dueAt).cls">{{ dueInfo(task.dueAt).text }}</b>
              </div>
              <button type="button" class="kbtn sm" @click="markDone(task)">{{ $t('wbx.markDone') }}</button>
            </div>
          </div>
        </section>

        <!-- 侧栏：跟进提醒（超过 7 天没有联系的客户） -->
        <section v-else-if="view === 'stale'" class="card list-card">
          <div class="card-head">
            <div>
              <div class="card-title">{{ $t('wbx.navStale') }}</div>
              <div class="card-sub">{{ $t('wbx.staleSub', [ov?.stale.count ?? 0]) }}</div>
            </div>
          </div>
          <StateBlock
            v-if="!ov?.stale.items.length"
            state="empty"
            :title="$t('wbx.staleEmpty')"
            :message="$t('wbx.staleEmptyHint')"
            compact
          />
          <div v-else class="todo-list">
            <RouterLink v-for="c in ov.stale.items" :key="c.id" class="trow row-link" :to="`/customers/${c.id}`">
              <InitialBadge :name="c.company" />
              <div class="trow-main">
                <div class="trow-name">{{ c.company }}</div>
                <div class="trow-meta">{{ STAGE_LABEL[c.stage] }}</div>
              </div>
              <div class="trow-when">
                <b class="over">{{ $t('wbx.lastTouch', [relativeTime(c.lastTouchAt)]) }}</b>
              </div>
            </RouterLink>
            <p v-if="ov.stale.count > ov.stale.items.length" class="more-note">
              {{ $t('wbx.staleMore', [ov.stale.count - ov.stale.items.length]) }}
            </p>
          </div>
        </section>

        <!-- 侧栏：团队动态（最近跟进记录） -->
        <section v-else-if="view === 'activity'" class="card list-card">
          <div class="card-head">
            <div class="card-title">{{ $t('wbx.navActivity') }}</div>
          </div>
          <StateBlock
            v-if="!summary.recentActivities.length"
            state="empty"
            :title="$t('workbench.k190amr1')"
            :message="$t('workbench.kfhrap2')"
            compact
          />
          <ul v-else class="acts">
            <li v-for="a in summary.recentActivities" :key="a.id">
              <span class="tag">{{ ACTIVITY_LABEL[a.type] ?? a.type }}</span>
              <RouterLink v-if="a.customerId" class="act-text" :to="`/customers/${a.customerId}`">{{
                a.content
              }}</RouterLink>
              <span v-else class="act-text">{{ a.content }}</span>
              <span class="when">{{ relativeTime(a.createdAt) }}</span>
            </li>
          </ul>
        </section>

        <template v-else>
          <div class="page-greet">
            <div>
              <h2>{{ greeting }}</h2>
              <p v-if="summaryLine" data-testid="wb-summary-line">{{ summaryLine }}</p>
            </div>
            <div class="segmented" role="tablist" :aria-label="$t('wbx.rangeLabel')">
              <button
                v-for="r in ['today', '7d', '30d'] as const"
                :key="r"
                type="button"
                role="tab"
                :aria-selected="range === r"
                :class="{ on: range === r }"
                :disabled="loading"
                @click="range = r"
              >
                {{ r === 'today' ? $t('wbx.segToday') : r === '7d' ? $t('wbx.seg7d') : $t('wbx.seg30d') }}
              </button>
            </div>
          </div>

          <div v-if="!ov" class="note">{{ $t('wbx.oldServer') }}</div>

          <!-- KPI -->
          <div v-if="ov" class="stat-row">
            <button v-for="k in kpis" :key="k.key" type="button" class="stat" @click="onKpi(k.to)">
              <span class="k">{{ k.label }}</span>
              <span class="kpi-row">
                <span class="v">{{ k.value }}</span>
                <span v-if="k.unit" class="kpi-unit">{{ k.unit }}</span>
                <span v-if="k.delta" class="kpi-delta" :class="k.delta.cls">{{ k.delta.text }}</span>
              </span>
              <span class="s"
                ><template v-for="(p, i) in boldParts(k.foot)" :key="i"
                  ><b v-if="p.b">{{ p.s }}</b
                  ><template v-else>{{ p.s }}</template></template
                ></span
              >
            </button>
          </div>

          <div class="cols">
            <div class="col">
              <!-- 邮件与询盘 -->
              <section v-if="ov && chart" class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">{{ $t('wbx.chartTitle') }}</div>
                    <div class="card-sub">{{ $t('wbx.chartSub', [ov.mail.daily.length]) }}</div>
                  </div>
                  <RouterLink v-if="hasMailbox" class="link" to="/mailbox">{{ $t('wbx.openInbox') }}</RouterLink>
                </div>
                <template v-if="hasMailbox">
                  <div class="legend">
                    <span><i class="mail"></i>{{ $t('wbx.legendMail') }}</span>
                    <span><i class="inq"></i>{{ $t('wbx.legendInq') }}</span>
                  </div>
                  <div class="chart-wrap">
                    <svg
                      :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
                      width="100%"
                      :height="CHART.height"
                      role="img"
                      :aria-label="$t('wbx.chartAria', [ov.mail.daily.length, chartTotal])"
                      data-testid="wb-chart"
                    >
                      <g class="axis">
                        <text v-for="tk in chart.ticks" :key="tk.v" x="8" :y="tk.y + 3">{{ tk.v }}</text>
                        <text
                          v-for="l in chart.labels"
                          :key="l.i"
                          :x="l.i === ov.mail.daily.length - 1 ? l.x - 20 : l.x"
                          y="180"
                        >
                          {{ l.i === ov.mail.daily.length - 1 ? $t('wbx.today') : l.text }}
                        </text>
                      </g>
                      <line
                        v-for="tk in chart.ticks"
                        :key="`g${tk.v}`"
                        class="grid"
                        :x1="CHART.left"
                        :y1="tk.y"
                        :x2="CHART.right"
                        :y2="tk.y"
                      />
                      <line class="baseline" :x1="CHART.left" :y1="CHART.zeroY" :x2="CHART.right" :y2="CHART.zeroY" />
                      <polyline class="pl-mail" :points="chart.mail" />
                      <polyline class="pl-inq" :points="chart.inquiry" />
                      <template v-if="chart.end">
                        <circle class="pt-mail" :cx="chart.end.x" :cy="chart.end.mailY" r="4.5" />
                        <circle class="pt-inq" :cx="chart.end.x" :cy="chart.end.inqY" r="4.5" />
                        <text class="endlabel" :x="chart.end.x - 30" :y="chart.end.mailY - 9">
                          {{ chart.end.mail }}
                        </text>
                        <text
                          class="endlabel"
                          :x="chart.end.x - 30"
                          :y="chart.end.inqY + (chart.end.inqY - chart.end.mailY < 14 ? 16 : -4)"
                        >
                          {{ chart.end.inquiry }}
                        </text>
                      </template>
                    </svg>
                  </div>
                </template>
                <StateBlock v-else state="empty" :title="$t('wbx.noMailTitle')" :message="$t('wbx.noMailHint')" compact>
                  <RouterLink class="kbtn sm primary" to="/settings/mailbox">{{ $t('wbx.connectMail') }}</RouterLink>
                </StateBlock>
              </section>

              <!-- 客户阶段 -->
              <section class="card">
                <div class="card-head">
                  <div>
                    <div class="card-title">{{ $t('workbench.k1v4f5xb') }}</div>
                    <div class="card-sub">{{ $t('wbx.stageSub', [summary.customers.total]) }}</div>
                  </div>
                  <RouterLink class="link" to="/customers">{{ $t('workbench.k1tsmr5p') }}</RouterLink>
                </div>
                <div v-if="summary.customers.total" class="sbars stage-body">
                  <RouterLink
                    v-for="row in stageRows"
                    :key="row.key"
                    class="sbar"
                    :to="{ path: '/customers', query: { stage: row.key } }"
                  >
                    <span class="sk">{{ row.label }}</span>
                    <span class="st"><i :class="`s-${row.key}`" :style="{ width: `${row.pct}%` }"></i></span>
                    <span class="sv">{{ row.count }}</span>
                  </RouterLink>
                </div>
                <StateBlock v-else state="empty" :title="$t('wbx.noCustTitle')" :message="$t('wbx.noCustHint')" compact>
                  <RouterLink class="kbtn sm" to="/customers/import">{{ $t('workbench.kmozngi') }}</RouterLink>
                  <RouterLink class="kbtn sm primary" to="/customers?new=1">{{ $t('workbench.kr9abat') }}</RouterLink>
                </StateBlock>
              </section>

              <!-- 应收与逾期（卡片样式同上） -->
              <section v-if="receivables" class="card recv" data-testid="receivables-card">
                <div class="card-head">
                  <div>
                    <div class="card-title">{{ $t('workbench.receivables') }}</div>
                    <div class="card-sub">{{ $t('workbench.outstanding', [receivables.summary.openCount]) }}</div>
                  </div>
                  <RouterLink class="link" to="/orders">{{ $t('workbench.allOrders') }}</RouterLink>
                </div>
                <div class="recv-body">
                  <div class="recv-sum">
                    <div>
                      <span class="k">{{ $t('wbx.recvOpen') }}</span>
                      <span v-for="m in formatMoneyMap(receivables.summary.outstandingByCurrency)" :key="m" class="v">{{
                        m
                      }}</span>
                      <span v-if="!formatMoneyMap(receivables.summary.outstandingByCurrency).length" class="v">—</span>
                    </div>
                    <div :class="{ bad: receivables.summary.overdueCount > 0 }">
                      <span class="k">{{ $t('workbench.overdue', [receivables.summary.overdueCount]) }}</span>
                      <span v-for="m in formatMoneyMap(receivables.summary.overdueByCurrency)" :key="m" class="v">{{
                        m
                      }}</span>
                      <span v-if="!formatMoneyMap(receivables.summary.overdueByCurrency).length" class="v">—</span>
                    </div>
                  </div>
                  <div v-if="receivables.items.length" class="recv-list">
                    <RouterLink v-for="o in receivables.items" :key="o.id" :to="`/orders/${o.id}`" class="mline">
                      <span class="recv-num">{{ o.number }}</span>
                      <span class="recv-cust" :title="o.customerName">{{ o.customerName }}</span>
                      <span class="recv-due" :class="{ bad: o.overdue }">{{
                        o.overdue ? $t('workbench.overdueDays', [o.overdueDays]) : o.dueDate || '—'
                      }}</span>
                      <span class="n">{{ formatMoney(o.balance, o.currency) }}</span>
                    </RouterLink>
                  </div>
                  <p v-else class="recv-empty">{{ $t('workbench.noReceivables') }}</p>
                </div>
              </section>
            </div>

            <div class="col">
              <!-- LULUX 今日摘要 -->
              <section v-if="ov" class="ai-card" data-testid="wb-ai">
                <div class="ai-head">
                  <img :src="logoUrl" alt="" />
                  <b>{{ $t('wbx.aiTitle') }}</b>
                  <span class="when">{{ aiTime }}</span>
                </div>
                <p>
                  <template v-for="(p, i) in boldParts(aiText)" :key="i"
                    ><b v-if="p.b">{{ p.s }}</b
                    ><template v-else>{{ p.s }}</template></template
                  >
                </p>
                <div class="ai-actions">
                  <RouterLink :to="{ path: '/mailbox', query: { verdict: 'inquiry' } }">{{
                    replyCount > 0 ? $t('wbx.aiReplyN', [replyCount]) : $t('wbx.aiReply')
                  }}</RouterLink>
                  <RouterLink to="/quotation/new">{{ $t('wbx.aiQuote') }}</RouterLink>
                  <button type="button" @click="showFollow = true">{{ $t('wbx.aiFollow') }}</button>
                  <button v-if="canSummarize" type="button" @click="aiSummarize">{{ $t('wbx.aiAsk') }}</button>
                </div>
              </section>

              <!-- 今日待跟进 -->
              <section v-if="ov" class="card todo">
                <div class="todo-head">
                  <div class="card-title">{{ $t('wbx.todoTitle') }}</div>
                  <button v-if="ov.followUps.openTotal" type="button" class="link" @click="view = 'todo'">
                    {{ $t('wbx.todoAll', [ov.followUps.openTotal]) }}
                  </button>
                </div>
                <div v-if="!ov.followUps.items.length" class="todo-empty">
                  <p>{{ $t('wbx.todoEmpty') }}</p>
                  <button type="button" class="link" @click="showFollow = true">{{ $t('wbx.aiFollow') }}</button>
                </div>
                <component
                  :is="i.customerId ? 'RouterLink' : 'div'"
                  v-for="i in ov.followUps.items.slice(0, 5)"
                  :key="i.id"
                  class="trow"
                  :class="{ 'row-link': i.customerId }"
                  :to="i.customerId ? `/customers/${i.customerId}` : undefined"
                >
                  <InitialBadge :name="i.company || i.title" />
                  <div class="trow-main">
                    <div class="trow-name">{{ i.company || i.title }}</div>
                    <div class="trow-meta">
                      {{ i.company ? [metaLine(i), i.title].filter(Boolean).join(' · ') : $t('wbx.noCustomer') }}
                    </div>
                  </div>
                  <div class="trow-when">
                    <b :class="dueInfo(i.dueAt).cls">{{ dueInfo(i.dueAt).text }}</b>
                  </div>
                </component>
              </section>

              <!-- 邮箱 -->
              <section v-if="ov" class="card mailcard">
                <div class="todo-head">
                  <div class="card-title">{{ $t('wbx.mailTitle') }}</div>
                  <RouterLink v-if="hasMailbox" class="link" to="/mailbox">{{ $t('wbx.openInbox') }}</RouterLink>
                </div>
                <template v-if="hasMailbox">
                  <RouterLink class="mline" :to="{ path: '/mailbox', query: { verdict: 'inquiry' } }"
                    >{{ $t('wbx.mInq') }}
                    <span v-if="ov.mail.unreadInquiries" class="tag good">{{
                      $t('wbx.mNew', [ov.mail.unreadInquiries])
                    }}</span
                    ><span class="n">{{ ov.mail.current.inquiry }}</span></RouterLink
                  >
                  <RouterLink class="mline" to="/mailbox"
                    >{{ $t('wbx.mReply') }}<span class="n">{{ ov.mail.current.customerReply }}</span></RouterLink
                  >
                  <RouterLink class="mline" to="/mailbox"
                    >{{ $t('wbx.mOther') }}<span class="n">{{ ov.mail.current.other }}</span></RouterLink
                  >
                  <div class="mline mfoot">
                    {{ mailAccount?.email
                    }}<template v-if="ov.mail.accounts.length > 1">{{
                      $t('wbx.moreAccounts', [ov.mail.accounts.length - 1])
                    }}</template>
                    · {{ syncedAt ? $t('wbx.syncedAt', [syncedAt]) : $t('wbx.notSynced') }}
                  </div>
                </template>
                <div v-else class="todo-empty">
                  <p>{{ $t('wbx.noMailHint') }}</p>
                  <RouterLink class="link" to="/settings/mailbox">{{ $t('wbx.connectMail') }}</RouterLink>
                </div>
              </section>
            </div>
          </div>
        </template>
      </template>
    </div>
    <FollowUpModal v-if="showFollow" @close="showFollow = false" @created="refresh" />
  </main>
</template>

<style scoped>
.doc {
  padding: 24px 26px 28px;
}
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  gap: 14px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.stat {
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.nav-ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折线图 */
.legend {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.legend i {
  width: 16px;
  height: 2px;
  border-radius: 2px;
  display: block;
}
.legend i.mail {
  background: var(--chart-mail);
}
.legend i.inq {
  background: var(--good);
}
.chart-wrap {
  padding: 2px 18px 12px;
}
.axis text {
  font-size: 11px;
  fill: var(--text-tertiary);
  font-family: var(--font-sans);
}
.grid {
  stroke: var(--chart-grid);
  stroke-width: 1;
}
.baseline {
  stroke: var(--chart-base);
  stroke-width: 1;
}
.pl-mail,
.pl-inq {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pl-mail {
  stroke: var(--chart-mail);
}
.pl-inq {
  stroke: var(--good);
}
.pt-mail,
.pt-inq {
  stroke: var(--surface);
  stroke-width: 2;
}
.pt-mail {
  fill: var(--chart-mail);
}
.pt-inq {
  fill: var(--good);
}
.endlabel {
  font-size: 11.5px;
  fill: var(--text-secondary);
  font-weight: 600;
  font-family: var(--font-sans);
}

.stage-body {
  padding: 14px 20px 20px;
}

/* 待跟进 */
.todo {
  padding: 16px 20px 12px;
}
.todo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.trow {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 0;
  border-top: 1px solid var(--surface-muted);
  color: inherit;
}
.todo-head + .trow,
.todo-list > .trow:first-child {
  border-top: 0;
}
.trow-main {
  min-width: 0;
  flex: 1;
}
.trow-name {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trow-meta {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trow-when {
  font-size: 11.5px;
  color: var(--text-tertiary);
  text-align: right;
  white-space: nowrap;
}
.trow-when b {
  display: block;
  font-weight: 600;
}
.trow-when b.today {
  color: var(--text);
}
.trow-when b.over {
  color: var(--danger-text);
}
.row-link {
  cursor: pointer;
}
.trow.row-link:hover {
  background: var(--surface-soft);
}
.todo-empty {
  padding: 8px 0 6px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.todo-empty p {
  margin: 0 0 4px;
}

/* 邮箱 */
.mailcard {
  padding: 16px 20px 14px;
}
.mline {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 24px;
  padding: 10px 0;
  font-size: 13px;
  color: var(--text-secondary);
  border-top: 1px solid var(--surface-muted);
}
.todo-head + .mline,
.recv-list > .mline:first-child {
  border-top: 0;
}
a.mline:hover {
  color: var(--text);
}
.mline .n {
  margin-left: auto;
  font-size: 13px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.mfoot {
  display: block;
  color: var(--text-tertiary);
  font-size: 12px;
  padding-top: 12px;
}

/* 应收 */
.recv-body {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
  padding: 14px 20px 14px;
}
.recv-sum {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.recv-sum > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recv-sum .k {
  font-size: 12px;
  color: var(--text-tertiary);
}
.recv-sum .v {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.recv-sum .bad .v,
.recv-sum .bad .k,
.recv-due.bad {
  color: var(--danger-text);
}
.recv-num {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.recv-cust {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recv-due {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}
.recv-empty {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 13px;
  align-self: center;
}

/* 侧栏切换出来的列表 */
.list-card {
  max-width: 860px;
  padding-bottom: 8px;
}
.todo-list {
  padding: 8px 20px 4px;
}
.todo-list .trow .kbtn {
  flex: none;
}
.more-note {
  margin: 8px 0 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}
.acts {
  list-style: none;
  margin: 0;
  padding: 8px 20px 8px;
}
.acts li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--surface-muted);
  font-size: 13px;
}
.acts li:first-child {
  border-top: 0;
}
.act-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.when {
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

@media (max-width: 1180px) {
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .stat-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  .recv-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
